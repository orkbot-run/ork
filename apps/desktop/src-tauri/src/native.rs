// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
use tauri::{ipc::CapabilityBuilder, Manager};
use url::Url;

const DENIED: &str = "This document cannot use native desktop commands.";

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

struct Session {
    origin: url::Origin,
    proof: String,
    document: Option<String>,
    retired: HashSet<String>,
    zoom: f64,
    pending_locale: Option<String>,
    epoch: u64,
}

#[derive(Clone)]
pub struct Document {
    pub label: String,
    pub id: String,
    pub origin: Url,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "accounts.signIn")]
    AccountsSignIn,
    #[serde(rename = "accounts.session")]
    AccountsSession,
    #[serde(rename = "accounts.logout")]
    AccountsLogout,
    #[serde(rename = "hello")]
    Hello { epoch: u64 },
    #[serde(rename = "pairing.sync")]
    PairingSync,
    #[serde(rename = "pairing.clear")]
    PairingClear,
    #[serde(rename = "computer.requestAccess")]
    ComputerRequestAccess,
    #[serde(rename = "computer.revokeAccess")]
    ComputerRevokeAccess,
    #[serde(rename = "window.state")]
    WindowState,
    #[serde(rename = "window.close")]
    WindowClose,
    #[serde(rename = "window.minimize")]
    WindowMinimize,
    #[serde(rename = "window.toggleMaximize")]
    WindowToggleMaximize,
    #[serde(rename = "badge.set")]
    BadgeSet { count: f64 },
    #[serde(rename = "server.change")]
    ServerChange,
    #[serde(rename = "server.remember")]
    ServerRemember,
    #[serde(rename = "locale.set")]
    LocaleSet { locale: String },
    #[serde(rename = "monitoring.enabled")]
    MonitoringEnabled,
    #[serde(rename = "passkeys.rpIds")]
    PasskeyRpIds,
    #[serde(rename = "update.state")]
    UpdateState,
    #[serde(rename = "update.check")]
    UpdateCheck,
    #[serde(rename = "update.download")]
    UpdateDownload,
    #[serde(rename = "update.install")]
    UpdateInstall,
    #[serde(rename = "oauth.open")]
    OAuthOpen { url: String },
    #[serde(rename = "oauth.cancel")]
    OAuthCancel { url: String },
    #[serde(rename = "speech.start")]
    SpeechStart { language: String, session: u64 },
    #[serde(rename = "speech.stop")]
    SpeechStop { session: u64 },
    #[serde(rename = "speech.abort")]
    SpeechAbort { session: u64 },
}

impl Command {
    /// A hidden candidate may initialize the page, but cannot start native work.
    pub fn read_only(&self) -> bool {
        matches!(
            self,
            Self::Hello { .. }
                | Self::WindowState
                | Self::MonitoringEnabled
                | Self::PasskeyRpIds
                | Self::UpdateState
                | Self::LocaleSet { .. }
        )
    }
}

