//! Python debugging through the Jupyter debug protocol (ipykernel + debugpy).
use dataforge_lib::envdetect;
use dataforge_lib::kernel::{EventSink, Kernel, KernelEvent, Lang};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Events = Arc<Mutex<Vec<KernelEvent>>>;

async fn wait_event(events: &Events, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(e) = events.lock().unwrap().iter().find(|e| e.msg_type == "debug_event" && pred(&e.content)) {
            return e.content.clone();
        }
        assert!(Instant::now() < deadline, "no matching debug event; got {:?}", events.lock().unwrap().iter().filter(|e| e.msg_type == "debug_event").map(|e| e.content["event"].clone()).collect::<Vec<_>>());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn breakpoint_step_and_inspect() {
    let found = envdetect::detect_all().await;
    let Some(py) = found.iter().find(|i| i.lang == Lang::Python && i.has_kernel) else { return };
    let events: Events = Arc::new(Mutex::new(vec![]));
    let e2 = events.clone();
    let sink: EventSink = Arc::new(move |e| e2.lock().unwrap().push(e));
    let k = Kernel::launch("py".into(), Lang::Python, py.path.clone(), None, None, vec![], sink).await.unwrap();

    let mut seq = 0;
    let mut req = |command: &str, arguments: Value| {
        seq += 1;
        json!({ "type": "request", "seq": seq, "command": command, "arguments": arguments })
    };
    let r = k.debug_request(req("initialize", json!({ "clientID": "dataforge", "adapterID": "python", "pathFormat": "path", "linesStartAt1": true, "columnsStartAt1": true, "supportsVariableType": true }))).await.unwrap();
    eprintln!("initialize: {}", r["success"]);
    let r = k.debug_request(req("attach", json!({}))).await.unwrap();
    eprintln!("attach: {r}");
    let r = k.debug_request(req("debugInfo", json!({}))).await.unwrap();
    eprintln!("debugInfo: {r}");

    let dir = std::env::temp_dir().join(format!("df-dbg-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("script.py");
    std::fs::write(&file, "def f(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total\n\nx = 10\ny = f(x)\nprint('done', y)\n").unwrap();
    let path = file.to_string_lossy().to_string();
    let r = k.debug_request(req("setBreakpoints", json!({ "source": { "path": path }, "breakpoints": [{ "line": 4 }], "sourceModified": false }))).await.unwrap();
    eprintln!("setBreakpoints: {r}");
    let r = k.debug_request(req("configurationDone", json!({}))).await.unwrap();
    eprintln!("configurationDone: {}", r["success"]);

    let code = format!("exec(compile(open({p:?}).read(), {p:?}, 'exec'))", p = path);
    k.execute(&code, None).await.unwrap();
    let stopped = wait_event(&events, |c| c["event"] == "stopped").await;
    eprintln!("stopped: {stopped}");
    let thread = stopped["body"]["threadId"].clone();
    let st = k.debug_request(req("stackTrace", json!({ "threadId": thread }))).await.unwrap();
    let frames = st["body"]["stackFrames"].as_array().unwrap().clone();
    eprintln!("frames: {:?}", frames.iter().map(|f| (f["name"].clone(), f["line"].clone(), f["source"]["path"].clone())).collect::<Vec<_>>());
    assert_eq!(frames[0]["line"], 4);
    let scopes = k.debug_request(req("scopes", json!({ "frameId": frames[0]["id"] }))).await.unwrap();
    let vref = scopes["body"]["scopes"][0]["variablesReference"].clone();
    let vars = k.debug_request(req("variables", json!({ "variablesReference": vref }))).await.unwrap();
    let names: Vec<_> = vars["body"]["variables"].as_array().unwrap().iter().map(|v| format!("{}={}", v["name"].as_str().unwrap(), v["value"].as_str().unwrap())).collect();
    eprintln!("locals: {names:?}");
    assert!(names.iter().any(|n| n == "n=10"));
    let ev = k.debug_request(req("evaluate", json!({ "expression": "total + 100", "frameId": frames[0]["id"], "context": "repl" }))).await.unwrap();
    eprintln!("evaluate: {}", ev["body"]["result"]);

    // Step over, then remove breakpoints and continue to the end.
    events.lock().unwrap().clear();
    k.debug_request(req("next", json!({ "threadId": thread }))).await.unwrap();
    let s2 = wait_event(&events, |c| c["event"] == "stopped").await;
    let st2 = k.debug_request(req("stackTrace", json!({ "threadId": s2["body"]["threadId"] }))).await.unwrap();
    eprintln!("after next: line {}", st2["body"]["stackFrames"][0]["line"]);
    k.debug_request(req("setBreakpoints", json!({ "source": { "path": path }, "breakpoints": [] }))).await.unwrap();
    k.debug_request(req("continue", json!({ "threadId": thread }))).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let out: String = events.lock().unwrap().iter().filter(|e| e.msg_type == "stream").map(|e| e.content["text"].as_str().unwrap_or("").to_string()).collect();
        if out.contains("done 45") { break; }
        assert!(Instant::now() < deadline, "script did not finish: {out}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    k.shutdown().await;
}
