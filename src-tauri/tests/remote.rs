//! Remote development against a real SSH server. Skipped unless
//! `DF_SSH_TEST=user@host[:port][,identity_file]` points at a host that
//! accepts key authentication non-interactively, e.g.
//!   DF_SSH_TEST=dfremote@127.0.0.1:2222,/tmp/id_df cargo test --test remote

use dataforge_lib::kernel::{EventSink, Kernel, KernelEvent, Lang};
use dataforge_lib::remote::{Profile, RemoteManager};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn profile() -> Option<Profile> {
    let spec = std::env::var("DF_SSH_TEST").ok().filter(|s| !s.is_empty())?;
    let (target, identity) = match spec.split_once(',') {
        Some((t, i)) => (t.to_string(), Some(i.to_string())),
        None => (spec, None),
    };
    let (user, hostport) = match target.split_once('@') {
        Some((u, h)) => (Some(u.to_string()), h.to_string()),
        None => (None, target),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()),
        None => (hostport, None),
    };
    Some(Profile { id: "test".into(), name: "test".into(), host, user, port, identity_file: identity })
}

type Events = Arc<Mutex<Vec<KernelEvent>>>;

async fn run(k: &Kernel, events: &Events, code: &str) -> String {
    let id = k.execute(code, None).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        {
            let evs = events.lock().unwrap();
            if evs.iter().any(|e| e.parent_id.as_deref() == Some(&id) && e.msg_type == "status" && e.content["execution_state"] == "idle") {
                return evs
                    .iter()
                    .filter(|e| e.parent_id.as_deref() == Some(&id))
                    .map(|e| match e.msg_type.as_str() {
                        "stream" => e.content["text"].as_str().unwrap_or("").to_string(),
                        "execute_result" => e.content["data"]["text/plain"].as_str().unwrap_or("").to_string(),
                        "error" => format!("ERROR {}", e.content["evalue"]),
                        _ => String::new(),
                    })
                    .collect();
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "timeout running {code}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_files_git_and_kernels() {
    let Some(p) = profile() else {
        eprintln!("skipping: DF_SSH_TEST not set");
        return;
    };
    let m = Arc::new(RemoteManager::new());
    let info = m.connect(p.clone()).await.expect("connect");
    // Connection files of kernels started by others (e.g. a running DataForge) don't count.
    let run_files = || async {
        m.run(&p, "ls \"$HOME/.dataforge/run\" 2>/dev/null | grep -c kernel- || true", &[], None, Duration::from_secs(20)).await.unwrap().text().trim().to_string()
    };
    let files_before = run_files().await;
    assert!(info.home.starts_with('/'), "{info:?}");
    assert!(!info.interpreters.is_empty(), "no remote interpreters: {info:?}");

    // Files: create, write (non-ASCII), list, read, rename, trash.
    let root = format!("{}/df-remote-test-{}", info.home, uuid::Uuid::new_v4().simple());
    let parent = m.create("test", &info.home, root.rsplit('/').next().unwrap(), true).await.expect("mkdir");
    assert_eq!(parent, format!("ssh://test{root}"));
    let file = format!("{root}/elemzés.R");
    m.write("test", &file, "x <- \"árvíztűrő\"\n".as_bytes().to_vec()).await.expect("write");
    let entries = m.list_dir("test", &root, false).await.expect("list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "elemzés.R");
    assert_eq!(String::from_utf8(m.read("test", &file).await.unwrap()).unwrap(), "x <- \"árvíztűrő\"\n");
    assert!(m.create("test", &root, "elemzés.R", false).await.is_err(), "create must not overwrite");
    assert!(m.create("test", &root, "../x", false).await.is_err());
    let renamed = m.rename("test", &file, "a b.R").await.expect("rename");
    assert_eq!(renamed, format!("ssh://test{root}/a b.R"));
    assert!(m.read("test", &format!("{root}/nope.R")).await.is_err());

    // Project inspection + git.
    let git = |args: &[&str]| {
        let m = m.clone();
        let root = root.clone();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        async move { m.git("test", &root, &args, None).await }
    };
    if git(&["init", "-q"]).await.map(|o| o.code == 0).unwrap_or(false) {
        let st = git(&["status", "--porcelain=v2", "-z"]).await.unwrap();
        assert!(st.stdout.contains("? a b.R"), "{}", st.stdout);
        assert!(git(&["daemon"]).await.is_err(), "allowlist applies remotely");
        let info = m.inspect("test", &root).await.unwrap();
        assert!(info.git);
        assert_eq!(info.root.to_str().unwrap(), format!("ssh://test{root}"));
    }

    // Reproducibility inventory + checksums on the host.
    m.create("test", &root, ".venv", true).await.unwrap();
    m.write("test", &format!("{root}/.venv/x.py"), b"skip me".to_vec()).await.unwrap();
    let files = m.repro_files("test", &root, 1000).await.expect("repro files");
    let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(names, ["a b.R"], "environments are excluded");
    let sums = m.sha256("test", &root, &["a b.R".into(), "missing.R".into(), "../etc/passwd".into()]).await.unwrap();
    assert_eq!(sums["a b.R"].as_deref().map(str::len), Some(64));
    assert_eq!(sums["missing.R"], None);
    assert_eq!(sums["../etc/passwd"], None);
    let local = std::env::temp_dir().join(format!("df-dl-{}", uuid::Uuid::new_v4().simple()));
    m.download("test", &format!("{root}/a b.R"), &local).await.expect("download");
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "x <- \"árvíztűrő\"\n");
    let _ = std::fs::remove_file(&local);
    assert!(m.download("test", &format!("{root}/nope"), &local).await.is_err());
    let _ = std::fs::remove_file(&local);

    // Kernels: execute, helper calls (stdout transport), interrupt, shutdown.
    for lang in [Lang::Python, Lang::R] {
        let Some(interp) = info.interpreters.iter().find(|i| i.lang == lang && i.has_kernel) else {
            eprintln!("skipping {lang:?}: no remote kernel");
            continue;
        };
        let events: Events = Arc::new(Mutex::new(vec![]));
        let e2 = events.clone();
        let sink: EventSink = Arc::new(move |ev| e2.lock().unwrap().push(ev));
        let k = Kernel::launch_remote("t".into(), lang, interp.path.clone(), m.clone(), "test".into(), root.clone(), interp.kernel_lib.clone(), sink)
            .await
            .unwrap_or_else(|e| {
                let log: Vec<String> = events.lock().unwrap().iter().map(|e| e.content["text"].to_string()).collect();
                panic!("{lang:?} launch: {e:#}\n{}", log.join("\n"))
            });
        assert!(k.is_remote());
        let (assign, expr) = match lang {
            Lang::Python => ("import os\nszám = 41", "print(szám + 1, os.getcwd())"),
            Lang::R => ("szám <- 41", "cat(szám + 1, getwd())"),
        };
        run(&k, &events, assign).await;
        let out = run(&k, &events, expr).await;
        assert!(out.contains("42") && out.contains(&root), "{lang:?}: {out}");

        let info: serde_json::Value = k.call_helper("info", json!({})).await.expect("info");
        assert_eq!(info["cwd"].as_str(), Some(root.as_str()), "{info}");
        let vars = k.call_helper("env_list", json!({})).await.expect("env_list");
        assert!(vars.to_string().contains("szám"), "{lang:?}: {vars}");
        // Helper output must not leak into the UI stream.
        assert!(!events.lock().unwrap().iter().any(|e| e.content.to_string().contains("DFJSON")));

        // Interrupt a long computation.
        let sleep = match lang {
            Lang::Python => "import time\ntime.sleep(30)",
            Lang::R => "Sys.sleep(30)",
        };
        let id = k.execute(sleep, None).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let t0 = std::time::Instant::now();
        k.interrupt().await.unwrap();
        loop {
            let done = events.lock().unwrap().iter().any(|e| e.parent_id.as_deref() == Some(&id) && e.msg_type == "status" && e.content["execution_state"] == "idle");
            if done {
                break;
            }
            assert!(t0.elapsed() < Duration::from_secs(15), "{lang:?}: interrupt did not stop execution");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(run(&k, &events, expr).await.contains("42"), "{lang:?}: kernel survives interrupt");
        k.shutdown().await;
    }

    // The app dying without a shutdown (ssh killed) must not orphan the kernel.
    if let Some(interp) = info.interpreters.iter().find(|i| i.lang == Lang::Python && i.has_kernel) {
        let count = || async {
            m.run(&p, "pgrep -u \"$(id -u)\" -f '[i]pykernel_launcher' | wc -l", &[], None, Duration::from_secs(20)).await.unwrap().text().trim().to_string()
        };
        // Other clients (e.g. a running DataForge) may have kernels there too.
        let baseline = count().await;
        let sink: EventSink = Arc::new(|_| {});
        let k = Kernel::launch_remote("orphan".into(), Lang::Python, interp.path.clone(), m.clone(), "test".into(), root.clone(), None, sink)
            .await
            .expect("launch");
        drop(k); // kill_on_drop: the ssh client goes away abruptly
        let t0 = std::time::Instant::now();
        while count().await != baseline {
            assert!(t0.elapsed() < Duration::from_secs(15), "remote kernel survived the ssh session");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    // Kernels are gone on the host afterwards (no leaked processes / files).
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(run_files().await, files_before, "connection files left behind");

    m.trash("test", &root).await.expect("trash");
    assert!(m.list_dir("test", &root, false).await.is_err());
    m.disconnect("test").await;
    assert!(m.list_dir("test", &info.home, false).await.is_err(), "disconnected");
}

#[tokio::test]
async fn reports_auth_failures_clearly() {
    if profile().is_none() {
        return;
    }
    let mut p = profile().unwrap();
    p.id = "bad".into();
    p.user = Some("nobody-here".into());
    p.identity_file = Some("/nonexistent/key".into());
    let m = RemoteManager::new();
    let e = m.connect(p).await.unwrap_err().to_string();
    assert!(e.contains("authentication failed") || e.contains("identity"), "{e}");
    assert!(!m.is_connected("bad"));
}
