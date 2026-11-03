//! Extension packages (.dfext = zip with dataforge-extension.json at the root
//! or inside a single top-level folder): safe extraction and removal.

use anyhow::{anyhow, Result};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = "dataforge-extension.json";
const MAX_TOTAL: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 5000;

pub fn valid_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let ok = |p: &str| !p.is_empty() && p.len() <= 60 && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !p.starts_with('-');
    matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if ok(a) && ok(b))
}

/// Install (or update) a .dfext package into `root/<id>`; returns the id.
pub fn install_zip(package: &Path, root: &Path) -> Result<String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(package)?)?;
    if zip.len() > MAX_FILES {
        return Err(anyhow!("the package has too many files"));
    }
    // Where is the manifest? At the root, or under one top-level folder.
    let names: Vec<String> = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string())).collect();
    let prefix = if names.iter().any(|n| n == MANIFEST) {
        String::new()
    } else {
        let candidates: Vec<&String> = names.iter().filter(|n| n.ends_with(&format!("/{MANIFEST}")) && n.matches('/').count() == 1).collect();
        match candidates.as_slice() {
            [one] => one.trim_end_matches(MANIFEST).to_string(),
            _ => return Err(anyhow!("{MANIFEST} not found in the package")),
        }
    };
    let manifest: serde_json::Value = {
        let f = zip.by_name(&format!("{prefix}{MANIFEST}"))?;
        let mut s = String::new();
        f.take(1 << 20).read_to_string(&mut s)?;
        serde_json::from_str(&s)?
    };
    let id = manifest["id"].as_str().unwrap_or_default().to_string();
    if !valid_id(&id) {
        return Err(anyhow!("invalid extension id {id:?}"));
    }
    std::fs::create_dir_all(root)?;
    let staging = root.join(format!(".install-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<()> {
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i)?;
            // enclosed_name() rejects absolute paths and `..` (zip-slip).
            let Some(rel) = f.enclosed_name() else { return Err(anyhow!("unsafe path in package: {}", f.name())) };
            let Ok(rel) = rel.strip_prefix(&prefix) else { continue };
            if rel.as_os_str().is_empty() || f.is_symlink() {
                continue;
            }
            let target = staging.join(rel);
            if f.is_dir() {
                std::fs::create_dir_all(&target)?;
                continue;
            }
            total += f.size();
            if total > MAX_TOTAL {
                return Err(anyhow!("the package is larger than {} MB", MAX_TOTAL >> 20));
            }
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut out = std::fs::File::create(&target)?;
            std::io::copy(&mut (&mut f).take(MAX_TOTAL), &mut out)?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let dest = root.join(&id);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    std::fs::rename(&staging, &dest)?;
    Ok(id)
}

pub fn uninstall(root: &Path, id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(anyhow!("invalid extension id"));
    }
    let dir: PathBuf = root.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(path: &Path, files: &[(&str, &str)]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, body) in files {
            z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn installs_updates_and_removes() {
        let d = std::env::temp_dir().join(format!("df-ext-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let root = d.join("extensions");
        let pkg = d.join("a.dfext");
        make_zip(&pkg, &[("hello/dataforge-extension.json", r#"{"id":"acme.hello","name":"x","version":"1.0.0"}"#), ("hello/main.js", "export function activate(){}")]);
        assert_eq!(install_zip(&pkg, &root).unwrap(), "acme.hello");
        assert!(root.join("acme.hello/main.js").exists());
        // Update in place (manifest at the root this time).
        make_zip(&pkg, &[("dataforge-extension.json", r#"{"id":"acme.hello","name":"x","version":"1.1.0"}"#)]);
        install_zip(&pkg, &root).unwrap();
        assert!(!root.join("acme.hello/main.js").exists(), "old files are replaced");
        uninstall(&root, "acme.hello").unwrap();
        assert!(!root.join("acme.hello").exists());
        assert!(uninstall(&root, "../etc").is_err());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rejects_bad_packages() {
        let d = std::env::temp_dir().join(format!("df-ext-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let root = d.join("extensions");
        let pkg = d.join("b.dfext");
        make_zip(&pkg, &[("dataforge-extension.json", r#"{"id":"../evil","name":"x","version":"1.0.0"}"#)]);
        assert!(install_zip(&pkg, &root).is_err());
        make_zip(&pkg, &[("dataforge-extension.json", r#"{"id":"acme.slip","name":"x","version":"1.0.0"}"#), ("../../outside.txt", "x")]);
        assert!(install_zip(&pkg, &root).is_err());
        assert!(!d.join("outside.txt").exists() && !root.join("acme.slip").exists());
        make_zip(&pkg, &[("readme.txt", "no manifest")]);
        assert!(install_zip(&pkg, &root).is_err());
        assert!(valid_id("dataforge.data-summary") && !valid_id("Upper.case") && !valid_id("a.b.c"));
        std::fs::remove_dir_all(d).unwrap();
    }
}

#[cfg(test)]
mod manual {
    /// Installs a package with the real installer: DF_INSTALL_PKG=… DF_INSTALL_ROOT=… cargo test install_from_env -- --ignored
    #[test]
    #[ignore]
    fn install_from_env() {
        let pkg = std::env::var("DF_INSTALL_PKG").expect("DF_INSTALL_PKG");
        let root = std::env::var("DF_INSTALL_ROOT").expect("DF_INSTALL_ROOT");
        println!("installed {}", super::install_zip(std::path::Path::new(&pkg), std::path::Path::new(&root)).unwrap());
    }
}
