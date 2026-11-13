// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited Apache-2.0 desktop system-speech.ts protocol and ownership rules.
// New Rust process management and cancellation follow LICENSE.md.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::mpsc,
    time::{sleep_until, timeout, Instant},
};
use url::{Host, Url};

const MAX_SESSION: u64 = 9_007_199_254_740_991;
const MAX_LINE_CHARS: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = MAX_LINE_CHARS * 4;
const FINAL_RESULT_TIMEOUT: Duration = Duration::from_secs(6);
const ERROR_CODES: [&str; 7] = [
    "aborted",
    "audio-capture",
    "language-not-supported",
    "network",
    "no-speech",
    "not-allowed",
    "service-not-allowed",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SpeechEvent {
    Result { session: u64, text: String },
    Error { session: u64, error: String },
    End { session: u64 },
}

pub type SpeechSink = Arc<dyn Fn(SpeechEvent) + Send + Sync>;

enum Control {
    Stop,
    Abort,
}

struct Recognizer {
    live: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Recognizer {
    fn new() -> Self {
        Self {
            live: AtomicBool::new(true),
            child: Mutex::new(None),
        }
    }

    fn kill(&self) {
        self.live.store(false, Ordering::Release);
        let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(child) = child.as_mut() {
            let _ = child.start_kill();
        }
    }

    fn spawn(
        &self,
        helper: &Path,
        language: &str,
    ) -> Result<Option<(ChildStdin, ChildStdout, ChildStderr)>, ()> {
        // Quit must kill the child before returning, even if the async runtime stops next.
        let mut slot = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if !self.live.load(Ordering::Acquire) {
            return Ok(None);
        }
        let mut child = Command::new(helper)
            .arg(language)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.start_kill();
            return Err(());
        };
        *slot = Some(child);
        Ok(Some((stdin, stdout, stderr)))
    }

    fn take_child(&self) -> Option<Child> {
        self.child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

struct Active {
    owner: String,
    session: u64,
    generation: u64,
    recognizer: Arc<Recognizer>,
    stopping: bool,
    control: mpsc::UnboundedSender<Control>,
    emit: SpeechSink,
}

#[derive(Default)]
struct Sessions {
    generation: u64,
    active: Option<Active>,
}

pub struct SpeechManager {
    helper: PathBuf,
    sessions: Arc<Mutex<Sessions>>,
}

impl SpeechManager {
    pub fn new(helper: PathBuf) -> Self {
        Self {
            helper,
            sessions: Arc::new(Mutex::new(Sessions::default())),
        }
    }

    /// The composition root exposes this feature only on macOS with a packaged helper.
    pub fn available(&self) -> bool {
        cfg!(target_os = "macos") && executable_file(&self.helper)
    }

    /// Called only after the bridge has authenticated the current top-level document.
    pub fn start(
        &self,
        owner: &str,
        origin: &Url,
        language: &str,
        session: u64,
        emit: SpeechSink,
    ) -> bool {
        if owner.is_empty()
            || !secure_origin(origin)
            || !language_tag(language)
            || session == 0
            || session > MAX_SESSION
            || !self.available()
        {
            return false;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };
        let Some(generation) = sessions.generation.checked_add(1) else {
            return false;
        };
        let previous = sessions.active.take();
        if let Some(previous) = &previous {
            previous.recognizer.kill();
            let _ = previous.control.send(Control::Abort);
        }
        let (control, commands) = mpsc::unbounded_channel();
        let recognizer = Arc::new(Recognizer::new());
        sessions.generation = generation;
        sessions.active = Some(Active {
            owner: owner.into(),
            session,
            generation,
            recognizer: Arc::clone(&recognizer),
            stopping: false,
            control,
            emit,
        });
        drop(sessions);
        if let Some(previous) = previous {
            (previous.emit)(SpeechEvent::End {
                session: previous.session,
            });
        }

        let sessions = Arc::clone(&self.sessions);
        let helper = self.helper.clone();
        let language = language.to_owned();
        tauri::async_runtime::spawn(async move {
            run_recognizer(sessions, generation, recognizer, helper, language, commands).await;
        });
        true
    }

    pub fn stop(&self, owner: &str, session: u64) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(active) = sessions.active.as_mut() {
            if active.owner == owner && active.session == session && !active.stopping {
                active.stopping = true;
                let _ = active.control.send(Control::Stop);
            }
        }
    }

    pub fn abort(&self, owner: &str, session: u64) {
        self.cancel(
            |active| active.owner == owner && active.session == session,
            true,
        );
    }

    /// Navigation and teardown cancel silently because that document can no longer receive events.
    pub fn cancel_owner(&self, owner: &str) {
        self.cancel(|active| active.owner == owner, false);
    }

    pub fn shutdown(&self) {
        self.cancel(|_| true, false);
    }

    fn cancel(&self, matches: impl FnOnce(&Active) -> bool, notify: bool) {
        let active = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if sessions.active.as_ref().is_some_and(matches) {
                if let Some(active) = &sessions.active {
                    active.recognizer.kill();
                }
                sessions.active.take()
            } else {
                None
            }
        };
        if let Some(active) = active {
            let _ = active.control.send(Control::Abort);
            if notify {
                (active.emit)(SpeechEvent::End {
                    session: active.session,
                });
            }
        }
    }
}

impl Drop for SpeechManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let regular = metadata.is_file() && !metadata.file_type().is_symlink();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        regular && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        regular
    }
}

