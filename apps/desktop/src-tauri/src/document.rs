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
const FLUSH_FAILED: &str = "Could not save the selected files. Remove a file or try again.";
const FLUSH_SCRIPT: &str = r#"(() => {
  if (typeof window.orkbotFlushComposerDrafts !== 'function') return required ? 'failed' : 'ready';
  if (!window.__orkbotDraftFlush) {
    const attempt = { state: 'pending' };
    window.__orkbotDraftFlush = attempt;
    Promise.resolve().then(() => window.orkbotFlushComposerDrafts()).then(
      () => { attempt.state = 'ready'; }, () => { attempt.state = 'failed'; }
    );
  }
  return window.__orkbotDraftFlush.state;
})()"#;
const RESUME_SCRIPT: &str =
    "window.orkbotResumeComposerDrafts?.(); delete window.__orkbotDraftFlush;";

pub struct FlushedDrafts<R: Runtime>(WebviewWindow<R>);
impl<R: Runtime> Drop for FlushedDrafts<R> {
    fn drop(&mut self) {
        // A failed candidate leaves the previous editor usable. A destroyed window ignores this.
        let _ = self.0.eval(RESUME_SCRIPT);
    }
}

/// Only completion status crosses this bounded callback; file bytes remain in the webview profile.
pub async fn flush_drafts<R: Runtime>(
    window: &WebviewWindow<R>,
    timeout: Duration,
    required: bool,
    current: impl Fn() -> bool,
) -> Result<FlushedDrafts<R>, String> {
    let script = format!("(() => {{ const required = {required}; return {FLUSH_SCRIPT}; }})()");
    if let Err(error) = wait_for_state(window, timeout, &script, false, current).await {
        let _ = window.eval(RESUME_SCRIPT);
        return Err(error);
    }
    Ok(FlushedDrafts(window.clone()))
}

fn is_mounted_document(answer: &str) -> bool {
    serde_json::from_str::<String>(answer)
        .is_ok_and(|state| matches!(state.as_str(), "ready" | "failed"))
}

/// Wait for the shared renderer readiness check without exposing native IPC to the page.
pub async fn wait_for_document<R: Runtime>(
    window: &WebviewWindow<R>,
    timeout: Duration,
) -> Result<(), String> {
    wait_for_state(window, timeout, DOCUMENT_SCRIPT, true, || true).await
}

async fn wait_for_state<R: Runtime>(
    window: &WebviewWindow<R>,
    timeout: Duration,
    script: &str,
    allow_failed: bool,
    current: impl Fn() -> bool,
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
        if !current() {
            return Err("This connection is no longer active.".into());
        }
        if *closed.borrow()
            || window
                .app_handle()
                .get_webview_window(window.label())
                .is_none()
        {
            return Err(CLOSED.into());
        }
        if Instant::now() >= deadline {
            return Err(if allow_failed {
                TIMED_OUT
            } else {
                FLUSH_FAILED
            }
            .into());
        }

        let (sender, answer) = oneshot::channel();
        // Tauri accepts an Fn callback, so a late or repeated answer can consume the sender only once.
        let sender = Mutex::new(Some(sender));
        let evaluation = window.eval_with_callback(script, move |result| {
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
                    answer.map_err(|_| if allow_failed { TIMED_OUT } else { FLUSH_FAILED }.to_owned())?.ok()
                }
            };
            if answer.as_deref().is_some_and(is_mounted_document) {
                if !current() {
                    return Err("This connection is no longer active.".into());
                }
                if !allow_failed && answer.as_deref() != Some(r#""ready""#) {
                    return Err(FLUSH_FAILED.into());
                }
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

    #[tokio::test]
    async fn draft_flush_timeout_keeps_the_previous_window_available() {
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "previous",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let started = Instant::now();
        assert!(matches!(
            flush_drafts(&window, Duration::from_millis(20), true, || true).await,
            Err(error) if error == FLUSH_FAILED
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(app.get_webview_window("previous").is_some());
    }

    #[tokio::test]
    async fn document_replacement_retires_a_pending_flush_without_closing_the_window() {
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "previous",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let sessions = crate::native::Sessions::default();
        let origin = url::Url::parse("https://installation.example.test").unwrap();
        let proof = sessions.insert("previous", &origin).unwrap();
        let old = sessions
            .authorize("previous", &origin, &proof, &"a".repeat(64), Some(1))
            .unwrap()
            .0;
        let (result, ()) = tokio::join!(
            flush_drafts(&window, Duration::from_secs(1), true, || sessions
                .is_current(&old)),
            async {
                tokio::time::sleep(Duration::from_millis(5)).await;
                sessions
                    .authorize("previous", &origin, &proof, &"b".repeat(64), Some(2))
                    .unwrap();
            },
        );
        assert!(matches!(result, Err(error) if error == "This connection is no longer active."));
        assert!(app.get_webview_window("previous").is_some());
    }
}
