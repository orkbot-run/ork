// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Ports the inherited host-computer-protocol, host-computer-runner and desktop-sandbox
// behavior. The original material remains Apache-2.0; Rust additions follow LICENSE.md.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, watch},
};

pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BACKGROUND_COMMANDS: usize = 256;
const DEFAULT_TIMEOUT_MS: u64 = 5 * 60_000;
const MAX_TIMEOUT_MS: u64 = 60 * 60_000;
const INVALID: &str = "Local computer request is invalid";
const FAILED: &str = "Local computer operation failed";
const PATH_ERROR: &str = "Path escapes the computer workspace";

#[derive(Clone)]
pub struct HostRunner(Arc<Inner>);

struct Inner {
    root: PathBuf,
    enabled: AtomicBool,
    epoch: AtomicU64,
    sweeping: AtomicBool,
    sequence: AtomicU64,
    calls: Mutex<HashMap<u64, ActiveCall>>,
    processes: Mutex<HashMap<u32, ProcessOwner>>,
}

struct ActiveCall {
    bot: String,
    run: Option<String>,
    method: String,
    cancel: watch::Sender<bool>,
}

struct ProcessOwner {
    bot: String,
    run: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    method: String,
    bot_id: String,
    run_id: Option<String>,
    command: Option<Command>,
    target_run_id: Option<String>,
    path: Option<String>,
    max_bytes: Option<usize>,
    file: Option<PortableFile>,
    directories: Option<Directories>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    argv: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    unset_env: Option<Vec<String>>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct PortableFile {
    path: String,
    content: String,
    #[serde(default)]
    executable: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
enum Directories {
    Ensure { paths: Vec<String> },
    List,
    Remove { parent: String, names: Vec<String> },
}

fn bounded(value: &str, max: usize) -> bool {
    value.len() <= max && !value.contains('\0')
}

impl Request {
    fn parse(input: Value) -> Result<Self, String> {
        let request: Self = serde_json::from_value(input).map_err(|_| INVALID)?;
        if request.bot_id.is_empty()
            || !bounded(&request.bot_id, 256)
            || request
                .run_id
                .as_ref()
                .is_some_and(|v| v.is_empty() || !bounded(v, 256))
        {
            return Err(INVALID.into());
        }
        let valid = match request.method.as_str() {
            "execute" => request.command.as_ref().is_some_and(|command| {
                !command.argv.is_empty()
                    && command.argv.len() <= 1024
                    && command.argv.iter().all(|arg| bounded(arg, 1024 * 1024))
                    && !command.argv[0].is_empty()
                    && command.cwd.as_ref().is_none_or(|cwd| bounded(cwd, 4096))
                    && command.timeout_ms != Some(0)
                    && command.env.as_ref().is_none_or(|env| {
                        env.iter().all(|(key, value)| {
                            !key.is_empty() && !key.contains(['\0', '=']) && !value.contains('\0')
                        })
                    })
                    && command
                        .unset_env
                        .as_ref()
                        .is_none_or(|env| env.iter().all(|key| !key.contains(['\0', '='])))
            }),
            "cancelRunWork" => request
                .target_run_id
                .as_ref()
                .is_some_and(|v| !v.is_empty() && bounded(v, 256)),
            "listFiles" | "readFile" => {
                request
                    .path
                    .as_ref()
                    .is_some_and(|path| bounded(path, 4096))
                    && request
                        .max_bytes
                        .is_none_or(|max| max > 0 && max <= MAX_FILE_BYTES)
            }
            "writeFile" => request.file.as_ref().is_some_and(|file| {
                bounded(&file.path, 4096) && file.content.len() <= 12 * 1024 * 1024
            }),
            "workspaceDirectories" => match request.directories.as_ref() {
                Some(Directories::Ensure { paths }) => {
                    paths.len() <= 256 && paths.iter().all(|v| bounded(v, 4096))
                }
                Some(Directories::List) => true,
                Some(Directories::Remove { parent, names }) => {
                    matches!(parent.as_str(), "bots" | ".browser-profiles")
                        && names.len() <= 256
                        && names.iter().all(|v| bounded(v, 256))
                }
                None => false,
            },
            "provision" | "prepare" | "isRunning" | "exportWorkspace" | "snapshot" | "stop"
            | "destroy" | "environment" | "screenObserve" | "screenAct" => true,
            _ => false,
        };
        if valid {
            Ok(request)
        } else {
            Err(INVALID.into())
        }
    }
}

impl HostRunner {
    pub fn new(root: PathBuf) -> Self {
        Self(Arc::new(Inner {
            root,
            enabled: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            sweeping: AtomicBool::new(false),
            sequence: AtomicU64::new(1),
            calls: Mutex::new(HashMap::new()),
            processes: Mutex::new(HashMap::new()),
        }))
    }

    pub fn is_enabled(&self) -> bool {
        self.0.enabled.load(Ordering::SeqCst)
    }

    pub fn epoch(&self) -> u64 {
        self.0.epoch.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, enabled: bool) {
        // Hold the registration lock so disabling cannot miss a request about to start.
        let calls = self
            .0
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.0.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.0.epoch.fetch_add(1, Ordering::SeqCst);
            drop(calls);
            self.cancel_all();
        }
    }

    pub fn cancel_all(&self) {
        let calls = self
            .0
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for call in calls.values() {
            let _ = call.cancel.send(true);
        }
        self.kill_processes(|_| true);
    }

    fn kill_processes(&self, matches: impl Fn(&ProcessOwner) -> bool) {
        let mut processes = self
            .0
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        processes.retain(|pid, owner| {
            if matches(owner) {
                kill_group(*pid);
                false
            } else {
                group_alive(*pid)
            }
        });
    }

    fn home(&self, bot: &str) -> PathBuf {
        let hash = format!("{:x}", Sha256::digest(bot.as_bytes()));
        self.0.root.join("desktop-computers").join(hash)
    }

    fn start_process_sweep(&self) {
        if self.0.sweeping.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let mut processes = inner
                    .processes
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                processes.retain(|pid, _| group_alive(*pid));
                if processes.is_empty() {
                    inner.sweeping.store(false, Ordering::SeqCst);
                    return;
                }
            }
        });
    }

    /// Sends the existing HostComputerFrame values; the HTTP owner supplies framing and
    /// cancels this watch when its connection closes. Closing the receiver also stops work.
    pub async fn run(
        &self,
        input: Value,
        sender: mpsc::Sender<Value>,
        mut cancelled: watch::Receiver<bool>,
        accepted_epoch: u64,
    ) -> Result<(), String> {
        let request = Request::parse(input)?;
        let (cancel, mut cancellation) = watch::channel(false);
        let id = self.0.sequence.fetch_add(1, Ordering::Relaxed);
        {
            let mut calls = self
                .0
                .calls
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !self.is_enabled() || *cancelled.borrow() || self.epoch() != accepted_epoch {
                return Err("Not allowed on this computer".into());
            }
            let lifecycle = matches!(
                request.method.as_str(),
                "cancelRunWork" | "stop" | "destroy"
            );
            if calls.len() >= 20 || (!lifecycle && calls.len() >= 16) {
                return Err("Local computer is busy. Try again shortly.".into());
            }
            calls.insert(
                id,
                ActiveCall {
                    bot: request.bot_id.clone(),
                    run: request.run_id.clone(),
                    method: request.method.clone(),
                    cancel,
                },
            );
        }
        let _call = CallGuard {
            runner: self.clone(),
            id,
        };
        let timeout_ms = if request.method == "execute" {
            timeout_ms(
                request
                    .command
                    .as_ref()
                    .and_then(|command| command.timeout_ms),
            ) + 30_000
        } else {
            10 * 60_000
        };
        let result = self.dispatch(id, &request, &sender);
        tokio::pin!(result);
        let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms));
        tokio::pin!(deadline);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        heartbeat.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = cancelled.changed() => return Ok(()),
                _ = cancellation.changed() => return Ok(()),
                _ = sender.closed() => return Ok(()),
                _ = &mut deadline => return Ok(()),
                outcome = &mut result => {
                    match outcome {
                        Ok(()) => { let _ = sender.send(json!({"done": true})).await; }
                        Err(message) => { let _ = sender.send(json!({"error": message})).await; }
                    }
                    return Ok(());
                }
                _ = heartbeat.tick() => {
                    if sender.send(json!({"heartbeat": true})).await.is_err() { return Ok(()); }
                }
            }
        }
    }

    async fn dispatch(
        &self,
        id: u64,
        request: &Request,
        sender: &mpsc::Sender<Value>,
    ) -> Result<(), String> {
        let home = self.home(&request.bot_id);
        match request.method.as_str() {
            "environment" => value(sender, json!({ "platform": platform(), "home": user_home(), "shell": std::env::var("SHELL").unwrap_or_else(|_| if cfg!(windows) {"powershell.exe"} else {"/bin/sh"}.into()) })).await,
            "provision" => {
                let fresh = !home.exists();
                fs::create_dir_all(home.parent().ok_or(FAILED)?).map_err(safe_error)?;
                // Creation and reopening refuse symlinks to another workspace.
                create_home(&home)?;
                match fs::remove_file(stopped_marker(&home)) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(safe_error(error)) }
                let hash = home.file_name().and_then(|v| v.to_str()).ok_or(FAILED)?;
                value(sender, json!({"id": format!("desktop-{hash}"), "botId": request.bot_id, "kind": "desktop", "providerRef": format!("host:{hash}"), "fresh": fresh})).await
            }
            "isRunning" => value(sender, json!(running(&home))).await,
            "prepare" => value(sender, Value::Null).await,
            "execute" => {
                if !running(&home) { return Err("Local computer stopped".into()); }
                self.execute(id, request, &home, sender).await
            }
            "cancelRunWork" | "stop" | "destroy" => {
                let target = request.target_run_id.as_deref();
                {
                    let calls = self.0.calls.lock().unwrap_or_else(|error| error.into_inner());
                    for (other_id, call) in calls.iter() {
                        if *other_id != id && call.bot == request.bot_id && (target.is_none() || (call.method == "execute" && call.run.as_deref() == target)) { let _ = call.cancel.send(true); }
                    }
                    self.kill_processes(|owner| owner.bot == request.bot_id && (target.is_none() || owner.run.as_deref() == target));
                }
                if target.is_none() && home.exists() {
                    let marker = stopped_marker(&home);
                    let file = workspace_file(marker.parent().ok_or(FAILED)?, marker.file_name().and_then(|name| name.to_str()).ok_or(FAILED)?, true)?;
                    file.set_len(0).map_err(safe_error)?;
                }
                value(sender, Value::Null).await
            }
            "readFile" => {
                let data = read_workspace_file(&home, request.path.as_deref().ok_or(INVALID)?, request.max_bytes.unwrap_or(MAX_FILE_BYTES))?;
                value(sender, json!(base64_encode(&data))).await
            }
            "writeFile" => {
                let file = request.file.as_ref().ok_or(INVALID)?;
                let data = base64_decode(&file.content)?;
                if data.len() > MAX_FILE_BYTES { return Err(format!("computer file exceeds {MAX_FILE_BYTES} bytes")); }
                write_workspace_file(&home, &file.path, &data, file.executable)?;
                value(sender, Value::Null).await
            }
            "listFiles" => value(sender, json!(list_files(&home, request.path.as_deref().ok_or(INVALID)?)?)).await,
            "exportWorkspace" => {
                let mut pending = vec![String::new()];
                while let Some(directory) = pending.pop() {
                    if !directory.is_empty() && tagged_cache_directory(&home, &directory) { continue; }
                    for entry in list_files(&home, &directory)? {
                        let path = entry["path"].as_str().ok_or(FAILED)?;
                        if skip_export(path, entry["kind"] == "dir") { continue; }
                        if entry["kind"] == "dir" { pending.push(path.to_owned()); }
                        else {
                            let content = read_workspace_file(&home, path, MAX_FILE_BYTES)?;
                            value(sender, json!({ "path": path, "content": base64_encode(&content), "executable": entry.get("executable").and_then(Value::as_bool).unwrap_or(false) })).await?;
                        }
                    }
                }
                Ok(())
            }
            "snapshot" => {
                let created = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).map_err(|_| FAILED)?;
                let hash = home.file_name().and_then(|v| v.to_str()).ok_or(FAILED)?;
                value(sender, json!({"id": format!("desktop-snap-desktop-{hash}"), "createdAt": created})).await
            }
            "workspaceDirectories" => {
                match request.directories.as_ref().ok_or(INVALID)? {
                    Directories::Ensure { paths } => {
                        for path in paths { workspace_directory(&home, &segments(path)?, true)?; }
                        value(sender, json!([])).await
                    }
                    Directories::List => {
                        let mut entries = Vec::new();
                        for parent in ["bots", ".browser-profiles"] {
                            match list_files(&home, parent) {
                                Ok(children) => entries.extend(children.iter().filter_map(|entry| entry["path"].as_str().map(str::to_owned))),
                                Err(error) if error == "computer file not found" => {},
                                Err(error) => return Err(error),
                            }
                        }
                        value(sender, json!(entries)).await
                    }
                    Directories::Remove { parent, names } => {
                        remove_workspace_children(&home, parent, names)?;
                        value(sender, json!([])).await
                    }
                }
            }
            "screenObserve" | "screenAct" => Err("Screen control is not available on this computer.".into()),
            _ => Err(INVALID.into()),
        }
    }

    async fn execute(
        &self,
        id: u64,
        request: &Request,
        home: &Path,
        sender: &mpsc::Sender<Value>,
    ) -> Result<(), String> {
        ensure_execute_supported()?;
        let command = request.command.as_ref().ok_or(INVALID)?;
        let cwd = execute_cwd(home, command.cwd.as_deref())?;
        fs::create_dir_all(&cwd).map_err(safe_error)?;
        let mut process = tokio::process::Command::new(&command.argv[0]);
        process
            .args(&command.argv[1..])
            .current_dir(cwd)
            .env_clear()
            .envs(command_environment(command))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        process.process_group(0);
        let (mut child, pid) = {
            // Registration and revocation share this lock, so no spawn can escape a revoke.
            let calls = self
                .0
                .calls
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let call = calls.get(&id).ok_or(FAILED)?;
            if !self.is_enabled() || *call.cancel.borrow() {
                return Err("Local computer stopped".into());
            }
            let mut owned = self
                .0
                .processes
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            owned.retain(|pid, _| group_alive(*pid));
            if owned.len() >= MAX_BACKGROUND_COMMANDS {
                return Err("Too many local background commands".into());
            }
            let child = process.spawn().map_err(|_| FAILED)?;
            let pid = child.id().ok_or(FAILED)?;
            owned.insert(
                pid,
                ProcessOwner {
                    bot: request.bot_id.clone(),
                    run: request.run_id.clone(),
                },
            );
            self.start_process_sweep();
            (child, pid)
        };
        let (output_tx, mut output_rx) = mpsc::channel(8);
        let stdout = child.stdout.take().ok_or(FAILED)?;
        let stderr = child.stderr.take().ok_or(FAILED)?;
        let mut tree = ProcessGuard {
            runner: self.clone(),
            pid,
            completed: false,
            child: Some(child),
        };
        let stdout_reader = tokio::spawn(read_output(stdout, "stdout", output_tx.clone()));
        let stderr_reader = tokio::spawn(read_output(stderr, "stderr", output_tx));
        let readers = OutputGuards(stdout_reader, stderr_reader);
        let timeout = timeout_ms(command.timeout_ms);
        let deadline = tokio::time::sleep(Duration::from_millis(timeout));
        tokio::pin!(deadline);
        let mut exit = None;
        let mut output_closed = false;
        while exit.is_none() || !output_closed {
            tokio::select! {
                event = output_rx.recv(), if !output_closed => {
                    if let Some(event) = event { value(sender, event).await?; }
                    else { output_closed = true; }
                }
                status = tree.child.as_mut().ok_or(FAILED)?.wait(), if exit.is_none() => { exit = Some(status.map_err(|_| FAILED)?.code().unwrap_or(1)); }
                _ = &mut deadline => {
                    kill_group(pid);
                    let _ = tree.child.as_mut().ok_or(FAILED)?.wait().await;
                    value(sender, json!({"type": "stderr", "data": format!("command timed out after {timeout} ms\n")})).await?;
                    value(sender, json!({"type": "exit", "code": 124})).await?;
                    return Ok(());
                }
            }
        }
        drop(readers);
        value(sender, json!({"type": "exit", "code": exit.unwrap_or(1)})).await?;
        // Background descendants remain owned after their foreground shell exits.
        tree.completed = true;
        Ok(())
    }
}