impl Sessions {
    pub fn insert(&self, label: &str, origin: &Url) -> Result<String, String> {
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|_| "Could not secure the desktop window.")?;
        let proof: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        self.0.lock().map_err(|_| DENIED)?.insert(
            label.to_owned(),
            Session {
                origin: origin.origin(),
                proof: proof.clone(),
                document: None,
                retired: HashSet::new(),
                zoom: 1.0,
                pending_locale: None,
                epoch: 0,
            },
        );
        Ok(proof)
    }

    pub fn authorize(
        &self,
        label: &str,
        url: &Url,
        proof: &str,
        document: &str,
        epoch: Option<u64>,
    ) -> Result<(Document, Option<String>), String> {
        if document.len() != 64
            || !document
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(DENIED.into());
        }
        let mut sessions = self.0.lock().map_err(|_| DENIED)?;
        let session = sessions.get_mut(label).ok_or(DENIED)?;
        if url.origin() != session.origin
            || !url.username().is_empty()
            || url.password().is_some()
            || !proof_matches(&session.proof, proof)
            || session.retired.contains(document)
            || session.retired.len() >= 4096
            || !matches!(url.scheme(), "http" | "https")
        {
            return Err(DENIED.into());
        }
        let previous = if let Some(epoch) = epoch {
            // The renderer captures its monotonic time origin before any async IPC.
            // Reject an older hello even if that document's first request was delayed.
            if epoch == 0
                || epoch > 9_007_199_254_740_991
                || epoch < session.epoch
                || (epoch == session.epoch && session.document.as_deref() != Some(document))
                || (session.document.as_deref() == Some(document) && epoch != session.epoch)
            {
                return Err(DENIED.into());
            }
            session.epoch = epoch;
            let previous = session
                .document
                .replace(document.into())
                .filter(|id| id != document);
            if let Some(previous) = &previous {
                session.retired.insert(previous.clone());
            }
            previous
        } else if session.document.as_deref() == Some(document) {
            None
        } else {
            return Err(DENIED.into());
        };
        Ok((
            Document {
                label: label.into(),
                id: document.into(),
                origin: url.clone(),
            },
            previous.filter(|id| id != document),
        ))
    }

    pub fn current(&self, label: &str) -> Option<Document> {
        let sessions = self.0.lock().ok()?;
        let session = sessions.get(label)?;
        Some(Document {
            label: label.into(),
            id: session.document.clone()?,
            origin: Url::parse(&session.origin.ascii_serialization()).ok()?,
        })
    }

    pub fn invalidate(&self, label: &str) -> Option<String> {
        let mut sessions = self.0.lock().ok()?;
        let session = sessions.get_mut(label)?;
        let document = session.document.take()?;
        session.retired.insert(document.clone());
        session.pending_locale = None;
        Some(document)
    }

    pub fn adjust_zoom(&self, label: &str, delta: Option<f64>) -> Option<f64> {
        let mut sessions = self.0.lock().ok()?;
        let session = sessions.get_mut(label)?;
        session.zoom = delta.map_or(1.0, |delta| (session.zoom + delta).clamp(0.5, 3.0));
        Some(session.zoom)
    }

    pub fn remove(&self, label: &str) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.remove(label);
        }
    }

    pub fn pending_locale(&self, label: &str, locale: &str) -> Result<(), String> {
        if locale.len() > 35 {
            return Err("Invalid language tag.".into());
        }
        let mut sessions = self.0.lock().map_err(|_| DENIED)?;
        sessions.get_mut(label).ok_or(DENIED)?.pending_locale = Some(locale.into());
        Ok(())
    }

    pub fn take_locale(&self, label: &str) -> Option<String> {
        self.0.lock().ok()?.get_mut(label)?.pending_locale.take()
    }

    pub fn is_current(&self, document: &Document) -> bool {
        self.current(&document.label).is_some_and(|current| {
            current.id == document.id && current.origin.origin() == document.origin.origin()
        })
    }
}

impl Document {
    pub fn owner(&self) -> String {
        owner(&self.label, &self.id)
    }
}

pub fn owner(label: &str, document: &str) -> String {
    format!("{label}:{document}")
}

fn proof_matches(expected: &str, received: &str) -> bool {
    expected.len() == received.len()
        && expected
            .bytes()
            .zip(received.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

pub fn grant<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    origin: &Url,
) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new(format!("native-{label}"))
            .local(false)
            .window(label)
            .remote(format!("{}/*", origin.origin().ascii_serialization()))
            .permission("allow-native-command"),
    )
}

pub fn initialization_script(
    label: &str,
    origin: &Url,
    proof: &str,
    speech: bool,
    computer: bool,
) -> String {
    let config = serde_json::json!({
        "origin": origin.origin().ascii_serialization(),
        "proof": proof,
        "platform": if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "win32" } else { "linux" },
        "speech": speech,
        "computer": computer,
        "label": label,
    });
    format!(
        "(() => {{ const config = {config}; {} }})();",
        include_str!("../../build/tauri-ui/native-bridge.js")
    )
}

