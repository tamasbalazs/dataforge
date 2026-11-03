//! Talks to a real Python language server through the host bridge.
//! Skipped when no server is installed.

use dataforge_lib::envdetect;
use dataforge_lib::kernel::Lang;
use dataforge_lib::lsp::{self, LspEvent, LspManager, LspSink};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

async fn wait_for<F: Fn(&Value) -> bool>(events: &Arc<Mutex<Vec<Value>>>, pred: F) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(v) = events.lock().unwrap().iter().find(|v| pred(v)) {
            return v.clone();
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for LSP message");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn python_language_server_roundtrip() {
    let Some(py) = envdetect::detect_all().await.into_iter().find(|i| i.lang == Lang::Python) else {
        eprintln!("skipping: no Python");
        return;
    };
    let det = lsp::detect(Lang::Python, &py.path).await;
    let Some(cmd) = det.command else {
        eprintln!("skipping: no Python language server ({:?})", det.install_hint);
        return;
    };
    eprintln!("using {} at {}", cmd.name, cmd.program.display());

    let messages: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let m2 = messages.clone();
    let sink: LspSink = Arc::new(move |ev: LspEvent| {
        if ev.kind == "message" {
            m2.lock().unwrap().push(serde_json::from_str(&ev.payload).unwrap());
        }
    });
    let mgr = LspManager::default();
    let dir = std::env::temp_dir().join(format!("df-lsp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    mgr.start("py".into(), &cmd, Some(dir.clone()), sink).await.unwrap();

    let root = format!("file://{}", dir.display());
    let send = |v: Value| {
        let mgr = &mgr;
        async move { mgr.send("py", &v.to_string()).await.unwrap() }
    };
    send(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "processId": null, "rootUri": root, "capabilities": {
            "textDocument": {"publishDiagnostics": {}, "completion": {"completionItem": {"snippetSupport": false}}}
        }, "workspaceFolders": [{"uri": root, "name": "t"}]
    }}))
    .await;
    let init = wait_for(&messages, |v| v["id"] == 1).await;
    assert!(init["result"]["capabilities"]["completionProvider"].is_object(), "{init}");
    send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}})).await;

    let uri = format!("{root}/t.py");
    let text = "import math\nx = math.sq\nprint(undefined_name)\n";
    send(json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
        "textDocument": {"uri": uri, "languageId": "python", "version": 1, "text": text}
    }}))
    .await;

    // Answer configuration requests the way the UI client does.
    let diag = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let pending: Vec<Value> = messages
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["method"] == "workspace/configuration" && v["id"].is_number())
                .cloned()
                .collect();
            for req in pending {
                let n = req["params"]["items"].as_array().map(|a| a.len()).unwrap_or(0);
                send(json!({"jsonrpc": "2.0", "id": req["id"], "result": vec![Value::Null; n]})).await;
                messages.lock().unwrap().retain(|v| v != &req);
            }
            if let Some(d) = messages.lock().unwrap().iter().find(|v| {
                v["method"] == "textDocument/publishDiagnostics" && v["params"]["diagnostics"].as_array().is_some_and(|a| !a.is_empty())
            }) {
                break d.clone();
            }
            assert!(tokio::time::Instant::now() < deadline, "no diagnostics");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    let msgs: Vec<String> = diag["params"]["diagnostics"].as_array().unwrap().iter().map(|d| d["message"].as_str().unwrap().to_string()).collect();
    assert!(msgs.iter().any(|m| m.contains("undefined_name")), "{msgs:?}");

    send(json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/completion", "params": {
        "textDocument": {"uri": uri}, "position": {"line": 1, "character": 11}
    }}))
    .await;
    let comp = wait_for(&messages, |v| v["id"] == 2).await;
    let items = comp["result"]["items"].as_array().or(comp["result"].as_array()).cloned().unwrap_or_default();
    assert!(items.iter().any(|i| i["label"] == "sqrt"), "no sqrt in completion");

    mgr.stop_all().await;
    let _ = std::fs::remove_dir_all(dir);
}
