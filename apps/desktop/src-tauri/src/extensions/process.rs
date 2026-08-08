//! Generic child-process primitives for `unsafe` extensions.
//!
//! These are the escape hatch that lets an extension integrate with something
//! the host has no business knowing about - an external agent over stdio, a
//! language server, a local model runner - without the host growing a bespoke
//! capability per integration.
//!
//! # Why there is no allowlist
//!
//! Every other capability in Writer is narrowed: paths are contained, network
//! hosts are matched against a declared list. This one is not, and that is
//! deliberate. A meaningful allowlist for process spawning is not achievable -
//! a permitted interpreter runs arbitrary code, a permitted shell runs anything
//! at all - so a partial gate would imply a guarantee that does not exist.
//! Instead, access is all-or-nothing behind [`CapabilityGrant::Unsafe`], which
//! the user consents to explicitly with the extension's stated reason in front
//! of them.
//!
//! What is still enforced: only extensions holding that grant reach this module
//! at all, handles are per-extension so one extension cannot touch another's
//! child, and every child is killed when the extension's processes are reaped.

use crate::error::AppError;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Cap on buffered child output, so a chatty or wedged process cannot grow the
/// host's memory without bound while an extension is slow to poll.
const MAX_BUFFERED_LINES: usize = 4096;

struct ChildProcess {
    /// Extension that spawned it. Handles are namespaced by this so one
    /// extension cannot read from or kill another's child.
    owner: String,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
    exited: Arc<Mutex<Option<i32>>>,
}

/// Process table, managed by Tauri.
#[derive(Default)]
pub struct ProcessTable {
    children: Mutex<HashMap<u64, ChildProcess>>,
    next_handle: AtomicU64,
}

impl ProcessTable {
    fn spawn(&self, owner: &str, program: &str, args: &[String]) -> Result<u64, AppError> {
        // Resolve through the same login-shell-aware lookup the rest of the app
        // uses. A GUI-launched app inherits launchd's minimal PATH, so bare
        // program names would otherwise fail in a packaged build while working
        // in development.
        let resolved = super::which::resolve_program(program)
            .ok_or_else(|| AppError::NotFound(format!("{program:?} was not found on PATH")))?;

        let mut child = Command::new(&resolved)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| AppError::Unavailable(format!("could not start {program:?}: {err}")))?;

        let stdin = child.stdin.take();
        let stdout_buf = Arc::new(Mutex::new(Vec::new()));
        let stderr_buf = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(Mutex::new(None));

        // Reader threads. The guest polls, so output has to be drained
        // continuously regardless: a child that fills its stdout pipe while
        // nobody reads it will block forever on write.
        if let Some(stdout) = child.stdout.take() {
            spawn_reader(stdout, Arc::clone(&stdout_buf));
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_reader(stderr, Arc::clone(&stderr_buf));
        }

        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed) + 1;
        self.children.lock().insert(
            handle,
            ChildProcess {
                owner: owner.to_string(),
                child,
                stdin,
                stdout: stdout_buf,
                stderr: stderr_buf,
                exited,
            },
        );
        Ok(handle)
    }

    /// Look up a handle, refusing handles belonging to another extension.
    fn with_owned<T>(
        &self,
        owner: &str,
        handle: u64,
        func: impl FnOnce(&mut ChildProcess) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut children = self.children.lock();
        let child = children
            .get_mut(&handle)
            .filter(|child| child.owner == owner)
            // Deliberately indistinguishable from "no such handle": telling one
            // extension that a handle exists but belongs to someone else leaks
            // what else is running.
            .ok_or_else(|| AppError::NotFound(format!("unknown process handle {handle}")))?;
        func(child)
    }

    /// Kill and reap every process owned by an extension.
    pub fn reap(&self, owner: &str) {
        let mut children = self.children.lock();
        let handles: Vec<u64> = children
            .iter()
            .filter(|(_, child)| child.owner == owner)
            .map(|(handle, _)| *handle)
            .collect();
        for handle in handles {
            if let Some(mut child) = children.remove(&handle) {
                let _ = child.child.kill();
                let _ = child.child.wait();
            }
        }
    }
}

