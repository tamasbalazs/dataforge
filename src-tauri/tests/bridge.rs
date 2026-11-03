//! R ↔ Python bridge against real kernels: `py$x` / `r.x` in both directions,
//! with type fidelity and a large frame. Skipped when either kernel is missing.

use dataforge_lib::bridge;
use dataforge_lib::envdetect;
use dataforge_lib::kernel::{EventSink, Kernel, KernelEvent, KernelManager, Lang};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Events = Arc<Mutex<Vec<KernelEvent>>>;

async fn run(k: &Kernel, events: &Events, code: &str) -> String {
    let id = k.execute(code, None).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        {
            let evs = events.lock().unwrap();
            let mine: Vec<_> = evs.iter().filter(|e| e.parent_id.as_deref() == Some(&id)).collect();
            if mine.iter().any(|e| e.msg_type == "status" && e.content["execution_state"] == "idle") {
                return mine
                    .iter()
                    .map(|e| match e.msg_type.as_str() {
                        "stream" => e.content["text"].as_str().unwrap_or("").to_string(),
                        "execute_result" => e.content["data"]["text/plain"].as_str().unwrap_or("").to_string(),
                        "error" => format!("ERROR: {} {}", e.content["ename"], e.content["evalue"]),
                        _ => String::new(),
                    })
                    .collect();
            }
        }
        assert!(Instant::now() < deadline, "timeout running {code}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn r_and_python_share_data() {
    let found = envdetect::detect_all().await;
    let (Some(r), Some(py)) = (
        found.iter().find(|i| i.lang == Lang::R && i.has_kernel),
        found.iter().find(|i| i.lang == Lang::Python && i.has_kernel),
    ) else {
        eprintln!("skipping: need both R and Python kernels");
        return;
    };
    let has_pandas = std::process::Command::new(&py.path)
        .args(["-c", "import pandas"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !has_pandas {
        eprintln!("skipping: pandas not installed");
        return;
    }

    let kernels = Arc::new(KernelManager::default());
    let b = bridge::start(kernels.clone()).await.expect("bridge");
    let mut ev = vec![];
    for (id, lang, interp) in [("r", Lang::R, r), ("python", Lang::Python, py)] {
        let events: Events = Arc::new(Mutex::new(vec![]));
        let e2 = events.clone();
        let sink: EventSink = Arc::new(move |e| e2.lock().unwrap().push(e));
        let k = Kernel::launch(id.into(), lang, interp.path.clone(), None, interp.kernel_lib.clone(), b.env(), sink)
            .await
            .expect("launch");
        kernels.insert(k.clone()).await;
        ev.push((k, events));
    }
    let (rk, re) = (&ev[0].0, &ev[0].1);
    let (pk, pe) = (&ev[1].0, &ev[1].1);

    // R → Python: a typed frame read from Python with r.x
    run(rk, re, r#"d <- data.frame(x = c(1.5, NA), n = c(1L, NA), s = c("árvíz", NA), f = factor(c("a", NA)),
                                    t = as.Date(c("2024-05-01", NA)))"#).await;
    let out = run(pk, pe, "d = r.d\nprint(d.dtypes.astype(str).tolist(), d['s'][0], d['n'].isna().tolist(), d['t'][0].date())").await;
    // pandas 3 reports text columns as 'str', older versions as 'object'.
    let out = out.replace("'object'", "'str'");
    assert!(out.contains("['float64', 'Int64', 'str', 'category', 'datetime64[s]'] árvíz [False, True] 2024-05-01"), "{out}");

    // Python → R: py$x
    run(pk, pe, "import pandas as pd\nq = pd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', None]})\nnums = [1.0, 2.5]").await;
    let out = run(rk, re, "q <- py$q; cat(class(q), nrow(q), q$a, is.na(q$b[3]), sum(py$nums), '\\n')").await;
    assert!(out.contains("data.frame 3 1 2 3 TRUE 3.5"), "{out}");

    // Writes in both directions
    run(rk, re, "py$from_r <- mtcars").await;
    let out = run(pk, pe, "print(from_r.shape, from_r.index[0])").await;
    assert!(out.contains("(32, 11) Mazda RX4"), "{out}");
    run(pk, pe, "r.from_py = {'k': [1, 2], 'name': 'ok'}").await;
    let out = run(rk, re, "cat(from_py$name, sum(from_py$k), '\\n')").await;
    assert!(out.contains("ok 3"), "{out}");

    // The bridge object itself stays out of the environment listing.
    let names = rk.call_helper("env_list", serde_json::json!({})).await.unwrap();
    assert!(!names.to_string().contains("\"py\""), "{names}");

    // Errors are reported, not hung.
    let out = run(rk, re, "py$does_not_exist").await;
    assert!(out.contains("not defined in Python"), "{out}");

    // A million rows R → Python.
    run(rk, re, "big <- data.frame(id = seq_len(1e6), v = runif(1e6), g = factor(sample(letters, 1e6, TRUE)))").await;
    let t = Instant::now();
    let out = run(pk, pe, "big = r.big\nprint(len(big), big['id'].iloc[-1])").await;
    let ms = t.elapsed().as_millis();
    assert!(out.contains("1000000 1000000"), "{out}");
    eprintln!("1M-row frame R → Python in {ms} ms");
    assert!(ms < 5000, "too slow: {ms} ms");

    let _ = std::fs::remove_dir_all(&b.dir);
    for (k, _) in ev {
        k.shutdown().await;
    }
}
