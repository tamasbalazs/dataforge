//! Kernel management: launching Jupyter kernels, routing shell replies and
//! IOPub messages, and calling the in-kernel DataForge helper.

pub mod lang;
pub mod wire;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::process::Child;
use tokio::sync::{oneshot, Mutex};
use zeromq::{DealerSocket, Socket, SocketRecv, SocketSend, SubSocket, ZmqMessage};

pub use lang::Lang;
use wire::JupyterMessage;

/// Event forwarded to the UI. `msg_type` is either a Jupyter IOPub message
/// type or one of the synthetic `dataforge:*` lifecycle events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEvent {
    pub kernel_id: String,
    pub msg_type: String,
    pub parent_id: Option<String>,
    pub content: Value,
}

pub type EventSink = Arc<dyn Fn(KernelEvent) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionInfo {
    pub ip: String,
    pub transport: String,
    pub shell_port: u16,
    pub iopub_port: u16,
    pub stdin_port: u16,
    pub control_port: u16,
    pub hb_port: u16,
    pub key: String,
    pub signature_scheme: String,
    pub kernel_name: String,
}

impl ConnectionInfo {
    pub fn generate() -> Result<Self> {
        // Reserve five distinct free ports by holding listeners open together.
        let listeners: Vec<TcpListener> =
            (0..5).map(|_| TcpListener::bind("127.0.0.1:0")).collect::<std::io::Result<_>>()?;
        let ports: Vec<u16> = listeners.iter().map(|l| l.local_addr().unwrap().port()).collect();
        drop(listeners);
        Ok(Self {
            ip: "127.0.0.1".into(),
            transport: "tcp".into(),
            shell_port: ports[0],
            iopub_port: ports[1],
            stdin_port: ports[2],
            control_port: ports[3],
            hb_port: ports[4],
            key: uuid::Uuid::new_v4().simple().to_string(),
            signature_scheme: "hmac-sha256".into(),
            kernel_name: String::new(),
        })
    }

    fn endpoint(&self, port: u16) -> String {
        format!("{}://{}:{}", self.transport, self.ip, port)
    }
}

type Pending = Arc<StdMutex<HashMap<String, oneshot::Sender<JupyterMessage>>>>;

/// Stdout of an internal request, collected until the kernel goes idle.
#[derive(Default)]
struct Capture {
    text: String,
    done: Option<oneshot::Sender<String>>,
}
type Captures = Arc<StdMutex<HashMap<String, Capture>>>;

/// Remote kernels: where they run, for interrupt and shutdown signals.
struct RemoteLink {
    manager: Arc<crate::remote::RemoteManager>,
    profile: String,
    pid: Arc<StdMutex<Option<u32>>>,
}

/// Markers around a helper result printed to stdout (remote kernels).
pub const RESULT_START: &str = "\u{1e}DFJSON";
pub const RESULT_END: char = '\u{1e}';

/// Extract the JSON envelope a helper printed between the markers.
pub fn extract_result(text: &str) -> Option<&str> {
    let start = text.rfind(RESULT_START)? + RESULT_START.len();
    let len = text[start..].find(RESULT_END)?;
    Some(&text[start..start + len])
}

/// Forward a child's stdout/stderr as log events. For remote kernels the
/// wrapper script announces the remote pid as `DFPID <n>`.
fn forward_output(child: &mut Child, id: &str, sink: &EventSink, pid_tx: Option<oneshot::Sender<u32>>) {
    let pid_tx = Arc::new(StdMutex::new(pid_tx));
    for (stream, name) in [
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), "stderr"),
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), "stdout"),
    ] {
        if let Some(stream) = stream {
            let sink = sink.clone();
            let kid = id.to_string();
            let pid_tx = pid_tx.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(pid) = line.strip_prefix("DFPID ").and_then(|p| p.trim().parse().ok()) {
                        if let Some(tx) = pid_tx.lock().unwrap().take() {
                            let _ = tx.send(pid);
                            continue;
                        }
                    }
                    if line.starts_with("Warning: Permanently added") {
                        continue;
                    }
                    sink(KernelEvent {
                        kernel_id: kid.clone(),
                        msg_type: "dataforge:log".into(),
                        parent_id: None,
                        content: json!({ "stream": name, "text": line }),
                    });
                }
            });
        }
    }
}

