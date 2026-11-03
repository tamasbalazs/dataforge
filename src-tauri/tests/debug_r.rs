//! R debugging through the DataForge helper + bridge debug hub.
use dataforge_lib::bridge;
use dataforge_lib::envdetect;
use dataforge_lib::kernel::{EventSink, Kernel, KernelEvent, KernelManager, Lang};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

async fn wait_for(events: &Arc<Mutex<Vec<Value>>>, name: &str, from: usize) -> (usize, Value) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some((i, e)) = events.lock().unwrap().iter().enumerate().skip(from).find(|(_, e)| e["event"] == name) {
            return (i, e.clone());
        }
        assert!(Instant::now() < deadline, "no {name} event; got {:?}", events.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn breakpoint_variables_step_continue() {
    let found = envdetect::detect_all().await;
    let Some(r) = found.iter().find(|i| i.lang == Lang::R && i.has_kernel) else { return };
    let kernels = Arc::new(KernelManager::default());
    let b = bridge::start(kernels.clone()).await.unwrap();
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let e2 = events.clone();
    b.debug.set_sink(Arc::new(move |v| e2.lock().unwrap().push(v)));
    let out: Arc<Mutex<Vec<KernelEvent>>> = Arc::new(Mutex::new(vec![]));
    let o2 = out.clone();
    let sink: EventSink = Arc::new(move |e| o2.lock().unwrap().push(e));
    let k = Kernel::launch("r".into(), Lang::R, r.path.clone(), None, r.kernel_lib.clone(), b.env(), sink).await.unwrap();
    kernels.insert(k.clone()).await;

    let dir = std::env::temp_dir().join(format!("df-rdbg-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("elemzés.R");
    std::fs::write(&file, "f <- function(n) {\n  total <- 0\n  for (i in seq_len(n)) {\n    total <- total + i\n  }\n  total\n}\nadat <- data.frame(a = 1:3, b = c('x', 'y', 'z'))\ny <- f(4)\ncat('kész', y, '\\n')\n").unwrap();
    let path = std::fs::canonicalize(&file).unwrap().to_string_lossy().to_string();
    k.call_helper("dbg_set_breakpoints", json!({ "path": path, "lines": [4] })).await.unwrap();
    k.execute(&format!("debugSource({path:?})"), None).await.unwrap();

    let (i, stopped) = wait_for(&events, "stopped", 0).await;
    eprintln!("stopped: {stopped}");
    let frames = stopped["frames"].as_array().unwrap();
    assert_eq!(frames[0]["line"], 4);
    assert_eq!(frames[0]["name"], "f");
    assert_eq!(frames[1]["name"], "<script>");
    let top = frames[0]["id"].clone();
    let vars = b.debug.request(json!({ "command": "variables", "frameId": top }), true).await.unwrap();
    eprintln!("locals: {vars}");
    let names: Vec<String> = vars.as_array().unwrap().iter().map(|v| format!("{}={}", v["name"].as_str().unwrap(), v["value"].as_str().unwrap())).collect();
    assert!(names.contains(&"n=4".to_string()) && names.contains(&"i=1".to_string()), "{names:?}");
    // Globals of the script frame, with an expandable data frame.
    let globals = b.debug.request(json!({ "command": "variables", "frameId": frames[1]["id"] }), true).await.unwrap();
    let adat = globals.as_array().unwrap().iter().find(|v| v["name"] == "adat").cloned().expect("adat");
    let cols = b.debug.request(json!({ "command": "variables", "ref": adat["variablesReference"] }), true).await.unwrap();
    assert_eq!(cols.as_array().unwrap().len(), 2, "{cols}");
    let ev = b.debug.request(json!({ "command": "evaluate", "expression": "total + 100", "frameId": top }), true).await.unwrap();
    assert!(ev["result"].as_str().unwrap().contains("100"), "{ev}");

    // Step over: next stop is the loop body again (i = 2).
    b.debug.request(json!({ "command": "next" }), false).await.unwrap();
    let (j, s2) = wait_for(&events, "stopped", i + 1).await;
    assert_eq!(s2["frames"][0]["line"], 4, "{s2}");
    let v2 = b.debug.request(json!({ "command": "evaluate", "expression": "i", "frameId": s2["frames"][0]["id"] }), true).await.unwrap();
    assert!(v2["result"].as_str().unwrap().contains("2"), "{v2}");

    // Step out to the script, then clear the breakpoint and continue.
    b.debug.request(json!({ "command": "setBreakpoints", "path": path, "lines": [] }), true).await.unwrap();
    b.debug.request(json!({ "command": "stepOut" }), false).await.unwrap();
    let (_, s3) = wait_for(&events, "stopped", j + 1).await;
    eprintln!("after stepOut: {s3}");
    assert_eq!(s3["frames"][0]["name"], "<script>");
    b.debug.request(json!({ "command": "continue" }), false).await.unwrap();
    wait_for(&events, "terminated", 0).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let text: String = out.lock().unwrap().iter().filter(|e| e.msg_type == "stream").map(|e| e.content["text"].as_str().unwrap_or("").to_string()).collect();
        if text.contains("kész 10") { break; }
        assert!(Instant::now() < deadline, "script output missing: {text}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Stop while paused: unwinds the script, the session survives.
    k.call_helper("dbg_set_breakpoints", json!({ "path": path, "lines": [9] })).await.unwrap();
    let before = events.lock().unwrap().len();
    k.execute(&format!("debugSource({path:?})"), None).await.unwrap();
    wait_for(&events, "stopped", before).await;
    b.debug.request(json!({ "command": "terminate" }), false).await.unwrap();
    wait_for(&events, "terminated", before).await;
    let alive = k.call_helper("info", json!({})).await;
    assert!(alive.is_ok(), "kernel died after stop: {alive:?}");
    k.shutdown().await;
}
