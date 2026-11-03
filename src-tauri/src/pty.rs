//! Integrated terminal: pseudo-terminal sessions running the user's shell.
//! Output is streamed as raw bytes (base64) so multi-byte characters split
//! across reads are reassembled by the terminal emulator, not mangled here.

use anyhow::{anyhow, Result};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyEvent {
    pub id: String,
    /// base64 of the bytes read; empty on exit
    pub data: String,
    /// Set once the shell has exited.
    pub exit: Option<i32>,
}

pub type PtySink = Arc<dyn Fn(PtyEvent) + Send + Sync>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

/// The user's login shell (falls back to bash / PowerShell).
pub fn default_shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".into();
    }
    std::env::var("SHELL").ok().filter(|s| !s.is_empty() && std::path::Path::new(s).exists()).unwrap_or_else(|| {
        ["/bin/zsh", "/bin/bash", "/bin/sh"].iter().find(|p| std::path::Path::new(p).exists()).unwrap_or(&"/bin/sh").to_string()
    })
}

impl PtyManager {
    pub fn open(
        &self,
        id: String,
        shell: Option<String>,
        args: Vec<String>,
        cwd: Option<PathBuf>,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        sink: PtySink,
    ) -> Result<String> {
        self.kill(&id);
        let pair = native_pty_system().openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })?;
        let shell = shell.filter(|s| !s.is_empty()).unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        // macOS GUI apps get a minimal PATH; a login shell restores the user's.
        // On Linux the app already has it, and /etc/profile may reset PATH.
        if !args.is_empty() {
            cmd.args(&args);
        } else if cfg!(target_os = "macos") && (shell.ends_with("bash") || shell.ends_with("zsh")) {
            cmd.arg("-l");
        }
        if let Some(dir) = cwd.filter(|d| d.is_dir()) {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "DataForge");
        if let Some(utf8) = crate::procs::default_utf8_locale() {
            cmd.env("LANG", utf8);
        }
        for (k, v) in env {
            if k == "DATAFORGE_PATH_PREPEND" {
                // The project's virtualenv first, like an activated venv.
                cmd.env("PATH", format!("{v}{}", std::env::var("PATH").unwrap_or_default()));
            } else {
                cmd.env(k, v);
            }
        }
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        self.sessions.lock().unwrap().insert(id.clone(), Session { master: pair.master, writer, killer });

        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let b64 = base64::engine::general_purpose::STANDARD;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink(PtyEvent { id: id.clone(), data: b64.encode(&buf[..n]), exit: None }),
                }
            }
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            sessions.lock().unwrap().remove(&id);
            sink(PtyEvent { id, data: String::new(), exit: Some(code) });
        });
        Ok(shell)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut all = self.sessions.lock().unwrap();
        let s = all.get_mut(id).ok_or_else(|| anyhow!("no terminal {id}"))?;
        s.writer.write_all(data.as_bytes())?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let all = self.sessions.lock().unwrap();
        let s = all.get(id).ok_or_else(|| anyhow!("no terminal {id}"))?;
        s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            let _ = s.killer.kill();
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }
}