fn secure_origin(origin: &Url) -> bool {
    if !origin.username().is_empty() || origin.password().is_some() || origin.host().is_none() {
        return false;
    }
    origin.scheme() == "https"
        || (origin.scheme() == "http"
            && match origin.host() {
                Some(Host::Domain(host)) => host == "localhost" || host.ends_with(".localhost"),
                Some(Host::Ipv4(host)) => host.is_loopback(),
                Some(Host::Ipv6(host)) => host.is_loopback(),
                None => false,
            })
}

fn language_tag(language: &str) -> bool {
    if language.len() > 35 {
        return false;
    }
    let mut parts = language.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&first.len()) || !first.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return false;
    }
    let parts: Vec<_> = parts.collect();
    parts.len() <= 3
        && parts.iter().all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

#[derive(Debug, PartialEq, Eq)]
enum HelperEvent {
    Result(String),
    Error(String),
    End,
}

#[derive(Default)]
struct HelperLines {
    pending: Vec<u8>,
}

impl HelperLines {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<HelperEvent>, ()> {
        let mut events = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                let line = self.line()?;
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let event = match value.get("type").and_then(Value::as_str) {
                        Some("result") => value
                            .get("text")
                            .and_then(Value::as_str)
                            .map(|text| HelperEvent::Result(text.into())),
                        Some("error") => {
                            value
                                .get("error")
                                .and_then(Value::as_str)
                                .and_then(|error| {
                                    ERROR_CODES
                                        .contains(&error)
                                        .then(|| HelperEvent::Error(error.into()))
                                })
                        }
                        Some("end") => Some(HelperEvent::End),
                        _ => None,
                    };
                    if let Some(event) = event {
                        let ended = event == HelperEvent::End;
                        events.push(event);
                        if ended {
                            self.pending.clear();
                            return Ok(events);
                        }
                    }
                }
                self.pending.clear();
            } else {
                self.pending.push(*byte);
                if self.pending.len() > MAX_LINE_BYTES {
                    return Err(());
                }
            }
        }
        self.line()?;
        Ok(events)
    }

    fn line(&self) -> Result<std::borrow::Cow<'_, str>, ()> {
        let line = String::from_utf8_lossy(&self.pending);
        if line.encode_utf16().count() > MAX_LINE_CHARS {
            Err(())
        } else {
            Ok(line)
        }
    }
}

fn current(
    sessions: &Mutex<Sessions>,
    generation: u64,
) -> Option<(SpeechSink, Arc<Recognizer>, u64)> {
    let sessions = sessions.lock().ok()?;
    let active = sessions.active.as_ref()?;
    (active.generation == generation).then(|| {
        (
            Arc::clone(&active.emit),
            Arc::clone(&active.recognizer),
            active.session,
        )
    })
}

fn finish(sessions: &Mutex<Sessions>, generation: u64, error: Option<&str>) {
    let active = sessions.lock().ok().and_then(|mut sessions| {
        if sessions
            .active
            .as_ref()
            .is_some_and(|active| active.generation == generation)
        {
            if let Some(active) = &sessions.active {
                active.recognizer.kill();
            }
            sessions.active.take()
        } else {
            None
        }
    });
    if let Some(active) = active {
        if let Some(error) = error {
            (active.emit)(SpeechEvent::Error {
                session: active.session,
                error: error.into(),
            });
        }
        (active.emit)(SpeechEvent::End {
            session: active.session,
        });
    }
}

