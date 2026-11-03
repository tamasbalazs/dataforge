//! Integrated terminal against a real shell.
#![cfg(unix)]

use base64::Engine;
use dataforge_lib::pty::{PtyEvent, PtyManager};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn wait_for(events: &Arc<Mutex<Vec<PtyEvent>>>, pred: impl Fn(&str, Option<i32>) -> bool) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (text, exit) = {
            let evs = events.lock().unwrap();
            let bytes: Vec<u8> = evs
                .iter()
                .flat_map(|e| base64::engine::general_purpose::STANDARD.decode(&e.data).unwrap())
                .collect();
            (String::from_utf8_lossy(&bytes).into_owned(), evs.iter().find_map(|e| e.exit))
        };
        if pred(&text, exit) {
            return text;
        }
        assert!(Instant::now() < deadline, "timeout; output so far: {text}");
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn runs_a_shell() {
    let pty = PtyManager::default();
    let events = Arc::new(Mutex::new(vec![]));
    let e2 = events.clone();
    let dir = std::env::temp_dir();
    let mut env = std::collections::HashMap::new();
    env.insert("DF_TEST_VAR".to_string(), "árvíztűrő".to_string());
    env.insert("DATAFORGE_PATH_PREPEND".to_string(), "/df/venv/bin:".to_string());
    pty.open("t".into(), Some("/bin/sh".into()), vec![], Some(dir.clone()), env, 80, 24, Arc::new(move |e| e2.lock().unwrap().push(e)))
        .expect("open");
    pty.write("t", "echo \"[$DF_TEST_VAR]\"; echo \"<$PATH>\"; pwd\n").unwrap();
    let out = wait_for(&events, |t, _| t.contains("[árvíztűrő]") && t.contains("</df/venv/bin:"));
    assert!(out.contains(dir.to_str().unwrap().trim_end_matches('/')), "{out}");
    pty.resize("t", 120, 40).unwrap();
    pty.write("t", "stty size\n").unwrap();
    wait_for(&events, |t, _| t.contains("40 120"));
    pty.write("t", "exit 3\n").unwrap();
    wait_for(&events, |_, exit| exit == Some(3));
    assert!(pty.write("t", "x").is_err(), "session is gone after exit");
}
