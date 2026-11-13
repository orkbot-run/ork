// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const ORG: &str = "10000000-0000-4000-8000-000000000001";
const SERVER: &str = "20000000-0000-4000-8000-000000000001";
const WORKSPACE: &str = "30000000-0000-4000-8000-000000000001";
const DEVICE: &str = "40000000-0000-4000-8000-000000000001";
const ENROLLMENT: &str = "50000000-0000-4000-8000-000000000001";
const TOKEN: &str = "private-accounts-fixture";

#[derive(Default)]
struct Observed {
    approved: bool,
    ready: bool,
    wrong_fingerprint: bool,
    changed_after_approval: bool,
    fail_complete: bool,
    operations: Vec<String>,
    grants: usize,
    completions: Vec<bool>,
    central_requests: usize,
    approval_requests: usize,
}
struct Fixture {
    _root: tempfile::TempDir,
    stack: LocalStack,
    directory: Directory,
    observed: Arc<Mutex<Observed>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    fn enrollment(&self) -> LocalEnrollment<'_> {
        LocalEnrollment {
            directory: &self.directory,
            stack: &self.stack,
            token: TOKEN,
            organization_id: ORG,
            device_id: DEVICE,
            subject: "fixture-subject",
        }
    }
}

async fn fixture() -> Fixture {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let address = origin.origin().ascii_serialization();
    let owner = "c".repeat(64);
    let capability = "d".repeat(64);
    let observed = Arc::new(Mutex::new(Observed::default()));
    let server_state = observed.clone();
    let server_owner = owner.clone();
    let server_capability = capability.clone();
    let server_address = address.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let state = server_state.clone();
            let owner = server_owner.clone();
            let capability = server_capability.clone();
            let address = server_address.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let split = loop {
                    let mut chunk = [0; 4096];
                    let size = stream.read(&mut chunk).await.unwrap();
                    if size == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..size]);
                    assert!(bytes.len() < 32768);
                    if let Some(at) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..split].to_vec()).unwrap();
                let length = headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                while bytes.len() < split + length {
                    let mut chunk = [0; 4096];
                    let size = stream.read(&mut chunk).await.unwrap();
                    if size == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..size]);
                }
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let body: Value = if length == 0 {
                    json!({})
                } else {
                    serde_json::from_slice(&bytes[split..split + length]).unwrap()
                };
                let central = path.starts_with("/api/identity/");
                if central {
                    assert!(headers.contains(&format!("Bearer {TOKEN}")));
                    assert!(!headers.contains(&capability));
                } else {
                    assert!(headers.contains(&capability));
                    assert!(!headers.contains(TOKEN));
                }
                let (status, response) = {
                    let mut observed = state.lock().unwrap();
                    if central {
                        observed.central_requests += 1;
                    }
                    let mut status = 200;
                    let ready = json!({"state":"ready", "organizationId":ORG, "serverId":SERVER, "bindingVersion":1,"keyFingerprint":if observed.changed_after_approval { "b".repeat(64) } else { "a".repeat(64) }});
                    let response = match path {
                        "/.well-known/orkbot-desktop-stack" => json!({"ok":true,"imageTag":"edge"}),
                        "/api/auth/capabilities" => json!({"managedAccountKey": owner}),
                        "/api/desktop-settings/installation" => {
                            if body["action"] == "enroll" {
                                if observed.approved {
                                    ready
                                } else {
                                    let expires = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap()
                                        .as_secs()
                                        + 300;
                                    json!({"state":"approval-required","enrollmentId":ENROLLMENT,"code":"ABCDEFGHJK","expiresAt":expires,"keyFingerprint":"a".repeat(64)})
                                }
                            } else {
                                observed
                                    .completions
                                    .push(body["delegateAI"].as_bool().unwrap());
                                if observed.fail_complete {
                                    observed.fail_complete = false;
                                    status = 503;
                                    json!({"error":"lost-response"})
                                } else {
                                    observed.ready = true;
                                    let mut response = ready;
                                    response["workspaceId"] = json!(WORKSPACE);
                                    response
                                }
                            }
                        }
                        "/api/identity/v2/enrollments/lookup" => {
                            json!({"id":ENROLLMENT,"keyFingerprint":if observed.wrong_fingerprint { "b".repeat(64) } else {"a".repeat(64)}})
                        }
                        "/api/identity/v2/enrollments/approve" => {
                            observed.approved = true;
                            observed.approval_requests += 1;
                            json!({"ok":true})
                        }
                        "/api/identity/v2/catalog" => {
                            json!({"version":2,"defaultOrganizationId":ORG,"organizations":[{
                                "id":ORG,"name":"Fixture organization","type":"personal","role":"admin","servers":[{
                                    "id":SERVER,"name":"This computer","bindingVersion":1,"keyFingerprint":"a".repeat(64),"state":"ready",
                                    "routes": if observed.ready { json!([{"id":DEVICE,"kind":"local","address":address,"deviceId":DEVICE}]) } else { json!([]) },
                                    "workspaces":[{"id":WORKSPACE,"name":"This computer","state":if observed.ready {"ready"} else {"provisioning"},"canOpen":true,"role":"admin"}]
                                }]
                            }]})
                        }
                        value if value.ends_with("/members") => {
                            observed.grants += 1;
                            assert_eq!(body["userId"], "fixture-subject");
                            json!({"ok":true})
                        }
                        value if value.ends_with("/workspaces") => {
                            observed
                                .operations
                                .push(body["operationId"].as_str().unwrap().to_owned());
                            json!({"workspace":{"id":WORKSPACE,"state":"provisioning"}})
                        }
                        _ => panic!("Unexpected request: {path}"),
                    };
                    (status, response)
                };
                let body = response.to_string();
                let response = format!("HTTP/1.1 {status} fixture\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("stack");
    crate::local_stack::private_directory(&path).unwrap();
    let mut hash = Sha256::new();
    hash.update(b"accounts-only-owner-v2\0");
    hash.update(owner.as_bytes());
    hash.update([0]);
    for (name, value) in [
        (".desktop-stack-token", capability),
        (".desktop-web-url", address),
        (".desktop-host-config", format!("{:x}", hash.finalize())),
    ] {
        crate::local_stack::write_private(&path.join(name), value.as_bytes()).unwrap();
    }
    let template = LocalStack::new(
        path.clone(),
        root.path().join("resources"),
        "edge".into(),
        None,
        None,
    );
    let stack = template.scoped(path, "fixture-project".into(), owner, None, None);
    Fixture {
        _root: root,
        stack,
        directory: Directory::for_test(origin),
        observed,
        task,
    }
}

