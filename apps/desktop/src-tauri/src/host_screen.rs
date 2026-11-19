// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! App-scoped OS screen driver. No shell interpolation and no desktop-wide fallback.
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
};

#[derive(Clone)]
pub struct HostScreen {
    helper: Option<std::path::PathBuf>,
    gate: Arc<Semaphore>,
}

impl HostScreen {
    pub fn prepare(directory: &Path) -> Result<Self, String> {
        let helper = if cfg!(any(target_os = "macos", windows)) {
            crate::local_stack::private_directory(directory)?;
            #[cfg(target_os = "macos")]
            let bytes: &[u8] = include_bytes!(env!("ORK_HOST_SCREEN_HELPER"));
            #[cfg(windows)]
            let bytes: &[u8] = include_bytes!("../native/host-screen.ps1");
            #[cfg(not(any(target_os = "macos", windows)))]
            let bytes: &[u8] = &[];
            let path = directory.join(if cfg!(windows) {
                "host-screen.ps1"
            } else {
                "host-screen"
            });
            crate::local_stack::write_private(&path, bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Could not prepare local screen control.")?;
            }
            Some(path)
        } else {
            None
        };
        Ok(Self {
            helper,
            gate: Arc::new(Semaphore::new(1)),
        })
    }

    /// This is the only call that may request OS permissions, after explicit native consent.
    pub async fn request_permissions(&self) -> Result<bool, String> {
        Ok(self.request(json!({"method":"permissions"})).await?["screen"] == true)
    }

    pub async fn request(&self, request: Value) -> Result<Value, String> {
        let helper = self
            .helper
            .as_ref()
            .ok_or("Screen control is not available on this computer.")?;
        let _permit = self
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Local screen control is busy.")?;
        let mut command = if cfg!(windows) {
            let mut command = tokio::process::Command::new("powershell.exe");
            command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(helper);
            command
        } else {
            tokio::process::Command::new(helper)
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "Local screen control could not start.")?;
        let mut input = child
            .stdin
            .take()
            .ok_or("Local screen control could not start.")?;
        let bytes = serde_json::to_vec(&request).map_err(|_| "Invalid screen request.")?;
        input
            .write_all(&bytes)
            .await
            .map_err(|_| "Local screen control disconnected.")?;
        drop(input);
        let output = child
            .stdout
            .take()
            .ok_or("Local screen control could not start.")?;
        let mut bytes = Vec::new();
        output
            .take(12 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Local screen control disconnected.")?;
        if bytes.len() > 12 * 1024 * 1024 {
            return Err("Local screen response is too large.".into());
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "Local screen control disconnected.")?;
        if !status.success() {
            return Err(
                "Local screen control disconnected. Check the result before retrying.".into(),
            );
        }
        let result: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Local screen control returned an invalid response.")?;
        if result["completed"].as_u64().is_none() {
            if let Some(error) = result["error"].as_str() {
                return Err(error.chars().take(500).collect());
            }
        }
        Ok(result)
    }
}

pub fn valid_request(app: Option<&str>, actions: Option<&[Value]>, act: bool) -> bool {
    if !app.is_some_and(|name| !name.trim().is_empty() && name.len() <= 200 && !name.contains('\0'))
    {
        return false;
    }
    if !act {
        return true;
    }
    actions.is_some_and(|actions| {
        !actions.is_empty()
            && actions.len() <= 24
            && actions.iter().all(|action| {
                let point = || {
                    ["x", "y"].iter().all(|key| {
                        action[*key]
                            .as_f64()
                            .is_some_and(|n| n.is_finite() && (0.0..=20_000.0).contains(&n))
                    })
                };
                match action["kind"].as_str() {
                    Some("click" | "move") => point() && action.get("element").is_none(),
                    Some("type") => {
                        action["text"].as_str().is_some_and(|v| v.len() <= 40_000)
                            && action.get("element").is_none()
                    }
                    Some("key") => {
                        action["key"]
                            .as_str()
                            .is_some_and(|v| !v.is_empty() && v.len() <= 32)
                            && action.get("element").is_none()
                            && action.get("modifiers").is_none_or(|v| {
                                v.as_array().is_some_and(|a| {
                                    a.len() <= 4
                                        && a.iter().all(|v| {
                                            matches!(
                                                v.as_str(),
                                                Some("cmd" | "shift" | "option" | "ctrl")
                                            )
                                        })
                                })
                            })
                    }
                    Some("scroll") => {
                        matches!(
                            action["direction"].as_str(),
                            Some("up" | "down" | "left" | "right")
                        ) && action
                            .get("amount")
                            .is_none_or(|v| v.as_u64().is_some_and(|v| (1..=20).contains(&v)))
                            && (action.get("x").is_none() && action.get("y").is_none() || point())
                            && action.get("element").is_none()
                    }
                    Some("wait") => action["ms"].as_u64().is_some_and(|ms| ms <= 5000),
                    _ => false,
                }
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_missing_native_bridge_fails_closed() {
        let screen = HostScreen {
            helper: None,
            gate: Arc::new(Semaphore::new(1)),
        };
        assert!(screen
            .request(json!({"method":"capabilities"}))
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_native_requests_kill_the_helper_process() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("helper");
        let pid_file = directory.path().join("pid");
        // The helper itself owns its work; it never starts a shell to interpret request data.
        std::fs::write(
            &helper,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n",
                pid_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let screen = HostScreen {
            helper: Some(helper),
            gate: Arc::new(Semaphore::new(1)),
        };
        let task = tokio::spawn(async move {
            screen
                .request(json!({"method":"screenObserve","app":"fixture"}))
                .await
        });
        let pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = pid.trim().parse::<i32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled helper must stop");
    }

    #[test]
    fn screen_targets_and_actions_are_validated_before_native_dispatch() {
        assert!(!valid_request(None, None, false));
        assert!(!valid_request(Some(""), None, false));
        assert!(valid_request(Some("TextEdit"), None, false));
        for action in [
            json!({"kind":"click","x":4,"y":8}),
            json!({"kind":"move","x":0,"y":0}),
            json!({"kind":"type","text":"hello"}),
            json!({"kind":"scroll","direction":"down"}),
            json!({"kind":"key","key":"enter"}),
        ] {
            assert!(valid_request(Some("TextEdit"), Some(&[action]), true));
        }
        for action in [
            json!({"kind":"click","x":-1,"y":0}),
            json!({"kind":"type","text":"hi","element":0}),
            json!({"kind":"launch","application":"other"}),
            json!({"kind":"key","key":"a","modifiers":["hyper"]}),
        ] {
            assert!(!valid_request(Some("TextEdit"), Some(&[action]), true));
        }
        assert!(!valid_request(Some("TextEdit"), Some(&[]), true));
    }
}
