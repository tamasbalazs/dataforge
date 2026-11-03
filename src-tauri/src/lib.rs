//! DataForge host: the Tauri command surface the UI talks to.

pub mod bridge;
pub mod envdetect;
pub mod ext;
pub mod git;
pub mod pty;
pub mod repro;
pub mod fsops;
pub mod procs;
pub mod project;
pub mod kernel;
pub mod lsp;
pub mod remote;
pub mod collab;
pub mod jobs;

use base64::Engine;
use envdetect::Interpreter;
use kernel::{EventSink, Kernel, KernelEvent, KernelManager, Lang};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tauri::{Emitter, Manager, RunEvent, State};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

struct AppState {
    kernels: Arc<KernelManager>,
    bridge: Option<bridge::Bridge>,
    lsp: lsp::LspManager,
    watcher: fsops::ProjectWatcher,
    procs: Arc<procs::Procs>,
    pty: pty::PtyManager,
    remote: Arc<remote::RemoteManager>,
    collab_server: std::sync::Mutex<Option<collab::CollabServer>>,
    collab_clients: collab::CollabClients,
}

/// `ssh://<profile>/path` → (profile, remote path).
fn remote_of(p: &std::path::Path) -> Option<(String, String)> {
    remote::parse_path(p)
}

const NOT_REMOTE: &str = "not available for remote folders";

fn cache_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("interpreters.json"))
}

/// Interpreter detection. Returns the cached result instantly when available
/// (keeps startup fast); `refresh` forces a new scan.
#[tauri::command]
async fn detect_interpreters(app: tauri::AppHandle, refresh: bool) -> CmdResult<Vec<Interpreter>> {
    let cache = cache_file(&app);
    if !refresh {
        if let Some(found) = cache
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice::<Vec<Interpreter>>(&b).ok())
            .filter(|v| v.iter().all(|i| i.path.exists()) && !v.is_empty())
        {
            return Ok(found);
        }
    }
    let found = envdetect::detect_all().await;
    if let Some(f) = cache {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let _ = std::fs::write(f, serde_json::to_vec_pretty(&found).unwrap_or_default());
    }
    Ok(found)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelStarted {
    id: String,
    lang: Lang,
    info: Value,
}

#[tauri::command]
async fn kernel_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    lang: Lang,
    interpreter: PathBuf,
    cwd: Option<PathBuf>,
    kernel_lib: Option<String>,
) -> CmdResult<KernelStarted> {
    if let Some(old) = state.kernels.remove(&id).await {
        old.shutdown().await;
    }
    let handle = app.clone();
    let sink: EventSink = Arc::new(move |ev: KernelEvent| {
        let _ = handle.emit("kernel-event", ev);
    });
    // Without a project, start in the home folder (not the app's own working
    // directory, which is "/" from a desktop launcher or inside an AppImage).
    let cwd = cwd.or_else(dirs::home_dir);
    let k = match cwd.as_deref().and_then(remote_of) {
        Some((profile, dir)) => Kernel::launch_remote(id.clone(), lang, interpreter, state.remote.clone(), profile, dir, kernel_lib, sink).await,
        None => {
            let env = state.bridge.as_ref().map(|b| b.env()).unwrap_or_default();
            Kernel::launch(id.clone(), lang, interpreter, cwd, kernel_lib, env, sink).await
        }
    }
    .map_err(|e| format!("{e:#}"))?;
    let info = k.call_helper("info", json!({})).await.unwrap_or(Value::Null);
    state.kernels.insert(k.clone()).await;

    // Report unexpected exits (crash, `quit()`).
    let watcher = k.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(code) = watcher.clone().wait_exit().await {
            let _ = handle.emit(
                "kernel-event",
                KernelEvent {
                    kernel_id: watcher.id.clone(),
                    msg_type: "dataforge:exited".into(),
                    parent_id: None,
                    content: json!({ "code": code }),
                },
            );
        }
    });
    Ok(KernelStarted { id, lang, info })
}

#[tauri::command]
async fn kernel_execute(
    state: State<'_, AppState>,
    id: String,
    code: String,
    msg_id: Option<String>,
) -> CmdResult<String> {
    state.kernels.get(&id).await.map_err(err)?.execute(&code, msg_id).await.map_err(err)
}

