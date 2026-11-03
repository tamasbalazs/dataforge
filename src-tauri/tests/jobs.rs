//! Background jobs: detached start, incremental log, status, cancel (whole
//! process tree), list/reattach; a real cmdstanr sampling job when R+cmdstanr
//! are installed; and over SSH (DF_SSH_TEST) a job that survives disconnecting.

use dataforge_lib::jobs::{self, JobSpec, Place};
use dataforge_lib::remote::{Profile, RemoteManager};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

fn spec(name: &str, script: &str) -> JobSpec {
    let mut files = BTreeMap::new();
    files.insert("job.sh".to_string(), script.to_string());
    JobSpec {
        name: name.into(),
        kind: "test".into(),
        program: "sh".into(),
        args: vec!["-c".into(), ". \"$DATAFORGE_JOB_DIR/job.sh\"".into()],
        cwd: std::env::temp_dir().display().to_string(),
        files,
        env: BTreeMap::from([("DF_GREETING".to_string(), "szia".to_string())]),
        meta: json!({ "test": true }),
    }
}

async fn wait_status(place: &Place, id: &str, want: &str, secs: u64) -> jobs::JobInfo {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let i = jobs::get(place, id).await.unwrap();
        if i.status == want {
            return i;
        }
        assert!(std::time::Instant::now() < deadline, "job {id} did not become {want}: {i:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Local tests keep their jobs out of the user's ~/.dataforge/jobs.
fn test_root() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("df-jobs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("DATAFORGE_JOBS_ROOT", dir);
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn local_jobs_stream_finish_fail_and_cancel() {
    if cfg!(windows) {
        return;
    }
    test_root();
    let place = Place::Local;
    // Streams output; an accented character is split across two reads.
    let job = jobs::start(&place, spec("ékezetes", "echo \"$DF_GREETING $(pwd)\"; printf 'á'; sleep 1; printf 'rvíztűrő\\n'; echo done")).await.unwrap();
    assert_eq!(job.status, "running");
    assert_eq!(job.meta["test"], true);
    let mut offset = 0;
    let mut text = String::new();
    for _ in 0..60 {
        let p = jobs::poll(&place, &job.id, offset).await.unwrap();
        assert!(!p.data.contains('\u{fffd}'), "split UTF-8 must not be mangled: {:?}", p.data);
        text.push_str(&p.data);
        offset = p.next_offset;
        if p.info.status != "running" && p.data.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(text.starts_with(&format!("szia {}", std::env::temp_dir().display())), "{text}");
    assert!(text.contains("árvíztűrő\ndone"), "{text}");
    let done = wait_status(&place, &job.id, "done", 10).await;
    assert_eq!(done.exit_code, Some(0));

    // Failure keeps the exit code.
    let bad = jobs::start(&place, spec("bad", "echo oops >&2; exit 3")).await.unwrap();
    let failed = wait_status(&place, &bad.id, "failed", 10).await;
    assert_eq!(failed.exit_code, Some(3));
    assert_eq!(jobs::poll(&place, &bad.id, 0).await.unwrap().data, "oops\n");

    // The job runs in its own session (not ours), and cancel stops its children too.
    let long = jobs::start(&place, spec("long", "sleep 300 & echo $! > \"$DATAFORGE_JOB_DIR/child\"; wait")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let child = std::fs::read_to_string(format!("{}/child", long.dir)).unwrap().trim().to_string();
    let pid = std::fs::read_to_string(format!("{}/pid", long.dir)).unwrap().trim().to_string();
    let sid = |p: &str| std::process::Command::new("ps").args(["-o", "sid=", "-p", p]).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    assert_eq!(sid(&pid), pid, "the job leads its own session");
    assert_ne!(sid(&pid), sid(&std::process::id().to_string()));
    jobs::cancel(&place, &long.id).await.unwrap();
    let c = wait_status(&place, &long.id, "cancelled", 10).await;
    assert!(c.exit_code.is_some());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let alive = std::process::Command::new("kill").args(["-0", &child]).status().unwrap().success();
    assert!(!alive, "the job's child process must be stopped as well");

    // Listing (what the app does after a restart) finds them; finished ones can be removed.
    let all = jobs::list(&place).await.unwrap();
    for id in [&job.id, &bad.id, &long.id] {
        assert!(all.iter().any(|j| &j.id == id));
    }
    assert!(jobs::poll(&place, "../etc", 0).await.is_err());
    let running = jobs::start(&place, spec("still", "sleep 30")).await.unwrap();
    assert!(jobs::remove(&place, &running.id).await.unwrap_err().to_string().contains("still running"));
    jobs::cancel(&place, &running.id).await.unwrap();
    for id in [&job.id, &bad.id, &long.id, &running.id] {
        jobs::remove(&place, id).await.unwrap();
    }
    assert!(!jobs::list(&place).await.unwrap().iter().any(|j| j.id == job.id));
}

fn has_cmdstanr() -> bool {
    std::process::Command::new("Rscript")
        .args(["-e", "quit(status = !(requireNamespace('cmdstanr', quietly = TRUE) && nzchar(tryCatch(cmdstanr::cmdstan_path(), error = function(e) ''))))"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

const STAN_JOB: &str = r#"
library(cmdstanr)
f <- write_stan_file("data { int N; vector[N] y; } parameters { real mu; real<lower=0> sigma; } model { y ~ normal(mu, sigma); mu ~ normal(0, 5); sigma ~ exponential(1); }")
m <- cmdstan_model(f)
set.seed(1)
dir.create(file.path(Sys.getenv("DATAFORGE_JOB_DIR"), "draws"), showWarnings = FALSE)
fit <- m$sample(data = list(N = 50, y = rnorm(50, 3)), chains = 2, parallel_chains = 2, iter_warmup = 500, iter_sampling = 500, refresh = 100, seed = 1, output_dir = file.path(Sys.getenv("DATAFORGE_JOB_DIR"), "draws"))
fit$save_object(file.path(Sys.getenv("DATAFORGE_JOB_DIR"), "fit.rds"))
"#;

#[tokio::test(flavor = "multi_thread")]
async fn stan_sampling_job_reports_chain_progress() {
    if cfg!(windows) || !has_cmdstanr() {
        eprintln!("skipping: R/cmdstanr/CmdStan not installed");
        return;
    }
    test_root();
    let place = Place::Local;
    let tmp = std::env::temp_dir().join(format!("df-stanjob-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&tmp).unwrap();
    let job = jobs::start(
        &place,
        JobSpec {
            name: "stan".into(),
            kind: "stan".into(),
            program: "Rscript".into(),
            args: vec!["-e".into(), "source(file.path(Sys.getenv('DATAFORGE_JOB_DIR'), 'job.R'))".into()],
            cwd: tmp.display().to_string(),
            files: BTreeMap::from([("job.R".to_string(), STAN_JOB.to_string())]),
            env: BTreeMap::new(),
            meta: json!({}),
        },
    )
    .await
    .unwrap();
    let done = wait_status(&place, &job.id, "done", 240).await;
    let log = jobs::read_file(&place, &job.id, "log").await.unwrap();
    assert!(log.contains("Chain 1 Iteration:") && log.contains("Chain 2 Iteration:"), "{log}");
    assert!(log.contains("(Sampling)") && log.contains("finished in"), "{log}");
    assert!(std::path::Path::new(&format!("{}/fit.rds", done.dir)).exists());
    jobs::remove(&place, &job.id).await.unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_job_survives_disconnect() {
    let Some(spec_str) = std::env::var("DF_SSH_TEST").ok().filter(|s| !s.is_empty()) else {
        eprintln!("skipping: DF_SSH_TEST not set");
        return;
    };
    let (target, identity) = spec_str.split_once(',').map(|(a, b)| (a.to_string(), Some(b.to_string()))).unwrap_or((spec_str.clone(), None));
    let (user, hp) = target.split_once('@').map(|(u, h)| (Some(u.to_string()), h.to_string())).unwrap_or((None, target.clone()));
    let (host, port) = hp.rsplit_once(':').map(|(h, p)| (h.to_string(), p.parse().ok())).unwrap_or((hp.clone(), None));
    let profile = Profile { id: "jobs".into(), name: "jobs".into(), host, user, port, identity_file: identity };

    let m = Arc::new(RemoteManager::new());
    m.connect(profile.clone()).await.expect("connect");
    let place = Place::Remote(m.clone(), profile.clone());
    let job = jobs::start(&place, spec("remote", "for i in 1 2 3 4 5 6; do echo \"tick $i\"; sleep 1; done")).await.unwrap();
    assert!(job.dir.contains("/.dataforge/jobs/"), "{}", job.dir);
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Drop the connection entirely (master included), as when the laptop sleeps.
    m.disconnect("jobs").await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Reconnect: the job is still there and kept running meanwhile.
    let m2 = Arc::new(RemoteManager::new());
    m2.connect(profile.clone()).await.expect("reconnect");
    let place2 = Place::Remote(m2.clone(), profile);
    assert!(jobs::list(&place2).await.unwrap().iter().any(|j| j.id == job.id));
    let done = wait_status(&place2, &job.id, "done", 20).await;
    assert_eq!(done.exit_code, Some(0));
    let log = jobs::poll(&place2, &job.id, 0).await.unwrap().data;
    assert_eq!(log.lines().count(), 6, "every tick ran while we were away: {log}");
    jobs::remove(&place2, &job.id).await.unwrap();
}
