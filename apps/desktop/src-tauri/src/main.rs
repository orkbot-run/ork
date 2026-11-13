// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod auth;
mod browser_auth;
mod credentials;
mod document;
mod host_computer;
mod host_runner;
mod installation_login;
mod installation_transport;
#[cfg(any(target_os = "macos", test))]
mod lifecycle;
mod local_enrollment;
mod local_stack;
mod local_stack_scope;
mod locale;
mod menu;
mod native;
mod oauth_capture;
mod pairing;
mod passkeys;
mod personal_devices;
mod personal_keys;
#[cfg(windows)]
mod private_files_windows;
mod profile;
mod renderer_host;
#[cfg(any(windows, test))]
mod revocation_storage;
mod revocations;
mod server;
mod server_directory;
mod server_discovery;
mod server_link;
mod server_login;
mod server_pairing;
mod settings;
mod speech;
mod updates;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    webview::NewWindowResponse, Emitter, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use url::Url;

struct DesktopState {
    directory: PathBuf,
    setup: Mutex<Option<settings::Setup>>,
    stack: Mutex<local_stack_scope::AccountStacks>,
    host_computer: Option<host_computer::HostComputer>,
    computer_choice: tokio::sync::Mutex<()>,
    computer_prompt: std::sync::atomic::AtomicBool,
    active_window: Mutex<Option<String>>,
    sequence: AtomicU64,
    switching: tokio::sync::Mutex<()>,
    sessions: native::Sessions,
    transport: installation_transport::Transport,
    personal_devices: personal_devices::PersonalDevices,
    browser_auth: browser_auth::BrowserAuth,
    accounts: accounts::Accounts,
    accounts_started: Mutex<AccountsStarted>,
    server_pairings: server_pairing::Attempts,
    restoring: std::sync::atomic::AtomicBool,
    restore_intent: AtomicU64,
    setup_ready: std::sync::atomic::AtomicBool,
    startup: Mutex<Startup>,
    speech: speech::SpeechManager,
    pairings: pairing::Pairings,
    warm_generation: AtomicU64,
    pending_server: Mutex<Option<String>>,
    pending_workspace: Mutex<Option<server_link::WorkspaceLink>>,
    initialization: Mutex<Option<server_link::Initialization>>,
    opening_server: Mutex<Option<OpeningServer>>,
    pending_bookmark: Mutex<Option<server_link::Bookmark>>,
    bookmark_sync: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct AccountsStarted {
    generation: u64,
    started: bool,
}

impl AccountsStarted {
    fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.started = false;
    }

    fn complete(&mut self, generation: u64, signed_in: bool) -> Result<(), String> {
        if self.generation != generation {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        self.started = signed_in;
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct AccountsLogout {
    generation: u64,
    restore_intent: u64,
}

impl AccountsLogout {
    fn matches(&self, gate: &AccountsStarted, intent: u64) -> bool {
        self.generation == gate.generation && !gate.started && self.restore_intent == intent
    }

    fn is_current(&self, state: &DesktopState) -> bool {
        state
            .accounts_started
            .lock()
            .ok()
            .is_some_and(|gate| self.matches(&gate, state.restore_intent.load(Ordering::SeqCst)))
    }
}

struct OpeningServer {
    label: String,
    origin: String,
    account: String,
    intent: u64,
    workspace: Option<server_directory::WorkspaceTarget>,
}

impl OpeningServer {
    fn permits(&self, document: &native::Document, account: Option<&str>, intent: u64) -> bool {
        self.label == document.label
            && self.origin == document.origin.origin().ascii_serialization()
            && account.is_none_or(|account| self.account == account)
            && self.intent == intent
    }
}

struct OpeningServerGuard<'a> {
    state: &'a DesktopState,
    label: String,
}

impl Drop for OpeningServerGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut opening) = self.state.opening_server.lock() {
            if opening
                .as_ref()
                .is_some_and(|opening| opening.label == self.label)
            {
                *opening = None;
            }
        }
    }
}

fn opening_server_matches(
    state: &DesktopState,
    document: &native::Document,
    account: Option<&str>,
) -> bool {
    state.opening_server.lock().ok().is_some_and(|opening| {
        opening.as_ref().is_some_and(|opening| {
            opening.permits(
                document,
                account,
                state.restore_intent.load(Ordering::SeqCst),
            )
        })
    })
}

impl DesktopState {
    fn accounts_have_started(&self) -> bool {
        self.accounts_started
            .lock()
            .ok()
            .is_some_and(|gate| gate.started)
    }

    fn reset_accounts_started(&self) -> Result<u64, String> {
        let mut gate = self
            .accounts_started
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        gate.reset();
        Ok(gate.generation)
    }

    fn stack_snapshot(&self) -> Arc<local_stack::LocalStack> {
        self.stack
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot()
    }

    fn deactivate_stack(&self) {
        self.stack
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .deactivate();
    }
}

/// Choose a scope from a current central authorization or an exact OS-held personal credential.
fn select_local_stack(
    app: &tauri::AppHandle,
    state: &DesktopState,
    authorization: &accounts::Authorization,
) -> Result<(Arc<local_stack::LocalStack>, u64), String> {
    require_native_account(state, authorization)?;
    let owner = settings::account_key(authorization.account.identity());
    let callback_app = app.clone();
    let callback_owner = owner.clone();
    let mut stacks = state
        .stack
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    let stack = stacks.select(
        &state.directory,
        &owner,
        move |scope| {
            let directory = scope.directory.clone();
            Some(Arc::new(move |value| {
                let Some(state) = callback_app.try_state::<DesktopState>() else {
                    return;
                };
                let accepts = state.stack.lock().ok().is_some_and(|stacks| {
                    stacks.accepts_output(&callback_owner, &directory, value.generation)
                });
                if accepts {
                    if let Some(window) = callback_app.get_webview_window("setup") {
                        let _ = window.emit("desktop-stack-changed", value);
                    }
                }
            }))
        },
        |scope| {
            state.host_computer.as_ref().map(|host| {
                host.scoped_connection(
                    &owner,
                    scope.project_name == local_stack::LEGACY_PROJECT_NAME,
                )
            })
        },
        || state.accounts.is_current(authorization),
    )?;
    require_native_account(state, authorization)?;
    if let Some(host) = &state.host_computer {
        if let Some(connection) = stack.host_connection() {
            host.select_connection(&connection);
        }
    }
    Ok((stack.clone(), stack.intent()))
}

fn require_current_stack(
    state: &DesktopState,
    authorization: &accounts::Authorization,
    stack: &Arc<local_stack::LocalStack>,
) -> Result<(), String> {
    require_native_account(state, authorization)?;
    if state
        .stack
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .is_selected(stack)
    {
        Ok(())
    } else {
        Err("Accounts sign-in changed. Try again.".into())
    }
}

fn current_server_account(
    app: &tauri::AppHandle,
    state: &DesktopState,
    document: &native::Document,
    authorization: &accounts::Authorization,
) -> bool {
    let owner = settings::account_key(authorization.account.identity());
    state.accounts.is_current(authorization)
        && (authorization.personal().is_none()
            || require_native_account(state, authorization).is_ok())
        && state.sessions.is_current(document)
        && (opening_server_matches(state, document, Some(&owner))
            || (active_document(app).is_some_and(|active| active.owner() == document.owner())
                && state
                    .setup
                    .lock()
                    .ok()
                    .and_then(|setup| setup.clone())
                    .is_some_and(|setup| {
                        setup.belongs_to(authorization.account.identity())
                            && setup.server_url.origin()
                                == document_server_origin(state, document).origin()
                    })))
}

fn document_server_origin(state: &DesktopState, document: &native::Document) -> Url {
    state
        .transport
        .logical_origin(&document.label, &document.origin)
        .unwrap_or_else(|| document.origin.clone())
}

async fn installation_ticket(
    app: &tauri::AppHandle,
    state: &DesktopState,
    document: &native::Document,
) -> Result<Option<String>, String> {
    let selection = state
        .transport
        .selected(&document.label)
        .ok_or("Native connection changed")?;
    if !selection.uses_relay() {
        return Ok(None);
    }
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let current = || {
        current_server_account(app, state, document, &authorization)
            && selection.account == settings::account_key(authorization.account.identity())
            && state.transport.selected(&document.label).as_ref() == Some(&selection)
    };
    server_login::issue_relay(authorization.directory_bearer()?, &selection, current)
        .await
        .map(Some)
}

fn retry_installation_revocations(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<DesktopState>();
        if let Ok(authorization) = state
            .accounts
            .authorization(&server_directory::origin())
            .await
        {
            state
                .accounts
                .retry_installation_revocations(&authorization)
                .await;
        }
    });
}

fn active_document(app: &tauri::AppHandle) -> Option<native::Document> {
    let state = app.try_state::<DesktopState>()?;
    let label = state.active_window.lock().ok()?.clone()?;
    state.sessions.current(&label)
}

fn document_workspace(
    state: &DesktopState,
    document: &native::Document,
    authorization: &accounts::Authorization,
) -> Result<Option<server_directory::WorkspaceTarget>, String> {
    let account = settings::account_key(authorization.account.identity());
    if let Some(opening) = state
        .opening_server
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .as_ref()
    {
        if opening.permits(
            document,
            Some(&account),
            state.restore_intent.load(Ordering::SeqCst),
        ) {
            return Ok(opening.workspace.clone());
        }
    }
    Ok(state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .as_ref()
        .filter(|setup| {
            setup.belongs_to(authorization.account.identity())
                && setup.server_url.origin() == document_server_origin(state, document).origin()
        })
        .and_then(|setup| setup.workspace.clone()))
}

fn send_native_event(
    app: &tauri::AppHandle,
    document: &native::Document,
    kind: &str,
    payload: impl serde::Serialize,
) {
    let state = app.state::<DesktopState>();
    if state
        .active_window
        .lock()
        .ok()
        .as_deref()
        .and_then(|label| label.as_deref())
        != Some(document.label.as_str())
        || !state.sessions.is_current(document)
    {
        return;
    }
    if let Some(window) = app.get_webview_window(&document.label) {
        if window.url().ok().is_some_and(|url| {
            matches!(url.scheme(), "http" | "https") && url.origin() == document.origin.origin()
        }) {
            let _ = window.eval(native::event_script(document, kind, payload));
        }
    }
}

fn cancel_native_document(app: &tauri::AppHandle, label: &str) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.transport.remove(label);
        if let Some(document) = state.sessions.invalidate(label) {
            let owner = native::owner(label, &document);
            state.browser_auth.cancel_owner(&owner);
            state.speech.cancel_owner(&owner);
            if let Some(host) = &state.host_computer {
                if host.intent(&owner).is_some() {
                    host.activate(None);
                }
            }
        }
    }
    auth::close_popup(app, label);
}

pub(crate) fn shutdown_native(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.deactivate_stack();
        state.browser_auth.cancel_all();
        state.speech.shutdown();
        if let Some(host) = &state.host_computer {
            host.close();
        }
    }
}

