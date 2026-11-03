//! Integration tests against real kernels. Skipped (pass trivially) when no
//! interpreter with a Jupyter kernel is installed.

use dataforge_lib::envdetect::{self, Interpreter};
use dataforge_lib::kernel::{EventSink, Kernel, KernelEvent, Lang};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

async fn find(lang: Lang) -> Option<Interpreter> {
    envdetect::detect_all().await.into_iter().find(|i| i.lang == lang && i.has_kernel)
}

type Events = Arc<Mutex<Vec<KernelEvent>>>;

fn sink() -> (EventSink, Events) {
    let events: Events = Arc::new(Mutex::new(vec![]));
    let e2 = events.clone();
    (Arc::new(move |ev| e2.lock().unwrap().push(ev)), events)
}

async fn run(k: &Kernel, events: &Events, code: &str) -> Vec<KernelEvent> {
    let id = k.execute(code, None).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        {
            let evs = events.lock().unwrap();
            let done = evs.iter().any(|e| {
                e.parent_id.as_deref() == Some(&id)
                    && e.msg_type == "status"
                    && e.content["execution_state"] == "idle"
            });
            if done {
                return evs.iter().filter(|e| e.parent_id.as_deref() == Some(&id)).cloned().collect();
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "timeout running {code}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn text_of(evs: &[KernelEvent]) -> String {
    evs.iter()
        .map(|e| match e.msg_type.as_str() {
            "stream" => e.content["text"].as_str().unwrap_or("").to_string(),
            "execute_result" => e.content["data"]["text/plain"].as_str().unwrap_or("").to_string(),
            _ => String::new(),
        })
        .collect()
}

async fn exercise(lang: Lang, assign: &str, expr: &str, expected: &str, plot: &str) {
    let Some(interp) = find(lang).await else {
        eprintln!("skipping: no {lang:?} kernel installed");
        return;
    };
    let (sink, events) = sink();
    let k = Kernel::launch("t".into(), lang, interp.path.clone(), None, interp.kernel_lib.clone(), vec![], sink).await.expect("launch");

    // Basic execution + output routing.
    let out = run(&k, &events, expr).await;
    assert!(text_of(&out).contains(expected), "{lang:?} output was {:?}", text_of(&out));

    // Helper: environment listing sees user variables but not helper internals.
    run(&k, &events, assign).await;
    let env = k.call_helper("env_list", json!({})).await.expect("env_list");
    let names: Vec<&str> = env.as_array().unwrap().iter().map(|v| v["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"df"), "{lang:?} env: {names:?}");
    assert!(!names.iter().any(|n| n.contains("dataforge")), "{lang:?} helper leaked: {names:?}");
    let df = env.as_array().unwrap().iter().find(|v| v["name"] == "df").unwrap();
    assert_eq!(df["kind"], "data");
    assert_eq!(df["dims"], json!([3, 2]));

    // Internal calls must not leak output to the UI. (Let the previous run's
    // execute_reply, which may trail its idle status under load, arrive first.)
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = events.lock().unwrap().len();
    k.call_helper("configure", json!({"plot": {"width": 6, "height": 4, "dpi": 96},
        "theme": {"bg": "#111111", "fg": "#eeeeee", "muted": "#999999", "grid": "#333333",
                  "palette": ["#5b6cff", "#ff8a4c"]}}))
        .await
        .expect("configure");
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Late messages of earlier (user) executions may still trickle in under
    // load; a leak would carry the internal request's id instead.
    let evs = events.lock().unwrap();
    let known: std::collections::HashSet<Option<String>> = evs[..before].iter().map(|e| e.parent_id.clone()).collect();
    let leaked: Vec<_> = evs[before..].iter().filter(|e| e.msg_type != "dataforge:log" && !known.contains(&e.parent_id)).cloned().collect();
    drop(evs);
    assert!(leaked.is_empty(), "internal output leaked: {leaked:?}");

    // Plots arrive as display_data with PNG, SVG and PDF representations.
    let out = run(&k, &events, plot).await;
    let disp = out.iter().find(|e| e.msg_type == "display_data").unwrap_or_else(|| panic!("{lang:?} no plot: {out:?}"));
    for mime in ["image/png", "image/svg+xml", "application/pdf"] {
        assert!(disp.content["data"].get(mime).is_some(), "{lang:?} plot missing {mime}");
    }

    // Errors are reported as error messages.
    let out = run(&k, &events, "stop_here_undefined_symbol").await;
    assert!(out.iter().any(|e| e.msg_type == "error"), "{lang:?} no error event");

    k.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn python_kernel_end_to_end() {
    exercise(
        Lang::Python,
        "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2, 3], 'b': list('xyz')})",
        "print(40 + 2)",
        "42",
        "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [3, 1, 2])\nplt.show()",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn r_kernel_end_to_end() {
    exercise(
        Lang::R,
        "df <- data.frame(a = 1:3, b = c('x', 'y', 'z'))",
        "print(40 + 2)",
        "42",
        "plot(1:10)",
    )
    .await;
}

/// Data viewer helpers: paging, sorting, filtering, search and stats on a
/// large frame, with a latency budget per page once the query is cached.
async fn exercise_data(lang: Lang, create: &str) {
    let Some(interp) = find(lang).await else {
        eprintln!("skipping: no {lang:?} kernel installed");
        return;
    };
    let (sink, events) = sink();
    let k = Kernel::launch("d".into(), lang, interp.path.clone(), None, interp.kernel_lib.clone(), vec![], sink).await.expect("launch");
    let out = run(&k, &events, create).await;
    assert!(!out.iter().any(|e| e.msg_type == "error"), "{lang:?} create failed: {out:?}");

    let info = k.call_helper("data_info", json!({"name": "big", "rev": 1})).await.expect("info");
    assert_eq!(info["rows"], json!(2_000_000), "{lang:?} {info}");
    assert_eq!(info["columns"][0]["tone"], "numeric");
    assert_eq!(info["columns"][1]["tone"], "text");

    // First page, unsorted.
    let p = k.call_helper("data_page", json!({"name": "big", "rev": 1, "offset": 0, "limit": 100})).await.expect("page");
    assert_eq!(p["total"], json!(2_000_000));
    assert_eq!(p["rows"][0], json!(1));
    assert_eq!(p["columns"][0].as_array().unwrap().len(), 100);

    // Sort descending by the numeric column; first value is the maximum.
    let sort = json!([{"col": 0, "desc": true}]);
    let t0 = std::time::Instant::now();
    let p = k.call_helper("data_page", json!({"name": "big", "rev": 1, "offset": 0, "limit": 100, "sort": sort})).await.unwrap();
    let first_sort = t0.elapsed();
    assert_eq!(p["rows"][0], json!(2_000_000), "{lang:?} sort: {}", p["rows"][0]);
    // Deep page from the cached index must be fast.
    let t0 = std::time::Instant::now();
    let p = k.call_helper("data_page", json!({"name": "big", "rev": 1, "offset": 1_500_000, "limit": 100, "sort": sort})).await.unwrap();
    let cached = t0.elapsed();
    assert_eq!(p["rows"][0], json!(500_000));
    eprintln!("{lang:?}: first sorted page {first_sort:?}, cached deep page {cached:?}");
    assert!(cached.as_millis() < 500, "{lang:?} cached page too slow: {cached:?}");

    // Filter + search.
    let p = k
        .call_helper("data_page", json!({"name": "big", "rev": 1, "offset": 0, "limit": 10,
            "filters": [{"col": 0, "op": "lte", "value": "10"}], "search": "b"}))
        .await
        .unwrap();
    assert_eq!(p["total"], json!(5), "{lang:?} filter+search total {}", p["total"]);

    // Stats: histogram for numbers, top values for text.
    let s = k.call_helper("data_stats", json!({"name": "big", "rev": 1, "cols": [0, 1]})).await.unwrap();
    assert_eq!(s[0]["hist"].as_array().unwrap().len(), 20, "{lang:?} {s}");
    assert_eq!(s[1]["unique"], json!(2));
    assert_eq!(s[1]["top"].as_array().unwrap().len(), 2);

    // View() publishes a viewer request.
    let out = run(&k, &events, "View(big)").await;
    let disp = out.iter().find(|e| e.msg_type == "display_data").expect("View display");
    assert!(disp.content["data"]["application/vnd.dataforge.view+json"].is_string());

    k.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn python_data_viewer() {
    exercise_data(
        Lang::Python,
        "import pandas as pd, numpy as np\nbig = pd.DataFrame({'x': np.arange(1, 2_000_001), 'g': np.where(np.arange(2_000_000) % 2 == 0, 'a', 'b')})",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn r_data_viewer() {
    exercise_data(Lang::R, "big <- data.frame(x = 1:2000000, g = rep(c('a', 'b'), 1000000))").await;
}

/// Packages and help helpers.
async fn exercise_packages_help(lang: Lang, pkg: &str, topic: &str, needle: &str) {
    let Some(interp) = find(lang).await else {
        eprintln!("skipping: no {lang:?} kernel installed");
        return;
    };
    let (sink, _events) = sink();
    let k = Kernel::launch("p".into(), lang, interp.path.clone(), None, interp.kernel_lib.clone(), vec![], sink).await.expect("launch");

    let pkgs = k.call_helper("packages", json!({})).await.expect("packages");
    let arr = pkgs.as_array().unwrap();
    assert!(arr.len() > 5, "{lang:?}: only {} packages", arr.len());
    let p = arr.iter().find(|p| p["name"].as_str().unwrap().eq_ignore_ascii_case(pkg)).unwrap_or_else(|| panic!("{lang:?}: {pkg} missing"));
    assert!(p["version"].is_string());

    let h = k.call_helper(if lang == Lang::R { "help_html" } else { "help_doc" }, json!({"topic": topic})).await.expect("help");
    assert_eq!(h["found"], true, "{lang:?} help: {h}");
    let text = if lang == Lang::R { h["html"].as_str().unwrap_or_default().to_string() } else { h["doc"].as_str().unwrap_or_default().to_string() };
    assert!(text.contains(needle), "{lang:?}: help for {topic} lacks {needle:?}");

    let missing = k.call_helper(if lang == Lang::R { "help_html" } else { "help_doc" }, json!({"topic": "no_such_topic_xyz"})).await.unwrap();
    assert_eq!(missing["found"], false);
    k.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn python_packages_and_help() {
    exercise_packages_help(Lang::Python, "pandas", "len", "Return the number of items").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn r_packages_and_help() {
    exercise_packages_help(Lang::R, "jsonlite", "mean", "Arithmetic Mean").await;
}

/// An R kernel must start inside an renv project (whose library does not
/// contain IRkernel) and use the project library first.
#[tokio::test(flavor = "multi_thread")]
async fn r_kernel_in_renv_project() {
    let Some(interp) = find(Lang::R).await else {
        eprintln!("skipping: no R kernel");
        return;
    };
    let rscript = interp.path.with_file_name(if cfg!(windows) { "Rscript.exe" } else { "Rscript" });
    let has_renv = std::process::Command::new(&rscript)
        .args(["-e", "cat(requireNamespace('renv', quietly=TRUE))"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("TRUE"))
        .unwrap_or(false);
    if !has_renv {
        eprintln!("skipping: renv not installed");
        return;
    }
    let dir = std::env::temp_dir().join(format!("df-renv-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let init = std::process::Command::new(&rscript)
        .args(["-e", "renv::init(bare = TRUE, restart = FALSE)"])
        .current_dir(&dir)
        .env("RENV_CONFIG_SYNCHRONIZED_CHECK", "FALSE")
        .output()
        .unwrap();
    assert!(dir.join("renv/activate.R").exists(), "renv init failed: {}", String::from_utf8_lossy(&init.stderr));

    let (sink, events) = sink();
    let k = Kernel::launch("rv".into(), Lang::R, interp.path.clone(), Some(dir.clone()), interp.kernel_lib.clone(), vec![], sink)
        .await
        .expect("R kernel should start in an renv project");
    let out = run(&k, &events, "cat(.libPaths()[1])").await;
    let first_lib = text_of(&out);
    assert!(first_lib.contains("renv"), "project library should come first, got {first_lib:?}");
    k.shutdown().await;
    let _ = std::fs::remove_dir_all(dir);
}
