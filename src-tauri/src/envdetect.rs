//! Detects installed R and Python interpreters and whether their Jupyter
//! kernels (IRkernel / ipykernel) are available.

use crate::kernel::Lang;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Interpreter {
    pub lang: Lang,
    pub path: PathBuf,
    pub version: String,
    pub has_kernel: bool,
    /// Where it was found: PATH, pyenv, conda, rig, framework, …
    pub source: String,
    /// Command the user can run to install the missing kernel package.
    pub install_hint: Option<String>,
    /// R only: library that contains IRkernel. Appended to `.libPaths()` at
    /// launch so the kernel also starts inside renv projects.
    #[serde(default)]
    pub kernel_lib: Option<String>,
}

#[cfg(windows)]
const EXE: &str = ".exe";
#[cfg(not(windows))]
const EXE: &str = "";

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    v.sort();
    v.reverse(); // newest version first
    v
}

fn path_candidates(names: &[&str]) -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else { return vec![] };
    let mut out = vec![];
    for dir in std::env::split_paths(&path) {
        for n in names {
            let p = dir.join(format!("{n}{EXE}"));
            if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

pub fn r_candidates() -> Vec<(PathBuf, String)> {
    let mut c: Vec<(PathBuf, String)> = path_candidates(&["R"]).into_iter().map(|p| (p, "PATH".into())).collect();
    let mut add = |p: PathBuf, src: &str| {
        if p.is_file() {
            c.push((p, src.into()));
        }
    };
    #[cfg(target_os = "macos")]
    {
        add("/Library/Frameworks/R.framework/Resources/bin/R".into(), "R.framework");
        add("/opt/homebrew/bin/R".into(), "Homebrew");
        add("/usr/local/bin/R".into(), "Homebrew");
    }
    #[cfg(target_os = "linux")]
    {
        add("/usr/bin/R".into(), "system");
        add("/usr/local/bin/R".into(), "system");
        for d in subdirs(Path::new("/opt/R")) {
            add(d.join("bin/R"), "rig");
        }
    }
    #[cfg(windows)]
    {
        for base in ["C:\\Program Files\\R", "C:\\Program Files (x86)\\R"] {
            for d in subdirs(Path::new(base)) {
                add(d.join("bin\\R.exe"), "CRAN installer");
            }
        }
        if let Some(local) = dirs::data_local_dir() {
            for d in subdirs(&local.join("Programs\\R")) {
                add(d.join("bin\\R.exe"), "CRAN installer");
            }
        }
    }
    c
}

pub fn python_candidates() -> Vec<(PathBuf, String)> {
    let mut c: Vec<(PathBuf, String)> = vec![];
    let mut add = |p: PathBuf, src: &str| {
        if p.is_file() {
            c.push((p, src.into()));
        }
    };
    // A project-local virtual environment wins.
    if let Ok(cwd) = std::env::current_dir() {
        for venv in [".venv", "venv"] {
            #[cfg(windows)]
            add(cwd.join(venv).join("Scripts\\python.exe"), "venv");
            #[cfg(not(windows))]
            add(cwd.join(venv).join("bin/python"), "venv");
        }
    }
    if let Some(venv) = std::env::var_os("VIRTUAL_ENV") {
        #[cfg(windows)]
        add(PathBuf::from(&venv).join("Scripts\\python.exe"), "venv");
        #[cfg(not(windows))]
        add(PathBuf::from(&venv).join("bin/python"), "venv");
    }
    if let Some(conda) = std::env::var_os("CONDA_PREFIX") {
        #[cfg(windows)]
        add(PathBuf::from(&conda).join("python.exe"), "conda");
        #[cfg(not(windows))]
        add(PathBuf::from(&conda).join("bin/python"), "conda");
    }
    for p in path_candidates(&["python3", "python"]) {
        add(p, "PATH");
    }
    if let Some(home) = dirs::home_dir() {
        for d in subdirs(&home.join(".pyenv/versions")) {
            add(d.join("bin/python"), "pyenv");
        }
        for base in ["miniconda3", "anaconda3", "miniforge3", "mambaforge"] {
            #[cfg(windows)]
            add(home.join(base).join("python.exe"), "conda");
            #[cfg(not(windows))]
            add(home.join(base).join("bin/python"), "conda");
        }
    }
    #[cfg(target_os = "macos")]
    {
        add("/opt/homebrew/bin/python3".into(), "Homebrew");
        add("/usr/local/bin/python3".into(), "Homebrew");
    }
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        for d in subdirs(&local.join("Programs\\Python")) {
            add(d.join("python.exe"), "python.org");
        }
    }
    c
}

/// Parse the probe output `"<version> <TRUE|FALSE|True|False> [extra…]"`.
pub fn parse_probe(out: &str) -> Option<(String, bool)> {
    parse_probe_ext(out).map(|(v, h, _)| (v, h))
}

/// Like `parse_probe`, also returning the rest of the line (may contain spaces).
pub fn parse_probe_ext(out: &str) -> Option<(String, bool, Option<String>)> {
    let line = out.lines().map(str::trim).rfind(|l| !l.is_empty())?;
    let (version, rest) = line.split_once(char::is_whitespace)?;
    if !version.chars().next()?.is_ascii_digit() {
        return None;
    }
    let rest = rest.trim_start();
    let (flag, extra) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let has = matches!(flag, "TRUE" | "True" | "true");
    let extra = extra.trim();
    Some((version.to_string(), has, (!extra.is_empty()).then(|| extra.to_string())))
}

fn rscript_for(r: &Path) -> PathBuf {
    r.with_file_name(format!("Rscript{EXE}"))
}

async fn run_probe(prog: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

pub async fn probe(lang: Lang, path: PathBuf, source: String) -> Option<Interpreter> {
    let (version, has_kernel, kernel_lib) = match lang {
        Lang::R => {
            let rs = rscript_for(&path);
            let out = run_probe(
                &rs,
                &[
                    "--vanilla",
                    "-e",
                    "ok <- requireNamespace('IRkernel', quietly=TRUE); cat(paste(R.version$major, R.version$minor, sep='.'), ok, if (ok) dirname(system.file(package='IRkernel')) else '')",
                ],
            )
            .await?;
            parse_probe_ext(&out)?
        }
        Lang::Python => {
            let out = run_probe(
                &path,
                &["-c", "import sys,importlib.util as u;print(sys.version.split()[0], u.find_spec('ipykernel') is not None)"],
            )
            .await?;
            let (v, h) = parse_probe(&out)?;
            (v, h, None)
        }
    };
    let install_hint = (!has_kernel).then(|| match lang {
        Lang::R => format!(
            "\"{}\" -e \"install.packages('IRkernel', repos='https://cloud.r-project.org')\"",
            rscript_for(&path).display()
        ),
        Lang::Python => format!("\"{}\" -m pip install ipykernel", path.display()),
    });
    Some(Interpreter { lang, path, version, has_kernel, source, install_hint, kernel_lib })
}

fn dedupe(cands: Vec<(PathBuf, String)>) -> Vec<(PathBuf, String)> {
    let mut seen = HashSet::new();
    cands
        .into_iter()
        .filter(|(p, _)| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

/// Probe all candidates concurrently. Interpreters with a kernel come first.
pub async fn detect_all() -> Vec<Interpreter> {
    let mut handles = vec![];
    for (lang, cands) in [(Lang::R, r_candidates()), (Lang::Python, python_candidates())] {
        for (p, src) in dedupe(cands).into_iter().take(8) {
            handles.push(tokio::spawn(probe(lang, p, src)));
        }
    }
    let mut out = vec![];
    for h in handles {
        if let Ok(Some(i)) = h.await {
            out.push(i);
        }
    }
    out.sort_by_key(|i| (i.lang.as_str(), !i.has_kernel));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_r_probe() {
        assert_eq!(parse_probe("4.3.3 TRUE"), Some(("4.3.3".into(), true)));
        assert_eq!(parse_probe("Loading...\n4.4.1 FALSE\n"), Some(("4.4.1".into(), false)));
    }

    #[test]
    fn parses_python_probe() {
        assert_eq!(parse_probe("3.13.1 True\n"), Some(("3.13.1".into(), true)));
        assert_eq!(parse_probe("3.11.0 False"), Some(("3.11.0".into(), false)));
    }

    #[test]
    fn parses_extra_fields_with_spaces() {
        assert_eq!(
            parse_probe_ext("4.4.1 TRUE C:/Program Files/R/library"),
            Some(("4.4.1".into(), true, Some("C:/Program Files/R/library".into())))
        );
        assert_eq!(parse_probe_ext("4.4.1 FALSE "), Some(("4.4.1".into(), false, None)));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_probe(""), None);
        assert_eq!(parse_probe("Error: something"), None);
    }

    #[test]
    fn rscript_is_sibling() {
        let r = PathBuf::from("/opt/R/4.4/bin/R");
        assert_eq!(rscript_for(&r), PathBuf::from(format!("/opt/R/4.4/bin/Rscript{EXE}")));
    }
}
