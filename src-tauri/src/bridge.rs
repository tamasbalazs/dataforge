//! R ↔ Python bridge.
//!
//! A tiny HTTP server on 127.0.0.1 that lets one kernel read or write a
//! variable of the other kernel while it is running code (`py$x` in R,
//! `r.x` in Python). Values travel as "dfc" folders (a manifest plus raw
//! little-endian column files) under a private exchange directory; the HTTP
//! request only carries names and paths.
//!
//! Endpoints (all GET, all require `token`):
//!   /pull?lang=python&name=x          → the target exports `x`, returns {path}
//!   /push?lang=python&name=x&path=P   → the target imports the folder P as `x`
//!   /names?lang=python                → the target's variable names

use crate::kernel::{KernelManager, Lang};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How long a bridge call waits for a busy kernel before giving up.
const CALL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct Bridge {
    pub url: String,
    pub token: String,
    pub dir: PathBuf,
    /// R debugger channel (see DebugHub).
    pub debug: Arc<DebugHub>,
}

pub type DebugSink = Arc<dyn Fn(Value) + Send + Sync>;

/// The R debugger's link to the UI. R has no DAP server, so the DataForge
/// helper pauses inside the kernel and long-polls here for commands
/// (continue, next, variables, evaluate …); events and replies come back as
/// JSON files in the exchange directory.
#[derive(Default)]
pub struct DebugHub {
    commands: std::sync::Mutex<std::collections::VecDeque<Value>>,
    notify: tokio::sync::Notify,
    replies: std::sync::Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
    seq: std::sync::atomic::AtomicU64,
    sink: std::sync::OnceLock<DebugSink>,
}

impl DebugHub {
    pub fn set_sink(&self, sink: DebugSink) {
        let _ = self.sink.set(sink);
    }

    /// Queue a command for the paused R session. Inspection commands
    /// (variables, evaluate) wait for R's answer; motion commands return at once.
    pub async fn request(&self, mut command: Value, wait: bool) -> Result<Value> {
        let id = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        command["id"] = json!(id);
        let rx = if wait {
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.replies.lock().unwrap().insert(id, tx);
            Some(rx)
        } else {
            None
        };
        self.commands.lock().unwrap().push_back(command);
        self.notify.notify_one();
        let Some(rx) = rx else { return Ok(json!({ "queued": true })) };
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.replies.lock().unwrap().remove(&id);
                Err(anyhow!("the R session did not answer (is it paused?)"))
            }
        }
    }

    async fn next_command(&self, timeout: Duration) -> Value {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(c) = self.commands.lock().unwrap().pop_front() {
                return c;
            }
            let notified = self.notify.notified();
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return json!({ "command": "none" });
            }
        }
    }

    fn event(&self, payload: Value) {
        if payload["event"] == "stopped" {
            // Motion commands sent while R was running must not leak into this stop.
            self.commands.lock().unwrap().clear();
        }
        if let Some(sink) = self.sink.get() {
            sink(payload);
        }
    }

    fn reply(&self, id: u64, payload: Value) {
        if let Some(tx) = self.replies.lock().unwrap().remove(&id) {
            let _ = tx.send(payload);
        }
    }
}

impl Bridge {
    /// Environment variables handed to every kernel.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("DATAFORGE_BRIDGE_URL".into(), self.url.clone()),
            ("DATAFORGE_BRIDGE_TOKEN".into(), self.token.clone()),
            ("DATAFORGE_BRIDGE_DIR".into(), self.dir.to_string_lossy().into_owned()),
        ];
        // R's url() goes through libcurl, which honours proxy variables:
        // make sure loopback requests never leave the machine.
        for var in ["no_proxy", "NO_PROXY"] {
            let old = std::env::var(var).unwrap_or_default();
            let val = if old.is_empty() { "127.0.0.1,localhost".to_string() } else { format!("{old},127.0.0.1,localhost") };
            env.push((var.into(), val));
        }
        env
    }
}