/// Events carry a document identity, so a queued result cannot reach a reloaded page.
pub fn event_script(document: &Document, kind: &str, payload: impl serde::Serialize) -> String {
    let origin = serde_json::to_string(&document.origin.origin().ascii_serialization()).unwrap();
    let id = serde_json::to_string(&document.id).unwrap();
    let kind = serde_json::to_string(kind).unwrap();
    let payload = serde_json::to_string(&payload).expect("native event payload is serializable");
    // Direct literal arguments avoid page-controlled iterators before the private ID check.
    // Check the live document too: navigation can race a queued native evaluation.
    format!("if (window.location.origin === {origin} && (window.location.protocol === 'https:' || window.location.protocol === 'http:')) {{ window.__orkbotNativeDispatch?.({id}, {kind}, {payload}); }}")
}

pub fn badge_count(count: f64) -> Option<i64> {
    (count.is_finite() && count >= 0.0 && count.fract() == 0.0 && count <= 9_007_199_254_740_991.0)
        .then(|| count.min(9999.0) as i64)
        .filter(|count| *count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        Arc,
    };
    use tauri::{test::MockRuntime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    #[derive(Default)]
    struct Effects {
        entered_native: AtomicUsize,
        authorized_native: AtomicUsize,
        setup: AtomicUsize,
        plugins: AtomicUsize,
    }

    #[tauri::command]
    fn native_command<R: tauri::Runtime>(
        window: WebviewWindow<R>,
        sessions: State<Sessions>,
        effects: State<Arc<Effects>>,
        proof: String,
        document: String,
        command: Command,
    ) -> Result<String, String> {
        effects.entered_native.fetch_add(1, AtomicOrdering::SeqCst);
        let (document, _) = sessions.authorize(
            window.label(),
            &window.url().map_err(|_| "Test window unavailable")?,
            &proof,
            &document,
            match command {
                Command::Hello { epoch } => Some(epoch),
                _ => None,
            },
        )?;
        effects
            .authorized_native
            .fetch_add(1, AtomicOrdering::SeqCst);
        Ok(document.owner())
    }

    #[tauri::command]
    fn setup_state(effects: State<Arc<Effects>>) -> bool {
        effects.setup.fetch_add(1, AtomicOrdering::SeqCst);
        true
    }

    #[tauri::command]
    fn connect_server(effects: State<Arc<Effects>>) -> bool {
        effects.setup.fetch_add(1, AtomicOrdering::SeqCst);
        true
    }

    struct AuthorityFixture {
        app: tauri::App<MockRuntime>,
        main: WebviewWindow<MockRuntime>,
        other: WebviewWindow<MockRuntime>,
        popup: WebviewWindow<MockRuntime>,
        setup: WebviewWindow<MockRuntime>,
        effects: Arc<Effects>,
        origin: Url,
        proof: String,
        other_proof: String,
    }

    fn authority_fixture() -> AuthorityFixture {
        let effects = Arc::new(Effects::default());
        let fs_effects = Arc::clone(&effects);
        let update_effects = Arc::clone(&effects);
        let app = tauri::test::mock_builder()
            .manage(Sessions::default())
            .manage(Arc::clone(&effects))
            .plugin(
                tauri::plugin::Builder::<MockRuntime, ()>::new("fs")
                    .invoke_handler(move |invoke| {
                        fs_effects.plugins.fetch_add(1, AtomicOrdering::SeqCst);
                        invoke.resolver.resolve("filesystem handler executed");
                        true
                    })
                    .build(),
            )
            .plugin(
                tauri::plugin::Builder::<MockRuntime, ()>::new("updater")
                    .invoke_handler(move |invoke| {
                        update_effects.plugins.fetch_add(1, AtomicOrdering::SeqCst);
                        invoke.resolver.resolve("updater handler executed");
                        true
                    })
                    .build(),
            )
            .invoke_handler(tauri::generate_handler![
                native_command,
                setup_state,
                connect_server
            ])
            .build(crate::app_context())
            .unwrap();
        let origin = Url::parse("http://localhost:45001").unwrap();
        let main =
            WebviewWindowBuilder::new(&app, "server-1", WebviewUrl::External(origin.clone()))
                .build()
                .unwrap();
        let other =
            WebviewWindowBuilder::new(&app, "server-2", WebviewUrl::External(origin.clone()))
                .build()
                .unwrap();
        let popup =
            WebviewWindowBuilder::new(&app, "auth-server-1", WebviewUrl::External(origin.clone()))
                .build()
                .unwrap();
        let setup = WebviewWindowBuilder::new(&app, "setup", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        let sessions = app.state::<Sessions>();
        let proof = sessions.insert("server-1", &origin).unwrap();
        let other_proof = sessions.insert("server-2", &origin).unwrap();
        grant(app.handle(), "server-1", &origin).unwrap();
        AuthorityFixture {
            app,
            main,
            other,
            popup,
            setup,
            effects,
            origin,
            proof,
            other_proof,
        }
    }

    fn invoke(
        command: &str,
        source: &Url,
        body: serde_json::Value,
    ) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: source.clone(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        }
    }

    fn native_request(
        source: &Url,
        proof: &str,
        document: &str,
        command: &str,
    ) -> tauri::webview::InvokeRequest {
        native_request_at_epoch(source, proof, document, command, 1)
    }

    fn native_request_at_epoch(
        source: &Url,
        proof: &str,
        document: &str,
        command: &str,
        epoch: u64,
    ) -> tauri::webview::InvokeRequest {
        let command = if command == "hello" {
            serde_json::json!({"type": "hello", "epoch": epoch})
        } else {
            serde_json::json!({"type": command})
        };
        invoke(
            "native_command",
            source,
            serde_json::json!({
                "proof": proof,
                "document": document,
                "command": command,
            }),
        )
    }

    #[test]
    fn runtime_authority_limits_dynamic_native_access_to_the_exact_window_and_origin() {
        let fixture = authority_fixture();
        let document = "a".repeat(64);
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request(&fixture.origin, &fixture.proof, &document, "hello"),
            Ok(format!("server-1:{document}")),
        );
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            1
        );
        for source in [
            "http://localhost:45002",
            "https://localhost:45001",
            "http://127.0.0.1:45001",
            "http://localhost.example.com:45001",
            "https://orkbot.example.com",
            "tauri://localhost/index.html",
        ] {
            assert!(
                tauri::test::get_ipc_response(
                    &fixture.main,
                    native_request(
                        &Url::parse(source).unwrap(),
                        &fixture.proof,
                        &document,
                        "hello"
                    ),
                )
                .is_err(),
                "{source}"
            );
        }
        for (window, proof) in [
            (&fixture.other, &fixture.other_proof),
            (&fixture.popup, &fixture.proof),
            (&fixture.setup, &fixture.proof),
        ] {
            assert!(tauri::test::get_ipc_response(
                window,
                native_request(&fixture.origin, proof, &document, "hello"),
            )
            .is_err());
        }
        // These denials must happen in RuntimeAuthority, before the session handler runs.
        assert_eq!(
            fixture.effects.entered_native.load(AtomicOrdering::SeqCst),
            1
        );
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            1
        );
    }

    #[test]
    fn dynamic_native_permission_never_grants_setup_or_direct_plugin_commands() {
        let fixture = authority_fixture();
        for command in [
            "setup_state",
            "connect_server",
            "local_stack_state",
            "connect_local_server",
            "quit_setup",
            "plugin:updater|check",
            "plugin:updater|download_and_install",
            "plugin:fs|read_file",
            "plugin:fs|write_file",
            "plugin:opener|open_url",
        ] {
            assert!(
                tauri::test::get_ipc_response(
                    &fixture.main,
                    invoke(command, &fixture.origin, serde_json::json!({})),
                )
                .is_err(),
                "{command}"
            );
        }
        assert_eq!(fixture.effects.setup.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(fixture.effects.plugins.load(AtomicOrdering::SeqCst), 0);
        // A positive local call proves that the registered setup handlers are reachable.
        let local = fixture.setup.url().unwrap();
        tauri::test::assert_ipc_response(
            &fixture.setup,
            invoke("setup_state", &local, serde_json::json!({})),
            Ok(true),
        );
        assert_eq!(fixture.effects.setup.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn a_matching_runtime_origin_still_requires_private_proof_and_document_identity() {
        let fixture = authority_fixture();
        let document = "a".repeat(64);
        for (proof, document, command) in [
            ("", document.as_str(), "hello"),
            ("incorrect-proof", document.as_str(), "hello"),
            (fixture.other_proof.as_str(), document.as_str(), "hello"),
            (fixture.proof.as_str(), "short", "hello"),
            (fixture.proof.as_str(), document.as_str(), "window.state"),
        ] {
            assert!(tauri::test::get_ipc_response(
                &fixture.main,
                native_request(&fixture.origin, proof, document, command),
            )
            .is_err());
        }
        assert_eq!(
            fixture.effects.entered_native.load(AtomicOrdering::SeqCst),
            5
        );
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            0
        );
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request(&fixture.origin, &fixture.proof, &document, "hello"),
            Ok(format!("server-1:{document}")),
        );
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request(&fixture.origin, &fixture.proof, &document, "window.state"),
            Ok(format!("server-1:{document}")),
        );
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            2
        );
        // Even a correctly granted second window cannot borrow the first window's proof.
        grant(fixture.app.handle(), "server-2", &fixture.origin).unwrap();
        assert!(tauri::test::get_ipc_response(
            &fixture.other,
            native_request(&fixture.origin, &fixture.proof, &document, "hello"),
        )
        .is_err());
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            2
        );
    }

    #[test]
    fn retired_hello_and_dangling_capabilities_cannot_restore_document_access() {
        let fixture = authority_fixture();
        let previous = "a".repeat(64);
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request(&fixture.origin, &fixture.proof, &previous, "hello"),
            Ok(format!("server-1:{previous}")),
        );
        fixture
            .main
            .navigate(fixture.origin.join("/reloaded").unwrap())
            .unwrap();
        let current = "b".repeat(64);
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request_at_epoch(&fixture.origin, &fixture.proof, &current, "hello", 2),
            Ok(format!("server-1:{current}")),
        );
        for command in ["hello", "window.state"] {
            assert!(tauri::test::get_ipc_response(
                &fixture.main,
                native_request(&fixture.origin, &fixture.proof, &previous, command),
            )
            .is_err());
        }
        let uppercase = current.to_uppercase();
        assert!(tauri::test::get_ipc_response(
            &fixture.main,
            native_request_at_epoch(&fixture.origin, &fixture.proof, &uppercase, "hello", 2),
        )
        .is_err());
        fixture.app.state::<Sessions>().remove("server-1");
        assert!(tauri::test::get_ipc_response(
            &fixture.main,
            native_request_at_epoch(&fixture.origin, &fixture.proof, &current, "hello", 2),
        )
        .is_err());
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            2
        );
    }

    #[test]
    fn a_fresh_document_hello_returns_the_previous_owner_and_retires_it() {
        let sessions = Sessions::default();
        let origin = Url::parse("http://localhost:45001").unwrap();
        let proof = sessions.insert("server-1", &origin).unwrap();
        let previous = "a".repeat(64);
        let next = "b".repeat(64);
        let (old_document, _) = sessions
            .authorize("server-1", &origin, &proof, &previous, Some(1))
            .unwrap();
        let (new_document, retired) = sessions
            .authorize("server-1", &origin, &proof, &next, Some(2))
            .unwrap();
        assert_eq!(retired.as_deref(), Some(previous.as_str()));
        assert!(!sessions.is_current(&old_document));
        assert!(sessions.is_current(&new_document));
        assert!(sessions
            .authorize("server-1", &origin, &proof, &previous, Some(3))
            .is_err());
        assert!(sessions
            .authorize("server-1", &origin, &proof, &previous, None)
            .is_err());
        let (_, retired) = sessions
            .authorize("server-1", &origin, &proof, &next, Some(2))
            .unwrap();
        assert!(retired.is_none());
    }

    #[test]
    fn an_unseen_older_hello_cannot_displace_the_current_document() {
        let fixture = authority_fixture();
        let current = "b".repeat(64);
        let delayed = "a".repeat(64);
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request_at_epoch(&fixture.origin, &fixture.proof, &current, "hello", 2),
            Ok(format!("server-1:{current}")),
        );
        assert!(tauri::test::get_ipc_response(
            &fixture.main,
            native_request_at_epoch(&fixture.origin, &fixture.proof, &delayed, "hello", 1),
        )
        .is_err());
        tauri::test::assert_ipc_response(
            &fixture.main,
            native_request(&fixture.origin, &fixture.proof, &current, "window.state"),
            Ok(format!("server-1:{current}")),
        );
        fixture.app.state::<Sessions>().invalidate("server-1");
        assert!(tauri::test::get_ipc_response(
            &fixture.main,
            native_request_at_epoch(&fixture.origin, &fixture.proof, &delayed, "hello", 1),
        )
        .is_err());
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            2
        );
    }

    #[test]
    fn document_epochs_are_positive_safe_integers_and_unchanged_for_idempotent_hello() {
        let sessions = Sessions::default();
        let origin = Url::parse("http://localhost:45001").unwrap();
        let proof = sessions.insert("server-1", &origin).unwrap();
        let current = "a".repeat(64);
        let next = "b".repeat(64);
        for epoch in [0, 9_007_199_254_740_992, u64::MAX] {
            assert!(sessions
                .authorize("server-1", &origin, &proof, &current, Some(epoch))
                .is_err());
        }
        sessions
            .authorize("server-1", &origin, &proof, &current, Some(2))
            .unwrap();
        sessions
            .authorize("server-1", &origin, &proof, &current, Some(2))
            .unwrap();
        assert!(sessions
            .authorize("server-1", &origin, &proof, &current, Some(3))
            .is_err());
        for epoch in [1, 2] {
            assert!(sessions
                .authorize("server-1", &origin, &proof, &next, Some(epoch))
                .is_err());
        }
        sessions.invalidate("server-1");
        assert!(sessions
            .authorize("server-1", &origin, &proof, &next, Some(2))
            .is_err());
        sessions
            .authorize("server-1", &origin, &proof, &next, Some(3))
            .unwrap();
    }

    #[test]
    fn a_blob_document_cannot_borrow_native_access_from_its_embedded_http_origin() {
        let fixture = authority_fixture();
        let blob = Url::parse("blob:http://localhost:45001/example-document").unwrap();
        assert_eq!(blob.origin(), fixture.origin.origin());
        fixture.main.navigate(blob).unwrap();
        // Model a platform reporting the top origin for a frame IPC message.
        assert!(tauri::test::get_ipc_response(
            &fixture.main,
            native_request(&fixture.origin, &fixture.proof, &"a".repeat(64), "hello"),
        )
        .is_err());
        assert_eq!(
            fixture.effects.entered_native.load(AtomicOrdering::SeqCst),
            1
        );
        assert_eq!(
            fixture
                .effects
                .authorized_native
                .load(AtomicOrdering::SeqCst),
            0
        );
    }

    #[test]
    fn commands_require_private_proof_the_window_origin_and_current_document() {
        let sessions = Sessions::default();
        let url = Url::parse("http://localhost:45001").unwrap();
        let other_port = Url::parse("http://localhost:45002").unwrap();
        let proof = sessions.insert("server-1", &url).unwrap();
        let document = "a".repeat(64);
        let authorize = |label, url: &Url, proof: &str, document: &str, epoch| {
            sessions.authorize(label, url, proof, document, epoch)
        };
        assert!(authorize("server-1", &url, &proof, &document, None).is_err());
        for (label, url, proof) in [
            ("server-1", &url, ""),
            ("server-1", &url, "invalid"),
            ("auth-server-1", &url, proof.as_str()),
            ("server-1", &other_port, proof.as_str()),
        ] {
            assert!(authorize(label, url, proof, &document, Some(1)).is_err());
        }
        let (current, previous) = authorize("server-1", &url, &proof, &document, Some(1)).unwrap();
        assert!(previous.is_none());
        assert!(sessions.is_current(&current));
        sessions.invalidate("server-1");
        assert!(!sessions.is_current(&current));
        assert!(authorize("server-1", &url, &proof, &document, None).is_err());
        assert!(authorize("server-1", &url, &proof, &document, Some(1)).is_err());
        let next = "b".repeat(64);
        authorize("server-1", &url, &proof, &next, Some(2)).unwrap();
        assert!(authorize("server-1", &url, &proof, &document, Some(1)).is_err());
        assert!(!sessions.is_current(&current));
        sessions.remove("server-1");
        assert!(authorize("server-1", &url, &proof, &next, Some(2)).is_err());
    }

    #[test]
    fn badge_values_are_bounded_and_invalid_values_clear_the_badge() {
        assert_eq!(badge_count(1.0), Some(1));
        assert_eq!(badge_count(10000.0), Some(9999));
        for value in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, f64::MAX] {
            assert_eq!(badge_count(value), None);
        }
    }

    #[test]
    fn generated_events_do_not_expose_payloads_before_the_current_document_check() {
        let origin = Url::parse("https://orkbot.example.com").unwrap();
        let current = Document {
            label: "server-1".into(),
            id: "0c".repeat(32),
            origin: origin.clone(),
        };
        let stale = Document {
            id: "0b".repeat(32),
            ..current.clone()
        };
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("payload.json"),
            serde_json::to_vec(&serde_json::json!([
                initialization_script("server-1", &origin, &"a".repeat(64), false, false),
                event_script(&stale, "menu", "private stale payload"),
                event_script(&current, "menu", "find")
            ]))
            .unwrap(),
        )
        .unwrap();
        let harness = r#"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const [bootstrap, stale, current] = JSON.parse(readFileSync(new URL('./payload.json', import.meta.url), 'utf8'));
