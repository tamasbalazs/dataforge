//! Language-specific knowledge: how to launch a kernel, how to inject the
//! DataForge helper and how to call helper functions silently.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const R_HELPER: &str = include_str!("../../helpers/dataforge.R");
pub const PY_HELPER: &str = include_str!("../../helpers/dataforge_kernel.py");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    R,
    Python,
}

impl Lang {
    pub fn as_str(&self) -> &'static str {
        match self {
            Lang::R => "r",
            Lang::Python => "python",
        }
    }

    /// Program + arguments that start a kernel for the given interpreter.
    /// `kernel_lib` (R only) is the library holding IRkernel; it is appended to
    /// the library path so projects with their own library (renv) still start.
    pub fn launch_command(&self, interpreter: &Path, connection_file: &Path, kernel_lib: Option<&str>) -> (String, Vec<String>) {
        let conn = connection_file.to_string_lossy().to_string();
        let exe = interpreter.to_string_lossy().to_string();
        match self {
            Lang::R => {
                let main = match kernel_lib {
                    Some(lib) => format!(".libPaths(unique(c(.libPaths(), {}))); IRkernel::main()", quote_single(lib)),
                    None => "IRkernel::main()".into(),
                };
                (exe, vec!["--slave".into(), "-e".into(), main, "--args".into(), conn])
            }
            Lang::Python => (exe, vec!["-m".into(), "ipykernel_launcher".into(), "-f".into(), conn]),
        }
    }

    /// Code executed once (silently) after the kernel is up.
    pub fn init_code(&self) -> &'static str {
        match self {
            Lang::R => R_HELPER,
            Lang::Python => PY_HELPER,
        }
    }

    /// Code that calls helper function `func` with JSON-encoded keyword args
    /// and writes a JSON result envelope to `out` (or prints it between
    /// markers when `out` is empty: remote kernels).
    pub fn call_code(&self, func: &str, args_json: &str, out: &Path) -> String {
        let out = out.to_string_lossy();
        match self {
            Lang::R => format!(
                ".dataforge$call({}, {}, {})",
                quote_single(func),
                quote_single(args_json),
                quote_single(&out)
            ),
            Lang::Python => format!(
                "__import__('_dataforge').call({}, {}, {})",
                quote_single(func),
                quote_single(args_json),
                quote_single(&out)
            ),
        }
    }
}

/// Single-quoted string literal valid in both R and Python.
pub fn quote_single(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_escapes_specials() {
        assert_eq!(quote_single(r#"a'b\c"#), r#"'a\'b\\c'"#);
        assert_eq!(quote_single("x\ny"), "'x\\ny'");
    }

    #[test]
    fn call_code_is_language_specific() {
        let p = Path::new("/tmp/o.json");
        assert_eq!(
            Lang::R.call_code("env_list", "{}", p),
            ".dataforge$call('env_list', '{}', '/tmp/o.json')"
        );
        assert!(Lang::Python.call_code("env_list", "{}", p).starts_with("__import__('_dataforge').call("));
    }

    #[test]
    fn launch_commands() {
        let (prog, args) = Lang::Python.launch_command(Path::new("/usr/bin/python3"), Path::new("/c.json"), None);
        assert_eq!(prog, "/usr/bin/python3");
        assert_eq!(args, ["-m", "ipykernel_launcher", "-f", "/c.json"]);
        let (_, args) = Lang::R.launch_command(Path::new("R"), Path::new("/c.json"), None);
        assert_eq!(args.last().unwrap(), "/c.json");
        let (_, args) = Lang::R.launch_command(Path::new("R"), Path::new("/c.json"), Some("/usr/lib/R/site-library"));
        assert_eq!(args[2], ".libPaths(unique(c(.libPaths(), '/usr/lib/R/site-library'))); IRkernel::main()");
    }
}