struct CallGuard {
    runner: HostRunner,
    id: u64,
}
impl Drop for CallGuard {
    fn drop(&mut self) {
        self.runner
            .0
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
    }
}

struct ProcessGuard {
    runner: HostRunner,
    pid: u32,
    completed: bool,
    child: Option<tokio::process::Child>,
}
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        if !self.completed {
            kill_group(self.pid);
            self.runner
                .0
                .processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.pid);
            if let Some(mut child) = self.child.take() {
                // Reap the foreground child even when its operation future was dropped.
                let pid = self.pid;
                tokio::spawn(async move {
                    let _ = child.wait().await;
                    // A fork already in progress can join the group after the first signal.
                    // Once the foreground parent has exited it cannot create another child.
                    kill_group(pid);
                });
            }
        }
    }
}

struct OutputGuards(tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>);
impl Drop for OutputGuards {
    fn drop(&mut self) {
        self.0.abort();
        self.1.abort();
    }
}

async fn read_output(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    kind: &'static str,
    sender: mpsc::Sender<Value>,
) {
    let mut buffer = [0u8; 16 * 1024];
    let mut remaining = Vec::new();
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(count) => count,
            Err(_) => return,
        };
        remaining.extend_from_slice(&buffer[..read]);
        let valid = match std::str::from_utf8(&remaining) {
            Ok(_) => remaining.len(),
            Err(error) if error.error_len().is_none() && read != 0 => error.valid_up_to(),
            Err(_) => remaining.len(),
        };
        if valid > 0 {
            let data = String::from_utf8_lossy(&remaining[..valid]).into_owned();
            remaining.drain(..valid);
            if sender
                .send(json!({"type": kind, "data": data}))
                .await
                .is_err()
            {
                return;
            }
        }
        if read == 0 {
            return;
        }
    }
}