#[tauri::command]
async fn native_command(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    proof: String,
    document: String,
    command: native::Command,
) -> Result<serde_json::Value, String> {
    use native::Command;
    let (document, previous) = state.sessions.authorize(
        window.label(),
        &window.url().map_err(|_| "Desktop window unavailable.")?,
        &proof,
        &document,
        match &command {
            Command::Hello { epoch } => Some(*epoch),
            _ => None,
        },
    )?;
    if let Some(previous) = previous {
        let previous_owner = native::owner(window.label(), &previous);
        state.browser_auth.cancel_owner(&previous_owner);
        state.speech.cancel_owner(&previous_owner);
        if let Some(host) = &state.host_computer {
            host.retire(&previous_owner);
        }
        auth::close_popup(&app, window.label());
    }
    if matches!(command, Command::Hello { .. }) {
        state.transport.document(&document.label, &document.id);
    }
    let active = state
        .active_window
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .as_deref()
        == Some(window.label());
    let opening_auth = matches!(
        &command,
        native::Command::AccountsCreateServerLoginGrant { .. }
            | native::Command::AccountsWorkspaceTarget
            | native::Command::AccountsConsumeServerInitializationSecret
            | native::Command::ServerRemember
            | native::Command::TransportOpen { .. }
            | native::Command::TransportStart { .. }
            | native::Command::TransportWrite { .. }
            | native::Command::TransportFinish { .. }
            | native::Command::TransportHead { .. }
            | native::Command::TransportRead { .. }
            | native::Command::TransportCancel { .. }
            | native::Command::AccountsSignInToServer
    ) && opening_server_matches(&state, &document, None);
    if !active && !command.read_only() && !opening_auth {
        return Err("This desktop window is not active.".into());
    }
    let owner = document.owner();
    let unit = serde_json::Value::Null;
    match command {
        Command::TransportOpen { id, input } => {
            let ticket = installation_ticket(&app, &state, &document).await?;
            state
                .transport
                .open(&document.label, &document.id, &id, &input, ticket)?;
            Ok(unit)
        }
        Command::TransportStart { id } => {
            state
                .transport
                .start(&document.label, &document.id, &id)
                .await?;
            Ok(unit)
        }
        Command::TransportWrite { id, bytes } => Ok(serde_json::json!(
            state
                .transport
                .write(&document.label, &document.id, &id, &bytes)
                .await?
        )),
        Command::TransportFinish { id } => {
            state
                .transport
                .finish(&document.label, &document.id, &id)
                .await?;
            Ok(unit)
        }
        Command::TransportHead { id } => {
            state
                .transport
                .head(&document.label, &document.id, &id)
                .await
        }
        Command::TransportRead { id } => Ok(serde_json::json!(
            state
                .transport
                .read(&document.label, &document.id, &id)
                .await?
        )),
        Command::TransportCancel { id } => {
            state.transport.cancel(&document.label, &document.id, &id);
            Ok(unit)
        }
        Command::AccountsSignInToServer => {
            installation_login::sign_in(&app, &state, &document).await
        }
        Command::AccountsSignIn => {
            if state.transport.selected(&document.label).is_some() {
                return Err("Use server settings to change Accounts sign-in.".into());
            }
            let opener_app = app.clone();
            let opener_owner = owner.clone();
            let account = state
                .accounts
                .sign_in(
                    &document.origin,
                    &state.browser_auth,
                    &owner,
                    None,
                    move |url| async move {
                        if active_document(&opener_app)
                            .is_none_or(|current| current.owner() != opener_owner)
                        {
                            return Err("This sign-in window is no longer active.".into());
                        }
                        opener_app
                            .opener()
                            .open_url(url, None::<&str>)
                            .map_err(|_| "Could not open browser sign-in.".into())
                    },
                    || {
                        state.sessions.is_current(&document)
                            && active_document(&app).is_some_and(|current| current.owner() == owner)
                    },
                )
                .await?;
            if !state.sessions.is_current(&document)
                || active_document(&app).is_none_or(|current| current.owner() != owner)
            {
                return Err("This sign-in window is no longer active.".into());
            }
            serde_json::to_value(account).map_err(|_| "Accounts session unavailable.".into())
        }
        Command::AccountsRetryRevocations => {
            state.accounts.retry_revocations();
            retry_installation_revocations(&app);
            Ok(unit)
        }
        Command::AccountsSession => {
            if let Some(credential) =
                installation_login::personal_credential(&app, &state, &document).await?
            {
                return serde_json::to_value(credential.account)
                    .map_err(|_| "Accounts session unavailable.".into());
            }
            let account = state
                .accounts
                .session(&if state.transport.selected(&document.label).is_some() {
                    server_directory::origin()
                } else {
                    document.origin.clone()
                })
                .await?;
            if !state.sessions.is_current(&document)
                || active_document(&app).is_none_or(|current| current.owner() != owner)
            {
                return Err("This sign-in window is no longer active.".into());
            }
            serde_json::to_value(account).map_err(|_| "Accounts session unavailable.".into())
        }
        Command::AccountsWorkspaceTarget => {
            if let Some(credential) =
                installation_login::personal_credential(&app, &state, &document).await?
            {
                return serde_json::to_value(credential.selection.target)
                    .map_err(|_| "Could not continue".into());
            }
            let authorization = state
                .accounts
                .authorization(&server_directory::origin())
                .await?;
            if !current_server_account(&app, &state, &document, &authorization) {
                return Err("Could not continue".into());
            }
            serde_json::to_value(document_workspace(&state, &document, &authorization)?)
                .map_err(|_| "Could not continue".into())
        }
        Command::AccountsCreateServerLoginGrant { origin, challenge } => {
            if state.transport.selected(&document.label).is_some() {
                return Err("Native installation sign-in must run in Rust.".into());
            }
            let audience = server_login::audience_for_document(&document.origin, &origin)?;
            if !server_login::valid_challenge(&challenge) {
                return Err("Could not continue".into());
            }
            let authorization = state
                .accounts
                .authorization(&server_directory::origin())
                .await?;
            let workspace = document_workspace(&state, &document, &authorization)?;
            let result = if let Some(target) = workspace {
                if !current_server_account(&app, &state, &document, &authorization) {
                    return Err("Could not continue".into());
                }
                server_login::issue_workspace(
                    authorization.directory_bearer()?,
                    &target,
                    &challenge,
                    || current_server_account(&app, &state, &document, &authorization),
                )
                .await?
            } else {
                server_login::issue(
                    authorization.directory_bearer()?,
                    &audience,
                    &challenge,
                    || current_server_account(&app, &state, &document, &authorization),
                )
                .await?
            };
            serde_json::to_value(result).map_err(|_| "Could not continue".into())
        }
        Command::AccountsConsumeServerInitializationSecret => {
            if state.transport.selected(&document.label).is_some() {
                return Err(
                    "This installation does not accept a renderer bootstrap secret.".into(),
                );
            }
            let authorization = state
                .accounts
                .authorization(&server_directory::origin())
                .await?;
            if !current_server_account(&app, &state, &document, &authorization) {
                return Err("Could not continue".into());
            }
            let mut pending = state
                .initialization
                .lock()
                .map_err(|_| "Desktop state unavailable.")?;
            let secret = pending.as_mut().and_then(|initialization| {
                initialization.consume(
                    &document.origin.origin().ascii_serialization(),
                    &document.label,
                    &settings::account_key(authorization.account.identity()),
                )
            });
            if secret.is_some() {
                *pending = None;
            }
            Ok(serde_json::json!(secret))
        }
        Command::AccountsLogout => {
            let previous_setup = app.get_webview_window("setup");
            let account = state
                .setup
                .lock()
                .map_err(|_| "Desktop state unavailable.")?
                .as_ref()
                .and_then(|setup| setup.account.clone());
            if !logout_document_matches(&state, &document, account.as_deref()) {
                return Err("Accounts sign-in changed. Try again.".into());
            }
            let logout = begin_accounts_logout(&state)?;
            let cleanup_app = app.clone();
            let cleanup_origin = document.origin.clone();
            let cleanup_document = document.clone();
            let cleanup_account = account.clone();
            let cleanup_attempt = state.pairings.begin_clear(&document.origin)?;
            tauri::async_runtime::spawn(async move {
                let state = cleanup_app.state::<DesktopState>();
                let _ = state
                    .pairings
                    .clear_attempt(&cleanup_origin, cleanup_attempt, || {
                        logout.is_current(&state)
                            && logout_document_matches(
                                &state,
                                &cleanup_document,
                                cleanup_account.as_deref(),
                            )
                    })
                    .await;
            });
            state.browser_auth.cancel_owner(&owner);
            state.speech.cancel_owner(&owner);
            auth::close_popup(&app, &document.label);
            update_startup(&app, Startup::idle());
            let server_result =
                clear_server_session(&window, &state, &logout, &document, account.as_deref()).await;
            let accounts_result =
                clear_accounts_credentials(&state, &logout, Some(&document.origin), || {
                    logout_document_matches(&state, &document, account.as_deref())
                })
                .await;
            let _switch = state.switching.lock().await;
            let reset_result = reset_setup_after_product_logout(
                &app,
                &logout,
                &document,
                account.as_deref(),
                previous_setup,
            )
            .await;
            let result = server_result.and(accounts_result).and(reset_result);
            if result.is_err() && logout.is_current(&state) {
                // A cookie-store failure must never reload a still-authenticated old product page.
                retire_server_windows(&app, &state);
                let _ = show_setup(&app);
            }
            result?;
            Ok(unit)
        }
        Command::Hello { .. } => {
            if managed_computer_document(&app, &document) {
                if let Some(host) = &state.host_computer {
                    host.activate(Some(owner));
                }
            }
            Ok(unit)
        }
        Command::ComputerRequestAccess => Ok(serde_json::json!(
            request_computer_access(&app, &document).await?
        )),
        Command::ComputerRevokeAccess => {
            if !managed_computer_document(&app, &document) {
                return Err("Local computer access requires an app-managed local instance.".into());
            }
            revoke_computer_access(&app).await?;
            Ok(unit)
        }
        Command::PairingSync => {
            if state
                .setup
                .lock()
                .map_err(|_| "Desktop state unavailable.")?
                .as_ref()
                .is_some_and(|setup| setup.mode == settings::InstanceMode::New)
            {
                return Ok(unit);
            }
            let origin = pairing::secure_origin(&document.origin)?;
            let attempt = state.pairings.attempt(&origin)?;
            let cookies = server_session_cookies(&window, &origin).await?;
            state
                .pairings
                .sync(&origin, &cookies, || {
                    attempt.is_current()
                        && state.sessions.is_current(&document)
                        && active_document(&app).is_some_and(|current| current.owner() == owner)
                })
                .await?;
            Ok(unit)
        }
        Command::ServerRemember => {
            let cookies = server_session_cookies(&window, &document.origin).await?;
            save_connected_server(&app, &state, &document, &cookies).await?;
            Ok(unit)
        }
        Command::PairingClear => {
            state.pairings.clear(&document.origin).await?;
            Ok(unit)
        }
        Command::WindowState => Ok(serde_json::json!({
            "minimized": window.is_minimized().unwrap_or(false),
            "maximized": window.is_maximized().unwrap_or(false),
            "fullScreen": window.is_fullscreen().unwrap_or(false),
        })),
        Command::WindowClose => {
            window.close().map_err(|_| "Could not close the window.")?;
            Ok(unit)
        }
        Command::WindowMinimize => {
            window
                .minimize()
                .map_err(|_| "Could not minimize the window.")?;
            Ok(unit)
        }
        Command::WindowToggleMaximize => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|_| "Could not resize the window.")?;
            Ok(unit)
        }
        Command::BadgeSet { count } => {
            let count = native::badge_count(count);
            Ok(serde_json::json!(
                !cfg!(windows) && window.set_badge_count(count).is_ok()
            ))
        }
        Command::ServerChange => {
            cancel_restore(&state);
            update_startup(&app, Startup::idle());
            show_setup(&app).map_err(|_| "Could not open server settings.")?;
            Ok(unit)
        }
        Command::LocaleSet { locale } => {
            if active {
                set_locale(&app, &locale)?;
            } else {
                state.sessions.pending_locale(window.label(), &locale)?;
            }
            Ok(unit)
        }
        Command::MonitoringEnabled => Ok(serde_json::json!(false)),
        Command::PasskeyRpIds => {
            let bundle_id = app.config().identifier.clone();
            let ids =
                tokio::task::spawn_blocking(move || passkeys::rp_ids(&document.origin, &bundle_id))
                    .await
                    .unwrap_or_default();
            Ok(serde_json::json!(ids))
        }
        Command::UpdateState => {
            Ok(serde_json::to_value(updates::state(&app))
                .map_err(|_| "Update state unavailable.")?)
        }
        Command::UpdateCheck => Ok(serde_json::to_value(updates::check_state(&app).await)
            .map_err(|_| "Update state unavailable.")?),
        Command::UpdateDownload => Ok(serde_json::to_value(updates::download(&app).await)
            .map_err(|_| "Update state unavailable.")?),
        Command::UpdateInstall => Ok(serde_json::to_value(updates::install(&app).await)
            .map_err(|_| "Update state unavailable.")?),
        Command::UpdateSetChannel { channel } => Ok(serde_json::to_value(
            updates::set_channel(&app, channel).await?,
        )
        .map_err(|_| "Update state unavailable.")?),
        Command::OAuthCapture {
            url,
            expected_state,
        } => {
            let callback =
                oauth_capture::capture(&app, &document.label, &url, &expected_state).await?;
            if !state.sessions.is_current(&document)
                || active_document(&app).is_none_or(|current| current.owner() != owner)
            {
                return Err("This sign-in window is no longer active.".into());
            }
            serde_json::to_value(callback)
                .map_err(|_| "Could not complete integration sign-in.".into())
        }
        Command::OAuthOpen { url } => {
            let expected_owner = owner.clone();
            state
                .browser_auth
                .open(&owner, &url, |url| async move {
                    if active_document(&app).is_none_or(|current| current.owner() != expected_owner)
                    {
                        return Err("This sign-in window is no longer active.".into());
                    }
                    app.opener()
                        .open_url(url, None::<&str>)
                        .map_err(|_| "Could not open browser sign-in.".into())
                })
                .await?;
            if !state.sessions.is_current(&document) {
                state.browser_auth.cancel_owner(&owner);
            }
            Ok(unit)
        }
        Command::OAuthCancel { url } => {
            state.browser_auth.cancel_url(&owner, &url);
            Ok(unit)
        }
        Command::SpeechStart { language, session } => {
            let callback_app = app.clone();
            let callback_document = document.clone();
            let started = state.speech.start(
                &owner,
                &document.origin,
                &language,
                session,
                Arc::new(move |event| {
                    send_native_event(&callback_app, &callback_document, "speech", event);
                }),
            );
            if !state.sessions.is_current(&document)
                || active_document(&app).is_none_or(|current| current.owner() != owner)
            {
                state.speech.cancel_owner(&owner);
                return Ok(serde_json::json!(false));
            }
            Ok(serde_json::json!(started))
        }
        Command::SpeechStop { session } => {
            state.speech.stop(&owner, session);
            Ok(unit)
        }
        Command::SpeechAbort { session } => {
            state.speech.abort(&owner, session);
            Ok(unit)
        }
    }
}

/// Only the selected account's app-owned stack can receive the private local host capability.
fn managed_stack(
    app: &tauri::AppHandle,
    document: &native::Document,
) -> Option<Arc<local_stack::LocalStack>> {
    let state = app.state::<DesktopState>();
    if !active_document(app).is_some_and(|active| active.owner() == document.owner())
        || !state.sessions.is_current(document)
    {
        return None;
    }
    let setup = state.setup.lock().ok()?.clone()?;
    let stacks = state.stack.lock().ok()?;
    let stack = stacks.snapshot();
    if setup.mode != settings::InstanceMode::New
        || setup.workspace.is_some()
        || setup.account.as_deref() != stacks.owner()
        || !stacks.is_selected(&stack)
        || setup.server_url.origin() != stack.web_url().origin()
        || document.origin.origin() != stack.web_url().origin()
    {
        return None;
    }
    Some(stack)
}

fn managed_computer_document(app: &tauri::AppHandle, document: &native::Document) -> bool {
    managed_stack(app, document).is_some()
}

fn managed_stack_is_current(
    app: &tauri::AppHandle,
    document: &native::Document,
    stack: &Arc<local_stack::LocalStack>,
) -> bool {
    managed_stack(app, document).is_some_and(|selected| Arc::ptr_eq(&selected, stack))
}

fn native_text(app: &tauri::AppHandle, text: &str) -> String {
    app.state::<Mutex<locale::Locale>>()
        .lock()
        .map(|locale| locale.text(text))
        .unwrap_or_else(|_| text.into())
}

fn discovery_session_current(
    state: &DesktopState,
    generation: u64,
    authorization: &accounts::Authorization,
) -> bool {
    state.accounts.is_current(authorization)
        && state
            .accounts_started
            .lock()
            .ok()
            .is_some_and(|gate| gate.started && gate.generation == generation)
}

fn discovery_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
) -> Option<WebviewWindow<R>> {
    let window = app.get_webview_window(label)?;
    if !window.is_visible().unwrap_or(false)
        || app
            .get_webview_window("setup")
            .is_some_and(|setup| setup.is_visible().unwrap_or(false))
    {
        return None;
    }
    Some(window)
}

/// Poll the account directory without exposing the Accounts bearer to product renderers.
fn start_server_discovery(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut discovery = server_discovery::Discovery::default();
        let directory = match server_directory::Directory::new() {
            Ok(directory) => directory,
            Err(_) => return,
        };
        let mut delay = 2;
        loop {
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = 30;
            let state = app.state::<DesktopState>();
            let generation = match state.accounts_started.lock() {
                Ok(gate) if gate.started => gate.generation,
                _ => {
                    discovery.reset();
                    delay = 2;
                    continue;
                }
            };
            let Some(document) = active_document(&app) else {
                if !discovery.has_baseline() {
                    delay = 2;
                }
                continue;
            };
            if discovery_window(&app, &document.label).is_none() {
                if !discovery.has_baseline() {
                    delay = 2;
                }
                continue;
            }
            let Ok(authorization) = state
                .accounts
                .authorization(&server_directory::origin())
                .await
            else {
                continue;
            };
            if !discovery_session_current(&state, generation, &authorization) {
                continue;
            }
            if !current_server_account(&app, &state, &document, &authorization) {
                continue;
            }
            let Ok(device) = server_directory::device_id(&state.directory) else {
                continue;
            };
            let Ok(bearer) = authorization.directory_bearer() else {
                continue;
            };
            let Ok(catalog) = directory.catalog_for_device(bearer, &device).await else {
                continue;
            };
            let servers = if catalog.has_organizations() {
                let Ok(servers) = catalog.discovery_servers() else {
                    continue;
                };
                servers
            } else {
                let Ok(servers) = directory.list(bearer, &device).await else {
                    continue;
                };
                servers
            };
            if !discovery_session_current(&state, generation, &authorization)
                || !current_server_account(&app, &state, &document, &authorization)
            {
                continue;
            }
            let Some(parent) = discovery_window(&app, &document.label) else {
                continue;
            };
            if !discovery.observe(
                authorization.account.identity(),
                generation,
                &servers,
                &document_server_origin(&state, &document)
                    .origin()
                    .ascii_serialization(),
            ) {
                continue;
            }
            let (sender, receiver) = tokio::sync::oneshot::channel();
            app.dialog()
                .message(native_text(&app, "New server available"))
                .title("Ork")
                .parent(&parent)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    native_text(&app, "Open servers"),
                    native_text(&app, "Later"),
                ))
                .show(move |open| {
                    let _ = sender.send(open);
                });
            if receiver.await.unwrap_or(false)
                && discovery_session_current(&state, generation, &authorization)
                && current_server_account(&app, &state, &document, &authorization)
            {
                menu_event(&app, menu::MenuAction::ChangeServer);
            }
        }
    });
}

