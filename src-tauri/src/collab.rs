//! Real-time collaboration transport: a small WebSocket relay run by the
//! person who shares a session, plus a WebSocket client for the UI.
//!
//! Star topology: guests only ever talk to the host. Every guest frame is
//! delivered to the host wrapped as `{"from": "<peer>", "data": "<frame>"}`;
//! the host addresses frames with `{"to": "<peer>" | "*", "except"?: "<peer>",
//! "data": "<frame>"}`. The host's UI is therefore the single authority that
//! checks permissions and merges edits (CRDT), and the relay never interprets
//! the payloads. The relay also tells the host about `join`/`leave` events and
//! can `kick` a guest.
//!
//! Two random 128-bit tokens: one for the host's own connection (never leaves
//! this machine) and one for guests (part of the invitation).

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

/// Largest frame accepted (a big document's initial state fits comfortably).
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
pub const MAX_GUESTS: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub port: u16,
    pub host_token: String,
    pub guest_token: String,
    /// Addresses guests can use (127.0.0.1, plus the LAN address when shared on the network).
    pub addresses: Vec<String>,
    pub lan: bool,
}

type Tx = mpsc::UnboundedSender<Message>;

#[derive(Default)]
struct Hub {
    host: Mutex<Option<Tx>>,
    guests: Mutex<HashMap<String, Tx>>,
    next: AtomicU64,
}

impl Hub {
    fn to_host(&self, v: Value) {
        if let Some(h) = self.host.lock().unwrap().as_ref() {
            let _ = h.send(Message::Text(v.to_string()));
        }
    }

    fn close_guest(&self, id: &str, reason: &str) {
        if let Some(tx) = self.guests.lock().unwrap().remove(id) {
            let _ = tx.send(close_msg(reason));
        }
    }
}

fn close_msg(reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: reason.to_string().into() }))
}

fn token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Constant-time comparison (tokens are secrets).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
}

/// The machine's LAN address (no packet is sent: UDP "connect" only picks a route).
fn lan_address() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

pub struct CollabServer {
    pub info: ServerInfo,
    hub: Arc<Hub>,
    task: tokio::task::JoinHandle<()>,
}

impl CollabServer {
    /// Listen on 127.0.0.1 (default; reach it through an SSH tunnel) or on all
    /// interfaces (`lan`), on a random free port unless `port` is given.
    pub async fn start(lan: bool, port: Option<u16>) -> Result<Self> {
        let ip = if lan { "0.0.0.0" } else { "127.0.0.1" };
        let listener = TcpListener::bind((ip, port.unwrap_or(0))).await.with_context(|| format!("cannot listen on {ip}"))?;
        let port = listener.local_addr()?.port();
        let mut addresses = vec![format!("127.0.0.1:{port}")];
        if lan {
            if let Some(a) = lan_address() {
                addresses.insert(0, format!("{a}:{port}"));
            }
        }
        let info = ServerInfo { port, host_token: token(), guest_token: token(), addresses, lan };
        let hub = Arc::new(Hub::default());
        let task = {
            let hub = hub.clone();
            let (ht, gt) = (info.host_token.clone(), info.guest_token.clone());
            tokio::spawn(async move {
                while let Ok((stream, addr)) = listener.accept().await {
                    let (hub, ht, gt) = (hub.clone(), ht.clone(), gt.clone());
                    tokio::spawn(async move {
                        let _ = handle(stream, addr, hub, ht, gt).await;
                    });
                }
            })
        };
        Ok(Self { info, hub, task })
    }

    pub fn guest_count(&self) -> usize {
        self.hub.guests.lock().unwrap().len()
    }

    /// Close every connection and stop listening.
    pub fn stop(&self) {
        self.task.abort();
        for (_, tx) in self.hub.guests.lock().unwrap().drain() {
            let _ = tx.send(close_msg("session-ended"));
        }
        if let Some(h) = self.hub.host.lock().unwrap().take() {
            let _ = h.send(close_msg("session-ended"));
        }
    }
}

impl Drop for CollabServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Host,
    Guest,
}

async fn handle(stream: TcpStream, _addr: SocketAddr, hub: Arc<Hub>, host_token: String, guest_token: String) -> Result<()> {
    let role: Arc<Mutex<Option<Role>>> = Arc::default();
    let cb = {
        let role = role.clone();
        let hub = hub.clone();
        move |req: &Request, resp: Response| -> std::result::Result<Response, ErrorResponse> {
            let reject = |code: StatusCode, msg: &str| {
                let mut r = ErrorResponse::new(Some(msg.to_string()));
                *r.status_mut() = code;
                r
            };
            let given = req.uri().query().and_then(|q| query_param(q, "token")).unwrap_or("");
            let r = if same(given, &host_token) {
                if hub.host.lock().unwrap().is_some() {
                    return Err(reject(StatusCode::CONFLICT, "the host is already connected"));
                }
                Role::Host
            } else if same(given, &guest_token) {
                if hub.guests.lock().unwrap().len() >= MAX_GUESTS {
                    return Err(reject(StatusCode::SERVICE_UNAVAILABLE, "the session is full"));
                }
                Role::Guest
            } else {
                return Err(reject(StatusCode::UNAUTHORIZED, "invalid invitation"));
            };
            *role.lock().unwrap() = Some(r);
            Ok(resp)
        }
    };
    let config = WebSocketConfig { max_message_size: Some(MAX_FRAME), max_frame_size: Some(MAX_FRAME), ..Default::default() };
    let ws = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::accept_hdr_async_with_config(stream, cb, Some(config)))
        .await
        .map_err(|_| anyhow!("handshake timed out"))??;
    let role = role.lock().unwrap().ok_or_else(|| anyhow!("no role"))?;
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let closing = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || closing {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let id = match role {
        Role::Host => {
            *hub.host.lock().unwrap() = Some(tx.clone());
            "host".to_string()
        }
        Role::Guest => {
            let id = format!("p{}", hub.next.fetch_add(1, Ordering::Relaxed) + 1);
            hub.guests.lock().unwrap().insert(id.clone(), tx.clone());
            hub.to_host(json!({ "event": "join", "peer": id }));
            id
        }
    };
    // The peer learns its id first.
    let _ = tx.send(Message::Text(json!({ "event": "welcome", "peer": id }).to_string()));

    while let Some(msg) = source.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue, // binary/ping/pong: ignored (pongs are automatic)
        };
        match role {
            Role::Guest => hub.to_host(json!({ "from": id, "data": text })),
            Role::Host => route_from_host(&hub, &text),
        }
    }

    match role {
        Role::Guest => {
            if hub.guests.lock().unwrap().remove(&id).is_some() {
                hub.to_host(json!({ "event": "leave", "peer": id }));
            }
        }
        Role::Host => {
            *hub.host.lock().unwrap() = None;
            for (_, g) in hub.guests.lock().unwrap().drain() {
                let _ = g.send(close_msg("host-left"));
            }
        }
    }
    let _ = tx.send(close_msg("bye"));
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    Ok(())
}

