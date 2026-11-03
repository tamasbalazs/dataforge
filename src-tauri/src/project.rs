//! Project inspection: which environments (renv, venv, uv, conda) a folder uses.

use crate::envdetect::{self, Interpreter};
use crate::kernel::Lang;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RProject {
    /// renv.lock or renv/activate.R present.
    pub renv: bool,
    pub renv_lock: bool,
    /// *.Rproj file name, if any.
    pub rproj: Option<String>,
    pub description: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PyProject {
    /// Virtual environments inside the project, probed (version, ipykernel).
    pub venvs: Vec<Interpreter>,
    pub pyproject: bool,
    pub uv_lock: bool,
    pub requirements: bool,
    pub environment_yml: bool,
    /// `uv` executable, if installed.
    pub uv: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub name: String,
    pub git: bool,
    pub r: RProject,
    pub python: PyProject,
}

#[cfg(windows)]
fn venv_python(dir: &Path) -> PathBuf {
    dir.join("Scripts").join("python.exe")
}
#[cfg(not(windows))]
fn venv_python(dir: &Path) -> PathBuf {
    dir.join("bin").join("python")
}

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

/// Candidate virtual environment directories in a project.
pub fn venv_dirs(root: &Path) -> Vec<PathBuf> {
    [".venv", "venv", "env", ".env"]
        .iter()
        .map(|d| root.join(d))
        .filter(|d| venv_python(d).is_file() && d.join("pyvenv.cfg").is_file())
        .collect()
}

pub async fn inspect(root: &Path) -> ProjectInfo {
    let has = |f: &str| root.join(f).exists();
    let rproj = std::fs::read_dir(root)
        .ok()
        .and_then(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).find(|n| n.ends_with(".Rproj")));
    let mut venvs = vec![];
    for dir in venv_dirs(root) {
        if let Some(i) = envdetect::probe(Lang::Python, venv_python(&dir), "venv".into()).await {
            venvs.push(i);
        }
    }
    ProjectInfo {
        root: root.to_path_buf(),
        name: root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.display().to_string()),
        git: has(".git"),
        r: RProject { renv: has("renv.lock") || has("renv/activate.R"), renv_lock: has("renv.lock"), rproj, description: has("DESCRIPTION") },
        python: PyProject {
            venvs,
            pyproject: has("pyproject.toml"),
            uv_lock: has("uv.lock"),
            requirements: has("requirements.txt"),
            environment_yml: has("environment.yml"),
            uv: find_in_path("uv"),
        },
    }
}

/// Program + args that create a virtual environment with ipykernel.
pub fn create_venv_steps(root: &Path, python: &Path, uv: Option<&Path>) -> Vec<(PathBuf, Vec<String>)> {
    let venv = root.join(".venv");
    let vpy = venv_python(&venv);
    let s = |p: &Path| p.to_string_lossy().to_string();
    match uv {
        Some(uv) => vec![
            (uv.to_path_buf(), vec!["venv".into(), "--seed".into(), "--python".into(), s(python), s(&venv)]),
            (uv.to_path_buf(), vec!["pip".into(), "install".into(), "--python".into(), s(&vpy), "ipykernel".into()]),
        ],
        None => vec![
            (python.to_path_buf(), vec!["-m".into(), "venv".into(), s(&venv)]),
            (vpy.clone(), vec!["-m".into(), "pip".into(), "install".into(), "ipykernel".into()]),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn inspects_markers() {
        let d = std::env::temp_dir().join(format!("df-proj-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(d.join("renv")).unwrap();
        std::fs::write(d.join("renv/activate.R"), "").unwrap();
        std::fs::write(d.join("analysis.Rproj"), "").unwrap();
        std::fs::write(d.join("pyproject.toml"), "").unwrap();
        std::fs::write(d.join("uv.lock"), "").unwrap();
        let info = inspect(&d).await;
        assert!(info.r.renv && !info.r.renv_lock);
        assert_eq!(info.r.rproj.as_deref(), Some("analysis.Rproj"));
        assert!(info.python.pyproject && info.python.uv_lock && !info.python.requirements);
        assert!(info.python.venvs.is_empty());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn venv_steps_prefer_uv() {
        let root = Path::new("/p");
        let steps = create_venv_steps(root, Path::new("/usr/bin/python3"), Some(Path::new("/bin/uv")));
        assert_eq!(steps[0].0, PathBuf::from("/bin/uv"));
        assert_eq!(steps[0].1[0], "venv");
        let steps = create_venv_steps(root, Path::new("/usr/bin/python3"), None);
        assert_eq!(steps[0].1, ["-m", "venv", "/p/.venv"]);
        assert!(steps[1].0.ends_with("bin/python") || steps[1].0.ends_with("python.exe"));
    }
}
