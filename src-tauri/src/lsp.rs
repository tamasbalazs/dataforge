//! Language servers: discovery and a stdio ↔ UI bridge. The host only frames
//! messages (`Content-Length` headers); the LSP client lives in the UI.

use crate::kernel::Lang;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspCommand {
    /// Display name, e.g. "Pyright" or "R languageserver".
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// The command as sent back by the UI (from a previous detection).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct LspCommandArgs {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDetection {
    pub lang: Lang,
    pub command: Option<LspCommand>,
    /// Shell command that installs a server when none was found.
    pub install_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspEvent {
    pub id: String,
    /// "message" | "log" | "exit"
    pub kind: String,
    pub payload: String,
}

pub type LspSink = Arc<dyn Fn(LspEvent) + Send + Sync>;

#[cfg(windows)]
const EXE: &str = ".exe";
#[cfg(not(windows))]
const EXE: &str = "";

fn find_in(dir: &Path, name: &str) -> Option<PathBuf> {
    for candidate in [format!("{name}{EXE}"), format!("{name}.cmd")] {
        let p = dir.join(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|d| find_in(&d, name))
}

/// Python servers in preference order: Pyright, basedpyright, pylsp.
pub fn python_server(interpreter: &Path) -> Option<LspCommand> {
    let bin_dir = interpreter.parent().map(Path::to_path_buf);
    let mut dirs: Vec<PathBuf> = bin_dir.into_iter().collect();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
    }
    let candidates = [
        ("Pyright", "pyright-langserver", vec!["--stdio".to_string()]),
        ("basedpyright", "basedpyright-langserver", vec!["--stdio".to_string()]),
        ("python-lsp-server", "pylsp", vec![]),
    ];
    for (label, exe, args) in candidates {
        let found = dirs.iter().find_map(|d| find_in(d, exe)).or_else(|| find_in_path(exe));
        if let Some(program) = found {
            return Some(LspCommand { name: label.into(), program, args });
        }
    }
    None
}

pub async fn r_server(r: &Path) -> Option<LspCommand> {
    let rscript = r.with_file_name(format!("Rscript{EXE}"));
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(&rscript)
            .args(["-e", "cat(requireNamespace('languageserver', quietly=TRUE))"])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if String::from_utf8_lossy(&out.stdout).trim() != "TRUE" {
        return None;
    }
    Some(LspCommand {
        name: "R languageserver".into(),
        program: r.to_path_buf(),
        args: vec!["--slave".into(), "-e".into(), "languageserver::run()".into()],
    })
}

pub async fn detect(lang: Lang, interpreter: &Path) -> LspDetection {
    let command = match lang {
        Lang::R => r_server(interpreter).await,
        Lang::Python => python_server(interpreter),
    };
    let install_hint = command.is_none().then(|| match lang {
        Lang::R => format!(
            "\"{}\" -e \"install.packages('languageserver', repos='https://cloud.r-project.org')\"",
            interpreter.with_file_name(format!("Rscript{EXE}")).display()
        ),
        Lang::Python => format!("\"{}\" -m pip install basedpyright", interpreter.display()),
    });
    LspDetection { lang, command, install_hint }
}

// ---------------------------------------------------------------------------
// Framing

pub fn encode(payload: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", payload.len()).into_bytes();
    out.extend_from_slice(payload.as_bytes());
    out
}

/// Read one framed message. Returns Ok(None) on clean EOF.
pub async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<String>> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if len.is_some() {
                break;
            }
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = Some(v.trim().parse()?);
            }
        }
    }
    let mut buf = vec![0u8; len.ok_or_else(|| anyhow!("missing Content-Length"))?];
    reader.read_exact(&mut buf).await?;
    Ok(Some(String::from_utf8(buf)?))
}

// ---------------------------------------------------------------------------
// Running servers

struct Server {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

#[derive(Default)]
pub struct LspManager {
    servers: Mutex<HashMap<String, Arc<Server>>>,
}

impl LspManager {
    pub async fn start(&self, id: String, cmd: &LspCommand, cwd: Option<PathBuf>, sink: LspSink) -> Result<()> {
        self.stop(&id).await;
        let mut c = tokio::process::Command::new(&cmd.program);
        c.args(&cmd.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = cwd.filter(|d| d.is_dir()) {
            c.current_dir(dir);
        }
        if ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|v| std::env::var_os(v).is_none()) {
            c.env("LANG", "C.UTF-8");
        }
        #[cfg(windows)]
        {
            c.creation_flags(0x0800_0000);
        }
        let mut child = c.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take();

        {
            let sink = sink.clone();
            let id = id.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_message(&mut reader).await {
                        Ok(Some(payload)) => sink(LspEvent { id: id.clone(), kind: "message".into(), payload }),
                        Ok(None) => break,
                        Err(e) => {
                            sink(LspEvent { id: id.clone(), kind: "log".into(), payload: format!("framing error: {e}") });
                            break;
                        }
                    }
                }
                sink(LspEvent { id, kind: "exit".into(), payload: String::new() });
            });
        }
        if let Some(stderr) = stderr {
            let id = id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    sink(LspEvent { id: id.clone(), kind: "log".into(), payload: line });
                }
            });
        }
        let server = Arc::new(Server { stdin: Mutex::new(stdin), child: Mutex::new(child) });
        self.servers.lock().await.insert(id, server);
        Ok(())
    }

    pub async fn send(&self, id: &str, payload: &str) -> Result<()> {
        let server = self.servers.lock().await.get(id).cloned().ok_or_else(|| anyhow!("no language server {id}"))?;
        let mut stdin = server.stdin.lock().await;
        stdin.write_all(&encode(payload)).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn stop(&self, id: &str) {
        if let Some(s) = self.servers.lock().await.remove(id) {
            let _ = s.child.lock().await.kill().await;
        }
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.servers.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_roundtrip() {
        let mut data = encode(r#"{"jsonrpc":"2.0","id":1}"#);
        data.extend(encode("{\"text\":\"árvíztűrő\"}"));
        let mut r = BufReader::new(&data[..]);
        assert_eq!(read_message(&mut r).await.unwrap().unwrap(), r#"{"jsonrpc":"2.0","id":1}"#);
        assert_eq!(read_message(&mut r).await.unwrap().unwrap(), "{\"text\":\"árvíztűrő\"}");
        assert!(read_message(&mut r).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn accepts_extra_headers() {
        let data = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}".to_vec();
        let mut r = BufReader::new(&data[..]);
        assert_eq!(read_message(&mut r).await.unwrap().unwrap(), "{}");
    }

    #[test]
    fn content_length_counts_bytes() {
        let e = encode("ő");
        assert!(String::from_utf8(e).unwrap().starts_with("Content-Length: 2\r\n"));
    }
}