async fn run_recognizer(
    sessions: Arc<Mutex<Sessions>>,
    generation: u64,
    recognizer: Arc<Recognizer>,
    helper: PathBuf,
    language: String,
    mut commands: mpsc::UnboundedReceiver<Control>,
) {
    if current(&sessions, generation).is_none() {
        return;
    }
    let (mut stdin, mut stdout, mut stderr) = match recognizer.spawn(&helper, &language) {
        Ok(Some(pipes)) => pipes,
        Ok(None) => return,
        Err(()) => {
            finish(&sessions, generation, Some("service-not-allowed"));
            return;
        }
    };
    // Drain diagnostics without retaining audio-service errors or blocking its stderr pipe.
    let diagnostics = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
    });
    let mut lines = HelperLines::default();
    let mut buffer = [0; 4096];
    let mut stopping_at = None;
    'reading: loop {
        tokio::select! {
            biased;
            command = commands.recv() => match command {
                Some(Control::Stop) => {
                    if stdin.write_all(b"stop\n").await.is_err() {
                        finish(&sessions, generation, Some("network"));
                        break;
                    }
                    stopping_at = Some(Instant::now() + FINAL_RESULT_TIMEOUT);
                }
                Some(Control::Abort) | None => break,
            },
            _ = async {
                match stopping_at {
                    Some(deadline) => sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => {
                finish(&sessions, generation, None);
                break;
            },
            read = stdout.read(&mut buffer) => match read {
                Ok(0) => {
                    finish(&sessions, generation, None);
                    break;
                },
                Ok(size) => match lines.push(&buffer[..size]) {
                    Ok(events) => for event in events {
                        let Some((emit, recognizer, session)) = current(&sessions, generation) else {
                            break 'reading;
                        };
                        if !recognizer.live.load(Ordering::Acquire) {
                            break 'reading;
                        }
                        match event {
                            HelperEvent::Result(text) => emit(SpeechEvent::Result { session, text }),
                            HelperEvent::Error(error) => emit(SpeechEvent::Error { session, error }),
                            HelperEvent::End => {
                                finish(&sessions, generation, None);
                                break 'reading;
                            },
                        }
                    },
                    Err(()) => {
                        finish(&sessions, generation, Some("network"));
                        break;
                    }
                },
                Err(_) => {
                    finish(&sessions, generation, Some("network"));
                    break;
                }
            },
        }
    }
    drop(stdin);
    recognizer.kill();
    if let Some(mut child) = recognizer.take_child() {
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
    }
    diagnostics.abort();
    finish(&sessions, generation, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_helper_requires_a_regular_file_and_executable_permissions_on_unix() {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("helper");
        assert!(!executable_file(&helper));
        assert!(!executable_file(directory.path()));
        std::fs::write(&helper, "fixture helper").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(!executable_file(&helper));
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
            let link = directory.path().join("linked-helper");
            std::os::unix::fs::symlink(&helper, &link).unwrap();
            assert!(!executable_file(&link));
        }
        assert!(executable_file(&helper));
    }

    #[test]
    fn event_payloads_match_the_shared_desktop_contract() {
        for (event, value) in [
            (
                SpeechEvent::Result {
                    session: 7,
                    text: "hello".into(),
                },
                serde_json::json!({"session":7,"type":"result","text":"hello"}),
            ),
            (
                SpeechEvent::Error {
                    session: 7,
                    error: "not-allowed".into(),
                },
                serde_json::json!({"session":7,"type":"error","error":"not-allowed"}),
            ),
            (
                SpeechEvent::End { session: 7 },
                serde_json::json!({"session":7,"type":"end"}),
            ),
        ] {
            assert_eq!(serde_json::to_value(event).unwrap(), value);
        }
    }

    #[test]
    fn recognition_requires_https_or_actual_loopback_http() {
        for origin in [
            "https://example.com",
            "http://localhost:45173",
            "http://app.localhost:45173",
            "http://127.0.0.1:45173",
            "http://[::1]:45173",
        ] {
            assert!(secure_origin(&Url::parse(origin).unwrap()), "{origin}");
        }
        for origin in [
            "http://192.168.1.20:45173",
            "http://10.0.0.20:45173",
            "http://[fd00::20]:45173",
            "http://server.local:45173",
            "http://localhost.:45173",
            "http://localhost.example.com",
            "http://[::ffff:127.0.0.1]:45173",
            "https://user:password@example.com",
            "file:///tmp/speech",
        ] {
            assert!(!secure_origin(&Url::parse(origin).unwrap()), "{origin}");
        }
    }

    #[test]
    fn language_values_match_the_existing_tag_policy() {
        for language in ["en", "en-US", "es-419", "zh-Hans-CN", "pt-BR", "de-DE-1996"] {
            assert!(language_tag(language), "{language}");
        }
        for language in [
            "",
            "e",
            "en US",
            "--help",
            "en-US;command",
            "en-US\n",
            "en_US",
            "en-US-a",
            "en-US-aa-bb-cc",
        ] {
            assert!(!language_tag(language), "{language}");
        }
    }

    #[test]
    fn helper_protocol_reassembles_lines_and_rejects_unknown_error_codes() {
        let mut lines = HelperLines::default();
        assert!(lines.push(b"{\"type\":\"res").unwrap().is_empty());
        assert_eq!(
            lines
                .push(b"ult\",\"text\":\"hello\"}\nnot json\n[]\n{\"type\":\"error\",\"error\":\"unknown\"}\n{\"type\":\"error\",\"error\":\"not-allowed\"}\n{\"type\":\"end\"}\n{\"type\":\"result\",\"text\":\"late\"}\n")
                .unwrap(),
            vec![
                HelperEvent::Result("hello".into()),
                HelperEvent::Error("not-allowed".into()),
                HelperEvent::End,
            ]
        );
    }

    #[test]
    fn protocol_limits_count_utf16_units_without_truncating_valid_utf8() {
        for ending in ["", "\n"] {
            assert!(HelperLines::default()
                .push(format!("{}{ending}", "x".repeat(MAX_LINE_CHARS + 1)).as_bytes())
                .is_err());
        }
        assert!(HelperLines::default()
            .push("🙂".repeat(MAX_LINE_CHARS / 2 + 1).as_bytes())
            .is_err());
        let text = "語".repeat(20_000);
        let line = format!("{}\n", serde_json::json!({"type":"result","text":text}));
        assert_eq!(
            HelperLines::default().push(line.as_bytes()).unwrap(),
            vec![HelperEvent::Result(text)]
        );
    }

    #[test]
    fn missing_helper_and_invalid_sessions_fail_closed_without_events() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SpeechManager::new(directory.path().join("missing"));
        let origin = Url::parse("https://example.com").unwrap();
        let emit: SpeechSink = Arc::new(|_| panic!("A refused start must emit no events"));
        assert!(!manager.available());
        assert!(!manager.start("server-1", &origin, "en-US", 1, Arc::clone(&emit)));
        assert!(!manager.start("server-1", &origin, "en-US", 0, Arc::clone(&emit)));
        assert!(!manager.start("server-1", &origin, "en-US", MAX_SESSION + 1, emit));
    }

    #[cfg(target_os = "macos")]
    mod process {
        use std::os::unix::fs::PermissionsExt;

        use super::*;

        fn helper(body: &str) -> (tempfile::TempDir, SpeechManager) {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("speech-protocol-fixture");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            let manager = SpeechManager::new(path);
            (directory, manager)
        }

        fn listener() -> (SpeechSink, mpsc::UnboundedReceiver<SpeechEvent>) {
            let (sender, receiver) = mpsc::unbounded_channel();
            (
                Arc::new(move |event| {
                    let _ = sender.send(event);
                }),
                receiver,
            )
        }

        async fn next(receiver: &mut mpsc::UnboundedReceiver<SpeechEvent>) -> SpeechEvent {
            timeout(Duration::from_secs(3), receiver.recv())
                .await
                .expect("The protocol fixture did not answer")
                .expect("The event stream ended")
        }

        async fn no_more_events(receiver: &mut mpsc::UnboundedReceiver<SpeechEvent>) {
            assert!(!matches!(
                timeout(Duration::from_millis(40), receiver.recv()).await,
                Ok(Some(_))
            ));
        }

        #[tokio::test]
        async fn actual_process_obeys_owner_and_session_stop_boundaries() {
            let (_directory, manager) = helper(
                "printf '%s\\n' '{\"type\":\"result\",\"text\":\"first\"}'\nIFS= read -r command\n[ \"$command\" = stop ] || exit 1\nprintf '%s\\n' '{\"type\":\"result\",\"text\":\"final\"}' '{\"type\":\"end\"}'",
            );
            let (emit, mut events) = listener();
            let origin = Url::parse("https://example.com").unwrap();
            assert!(manager.start("server-1", &origin, "en-US", 7, emit));
            assert_eq!(
                next(&mut events).await,
                SpeechEvent::Result {
                    session: 7,
                    text: "first".into()
                }
            );
            manager.stop("server-2", 7);
            manager.abort("server-1", 8);
            assert!(timeout(Duration::from_millis(40), events.recv())
                .await
                .is_err());
            manager.stop("server-1", 7);
            assert_eq!(
                next(&mut events).await,
                SpeechEvent::Result {
                    session: 7,
                    text: "final".into()
                }
            );
            assert_eq!(next(&mut events).await, SpeechEvent::End { session: 7 });
            no_more_events(&mut events).await;
        }

        #[tokio::test]
        async fn permission_rejection_protocol_and_process_exit_end_once() {
            let (_directory, manager) = helper(
                "printf '%s\\n' '{\"type\":\"error\",\"error\":\"not-allowed\"}' '{\"type\":\"end\"}'",
            );
            let (emit, mut events) = listener();
            assert!(manager.start(
                "server-1",
                &Url::parse("https://example.com").unwrap(),
                "en",
                3,
                emit
            ));
            assert_eq!(
                next(&mut events).await,
                SpeechEvent::Error {
                    session: 3,
                    error: "not-allowed".into()
                }
            );
            assert_eq!(next(&mut events).await, SpeechEvent::End { session: 3 });
            no_more_events(&mut events).await;
        }

        #[tokio::test]
        async fn navigation_and_quit_cancel_silently_and_reap_the_child() {
            for shutdown in [false, true] {
                let (_directory, manager) = helper(
                "printf '{\"type\":\"result\",\"text\":\"%s\"}\\n' \"$$\"\nIFS= read -r command\nprintf '%s\\n' '{\"type\":\"result\",\"text\":\"late\"}'",
            );
                let (emit, mut events) = listener();
                assert!(manager.start(
                    "server-1",
                    &Url::parse("https://example.com").unwrap(),
                    "en",
                    9,
                    emit
                ));
                let SpeechEvent::Result { text, .. } = next(&mut events).await else {
                    panic!("Expected the fixture process identifier");
                };
                let pid: libc::pid_t = text.parse().unwrap();
                if shutdown {
                    manager.shutdown();
                } else {
                    manager.cancel_owner("server-1");
                }
                timeout(Duration::from_secs(3), async {
                    loop {
                        // SAFETY: signal zero checks only whether this owned fixture process still exists.
                        if unsafe { libc::kill(pid, 0) } == -1 {
                            assert_eq!(
                                std::io::Error::last_os_error().raw_os_error(),
                                Some(libc::ESRCH)
                            );
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("The canceled fixture was not reaped");
                no_more_events(&mut events).await;
            }
        }

        #[tokio::test]
        async fn abort_ends_once_and_a_replaced_generation_cannot_finish_the_new_one() {
            let (_directory, manager) = helper(
                "printf '%s\\n' '{\"type\":\"result\",\"text\":\"ready\"}'\nIFS= read -r command",
            );
            let (emit, mut events) = listener();
            let origin = Url::parse("https://example.com").unwrap();
            assert!(manager.start("server-1", &origin, "en", 1, Arc::clone(&emit)));
            assert!(matches!(
                next(&mut events).await,
                SpeechEvent::Result { session: 1, .. }
            ));
            assert!(manager.start("server-1", &origin, "en", 2, emit));
            assert_eq!(next(&mut events).await, SpeechEvent::End { session: 1 });
            assert!(matches!(
                next(&mut events).await,
                SpeechEvent::Result { session: 2, .. }
            ));
            manager.abort("server-1", 2);
            assert_eq!(next(&mut events).await, SpeechEvent::End { session: 2 });
            no_more_events(&mut events).await;
        }
    }
}
