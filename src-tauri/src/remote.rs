//! Remote development over SSH.
//!
//! A remote folder is addressed as `ssh://<profileId>/absolute/path`. The UI
//! passes such paths to the ordinary commands (fs_*, project_inspect,
//! git_exec, pty_open, kernel_start); `lib.rs` routes them here.
//!
//! Everything goes through the system `ssh` client, so the user's
//! `~/.ssh/config`, agent, keys, jump hosts and known_hosts all apply. Commands
//! share one multiplexed connection (ControlMaster) per host; kernels get their
//! own connection with the five Jupyter ports forwarded to the remote loopback.
//! Remote hosts are expected to be Unix-like (Linux: GNU find/coreutils).

use crate::envdetect::Interpreter;
use crate::fsops::Entry;
use crate::kernel::Lang;
use crate::project::{ProjectInfo, PyProject, RProject};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub const SCHEME: &str = "ssh://";
/// Largest file the editor opens from a remote host.
pub const MAX_READ: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Host name, IP or a `Host` alias from ~/.ssh/config.
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub home: String,
    pub os: String,
    pub hostname: String,
    pub interpreters: Vec<Interpreter>,
}

#[derive(Debug)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl RunOutput {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Split `ssh://id/abs/path` into (id, "/abs/path").
pub fn parse(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix(SCHEME)?;
    let (id, p) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if id.is_empty() {
        return None;
    }
    // Normalise: no trailing slash (except root), no empty segments.
    let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if segs.contains(&"..") {
        return None;
    }
    Some((id.to_string(), format!("/{}", segs.join("/"))))
}

pub fn parse_path(p: &std::path::Path) -> Option<(String, String)> {
    p.to_str().and_then(parse)
}

pub fn format(id: &str, path: &str) -> String {
    format!("{SCHEME}{id}{}", if path.starts_with('/') { path.to_string() } else { format!("/{path}") })
}

/// POSIX single-quoted shell word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
        bail!("invalid name: {name}");
    }
    Ok(())
}

/// `ssh` executable; `DATAFORGE_SSH` overrides it (tests, custom builds).
pub fn ssh_program() -> String {
    std::env::var("DATAFORGE_SSH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ssh".into())
}

/// Shell prelude for scripts that need the user's PATH (interpreters in
/// ~/.local/bin, conda, …): non-interactive ssh sessions skip the profile.
const PROFILE: &str = r#"for f in /etc/profile "$HOME/.profile" "$HOME/.bash_profile"; do [ -r "$f" ] && . "$f" >/dev/null 2>&1 </dev/null; done; "#;

/// A UTF-8 locale for kernels, like the local launcher does.
const LOCALE: &str = r#"case "${LANG:-C}" in C|POSIX|C.ascii) export LANG=C.UTF-8;; esac; export LC_CTYPE="$LANG"; "#;

pub struct RemoteManager {
    profiles: Mutex<HashMap<String, Profile>>,
    control_dir: PathBuf,
}

impl Default for RemoteManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteManager {
    pub fn new() -> Self {
        // ControlPath must stay short (sun_path is ~104 bytes); %C is a hash.
        let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
        let control_dir = std::env::temp_dir().join(format!("dfssh-{user}"));
        Self { profiles: Mutex::new(HashMap::new()), control_dir }
    }