/// True once a ZeroMQ peer answers on the local port: ZMTP peers send their
/// greeting (0xFF …) right after connecting, while an ssh forward whose remote
/// end isn't listening yet just closes the connection.
async fn zmtp_peer_ready(port: u16) -> bool {
    use tokio::io::AsyncReadExt;
    let Ok(Ok(mut s)) = tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(("127.0.0.1", port))).await else {
        return false;
    };
    let mut b = [0u8; 1];
    matches!(tokio::time::timeout(Duration::from_secs(2), s.read(&mut b)).await, Ok(Ok(1)) if b[0] == 0xFF)
}

pub struct Kernel {
    pub id: String,
    pub lang: Lang,
    pub interpreter: PathBuf,
    session: String,
    key: Vec<u8>,
    shell: Mutex<zeromq::DealerSendHalf>,
    control: Mutex<zeromq::DealerSendHalf>,
    pending: Pending,
    internal: Arc<StdMutex<HashSet<String>>>,
    child: Mutex<Option<Child>>,
    pid: Option<u32>,
    workdir: PathBuf,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    captures: Captures,
    remote: Option<RemoteLink>,
}

impl Kernel {
    /// Launch a kernel process and connect to it. Returns once the kernel has
    /// answered `kernel_info_request` and the helper has been injected.
    pub async fn launch(
        id: String,
        lang: Lang,
        interpreter: PathBuf,
        cwd: Option<PathBuf>,
        kernel_lib: Option<String>,
        env: Vec<(String, String)>,
        sink: EventSink,
    ) -> Result<Arc<Kernel>> {
        let workdir = std::env::temp_dir().join(format!("dataforge-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&workdir)?;
        let conn = ConnectionInfo::generate()?;
        let conn_file = workdir.join("connection.json");
        std::fs::write(&conn_file, serde_json::to_vec_pretty(&conn)?)?;

        let (prog, args) = lang.launch_command(&interpreter, &conn_file, kernel_lib.as_deref());
        let mut cmd = tokio::process::Command::new(&prog);
        cmd.args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PYDEVD_DISABLE_FILE_VALIDATION", "1")
            .env("JPY_PARENT_PID", std::process::id().to_string())
            .env("PYTHONUTF8", "1")
            .envs(env)
            .kill_on_drop(true);
        if let Some(utf8) = crate::procs::default_utf8_locale() {
            cmd.env("LANG", utf8).env("LC_CTYPE", utf8);
        }
        if let Some(dir) = cwd.as_ref().filter(|d| d.is_dir()) {
            cmd.current_dir(dir);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        // If DataForge dies without cleaning up (kill -9, crash), the kernel
        // gets SIGTERM instead of lingering (ipykernel also watches
        // JPY_PARENT_PID; IRkernel has no such check).
        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().with_context(|| format!("failed to start {prog}"))?;
        let pid = child.id();
        forward_output(&mut child, &id, &sink, None);
        Self::connect(id, lang, interpreter, conn, child, pid, workdir, None, sink).await
    }

    /// Launch a kernel on a remote host over SSH. The kernel binds the remote
    /// loopback; its five ports are forwarded to local ones by the same ssh
    /// process, which is also the kernel's local "child" (its exit = kernel exit).
    #[allow(clippy::too_many_arguments)]
    pub async fn launch_remote(
        id: String,
        lang: Lang,
        interpreter: PathBuf,
        manager: Arc<crate::remote::RemoteManager>,
        profile_id: String,
        cwd: String,
        kernel_lib: Option<String>,
        sink: EventSink,
    ) -> Result<Arc<Kernel>> {
        let profile = manager.get(&profile_id)?;
        let workdir = std::env::temp_dir().join(format!("dataforge-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&workdir)?;
        let local = ConnectionInfo::generate()?;
        let rp = manager.free_ports(&profile, 5).await?;
        let mut remote = local.clone();
        (remote.shell_port, remote.iopub_port, remote.stdin_port, remote.control_port, remote.hb_port) = (rp[0], rp[1], rp[2], rp[3], rp[4]);
        let launch = lang.launch_command(&interpreter, Path::new("{connection_file}"), kernel_lib.as_deref());
        let script = crate::remote::kernel_script(&serde_json::to_string(&remote)?, &cwd, &launch);

        let mut args = manager.base_args(&profile, false, true);
        args.extend(["-o".into(), "ExitOnForwardFailure=yes".into(), "-T".into()]);
        for (l, r) in [
            (local.shell_port, remote.shell_port),
            (local.iopub_port, remote.iopub_port),
            (local.stdin_port, remote.stdin_port),
            (local.control_port, remote.control_port),
            (local.hb_port, remote.hb_port),
        ] {
            args.push("-L".into());
            args.push(format!("127.0.0.1:{l}:127.0.0.1:{r}"));
        }
        args.push("--".into());
        args.push(match &profile.user {
            Some(u) if !u.is_empty() => format!("{u}@{}", profile.host),
            _ => profile.host.clone(),
        });
        args.push(crate::remote::RemoteManager::remote_command(&script, &[]));

        let ssh = crate::remote::ssh_program();
        let mut cmd = tokio::process::Command::new(&ssh);
        cmd.args(&args)
            // Kept open for the kernel's lifetime: when it closes (app exit or
            // crash) the remote watchdog stops the kernel.
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let mut child = cmd.spawn().with_context(|| format!("failed to start {ssh}"))?;
        let (pid_tx, pid_rx) = oneshot::channel();
        forward_output(&mut child, &id, &sink, Some(pid_tx));
        let remote_pid = Arc::new(StdMutex::new(None));
        {
            let remote_pid = remote_pid.clone();
            tokio::spawn(async move {
                if let Ok(pid) = pid_rx.await {
                    *remote_pid.lock().unwrap() = Some(pid);
                }
            });
        }
        // Don't connect before the remote kernel listens: through a forward,
        // a TCP connect succeeds even when nothing is listening on the far side.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        for port in [local.shell_port, local.iopub_port, local.control_port] {
            loop {
                if zmtp_peer_ready(port).await {
                    break;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    bail!("remote kernel exited during startup ({status}); see the kernel log for details");
                }
                if tokio::time::Instant::now() > deadline {
                    bail!("timed out waiting for the remote kernel");
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        let link = RemoteLink { manager, profile: profile_id, pid: remote_pid };
        Self::connect(id, lang, interpreter, local, child, None, workdir, Some(link), sink).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn connect(
        id: String,
        lang: Lang,
        interpreter: PathBuf,
        conn: ConnectionInfo,
        mut child: Child,
        pid: Option<u32>,
        workdir: PathBuf,
        remote: Option<RemoteLink>,
        sink: EventSink,
    ) -> Result<Arc<Kernel>> {
        let key = conn.key.clone().into_bytes();
        let session = uuid::Uuid::new_v4().to_string();

        let mut iopub = SubSocket::new();
        let mut shell = DealerSocket::new();
        let mut control = DealerSocket::new();
        // The kernel binds its ports asynchronously; retry connecting for a while.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let ok = iopub.connect(&conn.endpoint(conn.iopub_port)).await.is_ok();
            if ok {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                bail!("kernel process exited during startup ({status})");
            }
            if tokio::time::Instant::now() > deadline {
                bail!("timed out connecting to kernel");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        iopub.subscribe("").await?;
        shell.connect(&conn.endpoint(conn.shell_port)).await?;
        control.connect(&conn.endpoint(conn.control_port)).await?;
        let (shell_tx, shell_rx) = shell.split();
        let (control_tx, control_rx) = control.split();

        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let internal: Arc<StdMutex<HashSet<String>>> = Arc::new(StdMutex::new(HashSet::new()));
        let captures: Captures = Arc::new(StdMutex::new(HashMap::new()));
        let mut tasks = vec![];

        // Shell + control replies: resolve waiters or forward to the UI.
        tasks.push(spawn_reply_router(shell_rx, key.clone(), id.clone(), pending.clone(), internal.clone(), sink.clone()));
        tasks.push(spawn_reply_router(control_rx, key.clone(), id.clone(), pending.clone(), internal.clone(), sink.clone()));

        // IOPub: forward everything except output of internal requests.
        {
            let internal = internal.clone();
            let captures = captures.clone();
            let sink = sink.clone();
            let kid = id.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                while let Ok(frames) = iopub.recv().await {
                    let Ok(msg) = JupyterMessage::from_frames(frames.into_vec(), &key) else { continue };
                    let parent = msg.parent_id().map(str::to_owned);
                    if let Some(p) = &parent {
                        let mut set = internal.lock().unwrap();
                        if set.contains(p) {
                            let idle = msg.msg_type() == "status" && msg.content["execution_state"] == "idle";
                            if idle {
                                set.remove(p);
                            }
                            let mut caps = captures.lock().unwrap();
                            if msg.msg_type() == "stream" && msg.content["name"] == "stdout" {
                                if let Some(c) = caps.get_mut(p) {
                                    c.text.push_str(msg.content["text"].as_str().unwrap_or(""));
                                }
                            } else if idle {
                                if let Some(mut c) = caps.remove(p) {
                                    if let Some(tx) = c.done.take() {
                                        let _ = tx.send(c.text);
                                    }
                                }
                            }
                            continue;
                        }
                    }
                    sink(KernelEvent {
                        kernel_id: kid.clone(),
                        msg_type: msg.msg_type().to_string(),
                        parent_id: parent,
                        content: msg.content,
                    });
                }
            }));
        }

        let kernel = Arc::new(Kernel {
            id: id.clone(),
            lang,
            interpreter,
            session,
            key,
            shell: Mutex::new(shell_tx),
            control: Mutex::new(control_tx),
            pending,
            internal,
            child: Mutex::new(Some(child)),
            pid,
            workdir,
            tasks,
            captures,
            remote,
        });

        kernel.wait_until_ready(Duration::from_secs(60)).await?;
        let reply = kernel.execute_internal(lang.init_code()).await?;
        if reply.content["status"] != "ok" {
            bail!("helper injection failed: {}", reply.content["evalue"]);
        }
        Ok(kernel)
    }

    async fn wait_until_ready(&self, timeout: Duration) -> Result<()> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(child) = self.child.lock().await.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    bail!("kernel process exited during startup ({status})");
                }
            }
            let msg = JupyterMessage::new("kernel_info_request", &self.session, json!({}));
            match tokio::time::timeout(Duration::from_millis(1500), self.request(msg, false)).await {
                Ok(Ok(_)) => return Ok(()),
                _ if tokio::time::Instant::now() > deadline => bail!("kernel did not become ready"),
                _ => {}
            }
        }
    }

    /// Send a request on shell (or control) and wait for its reply.
    async fn request(&self, msg: JupyterMessage, control: bool) -> Result<JupyterMessage> {
        let (tx, rx) = oneshot::channel();
        let id = msg.msg_id().to_string();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        self.send(&msg, control).await?;
        let res = rx.await.map_err(|_| anyhow!("kernel connection closed"));
        self.pending.lock().unwrap().remove(&id);
        res
    }

    async fn send(&self, msg: &JupyterMessage, control: bool) -> Result<()> {
        let frames = msg.to_frames(&self.key);
        let zmsg = ZmqMessage::try_from(frames).map_err(|e| anyhow!("{e:?}"))?;
        if control {
            self.control.lock().await.send(zmsg).await?;
        } else {
            self.shell.lock().await.send(zmsg).await?;
        }
        Ok(())
    }

    fn execute_msg(&self, code: &str, silent: bool) -> JupyterMessage {
        JupyterMessage::new(
            "execute_request",
            &self.session,
            json!({
                "code": code,
                "silent": silent,
                "store_history": !silent,
                "user_expressions": {},
                "allow_stdin": false,
                "stop_on_error": !silent,
            }),
        )
    }

    /// Execute user code; output arrives as events. Returns the request id.
    pub async fn execute(&self, code: &str, msg_id: Option<String>) -> Result<String> {
        let mut msg = self.execute_msg(code, false);
        if let Some(id) = msg_id {
            msg.header["msg_id"] = json!(id);
        }
        let id = msg.msg_id().to_string();
        self.send(&msg, false).await?;
        Ok(id)
    }

    /// Execute code whose output is hidden from the UI and wait for completion.
    pub async fn execute_internal(&self, code: &str) -> Result<JupyterMessage> {
        let msg = self.execute_msg(code, true);
        self.internal.lock().unwrap().insert(msg.msg_id().to_string());
        self.request(msg, false).await
    }

    pub fn remote_profile(&self) -> Option<String> {
        self.remote.as_ref().map(|r| r.profile.clone())
    }

    pub fn is_remote(&self) -> bool {
        self.remote.is_some()
    }

    /// Call a helper function inside the kernel and return its JSON result.
    /// Local kernels write the result to a file in our workdir; remote ones
    /// print it to stdout between markers, captured from IOPub.
    pub async fn call_helper(&self, func: &str, args: Value) -> Result<Value> {
        let raw = if self.remote.is_some() {
            let code = self.lang.call_code(func, &args.to_string(), Path::new(""));
            self.execute_captured(&code).await?
        } else {
            let out = self.workdir.join(format!("{}.json", uuid::Uuid::new_v4().simple()));
            let code = self.lang.call_code(func, &args.to_string(), &out);
            let reply = self.execute_internal(&code).await?;
            if reply.content["status"] != "ok" {
                bail!("{}: {}", reply.content["ename"], reply.content["evalue"]);
            }
            let raw = tokio::fs::read(&out).await.context("helper produced no result")?;
            let _ = tokio::fs::remove_file(&out).await;
            raw
        };
        let envelope: Value = serde_json::from_slice(&raw)?;
        if envelope["ok"] == true {
            Ok(envelope["value"].clone())
        } else {
            bail!("{}", envelope["error"].as_str().unwrap_or("helper error"))
        }
    }

    /// Run hidden code and return the helper envelope it printed. IRkernel
    /// drops stream output of `silent` requests, so R runs non-silent but
    /// without history (the execution counter doesn't move either).
    async fn execute_captured(&self, code: &str) -> Result<Vec<u8>> {
        let silent = self.lang == Lang::Python;
        let mut msg = self.execute_msg(code, silent);
        msg.content["store_history"] = json!(false);
        msg.content["stop_on_error"] = json!(false);
        let id = msg.msg_id().to_string();
        let (tx, rx) = oneshot::channel();
        self.captures.lock().unwrap().insert(id.clone(), Capture { text: String::new(), done: Some(tx) });
        self.internal.lock().unwrap().insert(id.clone());
        let reply = match self.request(msg, false).await {
            Ok(r) => r,
            Err(e) => {
                self.captures.lock().unwrap().remove(&id);
                return Err(e);
            }
        };
        if reply.content["status"] != "ok" {
            self.captures.lock().unwrap().remove(&id);
            bail!("{}: {}", reply.content["ename"], reply.content["evalue"]);
        }
        let text = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| anyhow!("helper output did not arrive"))?
            .map_err(|_| anyhow!("kernel connection closed"))?;
        let json = extract_result(&text).ok_or_else(|| anyhow!("helper produced no result"))?;
        Ok(json.as_bytes().to_vec())
    }

    /// Send a DAP request through the Jupyter debug protocol (control channel)
    /// and return the DAP response. Events arrive on IOPub as `debug_event`.
    pub async fn debug_request(&self, request: Value) -> Result<Value> {
        let msg = JupyterMessage::new("debug_request", &self.session, request);
        let reply = tokio::time::timeout(Duration::from_secs(30), self.request(msg, true))
            .await
            .map_err(|_| anyhow!("debugger did not answer"))??;
        Ok(reply.content)
    }

    pub async fn complete(&self, code: &str, cursor_pos: usize) -> Result<Value> {
        let msg = JupyterMessage::new(
            "complete_request",
            &self.session,
            json!({ "code": code, "cursor_pos": cursor_pos }),
        );
        let reply = tokio::time::timeout(Duration::from_secs(5), self.request(msg, false)).await??;
        Ok(reply.content)
    }

    pub async fn interrupt(&self) -> Result<()> {
        if let Some(r) = &self.remote {
            let pid = *r.pid.lock().unwrap();
            if let Some(pid) = pid {
                return r.manager.signal(&r.profile, pid, "INT").await;
            }
            let msg = JupyterMessage::new("interrupt_request", &self.session, json!({}));
            return self.send(&msg, true).await;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // Signal the whole process group (R's launcher script, the kernel, children).
            unsafe {
                libc::kill(-(pid as i32), libc::SIGINT);
            }
            return Ok(());
        }
        let msg = JupyterMessage::new("interrupt_request", &self.session, json!({}));
        self.send(&msg, true).await
    }

    pub async fn shutdown(&self) {
        let msg = JupyterMessage::new("shutdown_request", &self.session, json!({ "restart": false }));
        let _ = tokio::time::timeout(Duration::from_millis(800), self.request(msg, true)).await;
        if let Some(r) = &self.remote {
            // Closing ssh's stdin triggers the remote watchdog; give the kernel
            // a moment to exit by itself first.
            if let Some(child) = self.child.lock().await.as_mut() {
                if tokio::time::timeout(Duration::from_millis(1500), child.wait()).await.is_err() {
                    drop(child.stdin.take());
                    let pid = *r.pid.lock().unwrap();
                    if let Some(pid) = pid {
                        let _ = tokio::time::timeout(Duration::from_secs(3), r.manager.signal(&r.profile, pid, "TERM")).await;
                    }
                }
            }
        }
        if let Some(mut child) = self.child.lock().await.take() {
            if tokio::time::timeout(Duration::from_millis(1500), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
        for t in &self.tasks {
            t.abort();
        }
        let _ = std::fs::remove_dir_all(&self.workdir);
    }

    /// Resolves when the kernel process exits.
    pub async fn wait_exit(self: Arc<Self>) -> Option<i32> {
        loop {
            {
                let mut guard = self.child.lock().await;
                match guard.as_mut() {
                    None => return None,
                    Some(child) => {
                        if let Ok(Some(status)) = child.try_wait() {
                            return status.code();
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }
}

fn spawn_reply_router<R: SocketRecv + Send + 'static>(
    mut rx: R,
    key: Vec<u8>,
    kernel_id: String,
    pending: Pending,
    internal: Arc<StdMutex<HashSet<String>>>,
    sink: EventSink,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok(frames) = rx.recv().await {
            let Ok(msg) = JupyterMessage::from_frames(frames.into_vec(), &key) else { continue };
            let parent = msg.parent_id().map(str::to_owned);
            let waiter = parent.as_ref().and_then(|p| pending.lock().unwrap().remove(p));
            let is_internal = parent.as_ref().is_some_and(|p| internal.lock().unwrap().contains(p));
            if !is_internal && msg.msg_type() == "execute_reply" {
                sink(KernelEvent {
                    kernel_id: kernel_id.clone(),
                    msg_type: "execute_reply".into(),
                    parent_id: parent.clone(),
                    content: msg.content.clone(),
                });
            }
            if let Some(w) = waiter {
                let _ = w.send(msg);
            }
        }
    })
}

/// Registry of running kernels.
#[derive(Default)]
pub struct KernelManager {
    kernels: Mutex<HashMap<String, Arc<Kernel>>>,
}

impl KernelManager {
    pub async fn insert(&self, kernel: Arc<Kernel>) -> Option<Arc<Kernel>> {
        self.kernels.lock().await.insert(kernel.id.clone(), kernel)
    }

    pub async fn get(&self, id: &str) -> Result<Arc<Kernel>> {
        self.kernels.lock().await.get(id).cloned().ok_or_else(|| anyhow!("no kernel with id {id}"))
    }

    /// The running kernel for a language (the bridge's peer lookup).
    pub async fn list(&self) -> Vec<Arc<Kernel>> {
        self.kernels.lock().await.values().cloned().collect()
    }

    pub async fn by_lang(&self, lang: Lang) -> Option<Arc<Kernel>> {
        let all = self.kernels.lock().await;
        all.get(lang.as_str()).or_else(|| all.values().find(|k| k.lang == lang)).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Kernel>> {
        self.kernels.lock().await.remove(id)
    }

    pub async fn shutdown_all(&self) {
        let all: Vec<_> = self.kernels.lock().await.drain().map(|(_, k)| k).collect();
        for k in all {
            k.shutdown().await;
        }
    }
}