async fn request_computer_access(
    app: &tauri::AppHandle,
    document: &native::Document,
) -> Result<bool, String> {
    let stack = managed_stack(app, document)
        .ok_or("Local computer access requires an app-managed local instance.")?;
    let state = app.state::<DesktopState>();
    let host = state
        .host_computer
        .as_ref()
        .ok_or("Local computer unavailable.")?;
    let owner = document.owner();
    host.activate(Some(owner.clone()));
    let intent = host.intent(&owner).ok_or("Local computer unavailable.")?;
    if !host.is_enabled() {
        if state.computer_prompt.swap(true, Ordering::SeqCst) {
            return Ok(false);
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let dialog = app.dialog()
            .message(native_text(app, "Allow bots to use this computer?") + "\n\n" + &native_text(app, "Bots on this local instance can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access from the app menu."))
            .title(native_text(app, "Allow local computer access?"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(native_text(app, "Allow"), native_text(app, "Cancel")));
        dialog.show(move |allowed| {
            let _ = sender.send(allowed);
        });
        let allowed = receiver.await.unwrap_or(false);
        state.computer_prompt.store(false, Ordering::SeqCst);
        if !allowed {
            return Ok(false);
        }
    }
    let Ok(_switch) = state.switching.try_lock() else {
        return Ok(false);
    };
    let _choice = state.computer_choice.lock().await;
    if !managed_stack_is_current(app, document, &stack)
        || !stack.matches_desired_stack().await
        || !managed_stack_is_current(app, document, &stack)
    {
        return Ok(false);
    }
    if !host.grant(&owner, intent) {
        return Ok(false);
    }
    if let Err(error) = stack.save_host_choice("this-mac").await {
        host.revoke_owner(&owner);
        let _ = refresh_menu(app);
        return Err(error);
    }
    // The window or consent can change while the server persists its choice.
    if !managed_stack_is_current(app, document, &stack) || host.intent(&owner) != Some(intent) {
        host.revoke_owner(&owner);
        return Ok(false);
    }
    let _ = refresh_menu(app);
    Ok(host.is_enabled())
}

async fn revoke_computer_access(app: &tauri::AppHandle) -> Result<(), String> {
    let document = active_document(app).ok_or("Local computer unavailable.")?;
    let stack = managed_stack(app, &document).ok_or("Local computer unavailable.")?;
    let state = app.state::<DesktopState>();
    if let Some(host) = &state.host_computer {
        host.revoke_owner(&document.owner());
    }
    let _ = refresh_menu(app);
    let _choice = state.computer_choice.lock().await;
    if !managed_stack_is_current(app, &document, &stack) {
        return Err("This local server is no longer active.".into());
    }
    stack.save_host_choice("docker").await
}

fn is_setup_document(label: &str, url: &Url) -> bool {
    label == "setup"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(url.path(), "" | "/" | "/index.html")
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
}

fn require_setup<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    if is_setup_document(
        window.label(),
        &window.url().map_err(|_| "Invalid setup window")?,
    ) {
        Ok(())
    } else {
        Err("Only the bundled setup window can choose a server.".into())
    }
}

const SETUP_ACCOUNTS_OWNER: &str = "desktop-setup-accounts";

fn retire_server_windows(app: &tauri::AppHandle, state: &DesktopState) {
    state.deactivate_stack();
    if let Some(host) = &state.host_computer {
        host.activate(None);
    }
    if let Ok(mut active) = state.active_window.lock() {
        *active = None;
    }
    for (label, server) in app.webview_windows() {
        if label.starts_with("server-") {
            cancel_native_document(app, &label);
            state.sessions.remove(&label);
            let _ = server.destroy();
        }
    }
    let _ = refresh_menu(app);
}

fn cancel_server_pairings(state: &DesktopState) {
    if let Some(attempt) = state.server_pairings.take(None) {
        attempt.cancel();
    }
}

fn begin_accounts_logout(state: &DesktopState) -> Result<AccountsLogout, String> {
    state.transport.block_all();
    state.personal_devices.invalidate();
    cancel_server_pairings(state);
    let generation = state.reset_accounts_started()?;
    cancel_restore(state);
    state.accounts.invalidate();
    state.deactivate_stack();
    if let Some(host) = &state.host_computer {
        host.activate(None);
    }
    state.browser_auth.cancel_owner(SETUP_ACCOUNTS_OWNER);
    *state
        .initialization
        .lock()
        .map_err(|_| "Desktop state unavailable.")? = None;
    *state
        .pending_server
        .lock()
        .map_err(|_| "Desktop state unavailable.")? = None;
    *state
        .pending_workspace
        .lock()
        .map_err(|_| "Desktop state unavailable.")? = None;
    *state
        .pending_bookmark
        .lock()
        .map_err(|_| "Desktop state unavailable.")? = None;
    Ok(AccountsLogout {
        generation,
        restore_intent: state.restore_intent.load(Ordering::SeqCst),
    })
}

fn account_logout_origins(legacy: Option<&Url>) -> Result<Vec<Url>, String> {
    let central = server_directory::origin();
    let mut origins = vec![central.clone()];
    if let Some(legacy) = legacy {
        let legacy = server::normalize_server_url(legacy.as_str())?;
        if legacy.origin() != central.origin() {
            origins.push(legacy);
        }
    }
    Ok(origins)
}

async fn clear_accounts_credentials(
    state: &DesktopState,
    logout: &AccountsLogout,
    legacy: Option<&Url>,
    still_current: impl Fn() -> bool,
) -> Result<(), String> {
    let current = || logout.is_current(state) && still_current();
    if !current() {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    let personal_cleanup = state.personal_devices.forget_all();
    state
        .accounts
        .logout(&account_logout_origins(legacy)?, current)
        .await?;
    if !current() {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    personal_cleanup?;
    Ok(())
}

fn logout_document_matches(
    state: &DesktopState,
    document: &native::Document,
    account: Option<&str>,
) -> bool {
    state.sessions.is_current(document)
        && state
            .active_window
            .lock()
            .ok()
            .is_some_and(|active| active.as_deref() == Some(document.label.as_str()))
        && state
            .setup
            .lock()
            .ok()
            .and_then(|setup| setup.clone())
            .is_some_and(|setup| {
                setup.account.as_deref() == account
                    && setup.server_url.origin() == document_server_origin(state, document).origin()
            })
}

async fn reset_setup_after_product_logout<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    logout: &AccountsLogout,
    document: &native::Document,
    account: Option<&str>,
    previous_setup: Option<WebviewWindow<R>>,
) -> Result<(), String> {
    let callback_app = app.clone();
    let logout = *logout;
    let document = document.clone();
    let account = account.map(str::to_owned);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // The worker waits without holding the gate; UI checks and destruction run together.
    app.run_on_main_thread(move || {
        let state = callback_app.state::<DesktopState>();
        let result = (|| {
            let gate = state
                .accounts_started
                .lock()
                .map_err(|_| "Desktop state unavailable.")?;
            if !logout.matches(&gate, state.restore_intent.load(Ordering::SeqCst))
                || !logout_document_matches(&state, &document, account.as_deref())
            {
                return Err("Accounts sign-in changed. Try again.".into());
            }
            // Only the captured setup is discarded; the calling product document keeps its IPC.
            if let Some(setup) = previous_setup {
                setup
                    .destroy()
                    .map_err(|_| "Could not complete that request. Try again.")?;
                state.setup_ready.store(false, Ordering::SeqCst);
            }
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|_| "Desktop window unavailable.")?;
    receiver.await.map_err(|_| "Desktop window unavailable.")?
}

async fn finish_setup_accounts_logout(
    app: &tauri::AppHandle,
    logout: &AccountsLogout,
) -> Result<(), String> {
    let callback_app = app.clone();
    let logout = *logout;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let state = callback_app.state::<DesktopState>();
        let result = (|| {
            let gate = state
                .accounts_started
                .lock()
                .map_err(|_| "Desktop state unavailable.")?;
            if !logout.matches(&gate, state.restore_intent.load(Ordering::SeqCst)) {
                return Err("Accounts sign-in changed. Try again.".into());
            }
            retire_server_windows(&callback_app, &state);
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|_| "Desktop window unavailable.")?;
    receiver.await.map_err(|_| "Desktop window unavailable.")?
}

fn require_native_account(
    state: &DesktopState,
    authorization: &accounts::Authorization,
) -> Result<(), String> {
    let Some(personal) = authorization.personal() else {
        return require_account(state, authorization);
    };
    if !state.accounts.is_current(authorization) || personal.epoch != state.personal_devices.epoch()
    {
        return Err("Personal sign-in changed. Try again.".into());
    }
    let credential = state
        .personal_devices
        .credential(&personal.selection)?
        .ok_or("Personal workspace unavailable")?;
    if credential.device_id != personal.device_id
        || !credential
            .account
            .identity()
            .eq(&authorization.account.identity())
    {
        return Err("Personal workspace unavailable".into());
    }
    Ok(())
}

fn require_account(state: &DesktopState, account: &accounts::Authorization) -> Result<(), String> {
    account.directory_bearer()?;
    if state.accounts.is_current(account) {
        Ok(())
    } else {
        Err("Accounts sign-in changed. Try again.".into())
    }
}

fn adopt_setup_account(
    state: &DesktopState,
    account: &accounts::Account,
    generation: u64,
) -> Result<(), String> {
    let gate = state
        .accounts_started
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    if gate.generation != generation {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    let mut setup = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    if setup
        .as_ref()
        .is_some_and(|setup| !setup.belongs_to(account.identity()))
    {
        settings::clear(&state.directory)?;
        *setup = None;
    }
    Ok(())
}

#[tauri::command]
async fn setup_accounts_session<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<Option<accounts::Account>, String> {
    require_setup(&window)?;
    let generation = state
        .accounts_started
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .generation;
    if let Some(account) = state
        .accounts
        .local_account(&server_directory::origin())
        .await?
    {
        adopt_setup_account(&state, &account, generation)?;
    }
    let online = state.accounts.session(&server_directory::origin()).await;
    let personal = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .clone()
        .and_then(|setup| state.personal_devices.saved(&setup).ok().flatten());
    let account = match online {
        Ok(Some(account)) => Some(account),
        Ok(None) => personal.map(|credential| credential.account),
        Err(error) => match personal {
            Some(credential) => Some(credential.account),
            None => return Err(error),
        },
    };
    require_setup(&window)?;
    state
        .accounts_started
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .complete(generation, account.is_some())?;
    Ok(account)
}

#[tauri::command]
async fn setup_accounts_sign_in(
    window: WebviewWindow,
    ork_avatar: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<accounts::Account, String> {
    require_setup(&window)?;
    cancel_server_pairings(&state);
    let generation = state.reset_accounts_started()?;
    cancel_restore(&state);
    update_startup(&app, Startup::idle());
    state.accounts.invalidate();
    state.deactivate_stack();
    let _switch = state.switching.lock().await;
    retire_server_windows(&app, &state);
    let opener = app.clone();
    let result = state
        .accounts
        .sign_in(
            &server_directory::origin(),
            &state.browser_auth,
            SETUP_ACCOUNTS_OWNER,
            ork_avatar.as_deref(),
            move |url| async move {
                let setup = opener
                    .get_webview_window("setup")
                    .ok_or("Sign-in cancelled.")?;
                require_setup(&setup)?;
                if !setup.is_visible().unwrap_or(false) {
                    return Err("Sign-in cancelled.".into());
                }
                opener
                    .opener()
                    .open_url(url, None::<&str>)
                    .map_err(|_| "Could not open browser sign-in.".into())
            },
            || require_setup(&window).is_ok() && window.is_visible().unwrap_or(false),
        )
        .await;
    retire_server_windows(&app, &state);
    if let Ok(account) = &result {
        require_setup(&window)?;
        adopt_setup_account(&state, account, generation)?;
        let mut gate = state
            .accounts_started
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        if gate.generation != generation {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        // Failed personal cleanup retains its durable barrier while company login stays usable.
        let _ = state.personal_devices.after_interactive_sign_in();
        gate.complete(generation, true)?;
    }
    result
}

#[tauri::command]
async fn setup_accounts_logout(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    require_setup(&window)?;
    let logout = begin_accounts_logout(&state)?;
    update_startup(&app, Startup::idle());
    retire_server_windows(&app, &state);
    let result =
        clear_accounts_credentials(&state, &logout, None, || require_setup(&window).is_ok()).await;
    // A candidate already being built must retire without touching a newer sign-in attempt.
    let _switch = state.switching.lock().await;
    let fence = finish_setup_accounts_logout(&app, &logout).await;
    result.and(fence)
}

#[tauri::command]
async fn list_servers<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<Vec<DirectoryEntry>, String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let device = server_directory::device_id(&state.directory)?;
    let servers = server_directory::Directory::new()?
        .list(authorization.directory_bearer()?, &device)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let choice = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    let preference =
        server_directory::preference(&state.directory, authorization.account.identity())?;
    let selected = startup_server(
        preference.as_ref(),
        choice.as_ref(),
        authorization.account.identity(),
        &servers,
    )
    .map(|server| server.id.clone());
    // Migrate the previous saved choice once; future manual connections do not replace it.
    if preference.is_none() {
        if let Some(id) = selected.as_deref() {
            server_directory::save_preference(
                &state.directory,
                authorization.account.identity(),
                Some(id),
            )?;
        }
    }
    Ok(servers
        .into_iter()
        .map(|server| DirectoryEntry {
            is_default: selected.as_deref() == Some(server.id.as_str()),
            server,
        })
        .collect())
}

#[tauri::command]
async fn list_workspaces<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<Vec<server_directory::Workspace>, String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let workspaces = server_directory::Directory::new()?
        .workspaces_for_device(
            authorization.directory_bearer()?,
            &server_directory::device_id(&state.directory)?,
        )
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    Ok(workspaces)
}

#[tauri::command]
async fn workspace_catalog<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<server_directory::WorkspaceCatalog, String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let catalog = server_directory::Directory::new()?
        .catalog_for_device(
            authorization.directory_bearer()?,
            &server_directory::device_id(&state.directory)?,
        )
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    Ok(catalog)
}

#[tauri::command]
async fn set_default_organization<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    organization_id: Option<String>,
) -> Result<(), String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    server_directory::Directory::new()?
        .set_default_organization(
            authorization.directory_bearer()?,
            organization_id.as_deref(),
        )
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    Ok(())
}

#[tauri::command]
async fn check_workspace<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    id: String,
) -> Result<bool, String> {
    require_setup(&window)?;
    let intent = state.restore_intent.load(Ordering::SeqCst);
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let workspace = server_directory::Directory::new()?
        .workspaces_for_device(
            authorization.directory_bearer()?,
            &server_directory::device_id(&state.directory)?,
        )
        .await?
        .into_iter()
        .find(|workspace| workspace.id == id)
        .ok_or("That workspace is no longer available.")?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let target = server::normalize_server_url(&workspace.url)?;
    let reachable = if let Some(workspace) = &workspace.target {
        probe_managed_workspace(&state, &authorization, workspace, &target, || {
            require_setup(&window).is_ok() && state.restore_intent.load(Ordering::SeqCst) == intent
        })
        .await
        .is_ok()
    } else {
        server::probe_server(&target).await.is_ok()
    };
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    Ok(reachable)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    #[serde(flatten)]
    server: server_directory::Server,
    is_default: bool,
}

#[tauri::command]
async fn set_default_server<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    id: Option<String>,
) -> Result<(), String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let device = server_directory::device_id(&state.directory)?;
    let servers = server_directory::Directory::new()?
        .list(authorization.directory_bearer()?, &device)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    if id
        .as_ref()
        .is_some_and(|id| !servers.iter().any(|server| &server.id == id))
    {
        return Err("That server is no longer available.".into());
    }
    let _preference = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    server_directory::save_preference(
        &state.directory,
        authorization.account.identity(),
        id.as_deref(),
    )
}

fn server_pairing_gate(state: &DesktopState) -> Result<u64, String> {
    let gate = state
        .accounts_started
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    if !gate.started {
        return Err("Sign in to Accounts first.".into());
    }
    Ok(gate.generation)
}

#[tauri::command]
async fn server_initialization_required<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    raw_url: String,
) -> Result<bool, String> {
    require_setup(&window)?;
    let gate = server_pairing_gate(&state)?;
    let intent = state.restore_intent.load(Ordering::SeqCst);
    let target = server::normalize_server_url(&raw_url)?;
    server_login::initialization_required(&target, || {
        require_setup(&window).is_ok()
            && server_pairing_gate(&state).ok() == Some(gate)
            && state.restore_intent.load(Ordering::SeqCst) == intent
    })
    .await
}