#[tokio::test]
async fn actual_native_http_setup_resumes_without_duplicate_workspaces_or_restoring_removed_assignments(
) {
    let f = fixture().await;
    f.observed.lock().unwrap().fail_complete = true;
    assert!(f.enrollment().connect(|| Ok(())).await.is_err());
    let workspace = f.enrollment().connect(|| Ok(())).await.unwrap();
    assert_eq!(workspace.target.unwrap().workspace_id, WORKSPACE);
    let grants_before = f.observed.lock().unwrap().grants;
    f.enrollment().connect(|| Ok(())).await.unwrap();
    let observed = f.observed.lock().unwrap();
    assert_eq!(observed.approval_requests, 1);
    assert_eq!(observed.operations.len(), 3);
    assert!(observed
        .operations
        .iter()
        .all(|id| id == &observed.operations[0]));
    assert_eq!(observed.grants, grants_before);
    assert_eq!(observed.completions, [true, true, false]);
}

#[tokio::test]
async fn a_different_central_fingerprint_is_never_approved() {
    let f = fixture().await;
    f.observed.lock().unwrap().wrong_fingerprint = true;
    assert_eq!(
        f.enrollment().connect(|| Ok(())).await.unwrap_err(),
        "Installation identity changed"
    );
    assert_eq!(f.observed.lock().unwrap().approval_requests, 0);
    assert!(f.observed.lock().unwrap().operations.is_empty());
}

#[tokio::test]
async fn changing_the_local_key_after_approval_cannot_create_a_workspace_or_assignment() {
    let f = fixture().await;
    f.observed.lock().unwrap().changed_after_approval = true;
    assert_eq!(
        f.enrollment().connect(|| Ok(())).await.unwrap_err(),
        "Installation identity changed"
    );
    let observed = f.observed.lock().unwrap();
    assert_eq!(observed.approval_requests, 1);
    assert!(observed.operations.is_empty());
    assert_eq!(observed.grants, 0);
}

#[tokio::test]
async fn logging_out_after_local_enrollment_prevents_any_accounts_mutation() {
    let f = fixture().await;
    let checks = std::cell::Cell::new(0);
    let result = f
        .enrollment()
        .connect(|| {
            checks.set(checks.get() + 1);
            if checks.get() > 1 {
                Err("Account changed".into())
            } else {
                Ok(())
            }
        })
        .await;
    assert_eq!(result.unwrap_err(), "Account changed");
    assert_eq!(f.observed.lock().unwrap().central_requests, 0);
}
