// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use crate::{
    current_server_account, document_workspace, installation_ticket, native,
    retry_installation_revocations, server_directory, server_login, settings, DesktopState,
};

/// Native authentication never hands the Accounts bearer or completed installation token to IPC.
pub async fn sign_in(
    app: &tauri::AppHandle,
    state: &DesktopState,
    document: &native::Document,
) -> Result<serde_json::Value, String> {
    let _login = state.transport.begin_login(&document.label, &document.id)?;
    if let Some(credential) = personal_credential(app, state, document)? {
        return sign_in_personal(app, state, document, &credential).await;
    }
    let authorization = state
        .accounts
        .authorization(&server_directory::origin())
        .await?;
    if !current_server_account(app, state, document, &authorization) {
        return Err("Could not continue".into());
    }
    let target =
        document_workspace(state, document, &authorization)?.ok_or("Could not continue")?;
    let selection = state
        .transport
        .selected(&document.label)
        .ok_or("Could not continue")?;
    if selection.account != settings::account_key(authorization.account.identity())
        || selection.target != target
    {
        return Err("Could not continue".into());
    }
    let epoch = state.personal_devices.epoch();
    let catalog = server_directory::Directory::new()?
        .catalog_for_device(
            authorization.directory_bearer()?,
            &server_directory::device_id(&state.directory)?,
        )
        .await?;
    if !current_server_account(app, state, document, &authorization)
        || epoch != state.personal_devices.epoch()
    {
        return Err("Could not continue".into());
    }
    let personal = catalog.is_personal(&target)?;
    let _activation = if personal {
        Some(state.personal_devices.activation_lock().await)
    } else {
        None
    };
    if !current_server_account(app, state, document, &authorization)
        || epoch != state.personal_devices.epoch()
    {
        return Err("Could not continue".into());
    }
    let staged = if personal {
        Some(
            state
                .personal_devices
                .stage(&selection, &authorization.account)?,
        )
    } else {
        None
    };
    let ticket = installation_ticket(app, state, document).await?;
    let challenge = state
        .transport
        .json(
            &document.label,
            &document.id,
            "/api/auth/native/workspace/challenge",
            serde_json::json!({}),
            ticket,
        )
        .await?;
    let nonce = challenge["challenge"]
        .as_str()
        .filter(|nonce| server_login::valid_challenge(nonce))
        .ok_or("Could not continue")?;
    if challenge["version"] != 2 || !current_server_account(app, state, document, &authorization) {
        return Err("Could not continue".into());
    }
    let grant =
        server_login::issue_workspace_device(authorization.directory_bearer()?, &target, nonce,
            staged.as_ref().map(|staged| serde_json::json!({"id":staged.credential.device_id,"publicKey":staged.credential.public_key})), || {
            current_server_account(app, state, document, &authorization) && epoch == state.personal_devices.epoch()
        })
        .await?;
    let mut input = serde_json::json!({"challenge": nonce, "grant": grant.grant});
    if let Some(staged) = &staged {
        input["deviceSignature"] = serde_json::json!(state.personal_devices.activation_proof(
            staged,
            nonce,
            &grant.grant
        )?);
    }
    let ticket = installation_ticket(app, state, document).await?;
    let completed = state
        .transport
        .json(
            &document.label,
            &document.id,
            "/api/auth/native/workspace/complete",
            input,
            ticket,
        )
        .await?;
    if !current_server_account(app, state, document, &authorization)
        || epoch != state.personal_devices.epoch()
        || completed["workspaceId"].as_str() != Some(&target.workspace_id)
        || completed["spaceId"].as_str().is_none_or(str::is_empty)
        || completed["user"]["id"].as_str().is_none_or(str::is_empty)
    {
        return Err("Could not continue".into());
    }
    if let Some(staged) = staged {
        state.personal_devices.activate(staged, &completed)?;
    } else if completed.get("personalDevice").is_some() {
        return Err("Could not continue".into());
    }
    let token = completed["token"].as_str().ok_or("Could not continue")?;
    commit_token(state, document, &selection, token, || {
        current_server_account(app, state, document, &authorization)
            && epoch == state.personal_devices.epoch()
    })
    .await?;
    retry_installation_revocations(app);
    Ok(serde_json::json!({"user":completed["user"], "workspaceId":target.workspace_id}))
}