#[tauri::command]
async fn create_server_pairing<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<server_pairing::Pairing, String> {
    require_setup(&window)?;
    let gate = server_pairing_gate(&state)?;
    state
        .server_pairings
        .begin(request_id.clone(), String::new(), gate, String::new())?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let owner = settings::account_key(authorization.account.identity());
    if server_pairing_gate(&state)? != gate
        || !state.server_pairings.bind(
            &request_id,
            &owner,
            gate,
            authorization.directory_bearer()?,
        )?
    {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    let pairing = server_pairing::Broker::new()?
        .create(authorization.directory_bearer()?)
        .await?;
    let current = require_setup(&window).is_ok()
        && require_account(&state, &authorization).is_ok()
        && server_pairing_gate(&state).ok() == Some(gate);
    if !current
        || !state
            .server_pairings
            .finish(&request_id, &owner, gate, pairing.clone())?
    {
        server_pairing::cancel_background(authorization.directory_bearer()?.into(), pairing.id);
        return Err("Accounts sign-in changed. Try again.".into());
    }
    Ok(pairing)
}

#[tauri::command]
async fn get_server_pairing<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<server_pairing::PairingState, String> {
    require_setup(&window)?;
    let gate = server_pairing_gate(&state)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let owner = settings::account_key(authorization.account.identity());
    let pairing = state.server_pairings.pairing(&request_id, &owner, gate)?;
    let result = server_pairing::Broker::new()?
        .status(authorization.directory_bearer()?, &pairing)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    if server_pairing_gate(&state)? != gate
        || !state.server_pairings.matches(&request_id, &owner, gate)
    {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    state
        .server_pairings
        .observe(&request_id, &owner, gate, &result)?;
    Ok(result)
}

#[tauri::command]
async fn approve_server_pairing<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    request_id: String,
    origin: String,
) -> Result<server_pairing::PairingState, String> {
    require_setup(&window)?;
    let gate = server_pairing_gate(&state)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let owner = settings::account_key(authorization.account.identity());
    if server_pairing_gate(&state)? != gate {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    state
        .server_pairings
        .shown_origin(&request_id, &owner, gate, &origin)?;
    let pairing = state.server_pairings.pairing(&request_id, &owner, gate)?;
    let result = server_pairing::Broker::new()?
        .approve(authorization.directory_bearer()?, &pairing, &origin)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    if server_pairing_gate(&state)? != gate {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    state
        .server_pairings
        .shown_origin(&request_id, &owner, gate, &origin)?;
    state
        .server_pairings
        .approved(&request_id, &owner, gate, &origin)?;
    Ok(result)
}

#[tauri::command]
fn cancel_server_pairing<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<(), String> {
    require_setup(&window)?;
    if let Some(attempt) = state.server_pairings.take(Some(&request_id)) {
        attempt.cancel();
    }
    Ok(())
}

#[tauri::command]
async fn create_server_installation<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<server_directory::InstallationCommand, String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let command = server_directory::Directory::new()?
        .create_installation(authorization.directory_bearer()?)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    Ok(command)
}

#[tauri::command]
async fn get_server_installation<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    id: String,
) -> Result<server_directory::InstallationStatus, String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let status = server_directory::Directory::new()?
        .installation_status(authorization.directory_bearer()?, &id)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    Ok(status)
}

#[tauri::command]
async fn remove_server<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    id: String,
) -> Result<(), String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let device = server_directory::device_id(&state.directory)?;
    let directory = server_directory::Directory::new()?;
    let servers = directory
        .list(authorization.directory_bearer()?, &device)
        .await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    if !servers.iter().any(|server| server.id == id) {
        return Err("That server is no longer available.".into());
    }
    directory
        .remove(authorization.directory_bearer()?, &id)
        .await?;
    require_account(&state, &authorization)?;
    let _preference = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    if server_directory::preference(&state.directory, authorization.account.identity())?
        .is_some_and(|preference| preference.server_id.as_deref() == Some(id.as_str()))
    {
        server_directory::save_preference(
            &state.directory,
            authorization.account.identity(),
            None,
        )?;
    }
    Ok(())
}

#[tauri::command]
async fn connect_saved_server(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    id: String,
) -> Result<(), String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let _switch = state
        .switching
        .try_lock()
        .map_err(|_| "A connection is already in progress.")?;
    let device = server_directory::device_id(&state.directory)?;
    let directory = server_directory::Directory::new()?;
    let server = directory
        .list(authorization.directory_bearer()?, &device)
        .await?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or("That server is no longer available.")?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    connect_directory_server(
        &window,
        &app,
        &state,
        &server,
        &authorization,
        &directory,
        &device,
    )
    .await
}

#[tauri::command]
async fn connect_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    id: String,
    link: Option<server_link::WorkspaceLink>,
) -> Result<(), String> {
    require_setup(&window)?;
    let intent = state.restore_intent.load(Ordering::SeqCst);
    if let Some(link) = &link {
        if state
            .pending_workspace
            .lock()
            .map_err(|_| "Desktop state unavailable.")?
            .as_ref()
            != Some(link)
        {
            return Err("This workspace link is no longer active.".into());
        }
    }
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let _switch = state
        .switching
        .try_lock()
        .map_err(|_| "A connection is already in progress.")?;
    // Re-fetch from the authenticated directory so the renderer cannot choose an arbitrary URL.
    let workspace = server_directory::Directory::new()?
        .workspaces_for_device(
            authorization.directory_bearer()?,
            &server_directory::device_id(&state.directory)?,
        )
        .await?
        .into_iter()
        .find(|workspace| workspace.id == id)
        .ok_or("That workspace is no longer available.")?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let target = server::normalize_server_url(&workspace.url)?;
    let mode = prepare_workspace_route(
        &app,
        &state,
        &authorization,
        &target,
        workspace.target.as_ref(),
    )
    .await?;
    if state.restore_intent.load(Ordering::SeqCst) != intent {
        return Err("This connection is no longer active.".into());
    }
    if let Some(link) = &link {
        let selected = workspace.target.as_ref().ok_or("Workspace unavailable.")?;
        if link.organization_id != selected.organization_id
            || link.server_id != selected.server_id
            || link.workspace_id != selected.workspace_id
        {
            return Err("Workspace unavailable.".into());
        }
    }
    open_server(
        &window,
        &app,
        &state,
        settings::Setup {
            mode,
            server_url: target,
            account: None,
            workspace: workspace.target,
        },
        &authorization,
    )
    .await?;
    if state.restore_intent.load(Ordering::SeqCst) == intent {
        let mut pending = state
            .pending_workspace
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        if link.is_none() || pending.as_ref() == link.as_ref() {
            *pending = None;
        }
    }
    Ok(())
}

async fn prepare_workspace_route(
    app: &tauri::AppHandle,
    state: &DesktopState,
    authorization: &accounts::Authorization,
    target: &url::Url,
    workspace: Option<&server_directory::WorkspaceTarget>,
) -> Result<settings::InstanceMode, String> {
    require_account(state, authorization)?;
    if matches!(target.host_str(), Some("127.0.0.1" | "[::1]")) {
        let (stack, intent) = select_local_stack(app, state, authorization)?;
        if !stack.matches_saved_url(&target.origin().ascii_serialization()) {
            return Err("This local server is no longer active.".into());
        }
        let result = stack.start_for(intent).await;
        require_current_stack(state, authorization, &stack)?;
        if stack.intent() != intent
            || result.phase != local_stack::LocalStackPhase::Ready
            || !stack.matches_desired_stack().await
        {
            return Err(result
                .message
                .unwrap_or_else(|| "Could not start the local server.".into()));
        }
        server::probe_server(target).await?;
        require_current_stack(state, authorization, &stack)?;
        Ok(settings::InstanceMode::New)
    } else {
        server::probe_setup_server(target, workspace).await?;
        require_account(state, authorization)?;
        Ok(settings::InstanceMode::Existing)
    }
}

async fn connect_directory_server(
    window: &WebviewWindow,
    app: &tauri::AppHandle,
    state: &DesktopState,
    server: &server_directory::Server,
    authorization: &accounts::Authorization,
    directory: &server_directory::Directory,
    device: &str,
) -> Result<(), String> {
    require_setup(window)?;
    require_account(state, authorization)?;
    match server.kind {
        server_directory::Kind::Local => {
            start_local_server(
                window,
                app,
                state,
                authorization,
                directory,
                device,
                LocalServerSelection {
                    expected_url: Some(&server.url),
                    organization_id: None,
                },
            )
            .await
        }
        server_directory::Kind::Selfhosted => {
            let target = server::normalize_server_url(&server.url)?;
            server::probe_server(&target).await?;
            open_server(
                window,
                app,
                state,
                settings::Setup {
                    mode: settings::InstanceMode::Existing,
                    server_url: target,
                    account: None,
                    workspace: None,
                },
                authorization,
            )
            .await
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupState {
    server_url: Option<String>,
    mode: settings::InstanceMode,
    startup: Startup,
    pending_server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_workspace: Option<server_link::WorkspaceLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initializing_server: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Startup {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<server_directory::Kind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl Startup {
    fn checking() -> Self {
        Self {
            phase: "checking",
            server_id: None,
            kind: None,
            message: None,
        }
    }

    fn idle() -> Self {
        Self {
            phase: "idle",
            ..Self::checking()
        }
    }
}

fn update_startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>, startup: Startup) {
    let state = app.state::<DesktopState>();
    if let Ok(mut value) = state.startup.lock() {
        *value = startup.clone();
    }
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.emit("desktop-startup-changed", startup);
    }
}

#[tauri::command]
fn setup_state<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<DesktopState>,
) -> Result<SetupState, String> {
    require_setup(&window)?;
    let saved = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable")?;
    Ok(SetupState {
        server_url: saved
            .as_ref()
            .map(|setup| setup.server_url.origin().ascii_serialization()),
        mode: saved
            .as_ref()
            .map_or(settings::InstanceMode::Existing, |setup| setup.mode),
        startup: state
            .startup
            .lock()
            .map_err(|_| "Desktop state unavailable.")?
            .clone(),
        initializing_server: state
            .initialization
            .lock()
            .map_err(|_| "Desktop state unavailable.")?
            .as_ref()
            .map(|initialization| initialization.origin.clone()),
        pending_workspace: state
            .pending_workspace
            .lock()
            .map_err(|_| "Desktop state unavailable.")?
            .clone(),
        pending_server: state
            .pending_server
            .lock()
            .map_err(|_| "Desktop state unavailable.")?
            .clone(),
    })
}

fn open_external(app: &tauri::AppHandle, url: &Url) {
    if matches!(url.scheme(), "https" | "http")
        && url.username().is_empty()
        && url.password().is_none()
    {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

#[tauri::command]
async fn connect_server(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    raw_url: String,
) -> Result<(), String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    require_account(&state, &authorization)?;
    let _switch = state
        .switching
        .try_lock()
        .map_err(|_| "A connection is already in progress.")?;
    let target = server::normalize_server_url(&raw_url)?;
    server::probe_server(&target).await?;
    require_setup(&window)?;
    require_account(&state, &authorization)?;
    let bookmark = server_link::Bookmark {
        origin: target.origin().ascii_serialization(),
        account: settings::account_key(authorization.account.identity()),
    };
    *state
        .pending_bookmark
        .lock()
        .map_err(|_| "Desktop state unavailable.")? = Some(bookmark.clone());
    {
        let mut pending = state
            .pending_server
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        if pending.as_deref() == Some(bookmark.origin.as_str()) {
            *pending = None;
        }
    }
    let result = open_server(
        &window,
        &app,
        &state,
        settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: target,
            account: None,
            workspace: None,
        },
        &authorization,
    )
    .await;
    if result.is_err() {
        let mut pending = state
            .pending_bookmark
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        if pending.as_ref() == Some(&bookmark) {
            *pending = None;
        }
    }
    result
}

#[tauri::command]
fn local_stack_state<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<DesktopState>,
) -> Result<local_stack::LocalStackState, String> {
    require_setup(&window)?;
    Ok(state.stack_snapshot().state())
}

#[tauri::command]
async fn connect_local_server(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    organization_id: Option<String>,
) -> Result<(), String> {
    require_setup(&window)?;
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let _switch = state
        .switching
        .try_lock()
        .map_err(|_| "A connection is already in progress.")?;
    let device = server_directory::device_id(&state.directory)?;
    let directory = server_directory::Directory::new()?;
    start_local_server(
        &window,
        &app,
        &state,
        &authorization,
        &directory,
        &device,
        LocalServerSelection {
            expected_url: None,
            organization_id: organization_id.as_deref(),
        },
    )
    .await
}

struct LocalServerSelection<'a> {
    expected_url: Option<&'a str>,
    organization_id: Option<&'a str>,
}

async fn start_local_server(
    window: &WebviewWindow,
    app: &tauri::AppHandle,
    state: &DesktopState,
    authorization: &accounts::Authorization,
    directory: &server_directory::Directory,
    device: &str,
    selection: LocalServerSelection<'_>,
) -> Result<(), String> {
    let LocalServerSelection {
        expected_url,
        organization_id,
    } = selection;
    require_setup(window)?;
    let organization_id = directory
        .catalog_for_device(authorization.directory_bearer()?, device)
        .await?
        .local_organization(organization_id)?;
    require_account(state, authorization)?;
    let (stack, intent) = select_local_stack(app, state, authorization)?;
    if expected_url.is_some_and(|url| !stack.matches_saved_url(url)) {
        return Err("This saved local instance is unavailable for this account. Choose This computer to create or open your instance.".into());
    }
    require_current_stack(state, authorization, &stack)?;
    if let Some(host) = &state.host_computer {
        host.activate(None);
    }
    let result = stack.start_for(intent).await;
    require_setup(window)?;
    let authorization = state
        .accounts
        .renew(authorization, &server_directory::origin())
        .await?;
    require_current_stack(state, &authorization, &stack)?;
    if result.phase != local_stack::LocalStackPhase::Ready || !stack.matches_desired_stack().await {
        return Err(result
            .message
            .unwrap_or_else(|| "Could not start the local server.".into()));
    }
    require_current_stack(state, &authorization, &stack)?;
    if expected_url.is_some_and(|url| !stack.matches_saved_url(url)) {
        return Err(
            "The local server address changed. Choose This computer to open your instance.".into(),
        );
    }
    let enrollment = local_enrollment::LocalEnrollment {
        directory,
        stack: &stack,
        token: authorization.directory_bearer()?,
        organization_id: &organization_id,
        device_id: device,
        subject: authorization.account.identity().1,
    };
    let workspace = enrollment
        .connect(|| {
            require_setup(window)?;
            require_current_stack(state, &authorization, &stack)?;
            if stack.intent() != intent {
                return Err("The start was interrupted. Retry to continue.".into());
            }
            Ok(())
        })
        .await?;
    open_server(
        window,
        app,
        state,
        settings::Setup {
            mode: settings::InstanceMode::New,
            server_url: stack.web_url(),
            account: None,
            workspace: workspace.target,
        },
        &authorization,
    )
    .await
}

#[tauri::command]
async fn cancel_setup_connection<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    require_setup(&window)?;
    cancel_restore(&state);
    state.deactivate_stack();
    let _switch = state.switching.lock().await;
    update_startup(&app, Startup::idle());
    Ok(())
}

async fn probe_managed_workspace(
    state: &DesktopState,
    authorization: &accounts::Authorization,
    workspace: &server_directory::WorkspaceTarget,
    origin: &url::Url,
    current: impl Fn() -> bool,
) -> Result<installation_transport::Selection, String> {
    require_native_account(state, authorization)?;
    if !current() {
        return Err("This connection is no longer active.".into());
    }
    let catalog = server_directory::Directory::new()?
        .catalog_for_device(
            authorization.directory_bearer()?,
            &server_directory::device_id(&state.directory)?,
        )
        .await?;
    require_native_account(state, authorization)?;
    if !current() {
        return Err("This connection is no longer active.".into());
    }
    let selection = installation_transport::Selection {
        account: settings::account_key(authorization.account.identity()),
        origin: origin.origin().ascii_serialization(),
        target: workspace.clone(),
        relay_origin: catalog.relay_origin(workspace, origin)?,
        direct_origin: catalog.direct_origin(workspace, origin)?,
        prefer_relay: false,
    };
    let still_current = &current;
    let selection = selection
        .probe_available(|selection| async move {
            server_login::issue_relay(authorization.directory_bearer()?, &selection, || {
                still_current() && require_native_account(state, authorization).is_ok()
            })
            .await
        })
        .await?;
    require_native_account(state, authorization)?;
    if !current() {
        return Err("This connection is no longer active.".into());
    }
    Ok(selection)
}

