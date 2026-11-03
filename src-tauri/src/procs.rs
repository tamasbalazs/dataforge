//! Background processes (venv creation, uv sync, pip …) with streamed output.

use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcEvent {
    pub id: String,
    /// "stdout" | "stderr" | "exit"
    pub kind: String,
    pub text: String,
    pub code: Option<i32>,
}

pub type ProcSink = Arc<dyn Fn(ProcEvent) + Send + Sync>;

/// GUI apps (launched from Finder or a desktop menu) often have no locale;
/// R would then mangle non-ASCII text. The UTF-8 locale to default to, if any.
pub fn default_utf8_locale() -> Option<&'static str> {
    if ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|v| std::env::var_os(v).is_some()) {
        return None;
    }
    Some(if cfg!(target_os = "macos") { "en_US.UTF-8" } else { "C.UTF-8" })
}

/// One command of a background job.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Step {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Extra environment variables (e.g. QUARTO_PYTHON for renders).
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Default)]
pub struct Procs {
    running: Mutex<HashMap<String, u32>>,
}

impl Procs {
    /// Run steps one after another; stops at the first failure.
    pub async fn run(self: Arc<Self>, id: String, steps: Vec<Step>, cwd: Option<PathBuf>, sink: ProcSink) -> Result<()> {
        let me = self.clone();
        tokio::spawn(async move {
            let mut code = Some(0);
            for Step { program, args, env } in steps {
                sink(ProcEvent { id: id.clone(), kind: "stdout".into(), text: format!("$ {} {}", program.display(), args.join(" ")), code: None });
                let mut cmd = tokio::process::Command::new(&program);
                if let Some(utf8) = default_utf8_locale() {
                    cmd.env("LANG", utf8).env("LC_CTYPE", utf8);
                }
                cmd.args(&args).envs(&env).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::null());
                if let Some(dir) = cwd.as_ref().filter(|d| d.is_dir()) {
                    cmd.current_dir(dir);
                }
                #[cfg(windows)]
                {
                    cmd.creation_flags(0x0800_0000);
                }
                let mut child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        sink(ProcEvent { id: id.clone(), kind: "stderr".into(), text: e.to_string(), code: None });
                        code = Some(-1);
                        break;
                    }
                };
                if let Some(pid) = child.id() {
                    me.running.lock().await.insert(id.clone(), pid);
                }
                let mut tasks = vec![];
                for (stream, kind) in [
                    (child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), "stdout"),
                    (child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), "stderr"),
                ] {
                    if let Some(stream) = stream {
                        let sink = sink.clone();
                        let id = id.clone();
                        tasks.push(tokio::spawn(async move {
                            let mut lines = BufReader::new(stream).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                sink(ProcEvent { id: id.clone(), kind: kind.into(), text: line, code: None });
                            }
                        }));
                    }
                }
                let status = child.wait().await.ok();
                for t in tasks {
                    let _ = t.await;
                }
                code = status.and_then(|s| s.code());
                if code != Some(0) {
                    break;
                }
            }
            me.running.lock().await.remove(&id);
            sink(ProcEvent { id, kind: "exit".into(), text: String::new(), code });
        });
        Ok(())
    }

    pub async fn kill(&self, id: &str) {
        if let Some(pid) = self.running.lock().await.remove(id) {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
            }
        }
    }
}