    pub fn register(&self, p: Profile) -> Result<()> {
        if !valid_id(&p.id) {
            bail!("invalid profile id");
        }
        if p.host.trim().is_empty() || p.host.starts_with('-') || p.host.contains(char::is_whitespace) {
            bail!("invalid host");
        }
        if p.user.as_deref().is_some_and(|u| u.starts_with('-') || u.contains(['@', ' '])) {
            bail!("invalid user");
        }
        self.profiles.lock().unwrap().insert(p.id.clone(), p);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Profile> {
        self.profiles.lock().unwrap().get(id).cloned().ok_or_else(|| anyhow!("not connected to remote '{id}'"))
    }

    pub fn connected(&self) -> Vec<String> {
        self.profiles.lock().unwrap().keys().cloned().collect()
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.profiles.lock().unwrap().contains_key(id)
    }

    fn destination(p: &Profile) -> String {
        match &p.user {
            Some(u) if !u.is_empty() => format!("{u}@{}", p.host),
            _ => p.host.clone(),
        }
    }

    /// Options shared by every ssh invocation. `mux`: reuse the per-host
    /// master connection. `batch`: never prompt (commands, kernels); the
    /// terminal may prompt for a password or passphrase.
    pub fn base_args(&self, p: &Profile, mux: bool, batch: bool) -> Vec<String> {
        let mut a: Vec<String> = vec![];
        let mut opt = |s: &str| {
            a.push("-o".into());
            a.push(s.into());
        };
        if batch {
            opt("BatchMode=yes");
        }
        opt("StrictHostKeyChecking=accept-new");
        opt("ConnectTimeout=15");
        opt("ServerAliveInterval=15");
        opt("ServerAliveCountMax=4");
        if mux && cfg!(unix) {
            let _ = std::fs::create_dir_all(&self.control_dir);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&self.control_dir, std::fs::Permissions::from_mode(0o700));
            }
            opt("ControlMaster=auto");
            opt(&format!("ControlPath={}/%C", self.control_dir.display()));
            opt("ControlPersist=120");
        } else {
            opt("ControlPath=none");
        }
        if let Some(port) = p.port {
            a.push("-p".into());
            a.push(port.to_string());
        }
        if let Some(id) = p.identity_file.as_deref().filter(|s| !s.is_empty()) {
            let expanded = match id.strip_prefix("~/") {
                Some(rest) => dirs::home_dir().map(|h| h.join(rest).display().to_string()).unwrap_or_else(|| id.into()),
                None => id.into(),
            };
            a.push("-i".into());
            a.push(expanded);
            a.push("-o".into());
            a.push("IdentitiesOnly=yes".into());
        }
        a
    }

    /// The remote command string: `sh -c '<script>' sh 'arg1' …`. The remote
    /// login shell (bash, zsh, fish, …) only has to parse quoted words.
    pub fn remote_command(script: &str, args: &[&str]) -> String {
        let mut s = format!("sh -c {} sh", sh_quote(script));
        for a in args {
            s.push(' ');
            s.push_str(&sh_quote(a));
        }
        s
    }

    /// Full argument list for running `script` on the host.
    pub fn command_args(&self, p: &Profile, script: &str, args: &[&str], mux: bool, batch: bool) -> Vec<String> {
        let mut a = self.base_args(p, mux, batch);
        a.push("-T".into());
        a.push("--".into());
        a.push(Self::destination(p));
        a.push(Self::remote_command(script, args));
        a
    }

    /// Run a script on the host and collect its output.
    pub async fn run(&self, p: &Profile, script: &str, args: &[&str], stdin: Option<Vec<u8>>, timeout: Duration) -> Result<RunOutput> {
        let mut cmd = tokio::process::Command::new(ssh_program());
        cmd.args(self.command_args(p, script, args, true, true))
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let mut child = cmd.spawn().with_context(|| format!("failed to start {}", ssh_program()))?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            // Write concurrently with reading, so large inputs can't deadlock.
            tokio::spawn(async move {
                let _ = pipe.write_all(&input).await;
                let _ = pipe.shutdown().await;
            });
        }
        let out = tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| anyhow!("{}: the remote command timed out", p.host))??;
        let code = out.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if code == 255 {
            // ssh itself failed (auth, host key, network).
            bail!("{}", ssh_error(&stderr, &p.host));
        }
        Ok(RunOutput { code, stdout: out.stdout, stderr })
    }

    async fn run_ok(&self, p: &Profile, script: &str, args: &[&str], stdin: Option<Vec<u8>>) -> Result<RunOutput> {
        let out = self.run(p, script, args, stdin, Duration::from_secs(60)).await?;
        if out.code != 0 {
            bail!("{}", out.stderr.trim().lines().last().unwrap_or("remote command failed"));
        }
        Ok(out)
    }

    /// Register the profile, open the master connection and detect interpreters.
    pub async fn connect(&self, p: Profile) -> Result<RemoteInfo> {
        self.register(p.clone())?;
        let res = async {
            let out = self
                .run(&p, &format!("{PROFILE}{DETECT}"), &[], None, Duration::from_secs(90))
                .await?;
            if out.code != 0 {
                bail!("{}", out.stderr.trim());
            }
            Ok(parse_detect(&out.text()))
        }
        .await;
        if res.is_err() {
            self.profiles.lock().unwrap().remove(&p.id);
        }
        res
    }

    /// Close the master connection and forget the profile.
    pub async fn disconnect(&self, id: &str) {
        let Some(p) = self.profiles.lock().unwrap().remove(id) else { return };
        let mut args = self.base_args(&p, true, true);
        args.extend(["-O".into(), "exit".into(), Self::destination(&p)]);
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::process::Command::new(ssh_program()).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status(),
        )
        .await;
    }

    // -------------------------------------------------------------------
    // Files

    pub async fn list_dir(&self, id: &str, dir: &str, show_hidden: bool) -> Result<Vec<Entry>> {
        let p = self.get(id)?;
        let out = self
            .run(&p, r#"cd -- "$1" 2>/dev/null || exit 3; find . -mindepth 1 -maxdepth 1 -printf '%Y\t%s\t%T@\t%f\0'"#, &[dir], None, Duration::from_secs(60))
            .await?;
        match out.code {
            0 => {}
            3 => bail!("{dir}: no such directory"),
            _ => bail!("{}", out.stderr.trim()),
        }
        Ok(parse_find(&out.text(), id, dir, show_hidden))
    }

    pub async fn read(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let p = self.get(id)?;
        let script = format!(r#"[ -f "$1" ] || exit 3; [ "$(wc -c < "$1")" -le {MAX_READ} ] || exit 4; exec cat -- "$1""#);
        let out = self.run(&p, &script, &[path], None, Duration::from_secs(120)).await?;
        match out.code {
            0 => Ok(out.stdout),
            3 => bail!("{path}: no such file"),
            4 => bail!("{path} is larger than {} MB", MAX_READ / 1024 / 1024),
            _ => bail!("{}", out.stderr.trim()),
        }
    }

    pub async fn write(&self, id: &str, path: &str, data: Vec<u8>) -> Result<()> {
        let p = self.get(id)?;
        // Write next to the target, then rename (atomic, keeps the old file on
        // failure); copy the original mode when there is one.
        let script = r#"t="$1.dftmp.$$"; cat > "$t" || { rm -f "$t"; exit 1; }; [ -e "$1" ] && chmod --reference="$1" "$t" 2>/dev/null; mv -f -- "$t" "$1""#;
        self.run_ok(&p, script, &[path], Some(data)).await.map(|_| ())
    }

    /// Stream a remote file into a local one (no size limit; for bundles).
    pub async fn download(&self, id: &str, path: &str, dest: &std::path::Path) -> Result<()> {
        let p = self.get(id)?;
        let file = std::fs::File::create(dest)?;
        let mut cmd = tokio::process::Command::new(ssh_program());
        cmd.args(self.command_args(&p, r#"[ -f "$1" ] || exit 3; exec cat -- "$1""#, &[path], true, true))
            .stdin(Stdio::null())
            .stdout(Stdio::from(file))
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        // (tokio's output() would re-pipe stdout, so spawn + wait.)
        let child = cmd.spawn().with_context(|| format!("failed to start {}", ssh_program()))?;
        let out = tokio::time::timeout(Duration::from_secs(1800), child.wait_with_output())
            .await
            .map_err(|_| anyhow!("{path}: download timed out"))??;
        match out.status.code() {
            Some(0) => Ok(()),
            Some(3) => bail!("{path}: no such file"),
            Some(255) => bail!("{}", ssh_error(&String::from_utf8_lossy(&out.stderr), &p.host)),
            _ => bail!("{path}: {}", String::from_utf8_lossy(&out.stderr).trim()),
        }
    }

    pub async fn create(&self, id: &str, parent: &str, name: &str, dir: bool) -> Result<String> {
        check_name(name)?;
        let p = self.get(id)?;
        let target = join(parent, name);
        let script = r#"[ -e "$1" ] && exit 5; if [ "$2" = dir ]; then mkdir -- "$1"; else : > "$1"; fi"#;
        let out = self.run(&p, script, &[&target, if dir { "dir" } else { "file" }], None, Duration::from_secs(30)).await?;
        match out.code {
            0 => Ok(format(id, &target)),
            5 => bail!("{target} already exists"),
            _ => bail!("{}", out.stderr.trim()),
        }
    }

    pub async fn rename(&self, id: &str, path: &str, new_name: &str) -> Result<String> {
        check_name(new_name)?;
        let p = self.get(id)?;
        let target = join(parent_of(path), new_name);
        let out = self.run(&p, r#"[ -e "$2" ] && exit 5; mv -- "$1" "$2""#, &[path, &target], None, Duration::from_secs(30)).await?;
        match out.code {
            0 => Ok(format(id, &target)),
            5 => bail!("{target} already exists"),
            _ => bail!("{}", out.stderr.trim()),
        }
    }

    /// Move into the remote user's trash (freedesktop layout), never delete.
    pub async fn trash(&self, id: &str, path: &str) -> Result<()> {
        if path == "/" || path.is_empty() {
            bail!("refusing to trash /");
        }
        let p = self.get(id)?;
        let script = r#"[ -e "$1" ] || exit 3
if command -v gio >/dev/null 2>&1 && gio trash -- "$1" 2>/dev/null; then exit 0; fi
t="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"; mkdir -p "$t/files" "$t/info" || exit 1
b=$(basename -- "$1"); n="$b"; i=1
while [ -e "$t/files/$n" ]; do n="$b.$i"; i=$((i+1)); done
printf '[Trash Info]\nPath=%s\nDeletionDate=%s\n' "$1" "$(date +%Y-%m-%dT%H:%M:%S)" > "$t/info/$n.trashinfo"
mv -- "$1" "$t/files/$n""#;
        let out = self.run(&p, script, &[path], None, Duration::from_secs(60)).await?;
        match out.code {
            0 => Ok(()),
            3 => bail!("{path}: no such file"),
            _ => bail!("{}", out.stderr.trim()),
        }
    }

    // -------------------------------------------------------------------
    // Projects, git

    pub async fn inspect(&self, id: &str, root: &str) -> Result<ProjectInfo> {
        let p = self.get(id)?;
        let out = self.run(&p, &format!("{PROFILE}{INSPECT}"), &[root], None, Duration::from_secs(90)).await?;
        if out.code == 3 {
            bail!("{root}: no such directory");
        }
        Ok(parse_inspect(&out.text(), id, root))
    }

    pub async fn git(&self, id: &str, root: &str, args: &[String], stdin: Option<String>) -> Result<crate::git::GitOutput> {
        crate::git::check_args(args)?;
        let p = self.get(id)?;
        let mut all: Vec<&str> = vec![root];
        all.extend(args.iter().map(String::as_str));
        let script = r#"r="$1"; shift; export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C GIT_PAGER=cat; exec git -C "$r" -c core.quotepath=off -c color.ui=false "$@""#;
        let out = self.run(&p, script, &all, stdin.map(String::into_bytes), Duration::from_secs(300)).await?;
        if out.code == 127 {
            bail!("git is not installed on {}", p.host);
        }
        Ok(crate::git::GitOutput { code: out.code, stdout: out.text(), stderr: out.stderr })
    }

    /// Program + args for an interactive remote shell in `dir` (run in a local pty).
    pub fn terminal_command(&self, id: &str, dir: &str, env: &HashMap<String, String>) -> Result<(String, Vec<String>)> {
        let p = self.get(id)?;
        let mut a = self.base_args(&p, true, false);
        a.push("-tt".into());
        a.push("--".into());
        a.push(Self::destination(&p));
        let mut script = String::from("export TERM_PROGRAM=DataForge; ");
        if let Some(prepend) = env.get("DATAFORGE_PATH_PREPEND") {
            script.push_str(&format!("export PATH={}\"$PATH\"; ", sh_quote(prepend)));
        }
        script.push_str(r#"cd -- "$1" 2>/dev/null || cd; exec "${SHELL:-/bin/sh}" -l"#);
        a.push(Self::remote_command(&script, &[dir]));
        Ok((ssh_program(), a))
    }

    /// Project inventory for the reproducibility export (mirror of repro::list_files).
    pub async fn repro_files(&self, id: &str, root: &str, limit: usize) -> Result<Vec<crate::repro::ProjectFile>> {
        let p = self.get(id)?;
        let script = format!(
            r#"cd -- "$1" 2>/dev/null || exit 3
find . \( -name .git -o -name .venv -o -name venv -o -name env -o -name node_modules -o -name __pycache__ -o -name .Rproj.user -o -name .quarto -o -name .tox \) -prune -o -type f -printf '%P\t%s\0' | head -z -n {}"#,
            limit + 1
        );
        let out = self.run(&p, &script, &[root], None, Duration::from_secs(120)).await?;
        if out.code == 3 {
            bail!("{root}: no such directory");
        }
        let mut files: Vec<crate::repro::ProjectFile> = out
            .text()
            .split('\0')
            .filter_map(|rec| {
                let (path, size) = rec.rsplit_once('\t')?;
                (!crate::repro::is_skipped(std::path::Path::new(path)))
                    .then(|| crate::repro::ProjectFile { path: path.to_string(), size: size.parse().unwrap_or(0) })
            })
            .collect();
        if files.len() > limit {
            bail!("more than {limit} files — is this really a project folder?");
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// SHA-256 of project files on the host; unreadable files map to None.
    pub async fn sha256(&self, id: &str, root: &str, paths: &[String]) -> Result<HashMap<String, Option<String>>> {
        let p = self.get(id)?;
        let mut input = Vec::new();
        for f in paths {
            if f.starts_with('/') || f.split('/').any(|s| s == "..") {
                continue;
            }
            input.extend_from_slice(f.as_bytes());
            input.push(0);
        }
        let out = self
            .run(&p, r#"cd -- "$1" || exit 3; xargs -0 -r sha256sum -- 2>/dev/null; exit 0"#, &[root], Some(input), Duration::from_secs(300))
            .await?;
        let mut found: HashMap<String, String> = HashMap::new();
        for line in out.text().lines() {
            // Names with a backslash or newline are escaped and prefixed with "\"; skip those.
            if let Some((hash, name)) = line.split_once("  ") {
                if hash.len() == 64 && !hash.starts_with('\\') {
                    found.insert(name.to_string(), hash.to_string());
                }
            }
        }
        Ok(paths.iter().map(|f| (f.clone(), found.get(f).cloned())).collect())
    }

    // -------------------------------------------------------------------
    // Kernels

    /// Free TCP ports on the remote loopback (python3/perl if present, random otherwise).
    pub async fn free_ports(&self, p: &Profile, n: usize) -> Result<Vec<u16>> {
        let script = format!(
            r#"python3 -c 'import socket
s=[socket.socket() for _ in range({n})]
[x.bind(("127.0.0.1",0)) for x in s]
print(" ".join(str(x.getsockname()[1]) for x in s))' 2>/dev/null && exit 0
perl -MIO::Socket::INET -e 'my @s=map {{ IO::Socket::INET->new(Listen=>1,LocalAddr=>"127.0.0.1",LocalPort=>0) }} 1..{n}; print join(" ", map {{ $_->sockport }} @s), "\n"' 2>/dev/null && exit 0
exit 9"#
        );
        let out = self.run(p, &script, &[], None, Duration::from_secs(30)).await?;
        let ports: Vec<u16> = out.text().split_whitespace().filter_map(|s| s.parse().ok()).collect();
        if out.code == 0 && ports.len() == n {
            return Ok(ports);
        }
        // Neither available: pick from the dynamic range; collisions make the
        // kernel fail to bind, which is reported as a startup error.
        let seed = uuid::Uuid::new_v4().as_u128();
        Ok((0..n).map(|i| 40000 + ((seed >> (i * 16)) as u16 % 20000)).collect())
    }

    /// Kill a remote process (used for kernel interrupt/shutdown).
    pub async fn signal(&self, id: &str, pid: u32, signal: &str) -> Result<()> {
        if !matches!(signal, "INT" | "TERM" | "KILL") {
            bail!("unsupported signal");
        }
        let p = self.get(id)?;
        self.run(&p, &format!("kill -{signal} {pid}"), &[], None, Duration::from_secs(15)).await.map(|_| ())
    }
}

/// Script for the kernel's ssh session. Writes the connection file, starts the
/// kernel, prints its pid, and kills it when the ssh session goes away (our
/// stdin closes), so a crashed or killed app never leaves kernels behind.
/// (Background jobs of a non-interactive shell get /dev/null as stdin, hence
/// the explicit fd 3.)
pub fn kernel_script(conn_json: &str, cwd: &str, launch: &(String, Vec<String>)) -> String {
    let name = format!("kernel-{}.json", uuid::Uuid::new_v4().simple());
    let mut cmd = sh_quote(&launch.0);
    for a in &launch.1 {
        cmd.push(' ');
        cmd.push_str(&if a == "{connection_file}" { "\"$f\"".to_string() } else { sh_quote(a) });
    }
    format!(
        r#"{PROFILE}{LOCALE}umask 077
d="$HOME/.dataforge/run"; mkdir -p "$d" || exit 1
f="$d/{name}"
printf '%s' {conn} > "$f" || exit 1
cd -- {cwd} 2>/dev/null || cd
export PYDEVD_DISABLE_FILE_VALIDATION=1 PYTHONUTF8=1
exec 3<&0
{cmd} </dev/null 3<&- 2>&1 &
pid=$!
echo "DFPID $pid"
( cat <&3 >/dev/null; kill -TERM $pid 2>/dev/null; sleep 2; kill -KILL $pid 2>/dev/null; rm -f "$f" ) >/dev/null 2>&1 &
exec 3<&-
wait $pid; code=$?
rm -f "$f"
exit $code"#,
        conn = sh_quote(conn_json),
        cwd = sh_quote(cwd),
    )
}

fn ssh_error(stderr: &str, host: &str) -> String {
    let s = stderr.trim();
    let lower = s.to_lowercase();
    let reason = if lower.contains("permission denied") {
        "authentication failed (no usable key – add one to ssh-agent or set an identity file)"
    } else if lower.contains("host key verification failed") || lower.contains("remote host identification has changed") {
        "host key verification failed (the host key changed – check ~/.ssh/known_hosts)"
    } else if lower.contains("could not resolve hostname") {
        "unknown host"
    } else if lower.contains("connection refused") {
        "connection refused (is sshd running on that port?)"
    } else if lower.contains("timed out") {
        "connection timed out"
    } else if lower.contains("no such file") && lower.contains("identity") {
        "identity file not found"
    } else {
        ""
    };
    let last = s.lines().filter(|l| !l.starts_with("Warning: Permanently added")).last().unwrap_or("ssh failed");
    if reason.is_empty() {
        format!("{host}: {last}")
    } else {
        format!("{host}: {reason}")
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &path[..i],
    }
}

const SKIP: &[&str] = &[".git", "node_modules", "__pycache__", ".Rproj.user", ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache"];

/// Parse `find -printf '%Y\t%s\t%T@\t%f\0'` output.
pub fn parse_find(out: &str, id: &str, dir: &str, show_hidden: bool) -> Vec<Entry> {
    let mut v: Vec<Entry> = out
        .split('\0')
        .filter_map(|rec| {
            let mut it = rec.splitn(4, '\t');
            let (ty, size, mtime, name) = (it.next()?, it.next()?, it.next()?, it.next()?);
            if name.is_empty() || SKIP.contains(&name) {
                return None;
            }
            let hidden = name.starts_with('.');
            if hidden && !show_hidden {
                return None;
            }
            let is_dir = ty == "d";
            Some(Entry {
                name: name.to_string(),
                path: PathBuf::from(format(id, &join(dir, name))),
                is_dir,
                size: if is_dir { 0 } else { size.parse().unwrap_or(0) },
                modified: mtime.parse::<f64>().ok().map(|s| (s * 1000.0) as u64),
                hidden,
            })
        })
        .collect();
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| crate::fsops::natural_key(&a.name).cmp(&crate::fsops::natural_key(&b.name))));
    v
}

/// Remote interpreter detection. Prints `INFO\t<key>\t<value>` and
/// `INTERP\t<lang>\t<path>\t<probe output>` lines.
const DETECT: &str = r#"printf 'INFO\thome\t%s\n' "$HOME"
printf 'INFO\tos\t%s\n' "$(uname -s 2>/dev/null)"
printf 'INFO\thostname\t%s\n' "$(hostname 2>/dev/null || uname -n)"
seen=" "
probe_py() {
  [ -x "$1" ] || return
  real=$(readlink -f "$1" 2>/dev/null || echo "$1")
  case "$seen" in *" $real "*) return;; esac; seen="$seen$real "
  out=$("$1" -c 'import sys,importlib.util as u;print(sys.version.split()[0], u.find_spec("ipykernel") is not None)' 2>/dev/null) || return
  printf 'INTERP\tpython\t%s\t%s\n' "$1" "$out"
}
probe_r() {
  [ -x "$1" ] || return
  real=$(readlink -f "$1" 2>/dev/null || echo "$1")
  case "$seen" in *" $real "*) return;; esac; seen="$seen$real "
  rs="$(dirname "$1")/Rscript"; [ -x "$rs" ] || rs=Rscript
  out=$("$rs" --vanilla -e "ok <- requireNamespace('IRkernel', quietly=TRUE); cat(paste(R.version\$major, R.version\$minor, sep='.'), ok, if (ok) dirname(system.file(package='IRkernel')) else '')" 2>/dev/null) || return
  printf 'INTERP\tr\t%s\t%s\n' "$1" "$out"
}
for c in $(command -v python3 python 2>/dev/null) "$HOME/.local/bin/python3" "$HOME/.pyenv/shims/python3" "$HOME/miniconda3/bin/python" "$HOME/miniforge3/bin/python" "$HOME/anaconda3/bin/python" /opt/conda/bin/python /usr/local/bin/python3 /usr/bin/python3; do probe_py "$c"; done
for c in $(command -v R 2>/dev/null) /usr/local/bin/R /usr/bin/R /opt/R/*/bin/R; do probe_r "$c"; done
exit 0
"#;

pub fn parse_detect(out: &str) -> RemoteInfo {
    let mut info = RemoteInfo { home: String::new(), os: String::new(), hostname: String::new(), interpreters: vec![] };
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        match parts.as_slice() {
            ["INFO", "home", v] => info.home = v.to_string(),
            ["INFO", "os", v] => info.os = v.to_string(),
            ["INFO", "hostname", v] => info.hostname = v.to_string(),
            ["INTERP", lang, path, probe] => {
                let lang = if *lang == "r" { Lang::R } else { Lang::Python };
                if let Some(i) = interpreter_from_probe(lang, path, probe, "remote") {
                    info.interpreters.push(i);
                }
            }
            _ => {}
        }
    }
    info.interpreters.sort_by_key(|i| !i.has_kernel);
    info
}

fn interpreter_from_probe(lang: Lang, path: &str, probe: &str, source: &str) -> Option<Interpreter> {
    let (version, has_kernel, kernel_lib) = crate::envdetect::parse_probe_ext(probe)?;
    let install_hint = (!has_kernel).then(|| match lang {
        Lang::R => format!("Rscript -e \"install.packages('IRkernel', repos='https://cloud.r-project.org')\"   # on the remote host"),
        Lang::Python => format!("{} -m pip install ipykernel   # on the remote host", sh_quote(path)),
    });
    Some(Interpreter {
        lang,
        path: PathBuf::from(path),
        version,
        has_kernel,
        source: source.into(),
        install_hint,
        kernel_lib: if lang == Lang::R { kernel_lib } else { None },
    })
}

/// Project inspection on the host (mirror of project::inspect).
const INSPECT: &str = r#"cd -- "$1" 2>/dev/null || exit 3
for f in renv.lock renv/activate.R DESCRIPTION pyproject.toml uv.lock requirements.txt environment.yml .git; do [ -e "$f" ] && printf 'HAS\t%s\n' "$f"; done
for f in *.Rproj; do [ -f "$f" ] && printf 'RPROJ\t%s\n' "$f" && break; done
command -v uv >/dev/null 2>&1 && printf 'UV\t%s\n' "$(command -v uv)"
for v in .venv venv env; do
  py="$PWD/$v/bin/python"
  [ -x "$py" ] || continue
  out=$("$py" -c 'import sys,importlib.util as u;print(sys.version.split()[0], u.find_spec("ipykernel") is not None)' 2>/dev/null) || continue
  printf 'VENV\t%s\t%s\n' "$py" "$out"
done
exit 0
"#;

pub fn parse_inspect(out: &str, id: &str, root: &str) -> ProjectInfo {
    let mut has = std::collections::HashSet::new();
    let mut rproj = None;
    let mut uv = None;
    let mut venvs = vec![];
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        match parts.as_slice() {
            ["HAS", f] => {
                has.insert(f.to_string());
            }
            ["RPROJ", f] => rproj = Some(f.to_string()),
            ["UV", p] => uv = Some(PathBuf::from(p)),
            ["VENV", py, probe] => {
                let src = py.rsplit('/').nth(2).unwrap_or(".venv").to_string();
                if let Some(i) = interpreter_from_probe(Lang::Python, py, probe, &src) {
                    venvs.push(i);
                }
            }
            _ => {}
        }
    }
    let name = root.rsplit('/').find(|s| !s.is_empty()).unwrap_or("/").to_string();
    ProjectInfo {
        root: PathBuf::from(format(id, root)),
        name,
        git: has.contains(".git"),
        r: RProject {
            renv: has.contains("renv.lock") || has.contains("renv/activate.R"),
            renv_lock: has.contains("renv.lock"),
            rproj,
            description: has.contains("DESCRIPTION"),
        },
        python: PyProject {
            venvs,
            pyproject: has.contains("pyproject.toml"),
            uv_lock: has.contains("uv.lock"),
            requirements: has.contains("requirements.txt"),
            environment_yml: has.contains("environment.yml"),
            uv,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_paths() {
        assert_eq!(parse("ssh://lab/home/a/x.R"), Some(("lab".into(), "/home/a/x.R".into())));
        assert_eq!(parse("ssh://lab"), Some(("lab".into(), "/".into())));
        assert_eq!(parse("ssh://lab/"), Some(("lab".into(), "/".into())));
        assert_eq!(parse("ssh://lab//home//a/"), Some(("lab".into(), "/home/a".into())));
        assert_eq!(parse("ssh://lab/home/../etc"), None);
        assert_eq!(parse("ssh:///x"), None);
        assert_eq!(parse("/home/a"), None);
        assert_eq!(format("lab", "/home/a"), "ssh://lab/home/a");
        assert_eq!(parent_of("/home/a/x.R"), "/home/a");
        assert_eq!(parent_of("/x"), "/");
        assert_eq!(join("/", "x"), "/x");
    }

    #[test]
    fn quotes_for_posix_shells() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(RemoteManager::remote_command("echo \"$1\"", &["x y"]), r#"sh -c 'echo "$1"' sh 'x y'"#);
    }

    #[test]
    fn validates_profiles() {
        let m = RemoteManager::new();
        let p = |id: &str, host: &str, user: Option<&str>| Profile {
            id: id.into(),
            name: String::new(),
            host: host.into(),
            user: user.map(Into::into),
            port: None,
            identity_file: None,
        };
        assert!(m.register(p("lab", "example.org", Some("ana"))).is_ok());
        assert!(m.register(p("lab", "-oProxyCommand=x", None)).is_err());
        assert!(m.register(p("lab", "a b", None)).is_err());
        assert!(m.register(p("../x", "h", None)).is_err());
        assert!(m.register(p("lab", "h", Some("-x"))).is_err());
        assert!(m.get("nope").is_err());
        let args = m.command_args(&m.get("lab").unwrap(), "true", &[], false, true);
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ControlPath=none".to_string()));
        let dest = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dest + 1], "ana@example.org");
    }

    #[test]
    fn parses_find_output() {
        let out = "d\t4096\t1700000000.5\tdata\0f\t12\t1700000001.0\tb10.R\0f\t3\t1700000001.0\tb2.R\0d\t0\t1\t.git\0f\t1\t1\t.hidden\0f\t5\t1\ta\tb.txt\0";
        let v = parse_find(out, "lab", "/p", false);
        let names: Vec<&str> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["data", "a\tb.txt", "b2.R", "b10.R"]);
        assert_eq!(v[0].path, PathBuf::from("ssh://lab/p/data"));
        assert!(v[0].is_dir && v[0].size == 0);
        assert_eq!(v[0].modified, Some(1_700_000_000_500));
        assert_eq!(parse_find(out, "lab", "/p", true).len(), 5);
    }

    #[test]
    fn parses_detection_and_inspection() {
        let out = "INFO\thome\t/home/ana\nINFO\tos\tLinux\nINTERP\tpython\t/usr/bin/python3\t3.12.1 False\nINTERP\tr\t/usr/bin/R\t4.3.3 TRUE /usr/lib/R/site-library\ngarbage\n";
        let i = parse_detect(out);
        assert_eq!(i.home, "/home/ana");
        assert_eq!(i.interpreters.len(), 2);
        assert_eq!(i.interpreters[0].lang, Lang::R); // with kernel first
        assert_eq!(i.interpreters[0].kernel_lib.as_deref(), Some("/usr/lib/R/site-library"));
        assert!(i.interpreters[1].install_hint.as_deref().unwrap().contains("pip install ipykernel"));

        let out = "HAS\trenv.lock\nHAS\t.git\nRPROJ\tp.Rproj\nVENV\t/w/p/.venv/bin/python\t3.11.2 True\n";
        let info = parse_inspect(out, "lab", "/w/p");
        assert_eq!(info.root, PathBuf::from("ssh://lab/w/p"));
        assert_eq!(info.name, "p");
        assert!(info.git && info.r.renv && info.r.renv_lock);
        assert_eq!(info.r.rproj.as_deref(), Some("p.Rproj"));
        assert_eq!(info.python.venvs[0].source, ".venv");
        assert!(info.python.venvs[0].has_kernel);
    }

    #[test]
    fn kernel_script_quotes_everything() {
        let s = kernel_script(r#"{"key":"k"}"#, "/w/it's", &("/usr/bin/python3".into(), vec!["-m".into(), "ipykernel_launcher".into(), "-f".into(), "{connection_file}".into()]));
        assert!(s.contains(r#"printf '%s' '{"key":"k"}' > "$f""#));
        assert!(s.contains(r"cd -- '/w/it'\''s'"));
        assert!(s.contains(r#"'/usr/bin/python3' '-m' 'ipykernel_launcher' '-f' "$f" </dev/null 3<&-"#));
        assert!(s.contains("echo \"DFPID $pid\""));
    }

    #[test]
    fn explains_ssh_errors() {
        assert!(ssh_error("dfremote@h: Permission denied (publickey).", "h").contains("authentication failed"));
        assert!(ssh_error("ssh: connect to host h port 22: Connection refused", "h").contains("connection refused"));
        assert_eq!(ssh_error("weird", "h"), "h: weird");
    }
}
