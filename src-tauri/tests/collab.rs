//! Collaboration relay: authentication, star routing, kick and session end.

use dataforge_lib::collab::{CollabClients, CollabEvent, CollabServer};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Log = Arc<Mutex<Vec<CollabEvent>>>;

async fn client(clients: &CollabClients, id: &str, addr: &str, token: &str) -> anyhow::Result<Log> {
    let log: Log = Arc::default();
    let l2 = log.clone();
    clients.connect(id.into(), addr, token, Arc::new(move |e| l2.lock().unwrap().push(e))).await?;
    Ok(log)
}

async fn wait_for(log: &Log, what: &str, pred: impl Fn(&CollabEvent) -> bool) -> CollabEvent {
    for _ in 0..200 {
        if let Some(e) = log.lock().unwrap().iter().find(|e| pred(e)).cloned() {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}: {:?}", log.lock().unwrap());
}

fn json_of(e: &CollabEvent) -> Value {
    serde_json::from_str(&e.data).unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn relay_routes_through_the_host() {
    let server = CollabServer::start(false, None).await.unwrap();
    let addr = server.info.addresses[0].clone();
    assert!(addr.starts_with("127.0.0.1:"), "{addr}");
    let (ht, gt) = (server.info.host_token.clone(), server.info.guest_token.clone());
    let c = CollabClients::default();

    // Wrong or missing tokens are refused; a second host is refused.
    let err = client(&c, "x", &addr, "nottherightoken").await.unwrap_err().to_string();
    assert!(err.contains("invalid invitation"), "{err}");
    let host = client(&c, "host", &addr, &ht).await.unwrap();
    wait_for(&host, "host welcome", |e| json_of(e)["event"] == "welcome" && json_of(e)["peer"] == "host").await;
    assert!(client(&c, "host2", &addr, &ht).await.unwrap_err().to_string().contains("already connected"));

    let g1 = client(&c, "g1", &addr, &gt).await.unwrap();
    let g2 = client(&c, "g2", &addr, &gt).await.unwrap();
    let id1 = json_of(&wait_for(&g1, "g1 welcome", |e| json_of(e)["event"] == "welcome").await)["peer"].as_str().unwrap().to_string();
    let id2 = json_of(&wait_for(&g2, "g2 welcome", |e| json_of(e)["event"] == "welcome").await)["peer"].as_str().unwrap().to_string();
    assert_ne!(id1, id2);
    wait_for(&host, "join events", |e| json_of(e)["event"] == "join" && json_of(e)["peer"] == id2.as_str()).await;
    assert_eq!(server.guest_count(), 2);

    // Guest → host only (never directly to the other guest), tagged with the sender.
    c.send("g1", "szia, ez g1 – árvíztűrő".into()).unwrap();
    let e = wait_for(&host, "guest frame", |e| json_of(e)["from"] == id1.as_str()).await;
    assert_eq!(json_of(&e)["data"], "szia, ez g1 – árvíztűrő");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!g2.lock().unwrap().iter().any(|e| e.data.contains("ez g1")), "guests must not reach each other directly");

    // Host → one guest, and → everyone except one.
    c.send("host", json!({ "to": id2, "data": "csak neked" }).to_string()).unwrap();
    wait_for(&g2, "direct frame", |e| e.data == "csak neked").await;
    c.send("host", json!({ "to": "*", "except": id1, "data": "mindenkinek" }).to_string()).unwrap();
    wait_for(&g2, "broadcast", |e| e.data == "mindenkinek").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!g1.lock().unwrap().iter().any(|e| e.data == "mindenkinek" || e.data == "csak neked"));

    // Kick: the guest is disconnected and the host is told.
    c.send("host", json!({ "kick": id1 }).to_string()).unwrap();
    let closed = wait_for(&g1, "kick close", |e| e.kind == "closed").await;
    assert_eq!(closed.data, "removed-by-host");
    wait_for(&host, "leave event", |e| json_of(e)["event"] == "leave" && json_of(e)["peer"] == id1.as_str()).await;

    // A guest leaving is reported to the host.
    let g3 = client(&c, "g3", &addr, &gt).await.unwrap();
    let id3 = json_of(&wait_for(&g3, "g3 welcome", |e| json_of(e)["event"] == "welcome").await)["peer"].as_str().unwrap().to_string();
    c.close("g3");
    wait_for(&host, "g3 leave", |e| json_of(e)["event"] == "leave" && json_of(e)["peer"] == id3.as_str()).await;

    // The host leaving ends the session for everyone.
    c.close("host");
    let closed = wait_for(&g2, "host-left close", |e| e.kind == "closed").await;
    assert_eq!(closed.data, "host-left");
    assert_eq!(server.guest_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_ends_the_session() {
    let server = CollabServer::start(false, None).await.unwrap();
    let addr = server.info.addresses[0].clone();
    let c = CollabClients::default();
    let host = client(&c, "h", &addr, &server.info.host_token).await.unwrap();
    let g = client(&c, "g", &addr, &server.info.guest_token).await.unwrap();
    wait_for(&host, "join", |e| json_of(e)["event"] == "join").await;
    // Large frames (a big document's state) pass.
    let big = "x".repeat(3 * 1024 * 1024);
    c.send("g", big.clone()).unwrap();
    wait_for(&host, "big frame", |e| json_of(e)["data"].as_str().map(str::len) == Some(big.len())).await;
    server.stop();
    assert_eq!(wait_for(&g, "closed", |e| e.kind == "closed").await.data, "session-ended");
    // The port is no longer accepting.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(client(&c, "late", &addr, &server.info.guest_token).await.is_err());
}
