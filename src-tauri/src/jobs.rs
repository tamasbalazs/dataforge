//! Background jobs that outlive the app and the SSH connection.
//!
//! A job is a folder `~/.dataforge/jobs/<id>/` on the machine that runs it
//! (`$DATAFORGE_JOBS_ROOT/<id>/` when set)
//! (this computer, or the SSH host of a remote project):
//!
//! ```text
//!   job.json   name, kind, cwd, created, free-form meta from the UI
//!   <script>   the program's input (e.g. job.R)
//!   run.sh     wrapper: records the pid, runs the program, records the exit code
//!   log        stdout + stderr
//!   pid        process group leader (setsid) – used to cancel the whole tree
//!   exit       exit code, written when the program ends
//!   cancelled  marker, written before cancelling
//! ```
//!
//! The process is started in its own session (setsid / nohup), so neither the
//! app quitting nor the SSH connection dropping stops it. Every operation is a
//! small POSIX shell script, run locally with `sh` or remotely over SSH, so both
//! places behave the same.

use crate::remote::{sh_quote, Profile, RemoteManager};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

/// Where jobs run: this computer or an SSH host.
#[derive(Clone)]
pub enum Place {
    Local,
    Remote(Arc<RemoteManager>, Profile),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub name: String,
    /// Free-form kind for the UI ("r-script", "stan", …).
    pub kind: String,
    /// Program and arguments, run in `cwd` with the job folder as the second
    /// working reference ($DATAFORGE_JOB_DIR).
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    /// Files to create in the job folder (name → text), e.g. the R script.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// Extra environment variables.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub meta: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub cwd: String,
    /// Absolute folder of the job on its machine.
    pub dir: String,
    /// Milliseconds since the epoch.
    pub created: u64,
    /// running | done | failed | cancelled | lost
    pub status: String,
    pub exit_code: Option<i32>,
    pub log_size: u64,
    pub meta: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPoll {
    pub info: JobInfo,
    /// Log text from the requested offset (at most MAX_CHUNK bytes; may end mid UTF-8 sequence → lossy).
    pub data: String,
    pub next_offset: u64,
}

const MAX_CHUNK: u64 = 256 * 1024;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn valid_file(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !matches!(name, "job.json" | "run.sh" | "log" | "pid" | "exit" | "cancelled")
}

pub fn new_id() -> String {
    let now = chrono::Local::now();
    format!("{}-{}", now.format("%Y%m%d-%H%M%S"), &uuid::Uuid::new_v4().simple().to_string()[..6])
}

/// Jobs folder; DATAFORGE_JOBS_ROOT overrides it (tests use their own).
const ROOT: &str = r#"r="${DATAFORGE_JOBS_ROOT:-$HOME/.dataforge/jobs}""#;

/// Shell snippet: status of the job in "$d" → sets st and code.
const STATUS: &str = r#"
st=running; code=
if [ -f "$d/exit" ]; then
  code=$(cat "$d/exit")
  if [ -f "$d/cancelled" ]; then st=cancelled; elif [ "$code" = 0 ]; then st=done; else st=failed; fi
elif [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then st=running
elif [ -f "$d/pid" ]; then st=lost
fi
sz=$(wc -c < "$d/log" 2>/dev/null | tr -d ' '); [ -n "$sz" ] || sz=0
"#;

impl Place {
    /// Exit code, raw stdout, stderr text.
    async fn run_raw(&self, script: &str, args: &[&str], stdin: Option<Vec<u8>>) -> Result<(i32, Vec<u8>, String)> {
        match self {
            Place::Remote(m, p) => {
                let out = m.run(p, script, args, stdin, Duration::from_secs(60)).await?;
                Ok((out.code, out.stdout, out.stderr))
            }
            Place::Local => {
                if cfg!(windows) {
                    bail!("background jobs on Windows need WSL or a remote host for now");
                }
                use tokio::io::AsyncWriteExt;
                let mut cmd = tokio::process::Command::new("sh");
                cmd.arg("-c").arg(script).arg("sh").args(args);
                cmd.stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                let mut child = cmd.spawn()?;
                if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
                    tokio::spawn(async move {
                        let _ = pipe.write_all(&input).await;
                        let _ = pipe.shutdown().await;
                    });
                }
                let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await.map_err(|_| anyhow!("job command timed out"))??;
                Ok((out.status.code().unwrap_or(-1), out.stdout, String::from_utf8_lossy(&out.stderr).into_owned()))
            }
        }
    }

    async fn run(&self, script: &str, args: &[&str], stdin: Option<Vec<u8>>) -> Result<(i32, String, String)> {
        let (code, out, err) = self.run_raw(script, args, stdin).await?;
        Ok((code, String::from_utf8_lossy(&out).into_owned(), err))
    }

    async fn run_ok(&self, script: &str, args: &[&str], stdin: Option<Vec<u8>>) -> Result<String> {
        let (code, out, err) = self.run(script, args, stdin).await?;
        if code != 0 {
            bail!("{}", err.trim().lines().last().unwrap_or("job command failed"));
        }
        Ok(out)
    }
}

fn parse_info(json: &str, dir: &str, status: &str, code: &str, size: &str) -> Option<JobInfo> {
    let v: Value = serde_json::from_str(json).ok()?;
    Some(JobInfo {
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        kind: v["kind"].as_str().unwrap_or("").to_string(),
        cwd: v["cwd"].as_str().unwrap_or("").to_string(),
        dir: dir.to_string(),
        created: v["created"].as_u64().unwrap_or(0),
        status: status.to_string(),
        exit_code: code.trim().parse().ok(),
        log_size: size.trim().parse().unwrap_or(0),
        meta: v["meta"].clone(),
    })
}

/// Start a job; returns once it is running (detached).
pub async fn start(place: &Place, spec: JobSpec) -> Result<JobInfo> {
    if spec.program.trim().is_empty() {
        bail!("no program to run");
    }
    for name in spec.files.keys() {
        if !valid_file(name) {
            bail!("invalid job file name: {name}");
        }
    }
    for k in spec.env.keys() {
        if !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || k.is_empty() {
            bail!("invalid environment variable name: {k}");
        }
    }
    let id = new_id();
    let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let meta = serde_json::json!({ "id": id, "name": spec.name, "kind": spec.kind, "cwd": spec.cwd, "created": created, "meta": spec.meta });

    // Folder + metadata; prints the absolute folder.
    let dir = place
        .run_ok(&format!("{ROOT}; umask 077; mkdir -p \"$r/$1\" && cat > \"$r/$1/job.json\" && printf '%s' \"$r/$1\""), &[&id], Some(meta.to_string().into_bytes()))
        .await?;
    for (name, content) in &spec.files {
        place.run_ok(r#"cat > "$1/$2""#, &[&dir, name], Some(content.clone().into_bytes())).await?;
    }
    // The wrapper: own session, pid first, exit code last.
    let mut cmd = sh_quote(&spec.program);
    for a in &spec.args {
        cmd.push(' ');
        cmd.push_str(&sh_quote(a));
    }
    let mut exports = format!("export DATAFORGE_JOB_DIR={} DATAFORGE_JOB_ID={}; ", sh_quote(&dir), sh_quote(&id));
    for (k, v) in &spec.env {
        exports.push_str(&format!("export {k}={}; ", sh_quote(v)));
    }
    let wrapper = format!(
        "#!/bin/sh\n# DataForge job {id}\necho $$ > {d}/pid\ncd -- {cwd} 2>/dev/null || cd\n{exports}\n{cmd} < /dev/null > {d}/log 2>&1\necho $? > {d}/exit\n",
        d = sh_quote(&dir),
        cwd = sh_quote(&spec.cwd),
    );
    place.run_ok(r#"cat > "$1/run.sh" && chmod 700 "$1/run.sh""#, &[&dir], Some(wrapper.into_bytes())).await?;
    // setsid: new session and process group (immune to the terminal/SSH hangup,
    // and cancel can signal the whole group). nohup as a fallback (macOS).
    let launch = r#"cd "$1" || exit 1
if command -v setsid >/dev/null 2>&1; then setsid sh ./run.sh </dev/null >/dev/null 2>&1 &
else nohup sh ./run.sh </dev/null >/dev/null 2>&1 & fi
i=0; while [ ! -s pid ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
[ -s pid ] || { echo "the job did not start" >&2; exit 1; }"#;
    place.run_ok(launch, &[&dir], None).await?;
    get(place, &id).await
}

/// One job's current state.
pub async fn get(place: &Place, id: &str) -> Result<JobInfo> {
    if !valid_id(id) {
        bail!("invalid job id");
    }
    let script = format!("{ROOT}; d=\"$r/$1\"; [ -f \"$d/job.json\" ] || exit 3\n{STATUS}\nprintf '%s\\n%s\\n%s\\n%s\\n' \"$d\" \"$st\" \"$code\" \"$sz\"; cat \"$d/job.json\"");
    let (code, out, err) = place.run(&script, &[id], None).await?;
    if code == 3 {
        bail!("no such job: {id}");
    }
    if code != 0 {
        bail!("{}", err.trim());
    }
    let mut it = out.splitn(5, '\n');
    let (dir, st, ec, sz, json) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""));
    parse_info(json, dir, st, ec, sz).ok_or_else(|| anyhow!("corrupt job {id}"))
}

/// All jobs on that machine, newest first.
pub async fn list(place: &Place) -> Result<Vec<JobInfo>> {
    let script = format!(
        "{ROOT}; [ -d \"$r\" ] || exit 0\nfor d in \"$r\"/*/; do d=${{d%/}}; [ -f \"$d/job.json\" ] || continue\n{STATUS}\nprintf '\\036%s\\037%s\\037%s\\037%s\\037' \"$d\" \"$st\" \"$code\" \"$sz\"; cat \"$d/job.json\"; done"
    );
    let out = place.run_ok(&script, &[], None).await?;
    let mut jobs: Vec<JobInfo> = out
        .split('\u{1e}')
        .filter_map(|rec| {
            let p: Vec<&str> = rec.splitn(5, '\u{1f}').collect();
            if p.len() < 5 {
                return None;
            }
            parse_info(p[4], p[0], p[1], p[2], p[3])
        })
        .collect();
    jobs.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(jobs)
}

/// State plus new log text since `offset`.
pub async fn poll(place: &Place, id: &str, offset: u64) -> Result<JobPoll> {
    if !valid_id(id) {
        bail!("invalid job id");
    }
    let script = format!(
        "{ROOT}; d=\"$r/$1\"; [ -f \"$d/job.json\" ] || exit 3\n{STATUS}\nprintf '%s\\037%s\\037%s\\037%s\\037' \"$d\" \"$st\" \"$code\" \"$sz\"; cat \"$d/job.json\"; printf '\\036'\n[ \"$sz\" -gt \"$2\" ] && tail -c +$(($2 + 1)) \"$d/log\" | head -c {MAX_CHUNK}; exit 0"
    );
    let (code, out, err) = place.run_raw(&script, &[id, &offset.to_string()], None).await?;
    if code == 3 {
        bail!("no such job: {id}");
    }
    if code != 0 {
        bail!("{}", err.trim());
    }
    let sep = out.iter().position(|&b| b == 0x1e).unwrap_or(out.len());
    let head = String::from_utf8_lossy(&out[..sep]).into_owned();
    let raw = if sep < out.len() { &out[sep + 1..] } else { &[][..] };
    let p: Vec<&str> = head.splitn(5, '\u{1f}').collect();
    if p.len() < 5 {
        bail!("corrupt job {id}");
    }
    let info = parse_info(p[4], p[0], p[1], p[2], p[3]).ok_or_else(|| anyhow!("corrupt job {id}"))?;
    // Stop before a multi-byte character cut in half; it comes whole next time.
    let (data, used) = utf8_prefix(raw);
    Ok(JobPoll { info, data, next_offset: offset + used as u64 })
}

/// Longest decodable prefix of a byte chunk (invalid bytes inside are replaced).
fn utf8_prefix(raw: &[u8]) -> (String, usize) {
    match std::str::from_utf8(raw) {
        Ok(s) => (s.to_string(), raw.len()),
        Err(e) if e.error_len().is_none() => (String::from_utf8_lossy(&raw[..e.valid_up_to()]).into_owned(), e.valid_up_to()),
        Err(_) => (String::from_utf8_lossy(raw).into_owned(), raw.len()),
    }
}

/// Stop the job's whole process group (TERM, then KILL after a grace period).
pub async fn cancel(place: &Place, id: &str) -> Result<()> {
    if !valid_id(id) {
        bail!("invalid job id");
    }
    let script = format!(
        "{ROOT}; d=\"$r/$1\"; [ -f \"$d/pid\" ] || exit 3; [ -f \"$d/exit\" ] && exit 0\n: > \"$d/cancelled\"; p=$(cat \"$d/pid\")\nkill -TERM -\"$p\" 2>/dev/null || kill -TERM \"$p\" 2>/dev/null\ni=0; while kill -0 \"$p\" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.2; i=$((i+1)); done\nkill -KILL -\"$p\" 2>/dev/null; [ -f \"$d/exit\" ] || echo 143 > \"$d/exit\"; exit 0"
    );
    let (code, _, err) = place.run(&script, &[id], None).await?;
    match code {
        0 => Ok(()),
        3 => bail!("no such job: {id}"),
        _ => bail!("{}", err.trim()),
    }
}

/// Delete a finished job's folder.
pub async fn remove(place: &Place, id: &str) -> Result<()> {
    if !valid_id(id) {
        bail!("invalid job id");
    }
    let script = format!("{ROOT}; d=\"$r/$1\"; [ -d \"$d\" ] || exit 0\n{STATUS}\n[ \"$st\" = running ] && exit 4\nrm -rf -- \"$d\"");
    let (code, _, err) = place.run(&script, &[id], None).await?;
    match code {
        0 => Ok(()),
        4 => bail!("the job is still running – cancel it first"),
        _ => bail!("{}", err.trim()),
    }
}

/// Read a (small) text file from the job folder, e.g. a summary written by the job.
pub async fn read_file(place: &Place, id: &str, name: &str) -> Result<String> {
    if !valid_id(id) || (!valid_file(name) && name != "log") {
        bail!("invalid job file");
    }
    place.run_ok(&format!("{ROOT}; f=\"$r/$1/$2\"; [ -f \"$f\" ] || exit 3; head -c 2000000 \"$f\""), &[id, name], None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_file_names() {
        let id = new_id();
        assert!(valid_id(&id), "{id}");
        assert!(!valid_id("../x") && !valid_id("a b") && !valid_id(""));
        assert!(valid_file("job.R") && valid_file("input_data.rds"));
        assert!(!valid_file("../x") && !valid_file(".hidden") && !valid_file("run.sh") && !valid_file("a/b"));
    }

    #[test]
    fn keeps_split_characters_for_the_next_read() {
        let s = "ok é".as_bytes();
        assert_eq!(utf8_prefix(s), ("ok é".to_string(), s.len()));
        let cut = &s[..s.len() - 1];
        assert_eq!(utf8_prefix(cut), ("ok ".to_string(), 3));
    }

    #[test]
    fn parses_job_info() {
        let j = r#"{"id":"20261102-1-abc","name":"Stan: m","kind":"stan","cwd":"/p","created":5,"meta":{"chains":4}}"#;
        let i = parse_info(j, "/h/.dataforge/jobs/x", "running", "", "120").unwrap();
        assert_eq!(i.status, "running");
        assert_eq!(i.exit_code, None);
        assert_eq!(i.log_size, 120);
        assert_eq!(i.meta["chains"], 4);
        assert!(parse_info("{", "/d", "done", "0", "0").is_none());
    }
}