async fn value(sender: &mpsc::Sender<Value>, value: Value) -> Result<(), String> {
    sender
        .send(json!({"value": value}))
        .await
        .map_err(|_| FAILED.into())
}

fn timeout_ms(value: Option<u64>) -> u64 {
    value
        .filter(|value| *value > 0 && *value <= MAX_TIMEOUT_MS)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

fn user_home() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
}

fn ensure_execute_supported() -> Result<(), String> {
    // Windows taskkill cannot own detached descendants after their parent exits.
    // Fail closed until the native runner provides Windows Job Object ownership.
    if cfg!(windows) {
        Err("Host commands are not available on Windows in this desktop preview.".into())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}
#[cfg(not(unix))]
fn group_alive(_: u32) -> bool {
    false
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}
#[cfg(not(unix))]
fn kill_group(_: u32) {}

fn command_environment(command: &Command) -> HashMap<String, String> {
    // Only shell/tool settings cross into host commands; application secrets never do.
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LANGUAGE",
        "TERM",
        "TZ",
        "TMPDIR",
        "TEMP",
        "TMP",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "SSH_AUTH_SOCK",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
    ];
    let mut env: HashMap<_, _> = std::env::vars()
        .filter(|(key, _)| {
            ALLOWED.contains(&key.to_uppercase().as_str()) || key.to_uppercase().starts_with("LC_")
        })
        .collect();
    env.extend(command.env.clone().unwrap_or_default());
    for key in command.unset_env.as_deref().unwrap_or_default() {
        env.retain(|name, _| {
            if cfg!(windows) {
                !name.eq_ignore_ascii_case(key)
            } else {
                name != key
            }
        });
    }
    env
}