fn spawn_reader<R: std::io::Read + Send + 'static>(source: R, buffer: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(source);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let mut guard = buffer.lock();
            if guard.len() >= MAX_BUFFERED_LINES {
                // Drop the oldest rather than the newest: for a JSON-RPC stream
                // the recent traffic is what the extension still needs.
                guard.remove(0);
            }
            guard.push(line);
        }
    });
}

pub fn dispatch(
    table: &ProcessTable,
    extension_id: &str,
    method: &str,
    args: &[Value],
) -> Result<Value, AppError> {
    match method {
        "which" => {
            let program = string_arg(args, 0, "program")?;
            Ok(super::which::resolve_program(program)
                .map(|path| json!(path.to_string_lossy().to_string()))
                .unwrap_or(Value::Null))
        }
        "spawn" => {
            let program = string_arg(args, 0, "program")?;
            let spawn_args: Vec<String> = args
                .get(1)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let handle = table.spawn(extension_id, program, &spawn_args)?;
            Ok(json!(handle))
        }
        "write" => {
            let handle = handle_arg(args, 0)?;
            let data = string_arg(args, 1, "data")?;
            table.with_owned(extension_id, handle, |child| {
                let stdin = child
                    .stdin
                    .as_mut()
                    .ok_or_else(|| AppError::Unavailable("process stdin is closed".into()))?;
                stdin.write_all(data.as_bytes())?;
                stdin.flush()?;
                Ok(Value::Null)
            })
        }
        "read" => {
            let handle = handle_arg(args, 0)?;
            table.with_owned(extension_id, handle, |child| {
                let stdout: Vec<String> = std::mem::take(&mut child.stdout.lock());
                let stderr: Vec<String> = std::mem::take(&mut child.stderr.lock());

                // Report exit status without blocking, so a guest polling for
                // output learns that the child died instead of looping forever.
                let mut exited = child.exited.lock();
                if exited.is_none() {
                    if let Ok(Some(status)) = child.child.try_wait() {
                        *exited = Some(status.code().unwrap_or(-1));
                    }
                }

                Ok(json!({
                    "stdout": stdout,
                    "stderr": stderr,
                    "exitCode": *exited,
                }))
            })
        }
        "kill" => {
            let handle = handle_arg(args, 0)?;
            let mut children = table.children.lock();
            match children.get(&handle) {
                Some(child) if child.owner == extension_id => {
                    if let Some(mut child) = children.remove(&handle) {
                        let _ = child.child.kill();
                        let _ = child.child.wait();
                    }
                    Ok(Value::Null)
                }
                // Killing an already-gone process is not an error; the caller's
                // intent is satisfied either way.
                _ => Ok(Value::Null),
            }
        }
        _ => Err(AppError::Denied(format!(
            "unknown process method {method:?}"
        ))),
    }
}

fn string_arg<'a>(args: &'a [Value], index: usize, name: &str) -> Result<&'a str, AppError> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Invalid(format!("missing {name} argument")))
}

