//! Program lookup on the user's real PATH.
//!
//! Extensions holding the `unsafe` grant spawn child processes by name, and
//! resolving that name is the one piece the host must own: it is identical for
//! every extension and it depends on how the app was launched, which the guest
//! cannot see.
//!
//! Writer deliberately keeps **no list of AI harnesses here**. Which agents
//! exist, what flags they take, and which package versions are pinned are facts
//! about the AI ecosystem rather than about Writer, and they change on a
//! different cadence than the app ships. That list lives in the extension that
//! actually speaks the protocol (`extensions/ai-chat/src/acp/harnesses.ts`), so
//! adding a harness is an extension update rather than a Writer release.
//! A second copy here would only guarantee the two drift apart.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Resolve `program` to an absolute path using the *user's* PATH.
///
/// This cannot just read `std::env::var("PATH")`. A macOS app launched from
/// Finder or Spotlight inherits launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), not the login shell's. Copilot installs to
/// `~/.local/bin` and Node version managers live under `~/.nvm`, `~/.bun`, or
/// Homebrew, so a naive lookup finds nothing in a packaged build while working
/// perfectly under `cargo run` from a terminal.
pub fn resolve_program(program: &str) -> Option<PathBuf> {
    // Reject anything with a separator: presets are bare program names, and a
    // path here would mean the lookup is being fed something it should not be.
    if program.is_empty() || program.contains('/') {
        return None;
    }

    search_path()
        .iter()
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Directories to search, in priority order: the inherited PATH first, then the
/// login shell's PATH, then well-known install locations as a final fallback.
fn search_path() -> &'static [PathBuf] {
    static CACHE: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = Vec::new();
        let mut push = |dir: PathBuf| {
            if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        };

        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                push(dir);
            }
        }
        for dir in login_shell_path() {
            push(dir);
        }
        for dir in well_known_dirs() {
            push(dir);
        }
        dirs
    })
}

/// Ask the user's login shell what its PATH is.
///
/// This runs the user's own rc files, which is the same trust level as the app
/// itself and is what editors (Zed, VS Code) do for the identical reason.
///
/// Three details are load-bearing, each found by running this under a
/// launchd-like `PATH=/usr/bin:/bin:/usr/sbin:/sbin`:
///
/// 1. `-i` (interactive) is **required**, not optional. Node version managers
///    (nvm, fnm) and similar tools initialise in `.zshrc`/`.bashrc`, which a
///    login-only shell never sources. With `-lc` alone, `npx` was invisible and
///    both npx-based presets reported unavailable.
/// 2. Interactive shells print prompts, motd banners and job-control noise onto
///    stdout, so the PATH is bracketed by sentinels and parsed out rather than
///    trusting the whole of stdout.
/// 3. The probe is bounded by a timeout with stdin closed. An interactive shell
///    whose rc file waits on input would otherwise hang forever, and this runs
///    on the way to answering a capability call.
#[cfg(unix)]
fn login_shell_path() -> Vec<PathBuf> {
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    const BEGIN: &str = "__WRITER_PATH_BEGIN__";
    const END: &str = "__WRITER_PATH_END__";
    const TIMEOUT: Duration = Duration::from_secs(5);

    let Some(shell) = std::env::var_os("SHELL") else {
        return Vec::new();
    };

    let script = format!("printf '{BEGIN}%s{END}' \"$PATH\"");
    let child = Command::new(&shell)
        .args(["-ilc", &script])
        // Signals to rc files that this is a non-interactive probe, so a
        // well-behaved config can skip slow or interactive setup.
        .env("WRITER_PATH_PROBE", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();

    let Ok(child) = child else {
        return Vec::new();
    };

    // `wait_with_output` has no timeout, so it runs on a worker thread and the
    // caller gives up rather than blocking indefinitely.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let Ok(Ok(output)) = rx.recv_timeout(TIMEOUT) else {
        // The orphaned probe exits on its own; PATH resolution falls back to
        // the well-known directories.
        return Vec::new();
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(path) = stdout
        .split_once(BEGIN)
        .and_then(|(_, rest)| rest.split_once(END))
        .map(|(path, _)| path)
    else {
        return Vec::new();
    };

    std::env::split_paths(path.trim()).collect()
}

#[cfg(not(unix))]
fn login_shell_path() -> Vec<PathBuf> {
    Vec::new()
}

/// Last-resort locations, covering the installers the presets recommend.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_paths_and_empty_input() {
        // A bare program name is looked up on PATH; anything containing a
        // separator is a path being smuggled through a name-only API, and
        // resolving it would silently widen what can be launched.
        assert!(resolve_program("").is_none());
        assert!(resolve_program("/bin/sh").is_none());
        assert!(resolve_program("../../bin/sh").is_none());
        assert!(resolve_program("dir/prog").is_none());
    }

    #[test]
    fn resolve_finds_a_standard_binary() {
        // `sh` is on PATH on every platform this app targets. If this fails,
        // PATH discovery itself is broken.
        let found = resolve_program("sh").expect("sh should resolve");
        assert!(found.is_absolute());
        assert!(found.ends_with("sh"));
    }

    #[test]
    fn resolve_reports_missing_programs_as_none() {
        assert!(resolve_program("writer-definitely-not-a-real-program").is_none());
    }

    /// Not a test: a probe for checking PATH discovery under a minimal
    /// environment, which is what a Finder-launched app actually gets.
    ///
    ///   cargo test -p writer which::tests::print_detection -- --ignored --nocapture
    #[test]
    #[ignore]
    fn print_detection() {
        for program in ["copilot", "npx", "gemini", "node"] {
            println!("{program}: {:?}", resolve_program(program));
        }
        println!("search path: {:#?}", search_path());
    }
}