fn execute_cwd(home: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let requested = requested
        .filter(|value| !value.is_empty() && !matches!(*value, "/home/orkbot" | "/home/user"));
    let path = requested.map_or_else(|| home.to_owned(), |value| home.join(value));
    let normalized = normalize_absolute(&path)?;
    let host = user_home();
    if normalized.starts_with(normalize_absolute(home)?)
        || (!host.is_empty() && normalized.starts_with(normalize_absolute(Path::new(&host))?))
    {
        Ok(normalized)
    } else {
        Err("path is outside this computer's home".into())
    }
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(PATH_ERROR.into());
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(component),
        }
    }
    Ok(result)
}

fn stopped_marker(home: &Path) -> PathBuf {
    home.with_extension("stopped")
}
fn running(home: &Path) -> bool {
    fs::symlink_metadata(home).is_ok_and(|info| info.is_dir() && !info.file_type().is_symlink())
        && matches!(fs::symlink_metadata(stopped_marker(home)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

fn safe_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "computer file not found".into()
    } else {
        FAILED.into()
    }
}

fn segments(path: &str) -> Result<Vec<String>, String> {
    let normalized = path.replace('\\', "/");
    let parts: Vec<_> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    if parts
        .iter()
        .any(|part| matches!(part.as_str(), "." | "..") || part.contains('\0'))
    {
        return Err(PATH_ERROR.into());
    }
    Ok(parts)
}

#[cfg(unix)]
fn create_home(home: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::fd::AsRawFd};
    let directory = workspace_directory(home.parent().ok_or(FAILED)?, &[], false)?;
    let name = CString::new(
        home.file_name()
            .and_then(|name| name.to_str())
            .ok_or(FAILED)?,
    )
    .map_err(|_| FAILED)?;
    let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
    if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(safe_error(std::io::Error::last_os_error()));
    }
    workspace_directory(home, &[], false).map(|_| ())
}
#[cfg(not(unix))]
fn create_home(_: &Path) -> Result<(), String> {
    Err("Host workspaces are not available on this platform in this desktop preview.".into())
}

/// Walk using held directory descriptors, never following a caller-controlled symlink.
#[cfg(unix)]
fn workspace_directory(home: &Path, parts: &[String], create: bool) -> Result<File, String> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        },
    };
    let mut directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(home)
        .map_err(safe_error)?;
    for part in parts {
        let name = CString::new(part.as_bytes()).map_err(|_| PATH_ERROR)?;
        if create {
            let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
            if result < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(safe_error(std::io::Error::last_os_error()));
            }
        }
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_DIRECTORY
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(safe_error(std::io::Error::last_os_error()));
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}
#[cfg(not(unix))]
fn workspace_directory(_: &Path, _: &[String], _: bool) -> Result<File, String> {
    Err("Host workspaces are not available on this platform in this desktop preview.".into())
}