#[tauri::command]
async fn kernel_call(state: State<'_, AppState>, id: String, func: String, args: Value) -> CmdResult<Value> {
    state.kernels.get(&id).await.map_err(err)?.call_helper(&func, args).await.map_err(err)
}

#[tauri::command]
async fn kernel_complete(state: State<'_, AppState>, id: String, code: String, cursor: usize) -> CmdResult<Value> {
    state.kernels.get(&id).await.map_err(err)?.complete(&code, cursor).await.map_err(err)
}

#[tauri::command]
async fn kernel_interrupt(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.kernels.get(&id).await.map_err(err)?.interrupt().await.map_err(err)
}

#[tauri::command]
async fn kernel_shutdown(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if let Some(k) = state.kernels.remove(&id).await {
        k.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
async fn fs_read_text(state: State<'_, AppState>, path: PathBuf) -> CmdResult<String> {
    if let Some((id, p)) = remote_of(&path) {
        let bytes = state.remote.read(&id, &p).await.map_err(err)?;
        return String::from_utf8(bytes).map_err(|_| format!("{p} is not a UTF-8 text file"));
    }
    tokio::fs::read_to_string(&path).await.map_err(err)
}

#[tauri::command]
async fn fs_write_text(state: State<'_, AppState>, path: PathBuf, content: String) -> CmdResult<()> {
    if let Some((id, p)) = remote_of(&path) {
        return state.remote.write(&id, &p, content.into_bytes()).await.map_err(err);
    }
    tokio::fs::write(&path, content).await.map_err(err)
}

#[tauri::command]
async fn fs_write_base64(state: State<'_, AppState>, path: PathBuf, data: String) -> CmdResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(err)?;
    if let Some((id, p)) = remote_of(&path) {
        return state.remote.write(&id, &p, bytes).await.map_err(err);
    }
    tokio::fs::write(&path, bytes).await.map_err(err)
}

#[tauri::command]
async fn lsp_detect(lang: Lang, interpreter: PathBuf) -> CmdResult<lsp::LspDetection> {
    Ok(lsp::detect(lang, &interpreter).await)
}

#[tauri::command]
async fn lsp_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: lsp::LspCommandArgs,
    cwd: Option<PathBuf>,
) -> CmdResult<()> {
    let handle = app.clone();
    let sink: lsp::LspSink = Arc::new(move |ev| {
        let _ = handle.emit("lsp-event", ev);
    });
    if cwd.as_deref().and_then(remote_of).is_some() {
        return Err(format!("language server: {NOT_REMOTE}"));
    }
    let cmd = lsp::LspCommand { name: command.name, program: command.program, args: command.args };
    state.lsp.start(id, &cmd, cwd, sink).await.map_err(err)
}

#[tauri::command]
async fn lsp_send(state: State<'_, AppState>, id: String, payload: String) -> CmdResult<()> {
    state.lsp.send(&id, &payload).await.map_err(err)
}

#[tauri::command]
async fn lsp_stop(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.lsp.stop(&id).await;
    Ok(())
}

#[tauri::command]
async fn fs_list(state: State<'_, AppState>, path: PathBuf, show_hidden: bool) -> CmdResult<Vec<fsops::Entry>> {
    if let Some((id, p)) = remote_of(&path) {
        return state.remote.list_dir(&id, &p, show_hidden).await.map_err(err);
    }
    tokio::task::spawn_blocking(move || fsops::list_dir(&path, show_hidden)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn fs_create(state: State<'_, AppState>, parent: PathBuf, name: String, dir: bool) -> CmdResult<PathBuf> {
    if let Some((id, p)) = remote_of(&parent) {
        return state.remote.create(&id, &p, &name, dir).await.map(PathBuf::from).map_err(err);
    }
    fsops::create(&parent, &name, dir).map_err(err)
}

#[tauri::command]
async fn fs_rename(state: State<'_, AppState>, path: PathBuf, new_name: String) -> CmdResult<PathBuf> {
    if let Some((id, p)) = remote_of(&path) {
        return state.remote.rename(&id, &p, &new_name).await.map(PathBuf::from).map_err(err);
    }
    fsops::rename(&path, &new_name).map_err(err)
}

#[tauri::command]
async fn fs_trash(state: State<'_, AppState>, path: PathBuf) -> CmdResult<()> {
    if let Some((id, p)) = remote_of(&path) {
        return state.remote.trash(&id, &p).await.map_err(err);
    }
    tokio::task::spawn_blocking(move || fsops::to_trash(&path)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn fs_reveal(path: PathBuf) -> CmdResult<()> {
    if remote_of(&path).is_some() {
        return Err(NOT_REMOTE.into());
    }
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
async fn fs_open_external(path: PathBuf) -> CmdResult<()> {
    if remote_of(&path).is_some() {
        return Err(NOT_REMOTE.into());
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(err)
}

#[tauri::command]
async fn project_inspect(state: State<'_, AppState>, root: PathBuf) -> CmdResult<project::ProjectInfo> {
    if let Some((id, p)) = remote_of(&root) {
        return state.remote.inspect(&id, &p).await.map_err(err);
    }
    Ok(project::inspect(&root).await)
}

#[tauri::command]
async fn project_watch(app: tauri::AppHandle, state: State<'_, AppState>, root: Option<PathBuf>) -> CmdResult<()> {
    state.watcher.stop();
    // Remote folders aren't watched; the UI refreshes them on focus.
    let Some(root) = root.filter(|r| remote_of(r).is_none()) else { return Ok(()) };
    let handle = app.clone();
    state
        .watcher
        .watch(&root, Arc::new(move |paths| {
            let _ = handle.emit("fs-changed", paths);
        }))
        .map_err(err)
}

#[tauri::command]
async fn proc_run(app: tauri::AppHandle, state: State<'_, AppState>, id: String, steps: Vec<procs::Step>, cwd: Option<PathBuf>) -> CmdResult<()> {
    if cwd.as_deref().and_then(remote_of).is_some() {
        return Err(NOT_REMOTE.into());
    }
    let handle = app.clone();
    let sink: procs::ProcSink = Arc::new(move |ev| {
        let _ = handle.emit("proc-event", ev);
    });
    state.procs.clone().run(id, steps, cwd, sink).await.map_err(err)
}

#[tauri::command]
async fn proc_kill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.procs.kill(&id).await;
    Ok(())
}

#[tauri::command]
async fn project_venv_steps(root: PathBuf, python: PathBuf) -> CmdResult<Vec<serde_json::Value>> {
    let uv = project::find_in_path("uv");
    Ok(project::create_venv_steps(&root, &python, uv.as_deref())
        .into_iter()
        .map(|(p, a)| json!({ "program": p, "args": a }))
        .collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    shell: Option<String>,
    cwd: Option<PathBuf>,
    env: Option<std::collections::HashMap<String, String>>,
    cols: u16,
    rows: u16,
) -> CmdResult<String> {
    let handle = app.clone();
    let sink: pty::PtySink = Arc::new(move |ev| {
        let _ = handle.emit("pty-event", ev);
    });
    let env = env.unwrap_or_default();
    if let Some((profile, dir)) = cwd.as_deref().and_then(remote_of) {
        let (program, args) = state.remote.terminal_command(&profile, &dir, &env).map_err(err)?;
        state.pty.open(id, Some(program), args, None, Default::default(), cols, rows, sink).map_err(err)?;
        return Ok(format!("ssh {profile}"));
    }
    state.pty.open(id, shell, vec![], cwd.or_else(dirs::home_dir), env, cols, rows, sink).map_err(err)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    state.pty.write(&id, &data).map_err(err)
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    state.pty.resize(&id, cols, rows).map_err(err)
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, id: String) {
    state.pty.kill(&id);
}

#[tauri::command]
async fn kernel_debug(state: State<'_, AppState>, id: String, request: Value) -> CmdResult<Value> {
    state.kernels.get(&id).await.map_err(err)?.debug_request(request).await.map_err(err)
}

/// Send a command to the paused R session (see bridge::DebugHub).
#[tauri::command]
async fn r_debug(state: State<'_, AppState>, command: Value, wait: bool) -> CmdResult<Value> {
    let bridge = state.bridge.as_ref().ok_or("the R/Python bridge is not running")?;
    bridge.debug.request(command, wait).await.map_err(err)
}

#[tauri::command]
async fn repro_files(state: State<'_, AppState>, root: PathBuf) -> CmdResult<Vec<repro::ProjectFile>> {
    if let Some((id, p)) = remote_of(&root) {
        return state.remote.repro_files(&id, &p, 50_000).await.map_err(err);
    }
    tokio::task::spawn_blocking(move || repro::list_files(&root, 50_000)).await.map_err(err)?.map_err(err)
}

/// SHA-256 of files (relative to `root`); unreadable files map to null.
#[tauri::command]
async fn repro_hash(state: State<'_, AppState>, root: PathBuf, paths: Vec<String>) -> CmdResult<std::collections::HashMap<String, Option<String>>> {
    if let Some((id, p)) = remote_of(&root) {
        return state.remote.sha256(&id, &p, &paths).await.map_err(err);
    }
    tokio::task::spawn_blocking(move || {
        paths.into_iter().map(|p| {
            let h = repro::sha256_file(&root.join(&p)).ok();
            (p, h)
        }).collect()
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn repro_write(state: State<'_, AppState>, dest: PathBuf, mut entries: Vec<repro::BundleEntry>) -> CmdResult<u64> {
    if remote_of(&dest).is_some() {
        return Err("choose a local folder for the bundle".into());
    }
    // Files of a remote project are fetched into a scratch folder first.
    let scratch = std::env::temp_dir().join(format!("dataforge-bundle-{}", uuid::Uuid::new_v4().simple()));
    for (i, e) in entries.iter_mut().enumerate() {
        let Some((id, p)) = e.source.as_deref().and_then(|s| remote::parse(&s.to_string_lossy())) else { continue };
        std::fs::create_dir_all(&scratch).map_err(err)?;
        let local = scratch.join(i.to_string());
        if let Err(x) = state.remote.download(&id, &p, &local).await {
            let _ = std::fs::remove_dir_all(&scratch);
            return Err(x.to_string());
        }
        e.source = Some(local);
    }
    let res = tokio::task::spawn_blocking(move || repro::write_bundle(&dest, &entries)).await.map_err(err)?.map_err(err);
    let _ = std::fs::remove_dir_all(&scratch);
    res
}

fn extensions_root(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    app.path().app_data_dir().map(|d| d.join("extensions")).map_err(err)
}

#[tauri::command]
fn ext_dir(app: tauri::AppHandle) -> CmdResult<PathBuf> {
    let d = extensions_root(&app)?;
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

#[tauri::command]
async fn ext_install(app: tauri::AppHandle, package: PathBuf) -> CmdResult<String> {
    let root = extensions_root(&app)?;
    tokio::task::spawn_blocking(move || ext::install_zip(&package, &root)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn ext_uninstall(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let root = extensions_root(&app)?;
    ext::uninstall(&root, &id).map_err(err)
}

#[tauri::command]
async fn git_exec(state: State<'_, AppState>, root: PathBuf, args: Vec<String>, stdin: Option<String>) -> CmdResult<git::GitOutput> {
    if let Some((id, p)) = remote_of(&root) {
        return state.remote.git(&id, &p, &args, stdin).await.map_err(err);
    }
    git::exec(&root, &args, stdin).await.map_err(err)
}

/// Scratch folder for a document's rendered preview (outside the project, so
/// renders never litter the source tree).
#[tauri::command]
fn preview_dir(source: PathBuf) -> CmdResult<PathBuf> {
    if remote_of(&source).is_some() {
        return Err(format!("preview: {NOT_REMOTE}"));
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut h);
    let dir = std::env::temp_dir().join("dataforge-preview").join(format!("{:016x}", h.finish()));
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

#[tauri::command]
async fn remote_connect(state: State<'_, AppState>, profile: remote::Profile) -> CmdResult<remote::RemoteInfo> {
    state.remote.connect(profile).await.map_err(err)
}

#[tauri::command]
async fn remote_disconnect(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    // Kernels running there go down with the connection.
    for k in state.kernels.list().await {
        if k.remote_profile().as_deref() == Some(id.as_str()) {
            if let Some(k) = state.kernels.remove(&k.id).await {
                k.shutdown().await;
            }
        }
    }
    state.remote.disconnect(&id).await;
    Ok(())
}

/// Start sharing: a relay on 127.0.0.1 (or on the LAN). Replaces a running one.
#[tauri::command]
async fn collab_host_start(state: State<'_, AppState>, lan: bool, port: Option<u16>) -> CmdResult<collab::ServerInfo> {
    if let Some(old) = state.collab_server.lock().unwrap().take() {
        old.stop();
    }
    let server = collab::CollabServer::start(lan, port).await.map_err(err)?;
    let info = server.info.clone();
    *state.collab_server.lock().unwrap() = Some(server);
    Ok(info)
}

#[tauri::command]
fn collab_host_stop(state: State<'_, AppState>) {
    if let Some(s) = state.collab_server.lock().unwrap().take() {
        s.stop();
    }
}

#[tauri::command]
async fn collab_connect(app: tauri::AppHandle, state: State<'_, AppState>, id: String, address: String, token: String) -> CmdResult<()> {
    let handle = app.clone();
    let sink: collab::CollabSink = Arc::new(move |ev| {
        let _ = handle.emit("collab-event", ev);
    });
    state.collab_clients.connect(id, &address, &token, sink).await.map_err(err)
}

#[tauri::command]
fn collab_send(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    state.collab_clients.send(&id, data).map_err(err)
}

#[tauri::command]
fn collab_close(state: State<'_, AppState>, id: String) {
    state.collab_clients.close(&id);
}

/// Where jobs of this workspace run: the SSH host of a remote project, else here.
fn job_place(state: &AppState, workdir: Option<&std::path::Path>) -> CmdResult<jobs::Place> {
    match workdir.and_then(remote_of) {
        Some((id, _)) => Ok(jobs::Place::Remote(state.remote.clone(), state.remote.get(&id).map_err(err)?)),
        None => Ok(jobs::Place::Local),
    }
}

#[tauri::command]
async fn job_start(state: State<'_, AppState>, workdir: Option<PathBuf>, mut spec: jobs::JobSpec) -> CmdResult<jobs::JobInfo> {
    let place = job_place(&state, workdir.as_deref())?;
    // A remote project's cwd is a path on that host.
    if let Some((_, p)) = remote::parse(&spec.cwd) {
        spec.cwd = p;
    }
    if spec.cwd.is_empty() {
        spec.cwd = match &place {
            jobs::Place::Local => dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_else(|| "/".into()),
            jobs::Place::Remote(..) => "~".into(),
        };
    }
    jobs::start(&place, spec).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn job_list(state: State<'_, AppState>, workdir: Option<PathBuf>) -> CmdResult<Vec<jobs::JobInfo>> {
    jobs::list(&job_place(&state, workdir.as_deref())?).await.map_err(err)
}

#[tauri::command]
async fn job_poll(state: State<'_, AppState>, workdir: Option<PathBuf>, id: String, offset: u64) -> CmdResult<jobs::JobPoll> {
    jobs::poll(&job_place(&state, workdir.as_deref())?, &id, offset).await.map_err(err)
}

#[tauri::command]
async fn job_cancel(state: State<'_, AppState>, workdir: Option<PathBuf>, id: String) -> CmdResult<()> {
    jobs::cancel(&job_place(&state, workdir.as_deref())?, &id).await.map_err(err)
}

#[tauri::command]
async fn job_remove(state: State<'_, AppState>, workdir: Option<PathBuf>, id: String) -> CmdResult<()> {
    jobs::remove(&job_place(&state, workdir.as_deref())?, &id).await.map_err(err)
}

#[tauri::command]
async fn job_read(state: State<'_, AppState>, workdir: Option<PathBuf>, id: String, name: String) -> CmdResult<String> {
    jobs::read_file(&job_place(&state, workdir.as_deref())?, &id, &name).await.map_err(err)
}

#[tauri::command]
async fn open_url(url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
fn find_program(name: String) -> Option<PathBuf> {
    project::find_in_path(&name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: String,
    home: Option<PathBuf>,
    cwd: Option<PathBuf>,
    /// Milliseconds since process start (startup-time budget tracking).
    uptime_ms: u128,
    /// Folder given on the command line (`dataforge path/to/project`).
    launch_path: Option<PathBuf>,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        home: dirs::home_dir(),
        cwd: std::env::current_dir().ok(),
        uptime_ms: PROCESS_START.get().map(|s| s.elapsed().as_millis()).unwrap_or(0),
        launch_path: std::env::args_os()
            .skip(1)
            .map(PathBuf::from)
            .find(|p| p.is_dir())
            .and_then(|p| std::fs::canonicalize(p).ok()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    PROCESS_START.get_or_init(Instant::now);
    let kernels = Arc::new(KernelManager::default());
    let bridge = tauri::async_runtime::block_on(bridge::start(kernels.clone()))
        .map_err(|e| eprintln!("R/Python bridge unavailable: {e}"))
        .ok();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            kernels,
            bridge,
            lsp: lsp::LspManager::default(),
            watcher: fsops::ProjectWatcher::default(),
            procs: Arc::new(procs::Procs::default()),
            pty: pty::PtyManager::default(),
            remote: Arc::new(remote::RemoteManager::new()),
            collab_server: std::sync::Mutex::new(None),
            collab_clients: collab::CollabClients::default(),
        })
        .invoke_handler(tauri::generate_handler![
            detect_interpreters,
            kernel_start,
            kernel_execute,
            kernel_call,
            kernel_complete,
            kernel_interrupt,
            kernel_shutdown,
            fs_read_text,
            preview_dir,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            git_exec,
            kernel_debug,
            ext_dir,
            ext_install,
            ext_uninstall,
            repro_files,
            repro_hash,
            repro_write,
            r_debug,
            fs_write_text,
            fs_write_base64,
            app_info,
            lsp_detect,
            lsp_start,
            lsp_send,
            lsp_stop,
            fs_list,
            fs_create,
            fs_rename,
            fs_trash,
            fs_reveal,
            fs_open_external,
            project_inspect,
            project_watch,
            proc_run,
            proc_kill,
            project_venv_steps,
            find_program,
            open_url,
            remote_connect,
            remote_disconnect,
            collab_host_start,
            collab_host_stop,
            collab_connect,
            collab_send,
            collab_close,
            job_start,
            job_list,
            job_poll,
            job_cancel,
            job_remove,
            job_read,
        ])
        .setup(|app| {
            if let Some(b) = &app.state::<AppState>().bridge {
                let handle = app.handle().clone();
                b.debug.set_sink(Arc::new(move |ev| {
                    let _ = handle.emit("r-debug-event", ev);
                }));
            }
            // SIGTERM/SIGINT/SIGHUP (kill, Ctrl+C in a terminal, logout) take the
            // normal exit path, so kernels (local and remote) are shut down.
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let (Ok(mut term), Ok(mut int), Ok(mut hup)) =
                        (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup()))
                    else {
                        return;
                    };
                    tokio::select! {
                        _ = term.recv() => {}
                        _ = int.recv() => {}
                        _ = hup.recv() => {}
                    }
                    handle.exit(0);
                });
            }
            // The window starts hidden and the UI shows it after its first paint
            // (no white flash). Safety net in case the UI never does.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DataForge");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                state.kernels.shutdown_all().await;
                state.lsp.stop_all().await;
            });
            state.pty.kill_all();
            state.collab_clients.close_all();
            if let Some(s) = state.collab_server.lock().unwrap().take() {
                s.stop();
            }
            let ids = state.remote.connected();
            tauri::async_runtime::block_on(async {
                for id in ids {
                    state.remote.disconnect(&id).await;
                }
            });
            if let Some(b) = &state.bridge {
                let _ = std::fs::remove_dir_all(&b.dir);
            }
        }
    });
}