/// Bind the server and serve it on the current tokio runtime.
pub async fn start(kernels: Arc<KernelManager>) -> Result<Bridge> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let dir = std::env::temp_dir().join(format!("dataforge-bridge-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let bridge = Bridge {
        url: format!("http://127.0.0.1:{port}"),
        token: uuid::Uuid::new_v4().simple().to_string(),
        dir,
        debug: Arc::new(DebugHub::default()),
    };
    let shared = bridge.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let kernels = kernels.clone();
            let bridge = shared.clone();
            tokio::spawn(async move {
                let (status, body) = match read_request(&mut sock).await {
                    Ok((path, query)) => match handle(&kernels, &bridge, &path, &query).await {
                        Ok(v) => (200, json!({ "ok": true, "value": v })),
                        Err(e) => (if e.to_string() == "forbidden" { 403 } else { 200 }, json!({ "ok": false, "error": e.to_string() })),
                    },
                    Err(e) => (400, json!({ "ok": false, "error": e.to_string() })),
                };
                let body = body.to_string();
                let reply = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    Ok(bridge)
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Result<(String, HashMap<String, String>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = tokio::time::timeout(Duration::from_secs(10), sock.read(&mut chunk)).await??;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 64 * 1024 {
            return Err(anyhow!("request too large"));
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let target = head.lines().next().and_then(|l| l.split(' ').nth(1)).ok_or_else(|| anyhow!("bad request"))?;
    Ok(parse_target(target))
}

pub fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let params = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect();
    (path.to_string(), params)
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(v) => {
                        out.push(v);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A valid variable name in both languages (keeps paths and code injection out).
fn check_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() < 256
        && name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '.')
        && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.');
    if ok { Ok(()) } else { Err(anyhow!("invalid variable name: {name}")) }
}

async fn handle(kernels: &KernelManager, bridge: &Bridge, path: &str, q: &HashMap<String, String>) -> Result<Value> {
    if q.get("token") != Some(&bridge.token) {
        return Err(anyhow!("forbidden"));
    }
    if let Some(sub) = path.strip_prefix("/debug/") {
        return handle_debug(bridge, sub, q).await;
    }
    let lang = match q.get("lang").map(String::as_str) {
        Some("r") => Lang::R,
        Some("python") => Lang::Python,
        _ => return Err(anyhow!("missing or unknown lang")),
    };
    let label = if lang == Lang::R { "R" } else { "Python" };
    let kernel = kernels
        .by_lang(lang)
        .await
        .ok_or_else(|| anyhow!("the {label} kernel is not running"))?;
    let name = q.get("name").cloned().unwrap_or_default();
    let (func, args) = match path {
        "/pull" => {
            check_name(&name)?;
            let out = bridge.dir.join(format!("x{}", uuid::Uuid::new_v4().simple()));
            ("bridge_export", json!({ "name": name, "path": out }))
        }
        "/push" => {
            check_name(&name)?;
            let src = PathBuf::from(q.get("path").ok_or_else(|| anyhow!("missing path"))?);
            // Only folders inside the exchange directory may be imported.
            if !src.starts_with(&bridge.dir) || src.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err(anyhow!("forbidden path"));
            }
            ("bridge_import", json!({ "name": name, "path": src }))
        }
        "/names" => ("bridge_names", json!({})),
        _ => return Err(anyhow!("unknown endpoint {path}")),
    };
    match tokio::time::timeout(CALL_TIMEOUT, kernel.call_helper(func, args)).await {
        Ok(r) => r,
        Err(_) => Err(anyhow!("the {label} kernel is busy (timed out after {}s)", CALL_TIMEOUT.as_secs())),
    }
}

/// Read (and remove) a JSON payload file written by R into the exchange directory.
fn take_payload(bridge: &Bridge, q: &HashMap<String, String>) -> Result<Value> {
    let Some(file) = q.get("file") else { return Ok(Value::Null) };
    let path = PathBuf::from(file);
    if !path.starts_with(&bridge.dir) || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(anyhow!("forbidden path"));
    }
    let raw = std::fs::read(&path)?;
    let _ = std::fs::remove_file(&path);
    Ok(serde_json::from_slice(&raw)?)
}

async fn handle_debug(bridge: &Bridge, sub: &str, q: &HashMap<String, String>) -> Result<Value> {
    let hub = &bridge.debug;
    match sub {
        "event" => {
            hub.event(take_payload(bridge, q)?);
            Ok(json!(true))
        }
        "wait" => Ok(hub.next_command(Duration::from_secs(20)).await),
        "reply" => {
            let id: u64 = q.get("id").and_then(|v| v.parse().ok()).ok_or_else(|| anyhow!("missing id"))?;
            hub.reply(id, take_payload(bridge, q)?);
            Ok(json!(true))
        }
        _ => Err(anyhow!("unknown debug endpoint {sub}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_queries() {
        let (p, q) = parse_target("/pull?lang=python&name=my_df&path=%2Ftmp%2Fa%20b&x=%E2%82%AC+1");
        assert_eq!(p, "/pull");
        assert_eq!(q["name"], "my_df");
        assert_eq!(q["path"], "/tmp/a b");
        assert_eq!(q["x"], "€ 1");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn validates_names() {
        assert!(check_name("df").is_ok());
        assert!(check_name("my.data_2").is_ok());
        assert!(check_name("árvíztűrő").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name("a;b").is_err());
        assert!(check_name("../x").is_err());
        assert!(check_name("1x").is_err());
    }
}