async fn open_server(
    window: &WebviewWindow,
    app: &tauri::AppHandle,
    state: &DesktopState,
    mut choice: settings::Setup,
    authorization: &accounts::Authorization,
) -> Result<(), String> {
    let intent = state.restore_intent.load(Ordering::SeqCst);
    let accounts_generation = state
        .accounts_started
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .generation;
    require_setup(window)?;
    require_native_account(state, authorization)?;
    let pinned = if let Some(personal) = authorization.personal() {
        let credential = state
            .personal_devices
            .saved(&choice)?
            .ok_or("Personal workspace unavailable")?;
        if credential.device_id != personal.device_id
            || credential.selection.target != personal.selection.target
            || credential.selection.account != personal.selection.account
        {
            return Err("Personal workspace unavailable".into());
        }
        let mut selection = credential.selection;
        selection.prefer_relay = false;
        if selection.uses_relay() {
            return Err("Connect directly to this installation to work without Accounts.".into());
        }
        selection.probe(None).await?;
        Some(selection)
    } else if let Some(workspace) = &choice.workspace {
        Some(
            probe_managed_workspace(state, authorization, workspace, &choice.server_url, || {
                require_setup(window).is_ok()
                    && state.restore_intent.load(Ordering::SeqCst) == intent
            })
            .await?,
        )
    } else {
        server::require_accounts_only(&choice.server_url).await?;
        None
    };
    require_setup(window)?;
    require_native_account(state, authorization)?;
    let local = if choice.mode == settings::InstanceMode::New {
        let stack = state.stack_snapshot();
        require_current_stack(state, authorization, &stack)?;
        if stack.web_url().origin() != choice.server_url.origin() {
            return Err("This local server is no longer active.".into());
        }
        Some(stack)
    } else {
        None
    };
    if let Some(stack) = &local {
        if let Some(host) = &state.host_computer {
            host.activate(None);
        }
        stack.save_host_choice("docker").await?;
        require_setup(window)?;
        require_current_stack(state, authorization, stack)?;
    }
    let previous_document = state.active_window.lock().ok().and_then(|label| {
        label
            .as_ref()
            .and_then(|label| state.sessions.current(label))
    });
    let _drafts = if let Some(document) = previous_document {
        if let Some(previous) = app.get_webview_window(&document.label) {
            Some(
                document::flush_drafts(
                    &previous,
                    Duration::from_secs(3),
                    state.transport.selected(&document.label).is_some(),
                    || {
                        state.sessions.is_current(&document)
                            && require_native_account(state, authorization).is_ok()
                            && state.restore_intent.load(Ordering::SeqCst) == intent
                    },
                )
                .await?,
            )
        } else {
            None
        }
    } else {
        None
    };
    let logical = choice.server_url.clone();
    let target = if choice.workspace.is_some() {
        state.transport.renderer(&state.directory).await?
    } else {
        logical.clone()
    };
    let label = format!("server-{}", state.sequence.fetch_add(1, Ordering::Relaxed));
    let origin = target.origin();
    let popup_app = app.clone();
    let popup_parent = label.clone();
    let popup_origin = target.clone();
    let proof = state.sessions.insert(&label, &target)?;
    if let Some(selection) = pinned {
        state.transport.select(&label, selection)?;
    }
    if native::grant(app, &label, &target).is_err() {
        state.transport.remove(&label);
        state.sessions.remove(&label);
        return Err("Could not secure the desktop window.".into());
    }
    let opening = OpeningServer {
        label: label.clone(),
        origin: target.origin().ascii_serialization(),
        account: settings::account_key(authorization.account.identity()),
        intent,
        workspace: choice.workspace.clone(),
    };
    if let Some(initialization) = state
        .initialization
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .as_mut()
    {
        initialization.confirm(&opening.origin, &label, &opening.account);
    }
    *state
        .opening_server
        .lock()
        .map_err(|_| "Desktop state unavailable.")? = Some(opening);
    let _opening = OpeningServerGuard {
        state,
        label: label.clone(),
    };
    let navigation_target = target.clone();
    let bundled = choice.workspace.is_some();
    let navigation_origin = target.origin();
    let navigation_app = app.clone();
    let builder = profile::configure(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(target.clone())),
        &state.directory,
        &logical,
        authorization.account.identity(),
        choice.workspace.as_ref(),
        authorization.profile_epoch(),
    );
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0));
    let next = builder
        .title("Ork")
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(auth::initialization_script(&target))
        .initialization_script(native::initialization_script_with_transport(
            &label,
            &target,
            &proof,
            state.speech.available(),
            choice.mode == settings::InstanceMode::New && state.host_computer.is_some(),
            choice.workspace.is_some(),
        ))
        // WebKit navigation policy callbacks include subframes. Their loads must
        // not retire the main document or open an artifact in the system browser.
        .on_navigation(move |url| match url.scheme() {
            "http" | "https" => {
                if bundled && url.origin() != navigation_origin {
                    open_external(&navigation_app, url);
                    false
                } else {
                    url.username().is_empty() && url.password().is_none()
                }
            }
            "about" => matches!(url.path(), "blank" | "srcdoc"),
            "data" | "blob" => true,
            _ => false,
        })
        .on_page_load(move |window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started
                && (payload.url().origin() != origin
                    || !matches!(payload.url().scheme(), "http" | "https"))
            {
                cancel_native_document(window.app_handle(), window.label());
                open_external(window.app_handle(), payload.url());
                let _ = window.navigate(navigation_target.clone());
            }
        })
        .on_new_window(move |url, features| {
            if auth::entry_allowed(&popup_origin, &url) {
                auth::open_popup(&popup_app, &popup_parent, &popup_origin, url, features)
            } else {
                open_external(&popup_app, &url);
                NewWindowResponse::Deny
            }
        })
        .build();
    let next = match next {
        Ok(next) => next,
        Err(_) => {
            state.transport.remove(&label);
            state.sessions.remove(&label);
            return Err("Could not open that server.".into());
        }
    };

    if let Err(error) = document::wait_for_document(&next, Duration::from_secs(20))
        .await
        .and_then(|()| require_setup(window))
        .and_then(|()| require_native_account(state, authorization))
        .and_then(|()| {
            if let Some(stack) = &local {
                require_current_stack(state, authorization, stack)?;
            }
            Ok(())
        })
        .and_then(|()| {
            if state.restore_intent.load(Ordering::SeqCst) == intent {
                Ok(())
            } else {
                Err("This connection is no longer active.".into())
            }
        })
    {
        cancel_native_document(app, &label);
        state.sessions.remove(&label);
        let _ = next.destroy();
        return Err(error);
    }
    choice.account = Some(settings::account_key(authorization.account.identity()));
    if let Err(error) = settings::save(&state.directory, &choice) {
        cancel_native_document(app, &label);
        state.sessions.remove(&label);
        let _ = next.destroy();
        return Err(error);
    }
    let setup_window = window.clone();
    let presentation_app = app.clone();
    let current = move || {
        let state = presentation_app.state::<DesktopState>();
        state.restore_intent.load(Ordering::SeqCst) == intent
            && state
                .accounts_started
                .lock()
                .is_ok_and(|gate| gate.generation == accounts_generation)
            && require_setup(&setup_window).is_ok()
    };
    if show_only_window_if(&next, current.clone()).is_err() {
        cancel_native_document(app, &label);
        state.sessions.remove(&label);
        let previous = state
            .setup
            .lock()
            .map_err(|_| "Desktop state unavailable")?;
        let restored = match previous.as_ref() {
            Some(previous) => settings::save(&state.directory, previous),
            None => settings::clear(&state.directory),
        };
        drop(previous);
        let _ = next.destroy();
        let _ = show_only_window_if(window, current);
        return Err(if restored.is_ok() {
            "Could not show that server.".into()
        } else {
            "Could not show that server or restore the previous choice.".into()
        });
    }
    if let Some(workspace) = &choice.workspace {
        if server_directory::remember_workspace(
            &state.directory,
            authorization.account.identity(),
            workspace,
        )
        .is_err()
        {
            eprintln!("Could not save the workspace preference.");
        }
    }
    *state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable")? = Some(choice);
    let previous = state
        .active_window
        .lock()
        .map_err(|_| "Desktop state unavailable")?
        .replace(label.clone());
    state.warm_generation.fetch_add(1, Ordering::Relaxed);
    if let Some(locale) = state.sessions.take_locale(&label) {
        let _ = set_locale(app, &locale);
    }
    let _ = next.set_badge_count(None);
    if let Some(previous) = previous.and_then(|label| app.get_webview_window(&label)) {
        cancel_native_document(app, previous.label());
        state.sessions.remove(previous.label());
        let _ = previous.destroy();
    }
    if let Some(host) = &state.host_computer {
        host.activate(
            state
                .sessions
                .current(&label)
                .filter(|document| managed_computer_document(app, document))
                .map(|document| document.owner()),
        );
    }
    // The page may have requested pairing while it was still an inactive candidate.
    if let Some(document) = state.sessions.current(&label) {
        send_native_event(app, &document, "pairing", ());
    }
    let _ = refresh_menu(app);
    Ok(())
}

#[tauri::command]
fn clear_server_link<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<DesktopState>,
    raw_url: String,
) -> Result<(), String> {
    require_setup(&window)?;
    let mut pending = state
        .pending_server
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    if pending.as_deref() == Some(raw_url.as_str()) {
        *pending = None;
        *state
            .initialization
            .lock()
            .map_err(|_| "Desktop state unavailable.")? = None;
    }
    Ok(())
}

#[tauri::command]
fn clear_workspace_link<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    target: server_link::WorkspaceLink,
) -> Result<(), String> {
    require_setup(&window)?;
    let mut pending = state
        .pending_workspace
        .lock()
        .map_err(|_| "Desktop state unavailable.")?;
    if pending.as_ref() == Some(&target) {
        *pending = None;
    }
    Ok(())
}

#[tauri::command]
fn quit_setup(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_setup(&window)?;
    app.exit(0);
    Ok(())
}

fn receive_server_link(app: &tauri::AppHandle, input: &str) {
    if let Some(workspace) = server_link::parse_workspace(input) {
        let Some(state) = app.try_state::<DesktopState>() else {
            return;
        };
        cancel_server_pairings(&state);
        cancel_restore(&state);
        if let Ok(mut pending) = state.pending_workspace.lock() {
            *pending = Some(workspace.clone());
        }
        if let Ok(mut pending) = state.pending_server.lock() {
            *pending = None;
        }
        if let Ok(mut pending) = state.initialization.lock() {
            *pending = None;
        }
        update_startup(app, Startup::idle());
        if let Ok(window) = setup_window(app, true) {
            let _ = window.emit("desktop-workspace-link", workspace);
        }
        return;
    }

    let initialization = server_link::parse_initialization(input);
    let initializing = initialization.is_some();
    let Some(origin) = server_link::parse(input).or_else(|| {
        initialization
            .as_ref()
            .map(|initialization| initialization.origin.clone())
    }) else {
        return;
    };
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    cancel_server_pairings(&state);
    cancel_restore(&state);
    if let Ok(mut pending) = state.pending_workspace.lock() {
        *pending = None;
    }
    if let Ok(mut pending) = state.initialization.lock() {
        *pending = initialization;
    }
    if let Ok(mut pending) = state.pending_server.lock() {
        *pending = Some(origin.clone());
    }
    update_startup(app, Startup::idle());
    if let Ok(window) = setup_window(app, true) {
        let _ = window.emit(
            "desktop-server-link",
            serde_json::json!({"origin": origin, "initialize": initializing}),
        );
    }
}

fn auth_cookie(name: &str) -> bool {
    name.ends_with(".session_token")
        || name.ends_with(".session_data")
        || name.contains(".session_data.")
        || name.ends_with(".dont_remember")
}

fn same_captured_cookie(
    captured: &tauri::webview::Cookie<'_>,
    current: &tauri::webview::Cookie<'_>,
) -> bool {
    captured.name() == current.name()
        && captured.domain() == current.domain()
        && captured.path() == current.path()
        && captured.value() == current.value()
}

async fn clear_server_session(
    window: &WebviewWindow,
    state: &DesktopState,
    logout: &AccountsLogout,
    document: &native::Document,
    account: Option<&str>,
) -> Result<(), String> {
    let current = || logout.is_current(state) && logout_document_matches(state, document, account);
    if !current() {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    if state.transport.selected(&document.label).is_some() {
        let queued = if let Some((selection, token)) = state
            .transport
            .captured_session(&document.label, &document.id)?
        {
            state
                .accounts
                .queue_installation_logout(selection, token)
                .await
        } else {
            Ok(())
        };
        state
            .transport
            .retire_session(&document.label, &document.id)?;
        queued?;
        state.accounts.retry_revocations();
        return Ok(());
    }
    let cookie_window = window.clone();
    let cookie_url = document
        .origin
        .join("/api/auth/get-session")
        .map_err(|_| "Invalid server.")?;
    let read_url = cookie_url.clone();
    let captured = tokio::task::spawn_blocking(move || cookie_window.cookies_for_url(read_url))
        .await
        .map_err(|_| "Could not read the server session.")?
        .map_err(|_| "Could not read the server session.")?;
    if !current() {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    let cookies = captured
        .iter()
        .filter(|cookie| cookie.name().ends_with(".session_token"))
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let queued = state
        .accounts
        .queue_server_logout(&document.origin, cookies)
        .await;
    if !current() {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    let cookie_window = window.clone();
    let cookie_app = window.app_handle().clone();
    let cookie_document = document.clone();
    let cookie_logout = *logout;
    let cookie_account = account.map(str::to_owned);
    tokio::task::spawn_blocking(move || {
        let state = cookie_app.state::<DesktopState>();
        for cookie in captured
            .into_iter()
            .filter(|cookie| auth_cookie(cookie.name()))
        {
            let current = || {
                cookie_logout.is_current(&state)
                    && logout_document_matches(&state, &cookie_document, cookie_account.as_deref())
            };
            if !current() {
                return Err("Accounts sign-in changed. Try again.");
            }
            let latest = cookie_window
                .cookies_for_url(cookie_url.clone())
                .map_err(|_| "Could not read the server session.")?;
            if !current() {
                return Err("Accounts sign-in changed. Try again.");
            }
            // Recheck each captured value immediately before erasure, never a replacement cookie.
            if latest
                .iter()
                .any(|value| same_captured_cookie(&cookie, value))
            {
                cookie_window
                    .delete_cookie(cookie)
                    .map_err(|_| "Could not clear the server session.")?;
            }
        }
        Ok::<(), &str>(())
    })
    .await
    .map_err(|_| "Could not clear the server session.")??;
    if !current() {
        return Err("Accounts sign-in changed. Try again.".into());
    }
    state.accounts.retry_revocations();
    queued
}

async fn server_session_cookies(window: &WebviewWindow, origin: &Url) -> Result<String, String> {
    let cookie_window = window.clone();
    let cookie_url = origin
        .join("/api/auth/get-session")
        .map_err(|_| "Invalid server.")?;
    // WebView2 cookie access must run outside the UI thread. Cookies stay native.
    tokio::task::spawn_blocking(move || {
        cookie_window.cookies_for_url(cookie_url).map(|cookies| {
            cookies
                .iter()
                .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                .collect::<Vec<_>>()
                .join("; ")
        })
    })
    .await
    .map_err(|_| "Could not read the server session.")?
    .map_err(|_| "Could not read the server session.".into())
}

async fn save_connected_server(
    app: &tauri::AppHandle,
    state: &DesktopState,
    document: &native::Document,
    cookies: &str,
) -> Result<(), String> {
    let _operation = state.bookmark_sync.lock().await;
    let Some(bookmark) = state
        .pending_bookmark
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .clone()
    else {
        return Ok(());
    };
    if bookmark.origin != document.origin.origin().ascii_serialization() {
        return Ok(());
    }
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    let current = || {
        current_server_account(app, state, document, &authorization)
            && bookmark.account == settings::account_key(authorization.account.identity())
            && state
                .pending_bookmark
                .lock()
                .ok()
                .is_some_and(|pending| pending.as_ref() == Some(&bookmark))
    };
    if !current() || !pairing::has_session(&document.origin, cookies).await? || !current() {
        return Ok(());
    }
    let device = server_directory::device_id(&state.directory)?;
    server_directory::Directory::new()?
        .add(
            authorization.directory_bearer()?,
            &document.origin,
            server_directory::Kind::Selfhosted,
            &device,
        )
        .await?;
    if current() {
        let mut pending = state
            .pending_bookmark
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        if pending.as_ref() == Some(&bookmark) {
            *pending = None;
        }
    }
    Ok(())
}

fn show_setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    setup_window(app, true).map(|_| ())
}

fn show_only_window<R: tauri::Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    show_only_window_if(window, || true)
}

fn show_only_window_if<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    current: impl FnOnce() -> bool + Send + 'static,
) -> tauri::Result<()> {
    let target = window.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    // Keep presentation changes together so concurrent activations cannot reveal two windows.
    window.app_handle().run_on_main_thread(move || {
        let result = (|| {
            if !current() {
                return Err(tauri::Error::FailedToReceiveMessage);
            }
            for (label, other) in target.app_handle().webview_windows() {
                if label != target.label() && (label == "setup" || label.starts_with("server-")) {
                    other.hide()?;
                }
            }
            target.show()?;
            target.unminimize()?;
            target.set_focus()
        })();
        let _ = sender.send(result);
    })?;
    receiver
        .recv()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?
}