#[cfg(unix)]
fn workspace_file(home: &Path, relative: &str, write: bool) -> Result<File, String> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
    };
    let mut parts = segments(relative)?;
    let name = CString::new(parts.pop().ok_or(PATH_ERROR)?).map_err(|_| PATH_ERROR)?;
    let parent = workspace_directory(home, &parts, write)?;
    let flags = if write {
        libc::O_WRONLY | libc::O_CREAT
    } else {
        libc::O_RDONLY
    };
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(safe_error(std::io::Error::last_os_error()));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(safe_error)?;
    if !metadata.is_file() || (write && metadata.nlink() != 1) {
        return Err(PATH_ERROR.into());
    }
    Ok(file)
}
#[cfg(not(unix))]
fn workspace_file(_: &Path, _: &str, _: bool) -> Result<File, String> {
    Err("Host workspaces are not available on this platform in this desktop preview.".into())
}

fn read_workspace_file(home: &Path, relative: &str, max: usize) -> Result<Vec<u8>, String> {
    let file = workspace_file(home, relative, false)?;
    let mut data = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut data)
        .map_err(safe_error)?;
    if data.len() > max {
        return Err(format!("computer file exceeds {max} bytes"));
    }
    Ok(data)
}

fn write_workspace_file(
    home: &Path,
    relative: &str,
    data: &[u8],
    executable: bool,
) -> Result<(), String> {
    let mut file = workspace_file(home, relative, true)?;
    file.set_len(0).map_err(safe_error)?;
    file.write_all(data).map_err(safe_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(if executable {
            0o700
        } else {
            0o600
        }))
        .map_err(safe_error)?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

fn valid_cleanup_name(parent: &str, name: &str) -> bool {
    if parent == "bots" {
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    } else if parent == ".browser-profiles" {
        name.strip_prefix("chromium-bot-").is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    } else {
        false
    }
}

#[cfg(unix)]
fn directory_names(directory: &File) -> Result<Vec<String>, String> {
    use std::{ffi::CStr, os::fd::AsRawFd};
    struct Directory(*mut libc::DIR);
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let fd = unsafe { libc::dup(directory.as_raw_fd()) };
    if fd < 0 {
        return Err(safe_error(std::io::Error::last_os_error()));
    }
    let pointer = unsafe { libc::fdopendir(fd) };
    if pointer.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(safe_error(std::io::Error::last_os_error()));
    }
    let directory = Directory(pointer);
    let mut names = Vec::new();
    loop {
        #[cfg(target_os = "macos")]
        let error_pointer = unsafe { libc::__error() };
        #[cfg(not(target_os = "macos"))]
        let error_pointer = unsafe { libc::__errno_location() };
        unsafe {
            *error_pointer = 0;
        }
        let entry = unsafe { libc::readdir(directory.0) };
        if entry.is_null() {
            if unsafe { *error_pointer } != 0 {
                return Err(safe_error(std::io::Error::last_os_error()));
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .map_err(|_| FAILED)?;
        if !matches!(name, "." | "..") {
            names.push(name.to_owned());
        }
        if names.len() > 100_000 {
            return Err("Local computer response is too large".into());
        }
    }
    Ok(names)
}

#[cfg(unix)]
fn remove_workspace_children(home: &Path, parent: &str, names: &[String]) -> Result<(), String> {
    if names.iter().any(|name| !valid_cleanup_name(parent, name)) {
        return Err(PATH_ERROR.into());
    }
    let directory = match workspace_directory(home, &[parent.to_owned()], false) {
        Ok(directory) => directory,
        Err(error) if error == "computer file not found" => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut count = 0;
    for name in names {
        remove_child(&directory, name, 0, &mut count)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn remove_workspace_children(_: &Path, _: &str, _: &[String]) -> Result<(), String> {
    Err("Host workspaces are not available on this platform in this desktop preview.".into())
}

#[cfg(unix)]
fn remove_child(parent: &File, name: &str, depth: usize, count: &mut usize) -> Result<(), String> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
    };
    *count += 1;
    if depth > 128 || *count > 100_000 {
        return Err("Workspace cleanup is too large".into());
    }
    let name_c = CString::new(name).map_err(|_| PATH_ERROR)?;
    let before = match metadata_at(parent, name) {
        Ok(info) => info,
        Err(error) if error == "computer file not found" => return Ok(()),
        Err(error) => return Err(error),
    };
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    let flags = if fd >= 0 {
        let directory = unsafe { File::from_raw_fd(fd) };
        let opened = directory.metadata().map_err(safe_error)?;
        #[cfg(target_os = "macos")]
        let named_device = before.st_dev as u64;
        #[cfg(not(target_os = "macos"))]
        let named_device = before.st_dev;
        if opened.dev() != parent.metadata().map_err(safe_error)?.dev()
            || opened.dev() != named_device
            || opened.ino() != before.st_ino
        {
            return Err(PATH_ERROR.into());
        }
        for name in directory_names(&directory)? {
            remove_child(&directory, &name, depth + 1, count)?;
        }
        libc::AT_REMOVEDIR
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(());
        }
        if !matches!(error.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) {
            return Err(safe_error(error));
        }
        // unlinkat removes a symlink itself, never its target.
        0
    };
    let present = metadata_at(parent, name)?;
    if present.st_dev != before.st_dev || present.st_ino != before.st_ino {
        return Err(PATH_ERROR.into());
    }
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name_c.as_ptr(), flags) };
    if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
        return Err(safe_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(unix)]
fn metadata_at(parent: &File, name: &str) -> Result<libc::stat, String> {
    use std::{ffi::CString, os::fd::AsRawFd};
    let name = CString::new(name).map_err(|_| PATH_ERROR)?;
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    let status = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            info.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if status < 0 {
        Err(safe_error(std::io::Error::last_os_error()))
    } else {
        Ok(unsafe { info.assume_init() })
    }
}

#[cfg(unix)]
fn list_files(home: &Path, relative: &str) -> Result<Vec<Value>, String> {
    let parts = segments(relative)?;
    let directory = workspace_directory(home, &parts, false)?;
    let mut result = Vec::new();
    for name in directory_names(&directory)? {
        let info = match metadata_at(&directory, &name) {
            Ok(info) => info,
            Err(error) if error == "computer file not found" => continue,
            Err(error) => return Err(error),
        };
        let is_dir = info.st_mode & libc::S_IFMT == libc::S_IFDIR;
        let is_file = info.st_mode & libc::S_IFMT == libc::S_IFREG;
        if !is_dir && !is_file {
            continue;
        }
        let path = parts
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(name.as_str()))
            .collect::<Vec<_>>()
            .join("/");
        let mut value =
            json!({"path": path, "kind": if is_dir {"dir"} else {"file"}, "size": info.st_size});
        if is_file && info.st_mode & 0o100 != 0 {
            value["executable"] = json!(true);
        }
        result.push(value);
        if result.len() > 100_000 {
            return Err("Local computer response is too large".into());
        }
    }
    result.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(result)
}
#[cfg(not(unix))]
fn list_files(_: &Path, _: &str) -> Result<Vec<Value>, String> {
    Err("Host workspaces are not available on this platform in this desktop preview.".into())
}

