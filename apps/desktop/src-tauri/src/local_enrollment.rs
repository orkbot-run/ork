// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    local_stack::LocalStack,
    server_directory::{Directory, Workspace, WorkspaceTarget},
};

#[cfg(test)]
#[path = "local_enrollment_tests.rs"]
mod tests;

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case", deny_unknown_fields)]
enum Enrollment {
    #[serde(rename_all = "camelCase")]
    Ready {
        organization_id: String,
        server_id: String,
        binding_version: u64,
        key_fingerprint: String,
    },
    #[serde(rename_all = "camelCase")]
    ApprovalRequired {
        enrollment_id: String,
        code: String,
        expires_at: u64,
        key_fingerprint: String,
    },
}

pub struct LocalEnrollment<'a> {
    pub directory: &'a Directory,
    pub stack: &'a LocalStack,
    pub token: &'a str,
    pub organization_id: &'a str,
    pub device_id: &'a str,
    pub subject: &'a str,
}

impl LocalEnrollment<'_> {
    /// A user-selected local install confirms identity through its private bootstrap capability.
    pub async fn connect(
        &self,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<Workspace, String> {
        const ERROR: &str = "Could not complete local installation. Retry to continue.";
        check()?;
        let enrollment = self
            .stack
            .installation(json!({ "action": "enroll", "organizationId": self.organization_id }))
            .await?;
        check()?;
        let enrollment: Enrollment = serde_json::from_value(enrollment).map_err(|_| ERROR)?;
        let ready = match enrollment {
            Enrollment::Ready { .. } => enrollment,
            Enrollment::ApprovalRequired {
                enrollment_id,
                code,
                expires_at,
                key_fingerprint,
            } => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| ERROR)?
                    .as_secs();
                if !crate::server_directory::uuid(&enrollment_id)
                    || expires_at <= now
                    || expires_at > now + 905
                    || code.len() != 10
                    || !code
                        .bytes()
                        .all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b))
                    || key_fingerprint.len() != 64
                    || !key_fingerprint
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    return Err(ERROR.into());
                }
                let body = json!({ "organizationId": self.organization_id, "code": code });
                let ticket: Value = self
                    .directory
                    .identity_request(
                        self.token,
                        Method::POST,
                        "/api/identity/v2/enrollments/lookup",
                        body,
                    )
                    .await?;
                check()?;
                if ticket.get("id").and_then(Value::as_str) != Some(&enrollment_id)
                    || ticket.get("keyFingerprint").and_then(Value::as_str)
                        != Some(&key_fingerprint)
                {
                    return Err("Installation identity changed".into());
                }
                let _: Value = self.directory.identity_request(self.token, Method::POST, "/api/identity/v2/enrollments/approve", json!({
                    "organizationId": self.organization_id, "code": code, "keyFingerprint": key_fingerprint,
                })).await?;
                check()?;
                let confirmed = self
                    .stack
                    .installation(
                        json!({ "action": "enroll", "organizationId": self.organization_id }),
                    )
                    .await?;
                check()?;
                let confirmed: Enrollment = serde_json::from_value(confirmed).map_err(|_| ERROR)?;
                if !matches!(&confirmed, Enrollment::Ready { key_fingerprint: actual, .. } if actual == &key_fingerprint)
                {
                    return Err("Installation identity changed".into());
                }
                confirmed
            }
        };
        let Enrollment::Ready {
            organization_id,
            server_id,
            binding_version,
            key_fingerprint,
        } = ready
        else {
            return Err(ERROR.into());
        };
        let mut target = WorkspaceTarget {
            organization_id,
            server_id,
            binding_version,
            key_fingerprint,
            workspace_id: self.organization_id.to_owned(),
        };
        target.validate()?;
        if target.organization_id != self.organization_id {
            return Err("Installation identity changed".into());
        }
        let operation = self.stack.workspace_operation(
            self.organization_id,
            &target.server_id,
            target.binding_version,
            &target.key_fingerprint,
        )?;
        let response: Value = self.directory.identity_request(self.token, Method::POST, &format!("/api/identity/v2/organizations/{}/workspaces", self.organization_id), json!({
            "serverId": target.server_id, "operationId": operation.operation_id, "name": "This computer",
        })).await?;
        check()?;
        target.workspace_id = response
            .pointer("/workspace/id")
            .and_then(Value::as_str)
            .ok_or(ERROR)?
            .to_owned();
        target.validate()?;
        if !operation.completed {
            let _: Value = self
                .directory
                .identity_request(
                    self.token,
                    Method::PUT,
                    &format!(
                        "/api/identity/v2/organizations/{}/workspaces/{}/members",
                        self.organization_id, target.workspace_id
                    ),
                    json!({
                        "userId": self.subject, "role": "admin",
                    }),
                )
                .await?;
            check()?;
        }
        let catalog = self.directory.catalog(self.token).await?;
        check()?;
        let routes =
            catalog.local_installation_routes(&target, &self.stack.web_url(), self.device_id)?;
        let completed = self.stack.installation(json!({
            "action": "complete", "organizationId": target.organization_id, "serverId": target.server_id,
            "workspaceId": target.workspace_id, "bindingVersion": target.binding_version, "keyFingerprint": target.key_fingerprint,
            "routes": routes, "delegateAI": !operation.completed,
        })).await?;
        check()?;
        if completed.get("state").and_then(Value::as_str) != Some("ready")
            || completed.get("organizationId").and_then(Value::as_str)
                != Some(&target.organization_id)
            || completed.get("workspaceId").and_then(Value::as_str) != Some(&target.workspace_id)
            || completed.get("serverId").and_then(Value::as_str) != Some(&target.server_id)
            || completed.get("keyFingerprint").and_then(Value::as_str)
                != Some(&target.key_fingerprint)
            || completed.get("bindingVersion").and_then(Value::as_u64)
                != Some(target.binding_version)
        {
            return Err(ERROR.into());
        }
        let workspace = self
            .directory
            .workspaces_for_device(self.token, self.device_id)
            .await?
            .into_iter()
            .find(|row| {
                row.target.as_ref() == Some(&target)
                    && row.url == self.stack.web_url().origin().ascii_serialization()
            })
            .ok_or(ERROR)?;
        check()?;
        self.stack.complete_workspace_operation(operation)?;
        Ok(workspace)
    }
}