fn handle_arg(args: &[Value], index: usize) -> Result<u64, AppError> {
    args.get(index)
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::Invalid("missing process handle argument".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> ProcessTable {
        ProcessTable::default()
    }

    #[test]
    fn which_resolves_and_reports_missing() {
        let table = table();
        let found = dispatch(&table, "ext", "which", &[json!("sh")]).unwrap();
        assert!(found.is_string(), "sh should resolve on unix");

        let missing = dispatch(
            &table,
            "ext",
            "which",
            &[json!("definitely-not-a-real-program-xyz")],
        )
        .unwrap();
        assert_eq!(missing, Value::Null);
    }

    #[test]
    fn unknown_methods_are_denied() {
        let table = table();
        let err = dispatch(&table, "ext", "exec", &[]).unwrap_err();
        assert!(matches!(err, AppError::Denied(_)));
    }

    #[test]
    fn spawn_read_and_kill_round_trip() {
        let table = table();
        let handle = dispatch(
            &table,
            "ext",
            "spawn",
            &[json!("sh"), json!(["-c", "echo hello; echo oops >&2"])],
        )
        .unwrap()
        .as_u64()
        .unwrap();

        // Reader threads are asynchronous, so poll rather than assuming the
        // first read observes the output.
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        for _ in 0..100 {
            let output = dispatch(&table, "ext", "read", &[json!(handle)]).unwrap();
            for line in output["stdout"].as_array().unwrap() {
                stdout.push(line.as_str().unwrap().to_string());
            }
            for line in output["stderr"].as_array().unwrap() {
                stderr.push(line.as_str().unwrap().to_string());
            }
            if !stdout.is_empty() && !stderr.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        assert_eq!(stdout, vec!["hello".to_string()]);
        assert_eq!(stderr, vec!["oops".to_string()]);
        dispatch(&table, "ext", "kill", &[json!(handle)]).unwrap();
    }

    #[test]
    fn writes_reach_the_child() {
        let table = table();
        let handle = dispatch(&table, "ext", "spawn", &[json!("cat"), json!([])])
            .unwrap()
            .as_u64()
            .unwrap();

        dispatch(&table, "ext", "write", &[json!(handle), json!("ping\n")]).unwrap();

        let mut seen = Vec::new();
        for _ in 0..100 {
            let output = dispatch(&table, "ext", "read", &[json!(handle)]).unwrap();
            for line in output["stdout"].as_array().unwrap() {
                seen.push(line.as_str().unwrap().to_string());
            }
            if !seen.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(seen, vec!["ping".to_string()]);
        dispatch(&table, "ext", "kill", &[json!(handle)]).unwrap();
    }

    /// Handles are namespaced per extension. Without this, one unsafe extension
    /// could read another's agent traffic just by guessing a small integer.
    #[test]
    fn handles_are_not_reachable_across_extensions() {
        let table = table();
        let handle = dispatch(&table, "owner", "spawn", &[json!("cat"), json!([])])
            .unwrap()
            .as_u64()
            .unwrap();

        for method in ["read", "write", "kill"] {
            let args = if method == "write" {
                vec![json!(handle), json!("x")]
            } else {
                vec![json!(handle)]
            };
            let result = dispatch(&table, "intruder", method, &args);
            if method == "kill" {
                // kill is idempotent by design, but must not actually kill it.
                assert!(result.is_ok());
            } else {
                assert!(
                    matches!(result, Err(AppError::NotFound(_))),
                    "{method} must not be reachable across extensions"
                );
            }
        }

        // The owner's process survived the intruder's kill attempt.
        assert!(dispatch(&table, "owner", "read", &[json!(handle)]).is_ok());
        dispatch(&table, "owner", "kill", &[json!(handle)]).unwrap();
    }

    #[test]
    fn read_reports_exit_code_once_the_child_finishes() {
        let table = table();
        let handle = dispatch(
            &table,
            "ext",
            "spawn",
            &[json!("sh"), json!(["-c", "exit 3"])],
        )
        .unwrap()
        .as_u64()
        .unwrap();

        let mut exit = Value::Null;
        for _ in 0..100 {
            let output = dispatch(&table, "ext", "read", &[json!(handle)]).unwrap();
            if !output["exitCode"].is_null() {
                exit = output["exitCode"].clone();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(exit, json!(3));
        dispatch(&table, "ext", "kill", &[json!(handle)]).unwrap();
    }

    #[test]
    fn reap_kills_only_the_named_extensions_processes() {
        let table = table();
        let mine = dispatch(&table, "mine", "spawn", &[json!("cat"), json!([])])
            .unwrap()
            .as_u64()
            .unwrap();
        let theirs = dispatch(&table, "theirs", "spawn", &[json!("cat"), json!([])])
            .unwrap()
            .as_u64()
            .unwrap();

        table.reap("mine");

        assert!(dispatch(&table, "mine", "read", &[json!(mine)]).is_err());
        assert!(dispatch(&table, "theirs", "read", &[json!(theirs)]).is_ok());
        table.reap("theirs");
    }

    #[test]
    fn spawn_rejects_programs_that_do_not_exist() {
        let table = table();
        let err = dispatch(
            &table,
            "ext",
            "spawn",
            &[json!("definitely-not-a-real-program-xyz"), json!([])],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