fn skip_export(path: &str, is_directory: bool) -> bool {
    // Keep portable exports consistent with workspace-save-policy.ts.
    const BROWSER_DIRECTORIES: &[&str] = &[
        "Cache",
        "Code Cache",
        "CacheStorage",
        "GPUCache",
        "GrShaderCache",
        "ShaderCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "GraphiteDawnCache",
        "Crashpad",
        "startup_cache",
        "cache2",
        "ActorSafetyLists",
        "CertificateRevocation",
        "component_crx_cache",
        "Crowd Deny",
        "DeferredBrowserMetrics",
        "Dictionaries",
        "extensions_crx_cache",
        "hyphen-data",
        "OnDeviceHeadSuggestModel",
        "optimization_guide_model_store",
        "OptimizationHints",
        "PKIMetadata",
        "Safe Browsing",
        "SafetyTips",
        "screen_ai",
        "Subresource Filter",
        "WasmTtsEngine",
        "WidevineCdm",
        "ZxcvbnData",
    ];
    const BROWSER_ENTRIES: &[&str] = &[
        "BrowserMetrics",
        "BrowserMetrics-spare.pma",
        "DevToolsActivePort",
        "SingletonCookie",
        "SingletonLock",
        "SingletonSocket",
        ".parentlock",
        "lock",
    ];
    let segments: Vec<_> = path.trim_start_matches("./").split('/').collect();
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        if (!last || is_directory)
            && (matches!(
                *segment,
                ".cache"
                    | ".npm"
                    | ".pnpm-store"
                    | "node_modules"
                    | ".venv"
                    | "__pycache__"
                    | ".next"
                    | ".turbo"
            ) || (*segment == "cache" && index > 0 && segments[index - 1] == ".yarn"))
        {
            return true;
        }
        if last
            && !is_directory
            && (segment.ends_with(".log")
                || *segment == "core"
                || segment.strip_prefix("core.").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                }))
        {
            return true;
        }
        if segments.first() == Some(&".browser-profiles")
            && index > 0
            && (BROWSER_DIRECTORIES.contains(segment)
                || (last && BROWSER_ENTRIES.contains(segment)))
        {
            return true;
        }
    }
    false
}

