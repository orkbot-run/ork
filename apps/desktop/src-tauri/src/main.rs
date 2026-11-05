// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod browser_auth;
mod credentials;
mod document;
#[cfg(any(target_os = "macos", test))]
mod lifecycle;
mod local_stack;
mod locale;
mod menu;
mod native;
mod pairing;
mod passkeys;
mod profile;
mod server;
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
use tauri_plugin_opener::OpenerExt;
use url::Url;

struct DesktopState {
    directory: PathBuf,
    setup: Mutex<Option<settings::Setup>>,
    stack: local_stack::LocalStack,
    active_window: Mutex<Option<String>>,
    sequence: AtomicU64,
    switching: tokio::sync::Mutex<()>,
    sessions: native::Sessions,
    browser_auth: browser_auth::BrowserAuth,
    speech: speech::SpeechManager,
    pairings: pairing::Pairings,
    warm_generation: AtomicU64,
}

fn active_document(app: &tauri::AppHandle) -> Option<native::Document> {
    let state = app.try_state::<DesktopState>()?;
    let label = state.active_window.lock().ok()?.clone()?;
    state.sessions.current(&label)
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
        if let Some(document) = state.sessions.invalidate(label) {
            let owner = native::owner(label, &document);
            state.browser_auth.cancel_owner(&owner);
            state.speech.cancel_owner(&owner);
        }
    }
    auth::close_popup(app, label);
}

pub(crate) fn shutdown_native(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.stack.abort();
        state.browser_auth.cancel_all();
        state.speech.shutdown();
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
        auth::close_popup(&app, window.label());
    }
    let active = state
        .active_window
        .lock()
        .map_err(|_| "Desktop state unavailable.")?
        .as_deref()
        == Some(window.label());
    if !active && !command.read_only() {
        return Err("This desktop window is not active.".into());
    }
    let owner = document.owner();
    let unit = serde_json::Value::Null;
    match command {
        Command::Hello { .. } => Ok(unit),
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
            let cookie_window = window.clone();
            let cookie_url = origin
                .join("/api/auth/get-session")
                .map_err(|_| "Invalid server.")?;
            // WebView2 cookie access must run outside the UI thread. Cookies stay native.
            let cookies = tokio::task::spawn_blocking(move || {
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
            .map_err(|_| "Could not read the server session.")?;
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupState {
    server_url: Option<String>,
    mode: settings::InstanceMode,
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
    let _switch = state
        .switching
        .try_lock()
        .map_err(|_| "A connection is already in progress.")?;
    let target = server::normalize_server_url(&raw_url)?;
    server::probe_server(&target).await?;
    open_server(
        &window,
        &app,
        &state,
        settings::Setup {
            mode: settings::InstanceMode::Existing,
            server_url: target,
        },
    )
    .await
}

#[tauri::command]
fn local_stack_state<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    state: State<DesktopState>,
) -> Result<local_stack::LocalStackState, String> {
    require_setup(&window)?;
    Ok(state.stack.state())
}

#[tauri::command]
async fn connect_local_server(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    require_setup(&window)?;
    let _switch = state
        .switching
        .try_lock()
        .map_err(|_| "A connection is already in progress.")?;
    let result = state.stack.start().await;
    require_setup(&window)?;
    if result.phase != local_stack::LocalStackPhase::Ready
        || !state.stack.matches_desired_stack().await
    {
        return Err(result
            .message
            .unwrap_or_else(|| "Could not start the local server.".into()));
    }
    open_server(
        &window,
        &app,
        &state,
        settings::Setup {
            mode: settings::InstanceMode::New,
            server_url: state.stack.web_url(),
        },
    )
    .await
}

async fn open_server(
    window: &WebviewWindow,
    app: &tauri::AppHandle,
    state: &DesktopState,
    choice: settings::Setup,
) -> Result<(), String> {
    require_setup(window)?;
    let target = choice.server_url.clone();
    let label = format!("server-{}", state.sequence.fetch_add(1, Ordering::Relaxed));
    let origin = target.origin();
    let popup_app = app.clone();
    let popup_parent = label.clone();
    let popup_origin = target.clone();
    let proof = state.sessions.insert(&label, &target)?;
    if native::grant(app, &label, &target).is_err() {
        state.sessions.remove(&label);
        return Err("Could not secure the desktop window.".into());
    }
    let navigation_target = target.clone();
    let builder = profile::configure(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(target.clone())),
        &state.directory,
        &target,
    );
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0));
    let next = builder
        .title("Ork Preview")
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(auth::initialization_script(&target))
        .initialization_script(native::initialization_script(
            &label,
            &target,
            &proof,
            state.speech.available(),
        ))
        // WebKit navigation policy callbacks include subframes. Their loads must
        // not retire the main document or open an artifact in the system browser.
        .on_navigation(|url| match url.scheme() {
            "http" | "https" => url.username().is_empty() && url.password().is_none(),
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
            state.sessions.remove(&label);
            return Err("Could not open that server.".into());
        }
    };

    if let Err(error) = document::wait_for_document(&next, Duration::from_secs(20))
        .await
        .and_then(|()| require_setup(window))
    {
        cancel_native_document(app, &label);
        state.sessions.remove(&label);
        let _ = next.destroy();
        return Err(error);
    }
    if let Err(error) = settings::save(&state.directory, &choice) {
        cancel_native_document(app, &label);
        state.sessions.remove(&label);
        let _ = next.destroy();
        return Err(error);
    }
    if next.show().is_err() {
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
        let _ = next.destroy();
        return Err(if restored.is_ok() {
            "Could not show that server.".into()
        } else {
            "Could not show that server or restore the previous choice.".into()
        });
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
    // The page may have requested pairing while it was still an inactive candidate.
    if let Some(document) = state.sessions.current(&label) {
        send_native_event(app, &document, "pairing", ());
    }
    window.hide().map_err(|_| "Could not hide setup")?;
    let _ = refresh_menu(app);
    Ok(())
}