/// A saved descriptor is useful only in its exact current native document and OS key scope.
pub fn personal_credential(
    app: &tauri::AppHandle,
    state: &DesktopState,
    document: &native::Document,
) -> Result<Option<crate::personal_devices::Credential>, String> {
    if state.transport.selected(&document.label).is_none() {
        return Ok(None);
    }
    let selection = state
        .transport
        .active_selection(&document.label, &document.id)?;
    let owned = crate::opening_server_matches(state, document, Some(&selection.account))
        || (crate::active_document(app).is_some_and(|active| active.owner() == document.owner())
            && state
                .setup
                .lock()
                .ok()
                .and_then(|setup| setup.clone())
                .is_some_and(|setup| {
                    setup.account.as_deref() == Some(selection.account.as_str())
                        && setup.workspace.as_ref() == Some(&selection.target)
                        && setup.server_url.origin().ascii_serialization() == selection.origin
                }));
    if !owned || !state.sessions.is_current(document) {
        return Err("Could not continue".into());
    }
    // Unavailable personal storage grants no offline authority. Online company login stays independent.
    Ok(state.personal_devices.credential(&selection).ok().flatten())
}

async fn sign_in_personal(
    app: &tauri::AppHandle,
    state: &DesktopState,
    document: &native::Document,
    credential: &crate::personal_devices::Credential,
) -> Result<serde_json::Value, String> {
    let epoch = state.personal_devices.epoch();
    let selection = state
        .transport
        .selected(&document.label)
        .ok_or("Could not continue")?;
    let current = || {
        epoch == state.personal_devices.epoch()
            && state.sessions.is_current(document)
            && state.transport.selected(&document.label).as_ref() == Some(&selection)
    };
    let request = async |path: &str, body| {
        if !current() {
            return Err("Could not continue".to_owned());
        }
        let ticket = installation_ticket(app, state, document).await?;
        let result = state
            .transport
            .json(&document.label, &document.id, path, body, ticket)
            .await?;
        if !current() {
            return Err("Could not continue".to_owned());
        }
        Ok::<_, String>(result)
    };
    let challenge = request(
        "/api/auth/native/workspace/personal/challenge",
        serde_json::json!({"deviceId":credential.device_id}),
    )
    .await?;
    let signature = state
        .personal_devices
        .offline_proof(credential, &challenge, epoch)?;
    let completed = request("/api/auth/native/workspace/personal/complete", serde_json::json!({
        "deviceId":credential.device_id, "challenge":challenge["challenge"], "signature":signature,
    })).await?;
    if !current()
        || completed["workspaceId"] != credential.selection.target.workspace_id
        || completed["spaceId"].as_str().is_none_or(str::is_empty)
        || completed["user"]["id"].as_str().is_none_or(str::is_empty)
    {
        return Err("Could not continue".into());
    }
    commit_token(
        state,
        document,
        &selection,
        completed["token"].as_str().ok_or("Could not continue")?,
        current,
    )
    .await?;
    retry_installation_revocations(app);
    Ok(
        serde_json::json!({"user": completed["user"], "workspaceId":credential.selection.target.workspace_id}),
    )
}