fn tagged_cache_directory(home: &Path, directory: &str) -> bool {
    const SIGNATURE: &[u8] = b"Signature: 8a477f597d28d172789f06886806bc55";
    let Ok(mut tag) = workspace_file(home, &format!("{directory}/CACHEDIR.TAG"), false) else {
        return false;
    };
    if !tag.metadata().is_ok_and(|info| info.len() < 1024) {
        return false;
    }
    let mut prefix = [0u8; SIGNATURE.len()];
    tag.read_exact(&mut prefix).is_ok() && prefix == SIGNATURE
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn base64_encode(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        result.push(BASE64[((value >> 18) & 63) as usize] as char);
        result.push(BASE64[((value >> 12) & 63) as usize] as char);
        result.push(if chunk.len() > 1 {
            BASE64[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            BASE64[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}
fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(4) {
        return Err(INVALID.into());
    }
    let mut result = Vec::with_capacity(value.len() / 4 * 3);
    for (index, chunk) in value.as_bytes().chunks(4).enumerate() {
        let last = index + 1 == value.len() / 4;
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return Err(INVALID.into());
        }
        let mut decoded = 0u32;
        for (i, byte) in chunk.iter().enumerate() {
            let bits = if *byte == b'=' && i >= 4 - padding {
                0
            } else {
                BASE64
                    .iter()
                    .position(|candidate| candidate == byte)
                    .ok_or(INVALID)? as u32
            };
            decoded = (decoded << 6) | bits;
        }
        result.push((decoded >> 16) as u8);
        if padding < 2 {
            result.push((decoded >> 8) as u8);
        }
        if padding < 1 {
            result.push(decoded as u8);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn collect(runner: &HostRunner, request: Value) -> Vec<Value> {
        let (tx, mut rx) = mpsc::channel(8);
        let (_cancel, cancelled) = watch::channel(false);
        let (result, values) = tokio::join!(
            runner.run(request, tx, cancelled, runner.epoch()),
            async move {
                let mut values = Vec::new();
                while let Some(value) = rx.recv().await {
                    values.push(value);
                }
                values
            }
        );
        result.unwrap();
        values
    }

    #[test]
    fn validates_existing_contract_and_timeout_bounds() {
        assert!(
            Request::parse(json!({"method":"execute","botId":"bot","command":{"argv":[]}}))
                .is_err()
        );
        assert!(Request::parse(
            json!({"method":"execute","botId":"bot","command":{"argv":["sh", "bad\u{0}"]}})
        )
        .is_err());
        assert!(Request::parse(json!({"method":"other","botId":"bot"})).is_err());
        assert_eq!(timeout_ms(Some(1)), 1);
        assert_eq!(timeout_ms(Some(MAX_TIMEOUT_MS)), MAX_TIMEOUT_MS);
        assert_eq!(timeout_ms(Some(MAX_TIMEOUT_MS + 1)), DEFAULT_TIMEOUT_MS);
        assert_eq!(timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(ensure_execute_supported().is_err(), cfg!(windows));
    }

    #[test]
    fn base64_matches_existing_wire_format() {
        for (data, encoded) in [
            (b"".as_slice(), ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (&[0, 255, 128], "AP+A"),
        ] {
            assert_eq!(base64_encode(data), encoded);
            assert_eq!(base64_decode(encoded).unwrap(), data);
        }
        for invalid in ["!===", "Zg=", "====", "Zg==Zg=="] {
            assert!(base64_decode(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn requires_consent_and_rejects_malformed_requests() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        let (tx, _rx) = mpsc::channel(8);
        let (_cancel, cancelled) = watch::channel(false);
        assert!(runner
            .run(
                json!({"method":"environment","botId":"bot"}),
                tx,
                cancelled,
                runner.epoch()
            )
            .await
            .is_err());
        assert!(runner.0.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn revocation_fences_requests_that_started_reading_before_the_next_grant() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        runner.set_enabled(true);
        let previous_epoch = runner.epoch();
        runner.set_enabled(false);
        runner.set_enabled(true);
        let (tx, _rx) = mpsc::channel(8);
        let (_cancel, cancelled) = watch::channel(false);
        assert!(runner
            .run(
                json!({"method":"environment","botId":"bot"}),
                tx,
                cancelled,
                previous_epoch
            )
            .await
            .is_err());
        assert!(runner.0.calls.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provisions_isolated_workspaces_and_roundtrips_files() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        runner.set_enabled(true);
        let created = collect(
            &runner,
            json!({"method":"provision","botId":"../../outside"}),
        )
        .await;
        assert_eq!(created[0]["value"]["fresh"], true);
        assert!(runner.home("../../outside").starts_with(directory.path()));
        collect(&runner, json!({"method":"writeFile","botId":"../../outside","file":{"path":"folder/test.txt","content":"aGVsbG8="}})).await;
        let read = collect(
            &runner,
            json!({"method":"readFile","botId":"../../outside","path":"folder/test.txt"}),
        )
        .await;
        assert_eq!(read, [json!({"value":"aGVsbG8="}), json!({"done":true})]);
        let exported = collect(
            &runner,
            json!({"method":"exportWorkspace","botId":"../../outside"}),
        )
        .await;
        assert_eq!(exported[0]["value"]["path"], "folder/test.txt");
        assert_eq!(exported[0]["value"]["content"], "aGVsbG8=");
        collect(&runner, json!({"method":"stop","botId":"../../outside"})).await;
        assert!(!running(&runner.home("../../outside")));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_hardlinks_traversal_and_oversized_reads() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        fs::create_dir(&home).unwrap();
        let outside = directory.path().join("outside");
        fs::write(&outside, "private").unwrap();
        symlink(&outside, home.join("link")).unwrap();
        symlink(directory.path(), home.join("directory-link")).unwrap();
        fs::hard_link(&outside, home.join("hardlink")).unwrap();
        assert!(write_workspace_file(&home, "link", b"changed", false).is_err());
        assert!(write_workspace_file(&home, "hardlink", b"changed", false).is_err());
        assert!(write_workspace_file(&home, "directory-link/new", b"changed", false).is_err());
        assert!(read_workspace_file(&home, "../outside", 100).is_err());
        assert!(read_workspace_file(&home, "link", 100).is_err());
        fs::write(home.join("large"), [0; 10]).unwrap();
        assert_eq!(
            read_workspace_file(&home, "large", 5).unwrap_err(),
            "computer file exceeds 5 bytes"
        );
        assert_eq!(fs::read_to_string(outside).unwrap(), "private");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_cleanup_never_follows_links_or_accepts_other_names() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        fs::create_dir_all(home.join("bots/owned/folder")).unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("private"), b"unchanged").unwrap();
        symlink(&outside, home.join("bots/owned/link")).unwrap();
        symlink(&outside, home.join("bots/external")).unwrap();
        remove_workspace_children(&home, "bots", &["owned".into(), "external".into()]).unwrap();
        assert!(!home.join("bots/owned").exists());
        assert!(fs::symlink_metadata(home.join("bots/external")).is_err());
        assert_eq!(fs::read(outside.join("private")).unwrap(), b"unchanged");
        assert!(remove_workspace_children(&home, "bots", &["../outside".into()]).is_err());
        assert!(!valid_cleanup_name(".browser-profiles", "arbitrary"));
        assert!(valid_cleanup_name(
            ".browser-profiles",
            "chromium-bot-0123456789abcdef0123456789abcdef"
        ));
    }

    #[test]
    fn command_environment_contains_only_inherited_shell_settings_and_explicit_values() {
        let command: Command = serde_json::from_value(json!({"argv":["fixture"],"env":{"EXPLICIT":"value","REMOVED":"value"},"unsetEnv":["REMOVED", "HOME"]})).unwrap();
        let environment = command_environment(&command);
        assert_eq!(
            environment.get("EXPLICIT").map(String::as_str),
            Some("value")
        );
        assert!(!environment.contains_key("REMOVED"));
        assert!(!environment.contains_key("HOME"));
        assert!(!environment.contains_key("CARGO_HOME"));
        assert!(!environment.contains_key("RUSTUP_HOME"));
        assert!(!environment.contains_key("SANDBOX_HOST_TOKEN"));
    }

    #[test]
    fn portable_export_preserves_the_existing_file_and_browser_exclusions() {
        for name in [
            ".cache",
            ".npm",
            ".pnpm-store",
            ".yarn/cache",
            "node_modules",
            ".venv",
            "__pycache__",
            ".next",
            ".turbo",
        ] {
            for prefix in ["", "project/nested/"] {
                assert!(skip_export(&format!("{prefix}{name}"), true));
                assert!(skip_export(&format!("{prefix}{name}/huge/data"), false));
                assert!(!skip_export(&format!("{prefix}{name}"), false));
            }
        }
        for name in ["core", "core.123", "debug.log", "nested/output.log"] {
            assert!(skip_export(name, false));
            assert!(!skip_export(name, true));
            assert!(!skip_export(&format!("{name}/notes.txt"), false));
        }
        for name in [
            "packages/core/notes.txt",
            "core.txt",
            "core.abc",
            "a.log.txt",
            ".yarn/patches/fix.patch",
            "project/Cache/data",
            "project/lock",
            "project/WidevineCdm/notes.txt",
            ".browser-profiles/chromium/Default/Cookies",
        ] {
            assert!(!skip_export(name, false));
        }
        for name in ["Cache", "Code Cache", "WidevineCdm"] {
            assert!(skip_export(
                &format!(".browser-profiles/chromium/{name}"),
                true
            ));
            assert!(skip_export(
                &format!(".browser-profiles/chromium/{name}/data"),
                false
            ));
        }
        for name in ["SingletonLock", "lock", ".parentlock", "BrowserMetrics"] {
            assert!(skip_export(
                &format!(".browser-profiles/chromium/{name}"),
                false
            ));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_prunes_tagged_caches_without_pruning_the_home_itself() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        runner.set_enabled(true);
        collect(&runner, json!({"method":"provision","botId":"bot"})).await;
        let home = runner.home("bot");
        let signature = b"Signature: 8a477f597d28d172789f06886806bc55\n# Cache\n";
        write_workspace_file(&home, "tagged/CACHEDIR.TAG", signature, false).unwrap();
        write_workspace_file(&home, "tagged/data", b"omitted", false).unwrap();
        write_workspace_file(&home, "untagged/CACHEDIR.TAG", b"my notes", false).unwrap();
        write_workspace_file(&home, "untagged/data", b"kept", false).unwrap();
        write_workspace_file(&home, "CACHEDIR.TAG", signature, false).unwrap();
        let frames = collect(&runner, json!({"method":"exportWorkspace","botId":"bot"})).await;
        let mut paths: Vec<_> = frames
            .iter()
            .filter_map(|frame| frame["value"]["path"].as_str())
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            ["CACHEDIR.TAG", "untagged/CACHEDIR.TAG", "untagged/data"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executes_argv_and_environment_without_implicit_shell_expansion() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        runner.set_enabled(true);
        collect(&runner, json!({"method":"provision","botId":"bot"})).await;
        let frames = collect(&runner, json!({"method":"execute","botId":"bot","command":{"argv":["/bin/sh","-c","printf '%s|%s' \"$TEST_VALUE\" \"${REMOVED-unset}\"; printf error >&2"],"env":{"TEST_VALUE":"$(literal)","REMOVED":"secret"},"unsetEnv":["REMOVED"]}})).await;
        let output: String = frames
            .iter()
            .filter(|frame| frame["value"]["type"] == "stdout")
            .filter_map(|frame| frame["value"]["data"].as_str())
            .collect();
        assert_eq!(output, "$(literal)|unset");
        assert!(frames
            .iter()
            .any(|frame| frame["value"] == json!({"type":"stderr","data":"error"})));
        assert_eq!(
            frames[frames.len() - 2],
            json!({"value":{"type":"exit","code":0}})
        );
        assert_eq!(frames.last().unwrap(), &json!({"done":true}));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_owned_command() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        runner.set_enabled(true);
        collect(&runner, json!({"method":"provision","botId":"bot"})).await;
        let frames = collect(&runner, json!({"method":"execute","botId":"bot","command":{"argv":["/bin/sh","-c","sleep 30"],"timeoutMs":50}})).await;
        assert!(frames.contains(&json!({"value":{"type":"exit","code":124}})));
        assert!(runner.0.processes.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn revoke_owns_background_children_after_their_shell_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(directory.path().to_owned());
        runner.set_enabled(true);
        collect(&runner, json!({"method":"provision","botId":"bot"})).await;
        let frames = collect(&runner, json!({"method":"execute","botId":"bot","runId":"run","command":{"argv":["/bin/sh","-c","sleep 30 >/dev/null 2>&1 & printf '%s' \"$!\""]}})).await;
        let pid: u32 = frames
            .iter()
            .filter(|frame| frame["value"]["type"] == "stdout")
            .filter_map(|frame| frame["value"]["data"].as_str())
            .collect::<String>()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
        runner.set_enabled(false);
        for _ in 0..100 {
            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_revoke_and_run_cancel_kill_process_groups() {
        for action in ["disconnect", "receiver", "revoke", "cancel"] {
            let directory = tempfile::tempdir().unwrap();
            let runner = HostRunner::new(directory.path().to_owned());
            runner.set_enabled(true);
            collect(&runner, json!({"method":"provision","botId":"bot"})).await;
            let (tx, mut rx) = mpsc::channel(8);
            let (cancel, cancelled) = watch::channel(false);
            let active = runner.clone();
            let operation = tokio::spawn(async move {
                active.run(json!({"method":"execute","botId":"bot","runId":"run","command":{"argv":["/bin/sh","-c","printf '%s' $$; sleep 30"]}}), tx, cancelled, active.epoch()).await
            });
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            let pid: u32 = event["value"]["data"].as_str().unwrap().parse().unwrap();
            assert!(group_alive(pid));
            match action {
                "disconnect" => {
                    cancel.send(true).unwrap();
                }
                "receiver" => drop(rx),
                "revoke" => runner.set_enabled(false),
                _ => {
                    collect(
                        &runner,
                        json!({"method":"cancelRunWork","botId":"bot","targetRunId":"run"}),
                    )
                    .await;
                }
            }
            tokio::time::timeout(Duration::from_secs(5), operation)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            for _ in 0..50 {
                if !group_alive(pid) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!group_alive(pid), "{action} left command alive");
        }
    }
}
