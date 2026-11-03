//! File system operations for the Files panel, plus a project watcher.

use anyhow::{bail, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified: Option<u64>,
    pub hidden: bool,
}

/// Directories that are never interesting to browse and can be huge.
const SKIP: &[&str] = &[".git", "node_modules", "__pycache__", ".Rproj.user", ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache"];

/// Changes worth reporting: anything outside the skipped folders, plus the
/// repository state files (so commits/checkouts made in a terminal refresh the Git panel).
pub fn is_interesting(p: &Path) -> bool {
    let comps: Vec<String> = p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    match comps.iter().position(|c| SKIP.contains(&c.as_str())) {
        None => true,
        Some(i) if comps[i] == ".git" => {
            let rest = &comps[i + 1..];
            matches!(rest.first().map(String::as_str), Some("HEAD" | "index" | "MERGE_HEAD" | "ORIG_HEAD" | "refs"))
                && !rest.last().is_some_and(|f| f.ends_with(".lock"))
        }
        _ => false,
    }
}

pub fn list_dir(dir: &Path, show_hidden: bool) -> Result<Vec<Entry>> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir)? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().to_string();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let hidden = name.starts_with('.');
        if hidden && !show_hidden {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        out.push(Entry {
            name,
            path: e.path(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
            hidden,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_key(&a.name).cmp(&natural_key(&b.name))));
    Ok(out)
}

/// Case-insensitive ordering where digit runs compare numerically ("file2" < "file10").
pub fn natural_key(s: &str) -> Vec<(u8, String)> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut digits = false;
    for c in s.chars() {
        if c.is_ascii_digit() != digits && !cur.is_empty() {
            out.push(if digits { (0, format!("{:0>20}", cur)) } else { (1, cur.to_lowercase()) });
            cur.clear();
        }
        digits = c.is_ascii_digit();
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(if digits { (0, format!("{:0>20}", cur)) } else { (1, cur.to_lowercase()) });
    }
    out
}

fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        bail!("invalid name: {name}");
    }
    Ok(())
}

pub fn create(parent: &Path, name: &str, dir: bool) -> Result<PathBuf> {
    check_name(name)?;
    let p = parent.join(name);
    if p.exists() {
        bail!("{} already exists", p.display());
    }
    if dir {
        std::fs::create_dir(&p)?;
    } else {
        std::fs::File::create(&p)?;
    }
    Ok(p)
}

pub fn rename(path: &Path, new_name: &str) -> Result<PathBuf> {
    check_name(new_name)?;
    let target = path.with_file_name(new_name);
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::rename(path, &target)?;
    Ok(target)
}

/// Move to the OS trash (recoverable), never a hard delete.
pub fn to_trash(path: &Path) -> Result<()> {
    trash::delete(path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Watcher

pub type ChangeSink = Arc<dyn Fn(Vec<PathBuf>) + Send + Sync>;

#[derive(Default)]
pub struct ProjectWatcher {
    inner: Mutex<Option<RecommendedWatcher>>,
}

impl ProjectWatcher {
    /// Watch `root` recursively; changes are batched for 250 ms.
    pub fn watch(&self, root: &Path, sink: ChangeSink) -> Result<()> {
        let pending: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(vec![]));
        let flush_scheduled = Arc::new(Mutex::new(false));
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            let interesting: Vec<PathBuf> = ev
                .paths
                .into_iter()
                .filter(|p| is_interesting(p))
                .collect();
            if interesting.is_empty() {
                return;
            }
            pending.lock().unwrap().extend(interesting);
            let mut scheduled = flush_scheduled.lock().unwrap();
            if !*scheduled {
                *scheduled = true;
                let pending = pending.clone();
                let flag = flush_scheduled.clone();
                let sink = sink.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(250));
                    let mut batch: Vec<PathBuf> = std::mem::take(&mut *pending.lock().unwrap());
                    *flag.lock().unwrap() = false;
                    batch.sort();
                    batch.dedup();
                    sink(batch);
                });
            }
        })?;
        w.watch(root, RecursiveMode::Recursive)?;
        *self.inner.lock().unwrap() = Some(w);
        Ok(())
    }

    pub fn stop(&self) {
        self.inner.lock().unwrap().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("df-fs-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_dirs_first_with_natural_order() {
        let d = tmp();
        for f in ["file10.R", "file2.R", "B.py", ".hidden"] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        std::fs::create_dir(d.join("zdir")).unwrap();
        std::fs::create_dir(d.join(".git")).unwrap();
        let names: Vec<String> = list_dir(&d, false).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["zdir", "B.py", "file2.R", "file10.R"]);
        let with_hidden: Vec<String> = list_dir(&d, true).unwrap().into_iter().map(|e| e.name).collect();
        assert!(with_hidden.contains(&".hidden".to_string()));
        assert!(!with_hidden.contains(&".git".to_string()));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn create_and_rename_validate_names() {
        let d = tmp();
        let f = create(&d, "a.R", false).unwrap();
        assert!(f.is_file());
        assert!(create(&d, "a.R", false).is_err());
        assert!(create(&d, "../x", false).is_err());
        let g = rename(&f, "b.R").unwrap();
        assert!(g.is_file() && !f.exists());
        assert!(rename(&g, "sub/c.R").is_err());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn git_state_files_are_interesting() {
        assert!(is_interesting(Path::new("/p/a.R")));
        assert!(is_interesting(Path::new("/p/.git/HEAD")));
        assert!(is_interesting(Path::new("/p/.git/refs/heads/main")));
        assert!(!is_interesting(Path::new("/p/.git/objects/ab/cdef")));
        assert!(!is_interesting(Path::new("/p/.git/index.lock")));
        assert!(!is_interesting(Path::new("/p/node_modules/x/index.js")));
    }

    #[test]
    fn watcher_reports_changes() {
        let d = tmp();
        let seen: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let w = ProjectWatcher::default();
        w.watch(&d, Arc::new(move |p| s2.lock().unwrap().extend(p))).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(d.join("new.csv"), "a,b").unwrap();
        for _ in 0..40 {
            if seen.lock().unwrap().iter().any(|p| p.ends_with("new.csv")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(seen.lock().unwrap().iter().any(|p| p.ends_with("new.csv")));
        w.stop();
        std::fs::remove_dir_all(d).unwrap();
    }
}
