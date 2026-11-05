// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

/// Advertise native SSO popups without exposing the desktop command bridge.
pub fn initialization_script(origin: &Url) -> String {
    let origin = serde_json::to_string(&origin.origin().ascii_serialization())
        .expect("a server origin can be serialized");
    format!(
        r#"(() => {{
  if (window.top !== window || window.location.origin !== {origin}) return;
  if (Object.prototype.hasOwnProperty.call(window, "orkbotNativeAuth")) return;
  Object.defineProperty(window, "orkbotNativeAuth", {{
    value: Object.freeze({{ ssoPopup: true }}),
    writable: false,
    configurable: false
  }});
}})();"#
    )
}

fn popup_label(parent: &str) -> String {
    format!("auth-{parent}")
}

fn safe_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn entry_allowed(origin: &Url, target: &Url) -> bool {
    target.as_str() == "about:blank" || (safe_http(target) && target.origin() == origin.origin())
}

fn navigation_allowed(origin: &Url, target: &Url) -> bool {
    target.as_str() == "about:blank"
        || (safe_http(target) && (target.scheme() == "https" || target.origin() == origin.origin()))
}

#[cfg(target_os = "macos")]
fn isolate_popup_scripts(features: &NewWindowFeatures) -> bool {
    let Some(main_thread) = objc2::MainThreadMarker::new() else {
        return false;
    };
    // WebKit requires this exact target configuration, including its data store
    // and process pool. Replace only the shared script controller so Wry installs
    // the child's own initialization scripts and IPC handler.
    // SAFETY: The thread marker verifies the main thread required by WebKit. The
    // typed setter retains the fresh controller for the supplied configuration.
    unsafe {
        let controller = objc2_web_kit::WKUserContentController::new(main_thread);
        features
            .opener()
            .target_configuration
            .setUserContentController(&controller);
    }
    true
}

/// Create a related, unprivileged popup using the opener's native session.
pub fn open_popup(
    app: &AppHandle,
    parent: &str,
    origin: &Url,
    target: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    if !entry_allowed(origin, &target) {
        return NewWindowResponse::Deny;
    }
    let Some(parent_window) = app.get_webview_window(parent) else {
        return NewWindowResponse::Deny;
    };
    if parent_window.url().ok().map(|url| url.origin()) != Some(origin.origin()) {
        return NewWindowResponse::Deny;
    }
    let label = popup_label(parent);
    if app.get_webview_window(&label).is_some() {
        return NewWindowResponse::Deny;
    }
    #[cfg(target_os = "macos")]
    if !isolate_popup_scripts(&features) {
        return NewWindowResponse::Deny;
    }

    let origin = origin.clone();
    let popup = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(Url::parse("about:blank").expect("a blank URL is valid")),
    )
    // This preserves WKWebView's target configuration, WebView2's environment,
    // and WebKitGTK's related view. A new independent profile would lose SSO cookies.
    .window_features(features)
    .title("Ork")
    .inner_size(560.0, 720.0)
    .disable_drag_drop_handler()
    .on_navigation(move |url| navigation_allowed(&origin, url))
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .build();
    match popup {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

/// End the parent's authorization window when that server is left or closed.
pub fn close_popup(app: &AppHandle, parent: &str) {
    if let Some(window) = app.get_webview_window(&popup_label(parent)) {
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_popups_start_only_blank_or_on_the_selected_server() {
        let origin = Url::parse("http://localhost:45173").unwrap();
        for allowed in ["about:blank", "http://localhost:45173/auth"] {
            assert!(entry_allowed(&origin, &Url::parse(allowed).unwrap()));
        }
        for denied in [
            "about:blank#other",
            "https://identity.example.com/authorize",
            "http://localhost:45174/auth",
            "http://user:secret@localhost:45173/auth",
            "file:///tmp/auth.html",
            "tauri://localhost/index.html",
            "javascript:alert(1)",
            "data:text/html,auth",
        ] {
            assert!(
                !entry_allowed(&origin, &Url::parse(denied).unwrap()),
                "{denied}"
            );
        }
    }

    #[test]
    fn popup_navigation_keeps_plain_http_on_the_selected_origin() {
        let origin = Url::parse("http://localhost:45173").unwrap();
        for allowed in [
            "about:blank",
            "https://identity.example.com/authorize",
            "https://login.example.net/step",
            "http://localhost:45173/api/auth/callback/oidc?code=example",
        ] {
            assert!(
                navigation_allowed(&origin, &Url::parse(allowed).unwrap()),
                "{allowed}"
            );
        }
        for denied in [
            "http://identity.example.com/authorize",
            "http://localhost:45174/callback",
            "https://user:secret@identity.example.com/authorize",
            "https://user@identity.example.com/authorize",
            "about:blank#other",
            "file:///tmp/auth.html",
            "tauri://localhost/index.html",
            "javascript:alert(1)",
            "data:text/html,auth",
        ] {
            assert!(
                !navigation_allowed(&origin, &Url::parse(denied).unwrap()),
                "{denied}"
            );
        }
    }

    #[test]
    fn popup_labels_belong_to_one_parent() {
        assert_eq!(popup_label("server-1"), "auth-server-1");
        assert_ne!(popup_label("server-1"), popup_label("server-2"));
    }
}
