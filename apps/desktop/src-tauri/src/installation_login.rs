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
        server_login::issue_workspace(authorization.directory_bearer()?, &target, nonce, || {
            current_server_account(app, state, document, &authorization)
        })
        .await?;
    let ticket = installation_ticket(app, state, document).await?;
    let completed = state
        .transport
        .json(
            &document.label,
            &document.id,
            "/api/auth/native/workspace/complete",
            serde_json::json!({"challenge": nonce, "grant": grant.grant}),
            ticket,
        )
        .await?;
    if !current_server_account(app, state, document, &authorization)
        || completed["workspaceId"].as_str() != Some(&target.workspace_id)
        || completed["spaceId"].as_str().is_none_or(str::is_empty)
        || completed["user"]["id"].as_str().is_none_or(str::is_empty)
    {
        return Err("Could not continue".into());
    }
    let token = completed["token"].as_str().ok_or("Could not continue")?;
    state
        .transport
        .token(&document.label, &document.id, token.into())?;
    retry_installation_revocations(app);
    Ok(serde_json::json!({"user":completed["user"], "workspaceId":target.workspace_id}))
}