const window = {
  location: { origin: 'https://orkbot.example.com', protocol: 'https:' },
  __TAURI_INTERNALS__: {
    invoke: () => Promise.resolve(),
    metadata: { currentWindow: { label: 'server-1' }, currentWebview: { label: 'server-1' } }
  }
};
window.top = window;
const context = vm.createContext({window, crypto: {getRandomValues: value => value.fill(12)}, performance: {timeOrigin: 1000}});
vm.runInContext(bootstrap, context);
vm.runInContext(`
  globalThis.received = [];
  globalThis.iteratorLeaks = [];
  window.orkbotDesktop.menu.onCommand(value => received.push(value));
  Array.prototype[Symbol.iterator] = function* () {
    iteratorLeaks.push(this[2]);
    for (let index=0; index<this.length; index++) yield this[index];
  };
`, context);
vm.runInContext(stale, context);
assert.equal(vm.runInContext('received.length', context), 0);
assert.equal(vm.runInContext('iteratorLeaks.length', context), 0);
vm.runInContext("window.__orkbotNativeDispatch?.(...['stale', 'menu', 'unsafe control'])", context);
assert.equal(vm.runInContext('iteratorLeaks[0]', context), 'unsafe control');
vm.runInContext(current, context);
assert.equal(vm.runInContext('received[0]', context), 'find');
for (const location of [
  {origin:'https://foreign.example.com', protocol:'https:'},
  {origin:'https://orkbot.example.com', protocol:'blob:'}
]) {
  const leaks = [];
  vm.runInNewContext(stale, {window:{location, __orkbotNativeDispatch:(...args)=>leaks.push(args)}});
  assert.equal(leaks.length, 0);
}
"#;
        let script = directory.path().join("native-event.mjs");
        std::fs::write(&script, harness).unwrap();
        let output = std::process::Command::new("node")
            .arg(script)
            .output()
            .expect("Node is required by tauri:prepare and native bridge tests");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