fn route_from_host(hub: &Hub, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    if let Some(peer) = v["kick"].as_str() {
        hub.close_guest(peer, "removed-by-host");
        hub.to_host(json!({ "event": "leave", "peer": peer }));
        return;
    }
    let Some(data) = v["data"].as_str() else { return };
    let msg = Message::Text(data.to_string());
    let guests = hub.guests.lock().unwrap();
    match v["to"].as_str() {
        Some("*") => {
            let except = v["except"].as_str();
            for (id, g) in guests.iter() {
                if Some(id.as_str()) != except {
                    let _ = g.send(msg.clone());
                }
            }
        }
        Some(id) => {
            if let Some(g) = guests.get(id) {
                let _ = g.send(msg);
            }
        }
        None => {}
    }
}

// ---------------------------------------------------------------------------
// Client

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabEvent {
    pub conn: String,
    /// "message" or "closed"
    pub kind: String,
    pub data: String,
}

pub type CollabSink = Arc<dyn Fn(CollabEvent) + Send + Sync>;

#[derive(Default)]
pub struct CollabClients {
    conns: Mutex<HashMap<String, Tx>>,
}

/// `ws://host:port/?token=…` from "host:port" and a token; refuses anything else.
pub fn ws_url(address: &str, token: &str) -> Result<String> {
    let address = address.trim();
    if address.is_empty() || address.contains(['/', '?', '#', '@', ' ']) {
        bail!("invalid address: {address}");
    }
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("invalid invitation token");
    }
    Ok(format!("ws://{address}/?token={token}"))
}

impl CollabClients {
    pub async fn connect(&self, id: String, address: &str, token: &str, sink: CollabSink) -> Result<()> {
        self.close(&id);
        let url = ws_url(address, token)?;
        let config = WebSocketConfig { max_message_size: Some(MAX_FRAME), max_frame_size: Some(MAX_FRAME), ..Default::default() };
        let (ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async_with_config(url, Some(config), false))
            .await
            .map_err(|_| anyhow!("{address}: connection timed out"))?
            .map_err(|e| match e {
                tokio_tungstenite::tungstenite::Error::Http(r) => {
                    let body = r.body().as_ref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
                    anyhow!("{} ({})", if body.is_empty() { "refused".to_string() } else { body }, r.status())
                }
                other => anyhow!("{address}: {other}"),
            })?;
        let (mut sink_ws, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        self.conns.lock().unwrap().insert(id.clone(), tx);
        tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let closing = matches!(m, Message::Close(_));
                if sink_ws.send(m).await.is_err() || closing {
                    break;
                }
            }
            let _ = sink_ws.close().await;
        });
        tokio::spawn(async move {
            let mut reason = String::new();
            while let Some(msg) = source.next().await {
                match msg {
                    Ok(Message::Text(t)) => sink(CollabEvent { conn: id.clone(), kind: "message".into(), data: t }),
                    Ok(Message::Close(f)) => {
                        reason = f.map(|f| f.reason.to_string()).unwrap_or_default();
                        break;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        reason = e.to_string();
                        break;
                    }
                }
            }
            sink(CollabEvent { conn: id, kind: "closed".into(), data: reason });
        });
        Ok(())
    }

    pub fn send(&self, id: &str, text: String) -> Result<()> {
        let conns = self.conns.lock().unwrap();
        let tx = conns.get(id).ok_or_else(|| anyhow!("not connected"))?;
        tx.send(Message::Text(text)).map_err(|_| anyhow!("connection closed"))
    }

    pub fn close(&self, id: &str) {
        if let Some(tx) = self.conns.lock().unwrap().remove(id) {
            let _ = tx.send(close_msg("bye"));
        }
    }

    pub fn close_all(&self) {
        for (_, tx) in self.conns.lock().unwrap().drain() {
            let _ = tx.send(close_msg("bye"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_tokens() {
        assert_eq!(ws_url("10.0.0.5:4000", "abc123").unwrap(), "ws://10.0.0.5:4000/?token=abc123");
        assert!(ws_url("evil.com/x", "abc").is_err());
        assert!(ws_url("h:1", "a&b=c").is_err());
        assert!(ws_url("user@h:1", "abc").is_err());
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
        assert_eq!(query_param("a=1&token=xyz", "token"), Some("xyz"));
        assert_eq!(token().len(), 64);
    }
}