fn setup_window(app: &tauri::AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("setup") {
        if visible {
            show_only_window(&window)?;
        }
        Ok(window)
    } else {
        app.state::<DesktopState>()
            .setup_ready
            .store(false, Ordering::SeqCst);
        let window = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
            .title("Ork")
            .inner_size(580.0, 640.0)
            .resizable(false)
            .visible(false)
            .on_navigation(|url| is_setup_document("setup", url))
            .on_page_load(move |window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished
                    && is_setup_document("setup", payload.url())
                {
                    let first = !window
                        .app_handle()
                        .state::<DesktopState>()
                        .setup_ready
                        .swap(true, Ordering::SeqCst);
                    if !visible && first {
                        // A newly loaded setup document restores its session and selected server.
                        // Starting a second native restore here races its asynchronous session check.
                        if !focus_active(window.app_handle()) {
                            let _ = show_setup(window.app_handle());
                        }
                    }
                }
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()?;
        if visible {
            show_only_window(&window)?;
        }
        Ok(window)
    }
}

fn refresh_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let state = app.state::<DesktopState>();
    let locale = app.state::<Mutex<locale::Locale>>();
    let locale = locale
        .lock()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?;
    let app_open = state
        .active_window
        .lock()
        .ok()
        .is_some_and(|label| label.is_some());
    let local_server = state
        .setup
        .lock()
        .ok()
        .as_ref()
        .and_then(|choice| choice.as_ref())
        .is_some_and(|choice| choice.mode == settings::InstanceMode::New);
    menu::install(
        app,
        &locale,
        menu::MenuFlags {
            app_open,
            local_server,
            updates: true,
            computer_access: local_server && state.host_computer.is_some(),
            revoke_computer_access: local_server
                && state
                    .host_computer
                    .as_ref()
                    .is_some_and(|host| host.is_enabled()),
        },
    )
}

fn set_locale(app: &tauri::AppHandle, raw: &str) -> Result<(), String> {
    let changed = app
        .state::<Mutex<locale::Locale>>()
        .lock()
        .map_err(|_| "Desktop language unavailable.")?
        .set(raw)?;
    if changed {
        refresh_menu(app).map_err(|_| "Could not update native menus.")?;
    }
    Ok(())
}

fn focus_active<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<DesktopState>() else {
        return false;
    };
    let Ok(active) = state.active_window.lock() else {
        return false;
    };
    let Some(window) = active
        .as_ref()
        .and_then(|label| app.get_webview_window(label))
    else {
        return false;
    };
    // The warm-window reaper checks this generation under the same active-window lock.
    state.warm_generation.fetch_add(1, Ordering::Relaxed);
    drop(active);
    show_only_window(&window).is_ok()
}

fn saved_server<'a>(
    choice: &settings::Setup,
    identity: (&str, &str),
    servers: &'a [server_directory::Server],
) -> Option<&'a server_directory::Server> {
    if !choice.belongs_to(identity) {
        return None;
    }
    servers.iter().find(|server| {
        server.url == choice.server_url.origin().ascii_serialization()
            && matches!(
                (choice.mode, server.kind),
                (settings::InstanceMode::New, server_directory::Kind::Local)
                    | (
                        settings::InstanceMode::Existing,
                        server_directory::Kind::Selfhosted
                    )
            )
    })
}

fn startup_server<'a>(
    preference: Option<&server_directory::Preference>,
    choice: Option<&settings::Setup>,
    identity: (&str, &str),
    servers: &'a [server_directory::Server],
) -> Option<&'a server_directory::Server> {
    match preference {
        Some(preference) => {
            if let Some(server) = preference
                .server_id
                .as_ref()
                .and_then(|id| servers.iter().find(|server| &server.id == id))
            {
                return Some(server);
            }
        }
        None => {
            if let Some(server) = choice.and_then(|choice| saved_server(choice, identity, servers))
            {
                return Some(server);
            }
        }
    }
    if servers.len() == 1 {
        servers.first()
    } else {
        None
    }
}

fn cancel_restore(state: &DesktopState) {
    state.restore_intent.fetch_add(1, Ordering::SeqCst);
    if state.restoring.load(Ordering::SeqCst) {
        state.accounts.invalidate();
        state.deactivate_stack();
    }
}

fn begin_restore(state: &DesktopState) -> Option<u64> {
    if state
        .pending_workspace
        .lock()
        .ok()
        .is_some_and(|pending| pending.is_some())
        || !state.accounts_have_started()
        || !state.setup_ready.load(Ordering::SeqCst)
        || state
            .pending_server
            .lock()
            .ok()
            .is_some_and(|pending| pending.is_some())
        || state
            .restoring
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return None;
    }
    Some(state.restore_intent.load(Ordering::SeqCst))
}

#[cfg(any(target_os = "macos", test))]
fn retire_warm_window(state: &DesktopState, label: &str, generation: u64) -> bool {
    let Ok(mut active) = state.active_window.lock() else {
        return false;
    };
    if active.as_deref() != Some(label)
        || state.warm_generation.load(Ordering::Relaxed) != generation
    {
        return false;
    }
    *active = None;
    true
}

async fn restore_personal_server(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    intent: u64,
) -> Result<bool, String> {
    let state = app.state::<DesktopState>();
    require_setup(window)?;
    let epoch = state.personal_devices.epoch();
    let Some(choice) = state
        .setup
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .clone()
    else {
        return Ok(false);
    };
    let Some(credential) = state.personal_devices.saved(&choice)? else {
        return Ok(false);
    };
    if let Some((account, profile_epoch)) = state
        .accounts
        .local_profile_epoch(&server_directory::origin())
        .await?
    {
        if account != credential.selection.account || profile_epoch != credential.profile_epoch {
            return Ok(false);
        }
    }
    let authorization = state.accounts.personal_authorization(&credential, epoch)?;
    if state.restore_intent.load(Ordering::SeqCst) != intent {
        return Ok(false);
    }
    require_native_account(&state, &authorization)?;
    if choice.mode == settings::InstanceMode::New {
        let (stack, stack_intent) = select_local_stack(app, &state, &authorization)?;
        if !stack.owns_workspace(&credential.selection.target)
            || !stack.matches_saved_url(choice.server_url.as_str())
        {
            return Err(
                "Reconnect this installation through Accounts to verify its ownership.".into(),
            );
        }
        let result = stack.start_for(stack_intent).await;
        require_setup(window)?;
        require_current_stack(&state, &authorization, &stack)?;
        if result.phase != local_stack::LocalStackPhase::Ready
            || !stack.matches_saved_url(choice.server_url.as_str())
        {
            return Err(result
                .message
                .unwrap_or_else(|| "Could not resume this local installation.".into()));
        }
    }
    if state.restore_intent.load(Ordering::SeqCst) != intent {
        return Ok(false);
    }
    update_startup(
        app,
        Startup {
            phase: "opening",
            server_id: Some(credential.selection.target.workspace_id.clone()),
            kind: (choice.mode == settings::InstanceMode::New)
                .then_some(server_directory::Kind::Local),
            message: None,
        },
    );
    open_server(window, app, &state, choice, &authorization).await?;
    if state.restore_intent.load(Ordering::SeqCst) != intent {
        retire_server_windows(app, &state);
        return Ok(false);
    }
    Ok(true)
}

async fn restore_saved_server(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    intent: u64,
) -> Result<bool, String> {
    let state = app.state::<DesktopState>();
    let _switch = state.switching.lock().await;
    if !state.accounts_have_started() || state.restore_intent.load(Ordering::SeqCst) != intent {
        return Ok(false);
    }
    let authorization = match state
        .accounts
        .authorization(&server_directory::origin())
        .await
    {
        Ok(authorization) => authorization,
        Err(_) => return restore_personal_server(app, window, intent).await,
    };
    if state.restore_intent.load(Ordering::SeqCst) != intent {
        return Ok(false);
    }
    let device = server_directory::device_id(&state.directory)?;
    let directory = server_directory::Directory::new()?;
    let catalog = match directory
        .catalog_for_device(authorization.directory_bearer()?, &device)
        .await
    {
        Ok(catalog) => catalog,
        Err(error) => {
            return match restore_personal_server(app, window, intent).await {
                Ok(true) => Ok(true),
                Ok(false) => Err(error),
                Err(error) => Err(error),
            }
        }
    };
    require_account(&state, &authorization)?;
    if catalog.has_organizations() {
        let Some(workspace) =
            catalog.initial_workspace(&state.directory, authorization.account.identity())?
        else {
            return Ok(false);
        };
        if state.restore_intent.load(Ordering::SeqCst) != intent {
            return Ok(false);
        }
        let target = server::normalize_server_url(&workspace.url)?;
        let mode = prepare_workspace_route(
            app,
            &state,
            &authorization,
            &target,
            workspace.target.as_ref(),
        )
        .await?;
        require_account(&state, &authorization)?;
        update_startup(
            app,
            Startup {
                phase: "opening",
                server_id: Some(workspace.id.clone()),
                kind: (mode == settings::InstanceMode::New)
                    .then_some(server_directory::Kind::Local),
                message: None,
            },
        );
        show_setup(app).map_err(|_| "Could not open server settings.")?;
        open_server(
            window,
            app,
            &state,
            settings::Setup {
                mode,
                server_url: target,
                account: None,
                workspace: workspace.target,
            },
            &authorization,
        )
        .await?;
        if state.restore_intent.load(Ordering::SeqCst) != intent {
            retire_server_windows(app, &state);
            return Ok(false);
        }
        return Ok(true);
    }
    let entries = directory
        .list(authorization.directory_bearer()?, &device)
        .await?;
    require_account(&state, &authorization)?;
    let server = {
        let choice = state
            .setup
            .lock()
            .map_err(|_| "Desktop state unavailable.")?;
        let preference =
            server_directory::preference(&state.directory, authorization.account.identity())?;
        let Some(server) = startup_server(
            preference.as_ref(),
            choice.as_ref(),
            authorization.account.identity(),
            &entries,
        )
        .cloned() else {
            return Ok(false);
        };
        if state.restore_intent.load(Ordering::SeqCst) != intent {
            return Ok(false);
        }
        if preference.is_none() {
            server_directory::save_preference(
                &state.directory,
                authorization.account.identity(),
                Some(&server.id),
            )?;
        }
        server
    };
    update_startup(
        app,
        Startup {
            phase: "opening",
            server_id: Some(server.id.clone()),
            kind: Some(server.kind),
            message: None,
        },
    );
    show_setup(app).map_err(|_| "Could not open server settings.")?;
    connect_directory_server(
        window,
        app,
        &state,
        &server,
        &authorization,
        &directory,
        &device,
    )
    .await?;
    if state.restore_intent.load(Ordering::SeqCst) != intent {
        retire_server_windows(app, &state);
        return Ok(false);
    }
    Ok(true)
}

fn show_active_or_setup(app: &tauri::AppHandle) {
    if app
        .get_webview_window("setup")
        .is_some_and(|window| window.is_visible().unwrap_or(false))
    {
        let _ = show_setup(app);
        return;
    }
    if focus_active(app) {
        return;
    }
    let state = app.state::<DesktopState>();
    if !state.accounts_have_started() {
        update_startup(app, Startup::idle());
        let _ = show_setup(app);
        return;
    }
    if app.get_webview_window("setup").is_none() {
        // The new bundled document restores its session before selecting a server.
        let _ = setup_window(app, false);
        return;
    }
    let state = app.state::<DesktopState>();
    let Some(intent) = begin_restore(&state) else {
        return;
    };
    let Ok(window) = setup_window(app, false) else {
        state.restoring.store(false, Ordering::SeqCst);
        return;
    };
    update_startup(app, Startup::checking());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let restored = restore_saved_server(&app, &window, intent).await;
        app.state::<DesktopState>()
            .restoring
            .store(false, Ordering::SeqCst);
        if app
            .state::<DesktopState>()
            .restore_intent
            .load(Ordering::SeqCst)
            != intent
        {
            // A late activation may have hidden the picker requested by Change Server or logout.
            let _ = show_setup(&app);
            return;
        }
        let startup = match &restored {
            Err(error) => Startup {
                phase: "failed",
                message: Some(error.clone()),
                ..app
                    .state::<DesktopState>()
                    .startup
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_else(|_| Startup::idle())
            },
            _ => Startup::idle(),
        };
        update_startup(&app, startup);
        if !matches!(restored, Ok(true)) && !focus_active(&app) {
            let _ = show_setup(&app);
        }
    });
}

