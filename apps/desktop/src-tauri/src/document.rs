// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited Apache-2.0 desktop document readiness check.
// New Rust transport and deadline handling follow LICENSE.md.

use std::{sync::Mutex, time::Duration};

use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};
use tokio::{
    sync::{oneshot, watch},
    time::{sleep_until, timeout_at, Instant},
};

const DOCUMENT_SCRIPT: &str = include_str!("../../build/tauri-ui/app-document-script.js");
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const CLOSED: &str = "The window closed before the app loaded.";
const TIMED_OUT: &str = "The app did not finish loading. Try connecting again.";

fn is_mounted_document(answer: &str) -> bool {
    serde_json::from_str::<String>(answer)
        .is_ok_and(|state| matches!(state.as_str(), "ready" | "failed"))
}

/// Wait for the shared renderer readiness check without exposing native IPC to the page.
pub async fn wait_for_document<R: Runtime>(
    window: &WebviewWindow<R>,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let (closed_sender, mut closed) = watch::channel(false);
    let _closed_guard = closed_sender.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = closed_sender.send(true);
        }
    });

    loop {
        if *closed.borrow()
            || window
                .app_handle()
                .get_webview_window(window.label())
                .is_none()
        {
            return Err(CLOSED.into());
        }
        if Instant::now() >= deadline {
            return Err(TIMED_OUT.into());
        }

        let (sender, answer) = oneshot::channel();
        // Tauri accepts an Fn callback, so a late or repeated answer can consume the sender only once.
        let sender = Mutex::new(Some(sender));
        let evaluation = window.eval_with_callback(DOCUMENT_SCRIPT, move |result| {
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
            }
        });

        if evaluation.is_ok() {
            let answer = tokio::select! {
                _ = closed.changed() => return Err(CLOSED.into()),
                answer = timeout_at(deadline, answer) => {
                    answer.map_err(|_| TIMED_OUT.to_owned())?.ok()
                }
            };
            if answer.as_deref().is_some_and(is_mounted_document) {
                if *closed.borrow()
                    || window
                        .app_handle()
                        .get_webview_window(window.label())
                        .is_none()
                {
                    return Err(CLOSED.into());
                }
                // Preserve the web app's last-resort error screen and its Refresh action.
                return Ok(());
            }
        }

        // Reloads may dispose the evaluated frame. Retry without extending the original deadline.
        tokio::select! {
            _ = closed.changed() => return Err(CLOSED.into()),
            _ = sleep_until(deadline.min(Instant::now() + POLL_INTERVAL)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_finished_states_as_serialized_by_tauri() {
        for answer in [r#""ready""#, r#""failed""#] {
            assert!(is_mounted_document(answer), "{answer}");
        }
        for answer in [
            r#""pending""#,
            r#""Ready""#,
            r#"" ready""#,
            "ready",
            "failed",
            "null",
            "true",
            "{}",
            "[]",
            r#"{"state":"ready"}"#,
        ] {
            assert!(!is_mounted_document(answer), "{answer}");
        }
    }

    #[tokio::test]
    async fn missing_mock_runtime_callback_still_ends_at_the_deadline() {
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "document",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let timeout = Duration::from_millis(20);
        let started = Instant::now();
        // MockRuntime records eval_with_callback but drops its callback without an answer.
        assert_eq!(
            wait_for_document(&window, timeout).await,
            Err(TIMED_OUT.into())
        );
        assert!(started.elapsed() >= timeout);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
