//! Git: a thin, non-interactive runner around the `git` executable. Output is
//! parsed in the UI (src/git/gitParse.ts), where it is unit-tested.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Subcommands the UI may run. Anything else (hooks, aliases, `-c` options)
/// is refused, so a compromised page can't turn this into a shell.
const ALLOWED: &[&str] = &[
    "status", "diff", "show", "log", "branch", "checkout", "switch", "add", "restore", "reset", "rm", "commit", "merge",
    "rev-parse", "init", "stash", "fetch", "pull", "push", "remote", "ls-files", "cat-file", "for-each-ref", "config",
    "rebase", "cherry-pick", "tag", "symbolic-ref", "check-ignore",
];

pub fn git_program() -> Option<std::path::PathBuf> {
    crate::project::find_in_path("git")
}

/// Refuse subcommands outside the allowlist and config writes.
pub fn check_args(args: &[String]) -> Result<()> {
    let sub = args.first().ok_or_else(|| anyhow!("missing git subcommand"))?;
    if !ALLOWED.contains(&sub.as_str()) {
        return Err(anyhow!("git {sub} is not allowed from the UI"));
    }
    if sub == "config" && !args.iter().any(|a| a == "--get" || a == "--get-regexp" || a == "--list") {
        return Err(anyhow!("only reading git config is allowed"));
    }
    Ok(())
}

pub async fn exec(root: &Path, args: &[String], stdin: Option<String>) -> Result<GitOutput> {
    check_args(args)?;
    let program = git_program().ok_or_else(|| anyhow!("git is not installed"))?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off", "-c", "color.ui=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0") // never hang waiting for a password
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("GIT_PAGER", "cat")
        .env("GIT_SSH_COMMAND", std::env::var("GIT_SSH_COMMAND").unwrap_or_else(|_| "ssh -o BatchMode=yes".into()))
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn()?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        use tokio::io::AsyncWriteExt;
        pipe.write_all(input.as_bytes()).await?;
        drop(pipe);
    }
    let out = child.wait_with_output().await?;
    Ok(GitOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_unknown_subcommands_and_config_writes() {
        let dir = std::env::temp_dir();
        assert!(exec(&dir, &["daemon".into()], None).await.is_err());
        assert!(exec(&dir, &["config".into(), "core.hooksPath".into(), "/x".into()], None).await.is_err());
    }

    #[tokio::test]
    async fn runs_in_a_repository() {
        if git_program().is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("df-git-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(exec(&dir, &["init".into(), "-q".into()], None).await.unwrap().code, 0);
        std::fs::write(dir.join("á.txt"), "x").unwrap();
        let st = exec(&dir, &["status".into(), "--porcelain=v2".into(), "-z".into()], None).await.unwrap();
        assert!(st.stdout.contains("? á.txt"), "{}", st.stdout);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