#[tauri::command]
fn quit_setup(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_setup(&window)?;
    app.exit(0);
    Ok(())
}

fn show_setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("setup") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    } else {
        WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
            .title("Ork Preview")
            .inner_size(580.0, 520.0)
            .resizable(false)
            .on_navigation(|url| is_setup_document("setup", url))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()?;
    }
    Ok(())
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
            ..Default::default()
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

fn show_active_or_setup(app: &tauri::AppHandle) {
    let active = app.try_state::<DesktopState>().and_then(|state| {
        state.warm_generation.fetch_add(1, Ordering::Relaxed);
        state
            .active_window
            .lock()
            .ok()?
            .as_ref()
            .and_then(|label| app.get_webview_window(label))
    });
    if let Some(window) = active {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let _ = show_setup(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<DesktopState>();
        let Ok(_switch) = state.switching.try_lock() else {
            return;
        };
        let choice = state.setup.lock().ok().and_then(|choice| choice.clone());
        let Some(choice) = choice else {
            return;
        };
        let Some(setup) = app.get_webview_window("setup") else {
            return;
        };
        let result = async {
            if choice.mode == settings::InstanceMode::New {
                let stack = state.stack.start().await;
                if stack.phase != local_stack::LocalStackPhase::Ready
                    || !state.stack.matches_desired_stack().await
                {
                    return Err(stack
                        .message
                        .unwrap_or_else(|| "Could not start the local server.".into()));
                }
            } else {
                server::probe_server(&choice.server_url).await?;
            }
            open_server(&setup, &app, &state, choice).await
        }
        .await;
        if let Err(message) = result {
            let _ = setup.emit("desktop-reopen-failed", message);
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
            let _ = show_setup(app);
        }
        MenuAction::StopLocalServer => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.state::<DesktopState>().stack.stop().await;
            });
        }
        MenuAction::CheckForUpdates => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                updates::check(app).await;
            });
        }
        MenuAction::Quit => app.exit(0),
        MenuAction::ComputerAccess | MenuAction::RevokeComputerAccess => {}
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let setup = app
                .get_webview_window("setup")
                .filter(|window| window.is_visible().unwrap_or(false));
            if let Some(window) = setup {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            } else {
                show_active_or_setup(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            setup_state,
            connect_server,
            connect_local_server,
            local_stack_state,
            quit_setup,
            native_command
        ])
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?;
            let resources = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../infra/compose")
            } else {
                app.path().resource_dir()?.join("stack")
            };
            let callback_app = app.handle().clone();
            let stack = local_stack::LocalStack::new(
                directory.join("stack"),
                resources,
                local_stack::image_tag(
                    &app.package_info().version.to_string(),
                    !cfg!(debug_assertions),
                ),
                Some(Arc::new(move |state| {
                    if let Some(window) = callback_app.get_webview_window("setup") {
                        let _ = window.emit("desktop-stack-changed", state);
                    }
                })),
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
                stack,
                directory,
                active_window: Mutex::new(None),
                sequence: AtomicU64::new(1),
                switching: tokio::sync::Mutex::new(()),
                sessions: native::Sessions::default(),
                browser_auth,
                speech: speech::SpeechManager::new(speech_helper),
                pairings: pairing::Pairings::default(),
                warm_generation: AtomicU64::new(0),
            });
            app.manage(updates::UpdateCheck::default());
            updates::start_background(app.handle().clone());
            refresh_menu(app.handle())?;
            show_setup(app.handle())?;
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
                            let mut active = state
                                .active_window
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            if active.as_deref() != Some(&label) {
                                return;
                            }
                            *active = None;
                            drop(active);
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
        .expect("could not build Ork Preview")
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
            .manage(DesktopState {
                directory: directory.path().to_owned(),
                setup: Mutex::new(None),
                stack: local_stack::LocalStack::new(
                    directory.path().join("stack"),
                    directory.path().join("resources"),
                    "edge".into(),
                    None,
                ),
                active_window: Mutex::new(None),
                sequence: AtomicU64::new(1),
                switching: tokio::sync::Mutex::new(()),
                sessions: native::Sessions::default(),
                browser_auth: browser_auth::BrowserAuth::new(Arc::new(|_, _| {})),
                speech: speech::SpeechManager::new(PathBuf::new()),
                pairings: pairing::Pairings::default(),
                warm_generation: AtomicU64::new(0),
            })
            .plugin(tauri_plugin_updater::Builder::new().build())
            .invoke_handler(tauri::generate_handler![setup_state, local_stack_state])
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
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        };
        tauri::test::assert_ipc_response(
            &setup,
            request("setup_state", local),
            Ok(serde_json::json!({"serverUrl": null, "mode": "existing"})),
        );
        for (window, origin) in [
            (&setup, "https://orkbot.example.com"),
            (&other, local),
            (&other, "https://orkbot.example.com"),
        ] {
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
}