async fn commit_token(
    state: &DesktopState,
    document: &native::Document,
    selection: &crate::installation_transport::Selection,
    token: &str,
    current: impl Fn() -> bool,
) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 16 * 1024
        || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Could not continue".into());
    }
    if let Some((previous, retired)) = state
        .transport
        .captured_session(&document.label, &document.id)
        .ok()
        .flatten()
    {
        if retired != token {
            state
                .accounts
                .queue_installation_logout(previous, retired)
                .await?;
        }
    }
    if !current()
        || state
            .transport
            .token(&document.label, &document.id, token.into())
            .is_err()
    {
        state
            .accounts
            .queue_installation_logout(selection.clone(), token.into())
            .await?;
        return Err("Could not continue".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, Store};
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };

    #[derive(Default)]
    struct Credentials {
        values: Mutex<HashMap<String, String>>,
        fail: AtomicBool,
    }
    impl CredentialStore for Credentials {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("storage unavailable".into());
            }
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }
    impl Credentials {
        fn pending(self: &Arc<Self>) -> serde_json::Value {
            #[cfg(windows)]
            let store = crate::revocation_storage::ChunkedStore::new(self.clone());
            #[cfg(not(windows))]
            let store = self.as_ref();
            let raw = store
                .get("pending-session-revocations.v1")
                .unwrap()
                .unwrap();
            serde_json::from_str(&raw).unwrap()
        }
    }
    fn fixture() -> (
        tempfile::TempDir,
        DesktopState,
        Arc<Credentials>,
        native::Document,
        crate::installation_transport::Selection,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let mut state = crate::tests::test_state(directory.path());
        let store = Arc::new(Credentials::default());
        state.accounts = crate::accounts::Accounts::new(Store(store.clone()));
        let selection = crate::installation_transport::Selection {
            account: "a".repeat(64),
            origin: "https://installation.example.test".into(),
            relay_origin: None,
            direct_origin: None,
            prefer_relay: false,
            target: crate::server_directory::WorkspaceTarget {
                organization_id: "11111111-1111-4111-8111-111111111111".into(),
                server_id: "22222222-2222-4222-8222-222222222222".into(),
                workspace_id: "33333333-3333-4333-8333-333333333333".into(),
                binding_version: 1,
                key_fingerprint: "b".repeat(64),
            },
        };
        let document = native::Document {
            label: "server".into(),
            id: "document".into(),
            origin: url::Url::parse("https://renderer.example.test").unwrap(),
        };
        state
            .transport
            .select(&document.label, selection.clone())
            .unwrap();
        state.transport.document(&document.label, &document.id);
        state
            .transport
            .token(&document.label, &document.id, "retired-token".into())
            .unwrap();
        (directory, state, store, document, selection)
    }
    #[tokio::test]
    async fn rotation_persists_the_retired_scope_before_replacing_the_live_session() {
        let (_directory, state, store, document, selection) = fixture();
        commit_token(&state, &document, &selection, "replacement-token", || true)
            .await
            .unwrap();
        assert_eq!(
            state
                .transport
                .captured_session(&document.label, &document.id)
                .unwrap()
                .unwrap()
                .1,
            "replacement-token"
        );
        let pending = store.pending();
        assert_eq!(pending.as_array().unwrap().len(), 1);
        assert_eq!(pending[0]["target"]["token"], "retired-token");
        assert_eq!(
            pending[0]["target"]["selection"]["target"]["workspaceId"],
            selection.target.workspace_id
        );
    }
    #[tokio::test]
    async fn navigation_during_commit_queues_both_tokens_without_granting_the_replacement_document()
    {
        let (_directory, state, store, document, selection) = fixture();
        let result = commit_token(&state, &document, &selection, "late-token", || {
            state.transport.remove(&document.label);
            state
                .transport
                .select(&document.label, selection.clone())
                .unwrap();
            state
                .transport
                .document(&document.label, "replacement-document");
            true
        })
        .await;
        assert!(result.is_err());
        assert!(state
            .transport
            .captured_session(&document.label, "replacement-document")
            .unwrap()
            .is_none());
        let pending = store.pending();
        let tokens: Vec<_> = pending
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["target"]["token"].as_str().unwrap())
            .collect();
        assert_eq!(tokens, ["retired-token", "late-token"]);
    }
    #[tokio::test]
    async fn failed_revocation_persistence_preserves_the_old_live_token() {
        let (_directory, state, store, document, selection) = fixture();
        store.fail.store(true, Ordering::SeqCst);
        assert!(
            commit_token(&state, &document, &selection, "replacement-token", || true)
                .await
                .is_err()
        );
        assert_eq!(
            state
                .transport
                .captured_session(&document.label, &document.id)
                .unwrap()
                .unwrap()
                .1,
            "retired-token"
        );
    }
}