fn menu_event(app: &tauri::AppHandle, action: menu::MenuAction) {
    use menu::MenuAction;
    match action {
        MenuAction::Ui(command) => {
            if let Some(document) = active_document(app) {
                send_native_event(app, &document, "menu", command);
            }
        }
        MenuAction::Settings => {
            if let Some(document) = active_document(app) {
                send_native_event(app, &document, "settings", ());
            }
        }
        MenuAction::ChangeServer => {
            let state = app.state::<DesktopState>();
            cancel_restore(&state);
            state.deactivate_stack();
            update_startup(app, Startup::idle());
            let _ = show_setup(app);
            if let Some(window) = app.get_webview_window("setup") {
                let _ = window.emit("desktop-change-server", ());
            }
        }
        MenuAction::StopLocalServer => {
            let Some(document) = active_document(app) else {
                return;
            };
            let Some(stack) = managed_stack(app, &document) else {
                return;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<DesktopState>();
                if managed_stack_is_current(&app, &document, &stack) {
                    if let Some(host) = &state.host_computer {
                        host.activate(None);
                    }
                }
                // An account switch cannot retarget a stop that the user already requested.
                stack.stop().await;
                let _ = refresh_menu(&app);
            });
        }
        MenuAction::CheckForUpdates => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                updates::check(app).await;
            });
        }
        MenuAction::Quit => app.exit(0),
        MenuAction::ComputerAccess => {
            if let Some(document) =
                active_document(app).filter(|document| managed_computer_document(app, document))
            {
                send_native_event(app, &document, "computer", ());
            }
        }
        MenuAction::RevokeComputerAccess => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = revoke_computer_access(&app).await;
            });
        }
        action => {
            let window = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false));
            if let Some(window) = window {
                match action {
                    MenuAction::ToggleFullScreen => {
                        let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
                    }
                    MenuAction::Minimize => {
                        let _ = window.minimize();
                    }
                    MenuAction::ToggleMaximize => {
                        let _ = if window.is_maximized().unwrap_or(false) {
                            window.unmaximize()
                        } else {
                            window.maximize()
                        };
                    }
                    MenuAction::CloseWindow => {
                        let _ = window.close();
                    }
                    MenuAction::ResetZoom | MenuAction::ZoomIn | MenuAction::ZoomOut => {
                        let delta = match action {
                            MenuAction::ZoomIn => Some(0.1),
                            MenuAction::ZoomOut => Some(-0.1),
                            _ => None,
                        };
                        if let Some(scale) = app
                            .state::<DesktopState>()
                            .sessions
                            .adjust_zoom(window.label(), delta)
                        {
                            let _ = window.set_zoom(scale);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

fn main() {
    if let Some(passed) = personal_keys::check_cli() {
        if passed {
            println!("Personal device key check passed.");
        } else {
            eprintln!("Personal device key check failed.");
        }
        std::process::exit(if passed { 0 } else { 1 });
    }
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR") {
        let webkit =
            std::path::PathBuf::from(appdir).join("usr/lib/x86_64-linux-gnu/webkit2gtk-4.1");
        if webkit.join("WebKitNetworkProcess").is_file() {
            std::env::set_var("WEBKIT_EXEC_PATH", &webkit);
            std::env::set_var(
                "WEBKIT_INJECTED_BUNDLE_PATH",
                webkit.join("injected-bundle"),
            );
        }
    }
    renderer_host::configure(tauri::Builder::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|argument| {
                server_link::parse(argument).is_some()
                    || server_link::parse_initialization(argument).is_some()
                    || server_link::parse_workspace(argument).is_some()
            }) {
                show_active_or_setup(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            setup_state,
            setup_accounts_session,
            setup_accounts_sign_in,
            setup_accounts_logout,
            list_servers,
            list_workspaces,
            workspace_catalog,
            set_default_organization,
            check_workspace,
            set_default_server,
            create_server_installation,
            get_server_installation,
            server_initialization_required,
            create_server_pairing,
            get_server_pairing,
            approve_server_pairing,
            cancel_server_pairing,
            cancel_setup_connection,
            remove_server,
            connect_saved_server,
            connect_workspace,
            connect_server,
            connect_local_server,
            local_stack_state,
            quit_setup,
            clear_server_link,
            clear_workspace_link,
            native_command
        ])
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?;
            let credential_store =
                credentials::Store::system(&directory).map_err(std::io::Error::other)?;
            let resources = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../infra/compose")
            } else {
                app.path().resource_dir()?.join("stack")
            };
            let host_computer = host_computer::HostComputer::prepare(&directory).ok();
            let stack = local_stack::LocalStack::new(
                directory.join("stack"),
                resources,
                local_stack::image_tag(
                    &app.package_info().version.to_string(),
                    !cfg!(debug_assertions),
                    option_env!("ORKBOT_INSTALLER_REVISION"),
                ),
                None,
                host_computer.as_ref().map(|host| host.connection.clone()),
            );
            let auth_app = app.handle().clone();
            let browser_auth = browser_auth::BrowserAuth::new(Arc::new(move |owner, callback| {
                if let Some(document) = active_document(&auth_app) {
                    if document.owner() == owner {
                        send_native_event(&auth_app, &document, "oauth", callback);
                    }
                }
            }));
            let speech_helper = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../build/tauri-native/orkbot-speech")
            } else {
                std::env::current_exe()?.with_file_name("orkbot-speech")
            };
            app.manage(Mutex::new(locale::Locale::new(directory.clone())));
            app.manage(DesktopState {
                setup: Mutex::new(settings::load(&directory)),
                stack: Mutex::new(local_stack_scope::AccountStacks::new(stack)),
                host_computer,
                computer_choice: tokio::sync::Mutex::new(()),
                computer_prompt: std::sync::atomic::AtomicBool::new(false),
                directory: directory.clone(),
                active_window: Mutex::new(None),
                sequence: AtomicU64::new(1),
                switching: tokio::sync::Mutex::new(()),
                sessions: native::Sessions::default(),
                transport: installation_transport::Transport::default(),
                personal_devices: personal_devices::PersonalDevices::system(&directory),
                browser_auth,
                accounts: accounts::Accounts::new(credential_store.clone()),
                accounts_started: Mutex::new(AccountsStarted::default()),
                server_pairings: server_pairing::Attempts::default(),
                restoring: std::sync::atomic::AtomicBool::new(false),
                restore_intent: AtomicU64::new(0),
                setup_ready: std::sync::atomic::AtomicBool::new(false),
                startup: Mutex::new(Startup::idle()),
                speech: speech::SpeechManager::new(speech_helper),
                pairings: pairing::Pairings::new(credential_store),
                warm_generation: AtomicU64::new(0),
                pending_server: Mutex::new(None),
                pending_workspace: Mutex::new(None),
                initialization: Mutex::new(None),
                opening_server: Mutex::new(None),
                pending_bookmark: Mutex::new(None),
                bookmark_sync: tokio::sync::Mutex::new(()),
            });
            app.state::<DesktopState>().accounts.retry_revocations();
            app.manage(updates::UpdateCheck::default());
            updates::start_background(app.handle().clone());
            start_server_discovery(app.handle().clone());
            refresh_menu(app.handle())?;
            setup_window(app.handle(), false)?;
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
            let link_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    receive_server_link(&link_app, url.as_str());
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    receive_server_link(app.handle(), url.as_str());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<DesktopState>() {
                    if state
                        .active_window
                        .lock()
                        .ok()
                        .as_ref()
                        .and_then(|label| label.as_deref())
                        == Some(window.label())
                    {
                        api.prevent_close();
                        let _ = window.hide();
                        let generation = state.warm_generation.fetch_add(1, Ordering::Relaxed) + 1;
                        let app = window.app_handle().clone();
                        let label = window.label().to_owned();
                        let timeout = lifecycle::warm_window_ttl(
                            std::env::var("ORKBOT_WARM_WINDOW_TTL_MS").as_deref().ok(),
                        );
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(timeout).await;
                            let state = app.state::<DesktopState>();
                            let Some(window) = app.get_webview_window(&label) else {
                                return;
                            };
                            if state.warm_generation.load(Ordering::Relaxed) != generation
                                || window.is_visible().unwrap_or(true)
                            {
                                return;
                            }
                            if !retire_warm_window(&state, &label, generation) {
                                return;
                            }
                            cancel_native_document(&app, &label);
                            state.sessions.remove(&label);
                            let _ = window.set_badge_count(None);
                            let _ = window.destroy();
                            let _ = refresh_menu(&app);
                        });
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                cancel_native_document(window.app_handle(), window.label());
                if let Some(state) = window.app_handle().try_state::<DesktopState>() {
                    state.sessions.remove(window.label());
                    let active = state.active_window.lock().ok();
                    if active.as_ref().and_then(|label| label.as_deref()) == Some(window.label()) {
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .on_menu_event(|app, event| {
            if let Some(action) = menu::action(event.id().as_ref()) {
                menu_event(app, action);
            }
        })
        .build(app_context())
        .expect("could not build Ork")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                show_active_or_setup(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_native(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct TestCredentials(Mutex<std::collections::HashMap<String, String>>);
    impl credentials::CredentialStore for TestCredentials {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    pub(crate) fn test_state(directory: &std::path::Path) -> DesktopState {
        let store = credentials::Store(Arc::new(TestCredentials::default()));
        DesktopState {
            directory: directory.to_owned(),
            setup: Mutex::new(None),
            host_computer: None,
            computer_choice: tokio::sync::Mutex::new(()),
            computer_prompt: std::sync::atomic::AtomicBool::new(false),
            stack: Mutex::new(local_stack_scope::AccountStacks::new(
                local_stack::LocalStack::new(
                    directory.join("stack"),
                    directory.join("resources"),
                    "edge".into(),
                    None,
                    None,
                ),
            )),
            active_window: Mutex::new(None),
            sequence: AtomicU64::new(1),
            switching: tokio::sync::Mutex::new(()),
            sessions: native::Sessions::default(),
            transport: installation_transport::Transport::default(),
            personal_devices: personal_devices::PersonalDevices::system(directory),
            browser_auth: browser_auth::BrowserAuth::new(Arc::new(|_, _| {})),
            accounts: accounts::Accounts::new(store.clone()),
            accounts_started: Mutex::new(AccountsStarted::default()),
            server_pairings: server_pairing::Attempts::default(),
            restoring: std::sync::atomic::AtomicBool::new(false),
            restore_intent: AtomicU64::new(0),
            setup_ready: std::sync::atomic::AtomicBool::new(false),
            startup: Mutex::new(Startup::idle()),
            speech: speech::SpeechManager::new(PathBuf::new()),
            pairings: pairing::Pairings::new(store),
            warm_generation: AtomicU64::new(0),
            pending_server: Mutex::new(None),
            pending_workspace: Mutex::new(None),
            initialization: Mutex::new(None),
            opening_server: Mutex::new(None),
            pending_bookmark: Mutex::new(None),
            bookmark_sync: tokio::sync::Mutex::new(()),
        }
    }

    #[test]
    fn pending_native_auth_is_bound_to_the_confirmed_document_origin_account_and_intent() {
        let pending = OpeningServer {
            label: "server-new".into(),
            origin: "https://server.example.test".into(),
            account: "account-a".into(),
            intent: 3,
            workspace: None,
        };
        let mut document = native::Document {
            label: "server-new".into(),
            id: "document".into(),
            origin: Url::parse("https://server.example.test").unwrap(),
        };
        assert!(pending.permits(&document, Some("account-a"), 3));
        assert!(!pending.permits(&document, Some("account-b"), 3));
        assert!(!pending.permits(&document, Some("account-a"), 4));
        document.label = "server-old".into();
        assert!(!pending.permits(&document, Some("account-a"), 3));
        document.label = "server-new".into();
        document.origin = Url::parse("https://other.example.test").unwrap();
        assert!(!pending.permits(&document, Some("account-a"), 3));
    }

    #[test]
    fn reopening_an_existing_product_window_reuses_it_and_retires_the_warm_timeout() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .manage(test_state(directory.path()))
            .build(app_context())
            .unwrap();
        let _picker =
            WebviewWindowBuilder::new(&app, "setup", WebviewUrl::App("index.html".into()))
                .visible(true)
                .build()
                .unwrap();
        let product = WebviewWindowBuilder::new(
            &app,
            "server-1",
            WebviewUrl::External(Url::parse("https://product.example.test").unwrap()),
        )
        .visible(false)
        .build()
        .unwrap();
        let state = app.state::<DesktopState>();
        *state.active_window.lock().unwrap() = Some(product.label().into());
        assert!(focus_active(app.handle()));
        assert_eq!(state.warm_generation.load(Ordering::Relaxed), 1);
        // MockRuntime's visibility getter is constant. Native QA verifies show/hide and focus.
        assert!(focus_active(app.handle()));
        assert_eq!(state.warm_generation.load(Ordering::Relaxed), 2);
        assert_eq!(app.webview_windows().len(), 2);
    }

    #[test]
    fn a_missing_product_window_cannot_be_focused_from_a_stale_label() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .manage(test_state(directory.path()))
            .build(app_context())
            .unwrap();
        *app.state::<DesktopState>().active_window.lock().unwrap() = Some("server-missing".into());
        assert!(!focus_active(app.handle()));
    }

    #[test]
    fn discovery_requires_a_visible_product_window_and_no_setup_window() {
        let app = tauri::test::mock_builder().build(app_context()).unwrap();
        assert!(discovery_window(app.handle(), "server-missing").is_none());
        let product = WebviewWindowBuilder::new(
            &app,
            "server-1",
            WebviewUrl::External(Url::parse("https://product.example.test").unwrap()),
        )
        .build()
        .unwrap();
        assert_eq!(
            discovery_window(app.handle(), product.label())
                .unwrap()
                .label(),
            product.label()
        );
        let _setup = WebviewWindowBuilder::new(&app, "setup", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        // MockRuntime reports every created window as visible.
        assert!(discovery_window(app.handle(), product.label()).is_none());
    }

    #[test]
    fn logout_clears_only_captured_auth_cookies_and_preserves_replacements() {
        use tauri::webview::Cookie;
        let original = Cookie::build(("better-auth.session_token", "old-session"))
            .domain("server.example.test")
            .path("/")
            .build();
        assert!(auth_cookie(original.name()));
        assert!(auth_cookie("__Secure-better-auth.session_data.0"));
        assert!(!auth_cookie("color-mode"));
        assert!(!auth_cookie("other.session_data_backup"));
        assert!(same_captured_cookie(&original, &original.clone()));
        let mut replacement = original.clone();
        replacement.set_value("new-session");
        assert!(!same_captured_cookie(&original, &replacement));
        let mut other_domain = original.clone();
        other_domain.set_domain("other.example.test");
        assert!(!same_captured_cookie(&original, &other_domain));
        let mut other_path = original.clone();
        other_path.set_path("/different");
        assert!(!same_captured_cookie(&original, &other_path));
    }

    #[test]
    fn logout_always_targets_central_accounts_and_only_the_optional_legacy_server() {
        let central = server_directory::origin();
        assert_eq!(account_logout_origins(None).unwrap(), vec![central.clone()]);
        assert_eq!(
            account_logout_origins(Some(&central.join("/app").unwrap())).unwrap(),
            vec![central.clone()]
        );
        assert_eq!(
            account_logout_origins(Some(
                &Url::parse("https://server.example.test/app?next=home").unwrap()
            ))
            .unwrap(),
            vec![central, Url::parse("https://server.example.test").unwrap()]
        );
    }

    #[test]
    fn beginning_logout_clears_pending_auth_and_fences_new_accounts_activity() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        state
            .accounts_started
            .lock()
            .unwrap()
            .complete(0, true)
            .unwrap();
        *state.pending_server.lock().unwrap() = Some("https://server.example.test".into());
        *state.pending_bookmark.lock().unwrap() = Some(server_link::Bookmark {
            origin: "https://server.example.test".into(),
            account: "a".repeat(64),
        });
        *state.initialization.lock().unwrap() = server_link::parse_initialization(&format!(
            "orkbot://initialize?server=https%3A%2F%2Fserver.example.test&secret={}",
            "a".repeat(43)
        ));
        let logout = begin_accounts_logout(&state).unwrap();
        assert!(logout.is_current(&state));
        assert!(!state.accounts_have_started());
        assert!(state.pending_server.lock().unwrap().is_none());
        assert!(state.pending_bookmark.lock().unwrap().is_none());
        assert!(state.initialization.lock().unwrap().is_none());
        state.reset_accounts_started().unwrap();
        assert!(!logout.is_current(&state));
    }

    #[tokio::test]
    async fn product_logout_resets_only_bundled_setup_and_keeps_its_native_ipc_document_alive() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .manage(test_state(directory.path()))
            .build(app_context())
            .unwrap();
        let setup = WebviewWindowBuilder::new(&app, "setup", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        let origin = Url::parse("https://server.example.test/app").unwrap();
        let product =
            WebviewWindowBuilder::new(&app, "server-1", WebviewUrl::External(origin.clone()))
                .build()
                .unwrap();
        let state = app.state::<DesktopState>();
        state.setup_ready.store(true, Ordering::SeqCst);
        let proof = state.sessions.insert("server-1", &origin).unwrap();
        let document_id = "a".repeat(64);
        let (document, _) = state
            .sessions
            .authorize("server-1", &origin, &proof, &document_id, Some(1))
            .unwrap();
        *state.active_window.lock().unwrap() = Some("server-1".into());
        *state.setup.lock().unwrap() = Some(settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: origin.clone(),
            account: Some("a".repeat(64)),
            workspace: None,
        });
        let logout = begin_accounts_logout(&state).unwrap();
        reset_setup_after_product_logout(
            app.handle(),
            &logout,
            &document,
            Some(&"a".repeat(64)),
            Some(setup),
        )
        .await
        .unwrap();
        // MockRuntime does not notify AppManager of destruction; state records the reset attempt.
        assert!(!state.setup_ready.load(Ordering::SeqCst));
        assert!(app.get_webview_window(product.label()).is_some());
        assert!(state.sessions.is_current(&document));
        assert!(state
            .sessions
            .authorize("server-1", &origin, &proof, &document_id, None)
            .is_ok());
    }

    #[tokio::test]
    async fn late_product_logout_never_destroys_setup_for_a_newer_account() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .manage(test_state(directory.path()))
            .build(app_context())
            .unwrap();
        let setup = WebviewWindowBuilder::new(&app, "setup", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        let origin = Url::parse("https://server.example.test/app").unwrap();
        let state = app.state::<DesktopState>();
        state.setup_ready.store(true, Ordering::SeqCst);
        let proof = state.sessions.insert("server-1", &origin).unwrap();
        let (document, _) = state
            .sessions
            .authorize("server-1", &origin, &proof, &"a".repeat(64), Some(1))
            .unwrap();
        *state.active_window.lock().unwrap() = Some("server-1".into());
        *state.setup.lock().unwrap() = Some(settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: origin,
            account: Some("b".repeat(64)),
            workspace: None,
        });
        let logout = begin_accounts_logout(&state).unwrap();
        assert!(reset_setup_after_product_logout(
            app.handle(),
            &logout,
            &document,
            Some(&"a".repeat(64)),
            Some(setup.clone())
        )
        .await
        .is_err());
        assert!(state.setup_ready.load(Ordering::SeqCst));
        state.setup.lock().unwrap().as_mut().unwrap().account = Some("a".repeat(64));
        state.reset_accounts_started().unwrap();
        assert!(reset_setup_after_product_logout(
            app.handle(),
            &logout,
            &document,
            Some(&"a".repeat(64)),
            Some(setup)
        )
        .await
        .is_err());
        assert!(state.setup_ready.load(Ordering::SeqCst));
    }

    #[test]
    fn cold_start_never_restores_saved_servers_before_accounts_are_started() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        state.setup_ready.store(true, Ordering::SeqCst);
        *state.setup.lock().unwrap() = Some(settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: Url::parse("https://server.example.test").unwrap(),
            account: Some("a".repeat(64)),
            workspace: None,
        });
        assert!(!state.accounts_have_started());
        assert_eq!(state.startup.lock().unwrap().phase, "idle");
        assert_eq!(begin_restore(&state), None);
        assert!(!state.restoring.load(Ordering::SeqCst));
        state
            .accounts_started
            .lock()
            .unwrap()
            .complete(0, true)
            .unwrap();
        assert!(begin_restore(&state).is_some());
    }

    #[test]
    fn logout_fences_late_accounts_results_and_a_new_explicit_attempt_can_unlock_again() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        let first = state.accounts_started.lock().unwrap().generation;
        state.reset_accounts_started().unwrap();
        assert!(state
            .accounts_started
            .lock()
            .unwrap()
            .complete(first, true)
            .is_err());
        assert!(!state.accounts_have_started());
        let next = state.accounts_started.lock().unwrap().generation;
        state
            .accounts_started
            .lock()
            .unwrap()
            .complete(next, true)
            .unwrap();
        assert!(state.accounts_have_started());
        state.reset_accounts_started().unwrap();
        assert!(!state.accounts_have_started());
    }

    #[test]
    fn logout_during_cold_session_restore_cannot_unlock_automatic_startup() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        state.setup_ready.store(true, Ordering::SeqCst);
        let pending = state.accounts_started.lock().unwrap().generation;
        let logout = begin_accounts_logout(&state).unwrap();
        assert!(state
            .accounts_started
            .lock()
            .unwrap()
            .complete(pending, true)
            .is_err());
        assert!(logout.is_current(&state));
        assert_eq!(begin_restore(&state), None);
        assert!(!state.accounts_have_started());
    }

    #[test]
    fn absent_saved_session_does_not_enable_automatic_credential_access() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        state
            .accounts_started
            .lock()
            .unwrap()
            .complete(0, false)
            .unwrap();
        state.setup_ready.store(true, Ordering::SeqCst);
        assert!(!state.accounts_have_started());
        assert_eq!(begin_restore(&state), None);
    }

    #[test]
    fn startup_waits_for_the_bundled_document_and_deduplicates_restore_until_it_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        assert_eq!(begin_restore(&state), None);
        state.setup_ready.store(true, Ordering::SeqCst);
        state
            .accounts_started
            .lock()
            .unwrap()
            .complete(0, true)
            .unwrap();
        let intent = begin_restore(&state).unwrap();
        assert_eq!(begin_restore(&state), None);
        cancel_restore(&state);
        assert_ne!(state.restore_intent.load(Ordering::SeqCst), intent);
        assert_eq!(begin_restore(&state), None);
        state.restoring.store(false, Ordering::SeqCst);
        assert_eq!(begin_restore(&state), Some(intent + 1));
    }

    #[test]
    fn a_pending_external_link_prevents_automatic_default_server_restore() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        state.setup_ready.store(true, Ordering::SeqCst);
        state
            .accounts_started
            .lock()
            .unwrap()
            .complete(0, true)
            .unwrap();
        *state.pending_server.lock().unwrap() = Some("https://new.example.com".into());
        assert_eq!(begin_restore(&state), None);
        assert!(!state.restoring.load(Ordering::SeqCst));
    }

    #[test]
    fn a_reopen_between_the_warm_visibility_check_and_retirement_keeps_the_window() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        *state.active_window.lock().unwrap() = Some("server-1".into());
        let expiration = state.warm_generation.load(Ordering::Relaxed);
        // Reopen wins the active-window lock after the reaper's earlier visibility check.
        {
            let _active = state.active_window.lock().unwrap();
            state.warm_generation.fetch_add(1, Ordering::Relaxed);
        }
        assert!(!retire_warm_window(&state, "server-1", expiration));
        assert_eq!(
            state.active_window.lock().unwrap().as_deref(),
            Some("server-1")
        );
        assert!(retire_warm_window(&state, "server-1", expiration + 1));
        assert!(state.active_window.lock().unwrap().is_none());
    }

    #[test]
    fn startup_restores_only_a_current_accounts_directory_choice_for_the_same_identity() {
        let directory = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "subject-a");
        for (mode, kind, url) in [
            (
                settings::InstanceMode::Existing,
                server_directory::Kind::Selfhosted,
                "https://product.example.test",
            ),
            (
                settings::InstanceMode::New,
                server_directory::Kind::Local,
                "http://127.0.0.1:45173",
            ),
        ] {
            let choice = settings::Setup {
                mode,
                server_url: Url::parse(url).unwrap(),
                account: Some(settings::account_key(identity)),
                workspace: None,
            };
            settings::save(directory.path(), &choice).unwrap();
            let mut choice = settings::load(directory.path()).unwrap();
            let mut entries = vec![server_directory::Server {
                id: "11111111-1111-4111-8111-111111111111".into(),
                url: url.into(),
                kind,
                device_id: (kind == server_directory::Kind::Local).then(|| "this-device".into()),
            }];
            assert!(saved_server(&choice, identity, &entries).is_some());
            assert!(saved_server(&choice, (identity.0, "subject-b"), &entries).is_none());
            assert!(saved_server(
                &choice,
                ("https://other.example.test", identity.1),
                &entries
            )
            .is_none());
            assert!(saved_server(&choice, identity, &[]).is_none());
            entries[0].url = "https://different.example.test".into();
            assert!(saved_server(&choice, identity, &entries).is_none());
            entries[0].url = url.into();
            entries[0].kind = if kind == server_directory::Kind::Local {
                server_directory::Kind::Selfhosted
            } else {
                server_directory::Kind::Local
            };
            assert!(saved_server(&choice, identity, &entries).is_none());
            entries[0].kind = kind;
            choice.account = None;
            assert!(saved_server(&choice, identity, &entries).is_none());
        }
    }

    #[test]
    fn startup_uses_one_server_and_keeps_an_explicit_default_after_a_temporary_switch() {
        let identity = ("https://accounts.example.test", "subject-a");
        let first = server_directory::Server {
            id: "11111111-1111-4111-8111-111111111111".into(),
            url: "https://first.example.test".into(),
            kind: server_directory::Kind::Selfhosted,
            device_id: None,
        };
        let second = server_directory::Server {
            id: "22222222-2222-4222-8222-222222222222".into(),
            url: "https://second.example.test".into(),
            ..first.clone()
        };
        let entries = [first, second];
        assert_eq!(
            startup_server(None, None, identity, &entries[..1])
                .unwrap()
                .id,
            entries[0].id
        );
        assert!(startup_server(None, None, identity, &[]).is_none());
        assert!(startup_server(None, None, identity, &entries).is_none());
        let last_opened = settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: Url::parse(&entries[1].url).unwrap(),
            account: Some(settings::account_key(identity)),
            workspace: None,
        };
        let preference = server_directory::Preference {
            server_id: Some(entries[0].id.clone()),
        };
        assert_eq!(
            startup_server(Some(&preference), Some(&last_opened), identity, &entries)
                .unwrap()
                .id,
            entries[0].id
        );
        assert_eq!(
            startup_server(None, Some(&last_opened), identity, &entries)
                .unwrap()
                .id,
            entries[1].id
        );
        assert!(startup_server(
            None,
            Some(&last_opened),
            (identity.0, "other-subject"),
            &entries
        )
        .is_none());
        let ask = server_directory::Preference { server_id: None };
        assert!(startup_server(Some(&ask), Some(&last_opened), identity, &entries).is_none());
        assert_eq!(
            startup_server(Some(&ask), Some(&last_opened), identity, &entries[..1])
                .unwrap()
                .id,
            entries[0].id
        );
        let removed = server_directory::Preference {
            server_id: Some("33333333-3333-4333-8333-333333333333".into()),
        };
        assert!(startup_server(Some(&removed), Some(&last_opened), identity, &entries).is_none());
        assert_eq!(
            startup_server(Some(&removed), Some(&last_opened), identity, &entries[..1])
                .unwrap()
                .id,
            entries[0].id
        );
    }

    #[test]
    fn setup_commands_require_the_bundled_document_and_window() {
        for accepted in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            assert!(is_setup_document("setup", &Url::parse(accepted).unwrap()));
        }
        for rejected in [
            "https://orkbot.example.com/index.html",
            "http://localhost/index.html",
            "https://tauri.localhost/index.html",
            "tauri://localhost/other.html",
            "tauri://other/index.html",
            "http://tauri.localhost:8080/index.html",
            "tauri://localhost:123/index.html",
            "file:///index.html",
        ] {
            assert!(!is_setup_document("setup", &Url::parse(rejected).unwrap()));
        }
        assert!(!is_setup_document(
            "server-1",
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
    }

    #[test]
    fn runtime_authority_denies_remote_and_other_window_ipc() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .manage(test_state(directory.path()))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .invoke_handler(tauri::generate_handler![
                setup_state,
                local_stack_state,
                setup_accounts_session,
                list_servers,
                list_workspaces,
                workspace_catalog,
                set_default_organization,
                clear_workspace_link,
                check_workspace,
                set_default_server,
                create_server_installation,
                get_server_installation,
                server_initialization_required,
                create_server_pairing,
                get_server_pairing,
                approve_server_pairing,
                cancel_server_pairing,
                cancel_setup_connection,
                remove_server,
            ])
            .build(app_context())
            .unwrap();
        let setup = WebviewWindowBuilder::new(&app, "setup", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        assert!(
            is_setup_document("setup", &setup.url().unwrap()),
            "Unexpected setup URL: {:?}",
            setup.url()
        );
        let other =
            WebviewWindowBuilder::new(&app, "server-1", WebviewUrl::App("index.html".into()))
                .build()
                .unwrap();
        let local = if cfg!(windows) {
            "http://tauri.localhost/index.html"
        } else {
            "tauri://localhost/index.html"
        };
        let request = |command: &str, origin: &str| tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: origin.parse().unwrap(),
            body: if matches!(
                command,
                "server_initialization_required"
                    | "create_server_pairing"
                    | "get_server_pairing"
                    | "approve_server_pairing"
                    | "cancel_server_pairing"
            ) {
                tauri::ipc::InvokeBody::Json(
                    serde_json::json!({"requestId": "fixture-request", "origin": "https://server.example.test", "rawUrl": "https://server.example.test"}),
                )
            } else if command == "set_default_organization" {
                tauri::ipc::InvokeBody::Json(serde_json::json!({ "organizationId": null }))
            } else if command == "clear_workspace_link" {
                tauri::ipc::InvokeBody::Json(
                    serde_json::json!({ "target": { "organizationId": "00000000-0000-4000-8000-000000000001", "serverId": "00000000-0000-4000-8000-000000000001", "workspaceId": "00000000-0000-4000-8000-000000000001" } }),
                )
            } else {
                tauri::ipc::InvokeBody::default()
            },
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        };
        assert_eq!(
            tauri::test::get_ipc_response(&setup, request("server_initialization_required", local))
                .unwrap_err(),
            serde_json::json!("Sign in to Accounts first.")
        );
        assert_eq!(
            tauri::test::get_ipc_response(&setup, request("create_server_pairing", local))
                .unwrap_err(),
            serde_json::json!("Sign in to Accounts first.")
        );
        assert_eq!(
            tauri::test::get_ipc_response(&setup, request("get_server_pairing", local))
                .unwrap_err(),
            serde_json::json!("Sign in to Accounts first.")
        );
        tauri::test::assert_ipc_response(
            &setup,
            request("cancel_server_pairing", local),
            Ok(serde_json::Value::Null),
        );
        tauri::test::assert_ipc_response(
            &setup,
            request("cancel_setup_connection", local),
            Ok(serde_json::Value::Null),
        );
        tauri::test::assert_ipc_response(
            &setup,
            request("setup_state", local),
            Ok(
                serde_json::json!({"serverUrl": null, "mode": "existing", "startup": {"phase": "idle"}, "pendingServer": null}),
            ),
        );
        for command in ["workspace_catalog", "set_default_organization"] {
            let error = tauri::test::get_ipc_response(&setup, request(command, local)).unwrap_err();
            assert!(
                [
                    serde_json::json!("Sign in to Accounts first."),
                    serde_json::json!("Set ORK_ACCOUNTS_ISSUER before building the desktop app."),
                    serde_json::json!(
                        "Set ORK_ACCOUNTS_DESKTOP_CLIENT_ID before building the desktop app."
                    ),
                ]
                .contains(&error),
                "{error}"
            );
        }
        tauri::test::assert_ipc_response(
            &setup,
            request("clear_workspace_link", local),
            Ok(serde_json::Value::Null),
        );
        for (window, origin) in [
            (&setup, "https://orkbot.example.com"),
            (&other, local),
            (&other, "https://orkbot.example.com"),
        ] {
            for command in [
                "setup_accounts_session",
                "list_servers",
                "list_workspaces",
                "workspace_catalog",
                "set_default_organization",
                "clear_workspace_link",
                "check_workspace",
                "connect_workspace",
                "set_default_server",
                "create_server_installation",
                "get_server_installation",
                "server_initialization_required",
                "create_server_pairing",
                "get_server_pairing",
                "approve_server_pairing",
                "cancel_server_pairing",
                "cancel_setup_connection",
                "remove_server",
                "connect_saved_server",
                "setup_accounts_sign_in",
                "setup_accounts_logout",
                "clear_server_link",
            ] {
                assert!(tauri::test::get_ipc_response(window, request(command, origin)).is_err());
            }
            assert!(tauri::test::get_ipc_response(window, request("setup_state", origin)).is_err());
            assert!(
                tauri::test::get_ipc_response(window, request("local_stack_state", origin))
                    .is_err()
            );
            assert!(
                tauri::test::get_ipc_response(window, request("connect_local_server", origin))
                    .is_err()
            );
            assert!(
                tauri::test::get_ipc_response(window, request("plugin:updater|check", origin))
                    .is_err()
            );
        }
        assert!(
            tauri::test::get_ipc_response(&setup, request("plugin:updater|check", local)).is_err()
        );
    }
    #[test]
    fn adopting_another_account_clears_only_the_current_picker_and_preserves_owned_data_and_history(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        let identity = ("https://api.ork.run", "account-a");
        let target = server_directory::WorkspaceTarget {
            organization_id: "11111111-1111-4111-8111-111111111111".into(),
            server_id: "22222222-2222-4222-8222-222222222222".into(),
            workspace_id: "33333333-3333-4333-8333-333333333333".into(),
            binding_version: 1,
            key_fingerprint: "b".repeat(64),
        };
        let choice = settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: Url::parse("https://installation.example.test").unwrap(),
            account: Some(settings::account_key(identity)),
            workspace: Some(target.clone()),
        };
        settings::save(directory.path(), &choice).unwrap();
        *state.setup.lock().unwrap() = Some(choice.clone());
        server_directory::remember_workspace(directory.path(), identity, &target).unwrap();
        std::fs::write(
            directory.path().join("owned-data"),
            "keep this installation's data",
        )
        .unwrap();
        let account: accounts::Account = serde_json::from_value(serde_json::json!({
            "issuer":"https://api.ork.run", "subject":"account-b", "userinfo":{"sub":"account-b"}, "expiresAt":0,
        })).unwrap();
        assert!(adopt_setup_account(&state, &account, 1).is_err());
        assert!(state.setup.lock().unwrap().is_some());
        adopt_setup_account(&state, &account, 0).unwrap();
        assert!(state.setup.lock().unwrap().is_none());
        assert!(settings::load(directory.path()).is_none());
        assert_eq!(
            server_directory::workspace_history(
                directory.path(),
                identity,
                &target.organization_id
            )
            .unwrap(),
            Some(target)
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("owned-data")).unwrap(),
            "keep this installation's data"
        );
    }
}
