//! Reproducibility export: project file inventory, SHA-256 checksums and
//! writing the bundle (ZIP archive or plain folder).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Folders that are environments or caches, never part of a project's content.
const SKIP_DIRS: &[&str] = &[
    ".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".Rproj.user", ".ipynb_checkpoints",
    ".mypy_cache", ".pytest_cache", ".quarto", ".ruff_cache", ".tox", "_freeze",
];

#[derive(Debug, Clone, Serialize)]
pub struct ProjectFile {
    /// Path relative to the project root, with forward slashes.
    pub path: String,
    pub size: u64,
}

pub fn is_skipped(rel: &Path) -> bool {
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    parts.iter().any(|p| SKIP_DIRS.contains(&p.as_str()))
        // renv's library and staging are reinstalled from renv.lock
        || (parts.first().map(String::as_str) == Some("renv") && parts.get(1).is_some_and(|p| p == "library" || p == "staging" || p == "local" || p == "sandbox"))
}

/// Every file of the project (environments and caches excluded), sorted.
/// `limit` guards against accidentally pointing at a home folder.
pub fn list_files(root: &Path, limit: usize) -> Result<Vec<ProjectFile>> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap_or(&p).to_path_buf();
            if is_skipped(&rel) {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(ProjectFile { path: rel.to_string_lossy().replace('\\', "/"), size });
                if out.len() > limit {
                    return Err(anyhow!("more than {limit} files — is this really a project folder?"));
                }
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// One file of the bundle: copied from disk, or generated text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntry {
    /// Path inside the bundle, forward slashes.
    pub name: String,
    pub source: Option<PathBuf>,
    pub text: Option<String>,
    #[serde(default)]
    pub executable: bool,
}

fn safe_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.starts_with('/') || name.split('/').any(|p| p == ".." || p.is_empty()) || name.contains('\\') || name.contains(':') {
        return Err(anyhow!("invalid bundle path {name}"));
    }
    Ok(name)
}

/// Write the bundle as a .zip (if `dest` ends in .zip) or as a folder.
/// Returns the number of bytes written (uncompressed).
pub fn write_bundle(dest: &Path, entries: &[BundleEntry]) -> Result<u64> {
    for e in entries {
        safe_name(&e.name)?;
    }
    let mut total = 0u64;
    let is_zip = dest.extension().is_some_and(|x| x.eq_ignore_ascii_case("zip"));
    if is_zip {
        let tmp = dest.with_extension("zip.part");
        let file = std::fs::File::create(&tmp)?;
        let mut zw = zip::ZipWriter::new(file);
        for e in entries {
            let mode = if e.executable { 0o755 } else { 0o644 };
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(mode)
                .large_file(true);
            zw.start_file(e.name.as_str(), opts)?;
            total += copy_entry(e, &mut zw)?;
        }
        zw.finish()?;
        std::fs::rename(&tmp, dest)?;
    } else {
        if dest.exists() && std::fs::read_dir(dest)?.next().is_some() {
            return Err(anyhow!("the folder {} is not empty", dest.display()));
        }
        for e in entries {
            let target = dest.join(&e.name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&target)?;
            total += copy_entry(e, &mut f)?;
            #[cfg(unix)]
            if e.executable {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    Ok(total)
}

fn copy_entry(e: &BundleEntry, w: &mut dyn Write) -> Result<u64> {
    if let Some(text) = &e.text {
        w.write_all(text.as_bytes())?;
        Ok(text.len() as u64)
    } else if let Some(src) = &e.source {
        let mut f = std::fs::File::open(src)?;
        Ok(std::io::copy(&mut f, w)?)
    } else {
        Err(anyhow!("bundle entry {} has no content", e.name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("df-repro-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_project_files_without_environments() {
        let d = tmp();
        for p in ["a.R", "data/x.csv", ".venv/lib/site.py", "renv/library/pkg/DESCRIPTION", "renv/activate.R", "sub/__pycache__/m.pyc", "árvíz.py"] {
            let f = d.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
        let files: Vec<String> = list_files(&d, 1000).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(files, vec!["a.R", "data/x.csv", "renv/activate.R", "árvíz.py"]);
        assert!(list_files(&d, 2).is_err());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn hashes_and_writes_zip_and_folder() {
        let d = tmp();
        std::fs::write(d.join("data.csv"), "a,b\n1,2\n").unwrap();
        assert_eq!(sha256_file(&d.join("data.csv")).unwrap(), "492d5ea496056f1a6a6592241032fab764c321596317930b4fa0e1e8bc3b7470");
        let entries = vec![
            BundleEntry { name: "project/data.csv".into(), source: Some(d.join("data.csv")), text: None, executable: false },
            BundleEntry { name: "reproduce.sh".into(), source: None, text: Some("#!/bin/sh\necho ok\n".into()), executable: true },
        ];
        let zip_path = d.join("out.zip");
        write_bundle(&zip_path, &entries).unwrap();
        let mut z = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        let mut s = String::new();
        z.by_name("project/data.csv").unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, "a,b\n1,2\n");
        assert_eq!(z.by_name("reproduce.sh").unwrap().unix_mode().unwrap() & 0o777, 0o755);
        let folder = d.join("bundle");
        write_bundle(&folder, &entries).unwrap();
        assert_eq!(std::fs::read_to_string(folder.join("reproduce.sh")).unwrap(), "#!/bin/sh\necho ok\n");
        assert!(write_bundle(&folder, &entries).is_err(), "refuses a non-empty folder");
        let bad = vec![BundleEntry { name: "../evil".into(), source: None, text: Some("x".into()), executable: false }];
        assert!(write_bundle(&d.join("bad.zip"), &bad).is_err());
        std::fs::remove_dir_all(d).unwrap();
    }
}
