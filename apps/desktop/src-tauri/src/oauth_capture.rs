// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

use crate::browser_auth::OAuthCallback;

const DENIED: &str = "Could not complete integration sign-in.";

struct Attempt {
    authorization: Url,
    redirect: Url,
    state: String,
}

fn parameters(url: &Url) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(DENIED.into());
        }
    }
    Ok(values)
}

fn safe(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

impl Attempt {
    fn parse(input: &str, expected_state: &str) -> Result<Self, String> {
        if input.len() > 16_384 || !(16..=256).contains(&expected_state.len()) {
            return Err(DENIED.into());
        }
        let authorization = Url::parse(input).map_err(|_| DENIED)?;
        if !safe(&authorization) || authorization.scheme() != "https" {
            return Err(DENIED.into());
        }
        let values = parameters(&authorization)?;
        if values.get("state").map(String::as_str) != Some(expected_state) {
            return Err(DENIED.into());
        }
        let redirect = Url::parse(values.get("redirect_uri").ok_or(DENIED)?).map_err(|_| DENIED)?;
        if !safe(&redirect)
            || redirect.path() != "/mcp/oauth/callback"
            || redirect.query().is_some()
        {
            return Err(DENIED.into());
        }
        Ok(Self {
            authorization,
            redirect,
            state: expected_state.into(),
        })
    }

    fn is_callback(&self, url: &Url) -> bool {
        url.origin() == self.redirect.origin() && url.path() == self.redirect.path()
    }

    fn callback(&self, url: &Url) -> Result<OAuthCallback, String> {
        if !safe(url) || !self.is_callback(url) || url.as_str().len() > 16_384 {
            return Err(DENIED.into());
        }
        let values = parameters(url)?;
        if values.get("state") != Some(&self.state) || values.contains_key("error") {
            return Err(DENIED.into());
        }
        let code = values
            .get("code")
            .filter(|code| !code.is_empty() && code.len() <= 8192)
            .ok_or(DENIED)?;
        Ok(OAuthCallback {
            code: code.clone(),
            state: self.state.clone(),
            iss: values.get("iss").cloned(),
        })
    }
}

struct Popup(WebviewWindow);
impl Drop for Popup {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}

/// Capture the registered callback before loading it, without product cookies or IPC in the popup.
pub async fn capture(
    app: &AppHandle,
    parent: &str,
    input: &str,
    state: &str,
) -> Result<OAuthCallback, String> {
    let attempt = Attempt::parse(input, state)?;
    let label = format!("auth-{parent}");
    if app.get_webview_window(&label).is_some() {
        return Err(DENIED.into());
    }
    let initial = attempt.authorization.clone();
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let closed = sender.clone();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(initial))
        .title("Ork")
        .inner_size(560.0, 720.0)
        .incognito(true)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if attempt.is_callback(url) {
                if let Some(sender) = sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let _ = sender.send(attempt.callback(url));
                }
                return false;
            }
            safe(url) && url.scheme() == "https"
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| DENIED)?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(sender) = closed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                let _ = sender.send(Err(DENIED.into()));
            }
        }
    });
    let _popup = Popup(window);
    tokio::time::timeout(Duration::from_secs(120), receiver)
        .await
        .map_err(|_| DENIED)?
        .map_err(|_| DENIED)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn random_state() -> String {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).unwrap();
        bytes.iter().map(|value| format!("{value:02x}")).collect()
    }

    fn authorization(redirect: &str, state: &str) -> String {
        let mut url = Url::parse("https://identity.example.test/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("state", state)
            .append_pair("redirect_uri", redirect);
        url.into()
    }

    #[test]
    fn callback_requires_the_exact_registered_origin_path_and_unique_matching_state() {
        let state = random_state();
        let redirect = "http://127.0.0.1:5173/mcp/oauth/callback";
        let attempt = Attempt::parse(&authorization(redirect, &state), &state).unwrap();
        let mut callback = Url::parse(redirect).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("code", "provider-code");
        assert_eq!(attempt.callback(&callback).unwrap().code, "provider-code");
        for other in [
            format!("{callback}&code=second"),
            format!("{callback}&state={state}"),
            format!("{callback}&error=denied"),
            format!("{callback}#fragment"),
            callback.as_str().replace("5173", "5174"),
            callback.as_str().replace("/callback", "/callback/"),
            callback.as_str().replace(&state, &random_state()),
            callback.as_str().replace("127.0.0.1", "user@127.0.0.1"),
        ] {
            assert!(attempt.callback(&Url::parse(&other).unwrap()).is_err());
        }
    }

    #[test]
    fn authorization_cannot_change_the_attempt_or_capture_other_callback_routes() {
        let state = random_state();
        for redirect in [
            "https://server.example.test/callback",
            "file:///mcp/oauth/callback",
            "https://user@server.example.test/mcp/oauth/callback",
            "https://server.example.test/mcp/oauth/callback?x=1",
        ] {
            assert!(Attempt::parse(&authorization(redirect, &state), &state).is_err());
        }
        let input = authorization("https://server.example.test/mcp/oauth/callback", &state);
        assert!(Attempt::parse(
            &input.replace("https://identity", "http://identity"),
            &state
        )
        .is_err());
        assert!(Attempt::parse(&input, &random_state()).is_err());
        assert!(Attempt::parse(&format!("{input}&state={state}"), &state).is_err());
    }
}
