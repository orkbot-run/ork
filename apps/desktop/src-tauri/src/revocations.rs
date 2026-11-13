// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use url::Url;

use crate::credentials::{Store, STORAGE_ERROR};

const KEY: &str = "pending-session-revocations.v1";
const MAX_RECORDS: usize = 20;
const MAX_BYTES: usize = 128 * 1024;
const MAX_TOKEN: usize = 16 * 1024;
const RETENTION: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Target {
    Installation {
        selection: crate::installation_transport::Selection,
        token: String,
    },
    Session {
        origin: String,
        cookies: String,
    },
    OAuth {
        issuer: String,
        client_id: String,
        token: String,
        endpoint: Option<String>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    target: Target,
    created_at: u64,
}

impl Target {
    fn valid(&self) -> bool {
        let token = match self {
            Self::Installation { selection, token } => {
                if !selection.valid() {
                    return false;
                }
                token
            }
            Self::Session { origin, cookies } => {
                if origin.len() > 4096 {
                    return false;
                }
                let Ok(parsed) = Url::parse(origin) else {
                    return false;
                };
                if !crate::pairing::secure_origin(&parsed)
                    .is_ok_and(|url| url.origin().ascii_serialization() == *origin)
                {
                    return false;
                }
                cookies
            }
            Self::OAuth {
                issuer,
                client_id,
                token,
                endpoint,
            } => {
                if !safe_endpoint(issuer)
                    || client_id.is_empty()
                    || client_id.len() > 4096
                    || client_id.chars().any(char::is_control)
                    || endpoint.as_ref().is_some_and(|value| !safe_endpoint(value))
                {
                    return false;
                }
                token
            }
        };
        !token.is_empty() && token.len() <= MAX_TOKEN && !token.chars().any(char::is_control)
    }
}

fn safe_endpoint(value: &str) -> bool {
    value.len() <= 4096
        && Url::parse(value).ok().is_some_and(|url| {
            url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && (url.scheme() == "https"
                    || (cfg!(test) && crate::pairing::secure_origin(&url).is_ok()))
        })
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Default)]
struct Coordination {
    operation: Mutex<()>,
    running: std::sync::Mutex<bool>,
    revision: AtomicU64,
    known_empty: AtomicBool,
}

#[derive(Clone, Default)]
pub struct Revocations {
    store: Store,
    coordination: Arc<Coordination>,
}

impl Revocations {
    pub fn new(store: Store) -> Self {
        #[cfg(windows)]
        let store = Store(Arc::new(crate::revocation_storage::ChunkedStore::new(
            store.0,
        )));
        Self {
            store,
            coordination: Arc::default(),
        }
    }

    async fn load(&self) -> Result<Vec<Pending>, String> {
        let Some(raw) = self.store.get(KEY.into()).await? else {
            return Ok(Vec::new());
        };
        if raw.len() > MAX_BYTES {
            return Err(STORAGE_ERROR.into());
        }
        let mut pending: Vec<Pending> = serde_json::from_str(&raw).map_err(|_| STORAGE_ERROR)?;
        let time = now();
        pending.retain(|record| {
            record.created_at <= time
                && time - record.created_at < RETENTION
                && record.target.valid()
        });
        if pending.len() > MAX_RECORDS {
            pending.drain(..pending.len() - MAX_RECORDS);
        }
        Ok(pending)
    }

    async fn save(&self, pending: &[Pending]) -> Result<(), String> {
        if pending.is_empty() {
            self.store.delete(KEY.into()).await?;
        } else {
            self.store
                .set(
                    KEY.into(),
                    serde_json::to_string(pending).map_err(|_| STORAGE_ERROR)?,
                )
                .await?;
        }
        self.coordination
            .known_empty
            .store(pending.is_empty(), Ordering::SeqCst);
        Ok(())
    }

    pub fn is_known_empty(&self) -> bool {
        self.coordination.known_empty.load(Ordering::SeqCst)
    }

    pub fn is_running(&self) -> bool {
        self.coordination
            .running
            .lock()
            .map_or(true, |running| *running)
    }

    /// Persist an immutable old credential before retiring its live copy. No network is awaited.
    pub async fn enqueue(&self, target: Target) -> Result<(), String> {
        if !target.valid() {
            return Err(STORAGE_ERROR.into());
        }
        let _operation = self.coordination.operation.lock().await;
        let mut pending = self.load().await?;
        if pending.iter().any(|record| record.target == target) {
            return self.save(&pending).await;
        }
        pending.push(Pending {
            target,
            created_at: now(),
        });
        while pending.len() > MAX_RECORDS
            || serde_json::to_vec(&pending)
                .map_err(|_| STORAGE_ERROR)?
                .len()
                > MAX_BYTES
        {
            pending.remove(0);
        }
        self.save(&pending).await?;
        self.coordination.revision.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Replay captured credentials only. Concurrent triggers share a flush, never a live session.
    pub async fn flush(&self) {
        if self.is_known_empty() {
            return;
        }
        {
            let Ok(mut running) = self.coordination.running.lock() else {
                return;
            };
            if *running {
                return;
            }
            *running = true;
        }
        struct Guard<'a> {
            coordination: &'a Coordination,
            armed: bool,
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                if self.armed {
                    if let Ok(mut running) = self.coordination.running.lock() {
                        *running = false;
                    }
                }
            }
        }
        let mut guard = Guard {
            coordination: &self.coordination,
            armed: true,
        };
        let mut attempted: Vec<Target> = Vec::new();
        loop {
            let observed = self.coordination.revision.load(Ordering::SeqCst);
            let snapshot = {
                let _operation = self.coordination.operation.lock().await;
                match self.load().await {
                    Ok(pending) => {
                        if self.save(&pending).await.is_err() {
                            return;
                        }
                        pending
                    }
                    Err(_) => return,
                }
            };
            let snapshot: Vec<_> = snapshot
                .into_iter()
                .filter(|entry| !attempted.contains(&entry.target))
                .take(MAX_RECORDS - attempted.len())
                .collect();
            attempted.extend(snapshot.iter().map(|entry| entry.target.clone()));
            let Ok(client) = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(4))
                .timeout(Duration::from_secs(4))
                .build()
            else {
                return;
            };
            for record in snapshot {
                let accepted = match &record.target {
                    Target::Installation { selection, token } => {
                        // Relay capabilities require a fresh matching Accounts session. Never
                        // deliver these credentials through the ordinary HTTP logout fallback.
                        selection.relay_origin.is_none() && selection.revoke(token, None).await
                    }
                    Target::Session { origin, cookies } => {
                        let Ok(origin) = Url::parse(origin) else {
                            continue;
                        };
                        let Ok(endpoint) = origin.join("/api/auth/sign-out") else {
                            continue;
                        };
                        let response = client
                            .post(endpoint)
                            .header(reqwest::header::COOKIE, cookies)
                            .header(
                                reqwest::header::ORIGIN,
                                origin.origin().ascii_serialization(),
                            )
                            .json(&serde_json::json!({}))
                            .send()
                            .await;
                        match response {
                            Ok(response) => crate::accounts::revocation_ack(response).await,
                            Err(_) => false,
                        }
                    }
                    Target::OAuth {
                        issuer,
                        client_id,
                        token,
                        endpoint,
                    } => {
                        crate::accounts::revoke_queued_token(
                            &client,
                            issuer,
                            client_id,
                            token,
                            endpoint.as_deref(),
                        )
                        .await
                    }
                };
                if accepted {
                    let _operation = self.coordination.operation.lock().await;
                    let Ok(mut pending) = self.load().await else {
                        return;
                    };
                    pending.retain(|item| {
                        item.created_at != record.created_at || item.target != record.target
                    });
                    if self.save(&pending).await.is_err() {
                        return;
                    }
                }
            }
            // Closing the gate and checking the enqueue revision are one synchronous boundary.
            // A later trigger either contributes a new entry to this pass or starts a fresh attempt.
            let Ok(mut running) = self.coordination.running.lock() else {
                return;
            };
            if observed != self.coordination.revision.load(Ordering::SeqCst)
                && attempted.len() < MAX_RECORDS
            {
                drop(running);
                continue;
            }
            *running = false;
            guard.armed = false;
            return;
        }
    }
}

impl Revocations {
    /// Only the matching current Accounts identity may mint a new relay capability for a retry.
    pub async fn flush_installations<F, Fut>(&self, account: &str, mut ticket: F)
    where
        F: FnMut(crate::installation_transport::Selection) -> Fut,
        Fut: std::future::Future<Output = Result<Option<String>, String>>,
    {
        let snapshot = {
            let _operation = self.coordination.operation.lock().await;
            let Ok(pending) = self.load().await else {
                return;
            };
            pending
        };
        for record in snapshot {
            let Target::Installation { selection, token } = &record.target else {
                continue;
            };
            if selection.account != account {
                continue;
            }
            let Ok(ticket) = ticket(selection.clone()).await else {
                continue;
            };
            if !selection.revoke(token, ticket).await {
                continue;
            }
            let _operation = self.coordination.operation.lock().await;
            let Ok(mut pending) = self.load().await else {
                return;
            };
            pending.retain(|entry| {
                entry.created_at != record.created_at || entry.target != record.target
            });
            if self.save(&pending).await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::CredentialStore;

    #[tokio::test]
    async fn installation_logout_waits_for_the_matching_identity_and_keeps_failed_retries() {
        let store = Arc::new(MemoryStore::default());
        let queue = Revocations::new(Store(store));
        let id = "11111111-1111-4111-8111-111111111111";
        let selection = crate::installation_transport::Selection {
            account: "a".repeat(64),
            origin: format!("https://{id}.installation.ork.invalid"),
            relay_origin: Some("https://relay.example.test".into()),
            target: crate::server_directory::WorkspaceTarget {
                organization_id: id.into(),
                server_id: id.into(),
                workspace_id: id.into(),
                binding_version: 1,
                key_fingerprint: "b".repeat(64),
            },
        };
        let target = Target::Installation {
            selection,
            token: "retired-product-session".into(),
        };
        queue.enqueue(target.clone()).await.unwrap();
        queue
            .flush_installations(&"c".repeat(64), |_| async {
                panic!("another account cannot mint the capability")
            })
            .await;
        assert_eq!(queue.load().await.unwrap().len(), 1);
        queue
            .flush_installations(&"a".repeat(64), |_| async {
                Err("Accounts unavailable".into())
            })
            .await;
        assert!(queue.load().await.unwrap()[0].target == target);
    }
    use std::{
        collections::HashMap,
        sync::{atomic::AtomicU16, Mutex as StdMutex},
    };

    #[derive(Default)]
    struct MemoryStore(StdMutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct Server {
        origin: String,
        status: Arc<AtomicU16>,
        requests: Arc<StdMutex<Vec<(String, String, String)>>>,
        location: Arc<StdMutex<Option<String>>>,
        hold_first: Arc<AtomicBool>,
        release: Arc<tokio::sync::Notify>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Server {
        async fn new() -> Self {
            use http_body_util::{BodyExt, Full};
            use hyper::{body::Bytes, service::service_fn};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let status = Arc::new(AtomicU16::new(503));
            let requests = Arc::new(StdMutex::new(Vec::new()));
            let location = Arc::new(StdMutex::new(None::<String>));
            let hold_first = Arc::new(AtomicBool::new(false));
            let release = Arc::new(tokio::sync::Notify::new());
            let (held, released) = (hold_first.clone(), release.clone());
            let (response_status, saved, redirect) =
                (status.clone(), requests.clone(), location.clone());
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (status, requests, location) =
                        (response_status.clone(), saved.clone(), redirect.clone());
                    let (held, released) = (held.clone(), released.clone());
                    tokio::spawn(async move {
                        let service =
                            service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                                let (status, requests, location) =
                                    (status.clone(), requests.clone(), location.clone());
                                let (held, released) = (held.clone(), released.clone());
                                async move {
                                    let path = request.uri().path().to_owned();
                                    let cookies = request
                                        .headers()
                                        .get(reqwest::header::COOKIE)
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or("")
                                        .to_owned();
                                    let body =
                                        request.into_body().collect().await.unwrap().to_bytes();
                                    let session = path == "/api/auth/sign-out";
                                    requests.lock().unwrap().push((
                                        path,
                                        cookies,
                                        String::from_utf8(body.to_vec()).unwrap(),
                                    ));
                                    if held.swap(false, Ordering::SeqCst) {
                                        released.notified().await;
                                    }
                                    let mut response = hyper::Response::builder()
                                        .status(status.load(Ordering::SeqCst));
                                    if let Some(location) = location.lock().unwrap().as_ref() {
                                        response = response.header("location", location);
                                    }
                                    let payload = if status.load(Ordering::SeqCst) == 202 {
                                        "<html>Sign in to the access proxy</html>"
                                    } else if session {
                                        "{\"success\":true}"
                                    } else {
                                        ""
                                    };
                                    Ok::<_, std::convert::Infallible>(
                                        response.body(Full::new(Bytes::from(payload))).unwrap(),
                                    )
                                }
                            });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                            .await;
                    });
                }
            });
            Self {
                origin,
                status,
                requests,
                location,
                hold_first,
                release,
                task,
            }
        }
    }

    fn session(origin: &str, value: &str) -> Target {
        Target::Session {
            origin: origin.into(),
            cookies: format!("better-auth.session_token={value}"),
        }
    }

    #[tokio::test]
    async fn failed_revocation_survives_restart_and_never_reads_the_replacement_session() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let queue = Revocations::new(Store(store.clone()));
        queue
            .enqueue(session(&server.origin, "old-session"))
            .await
            .unwrap();
        queue.flush().await;
        assert_eq!(queue.load().await.unwrap().len(), 1);
        store.set("current-session", "new-session").unwrap();
        let restarted = Revocations::new(Store(store.clone()));
        server.status.store(200, Ordering::SeqCst);
        restarted.flush().await;
        assert!(restarted.load().await.unwrap().is_empty());
        assert_eq!(
            store.get("current-session").unwrap().as_deref(),
            Some("new-session")
        );
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|(path, cookie, _)| path == "/api/auth/sign-out"
                && cookie == "better-auth.session_token=old-session"));
    }

    #[tokio::test]
    async fn enqueue_during_replay_is_not_lost_when_the_next_trigger_arrives_early() {
        let server = Server::new().await;
        server.status.store(200, Ordering::SeqCst);
        server.hold_first.store(true, Ordering::SeqCst);
        let queue = Revocations::new(Store(Arc::new(MemoryStore::default())));
        queue
            .enqueue(session(&server.origin, "first-session"))
            .await
            .unwrap();
        let first_queue = queue.clone();
        let first = tokio::spawn(async move {
            first_queue.flush().await;
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.requests.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        queue
            .enqueue(session(&server.origin, "second-session"))
            .await
            .unwrap();
        let second_queue = queue.clone();
        let second = tokio::spawn(async move {
            second_queue.flush().await;
        });
        tokio::task::yield_now().await;
        server.release.notify_one();
        first.await.unwrap();
        second.await.unwrap();
        assert!(queue.load().await.unwrap().is_empty());
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn successful_rpc_bursts_coalesce_without_waiters_or_repeating_failed_records() {
        let server = Server::new().await;
        server.hold_first.store(true, Ordering::SeqCst);
        let queue = Revocations::new(Store(Arc::new(MemoryStore::default())));
        queue
            .enqueue(session(&server.origin, "offline-old-session"))
            .await
            .unwrap();
        let active_queue = queue.clone();
        let active = tokio::spawn(async move {
            active_queue.flush().await;
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.requests.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut burst = Vec::new();
            for _ in 0..100 {
                let queue = queue.clone();
                burst.push(tokio::spawn(async move {
                    queue.flush().await;
                }));
            }
            for task in burst {
                task.await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        server.release.notify_one();
        active.await.unwrap();
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert_eq!(queue.load().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_proxy_html_success_is_not_an_acknowledged_server_logout() {
        let server = Server::new().await;
        server.status.store(202, Ordering::SeqCst);
        let queue = Revocations::new(Store(Arc::new(MemoryStore::default())));
        queue
            .enqueue(session(&server.origin, "old-session"))
            .await
            .unwrap();
        queue.flush().await;
        assert_eq!(queue.load().await.unwrap().len(), 1);
        server.status.store(200, Ordering::SeqCst);
        queue.flush().await;
        assert!(queue.load().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn replay_never_follows_redirects_with_captured_credentials() {
        let source = Server::new().await;
        let destination = Server::new().await;
        source.status.store(307, Ordering::SeqCst);
        *source.location.lock().unwrap() = Some(format!("{}/leak", destination.origin));
        let queue = Revocations::new(Store(Arc::new(MemoryStore::default())));
        queue
            .enqueue(session(&source.origin, "private-old-session"))
            .await
            .unwrap();
        queue.flush().await;
        assert_eq!(source.requests.lock().unwrap().len(), 1);
        assert!(destination.requests.lock().unwrap().is_empty());
        assert_eq!(queue.load().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn scopes_and_empty_oauth_success_are_handled_without_json_or_live_credentials() {
        let first = Server::new().await;
        let second = Server::new().await;
        first.status.store(200, Ordering::SeqCst);
        second.status.store(200, Ordering::SeqCst);
        let queue = Revocations::new(Store(Arc::new(MemoryStore::default())));
        queue
            .enqueue(session(&first.origin, "first-old-session"))
            .await
            .unwrap();
        queue
            .enqueue(Target::OAuth {
                issuer: "https://identity.example.test".into(),
                client_id: "desktop".into(),
                token: "old-refresh-token".into(),
                endpoint: Some(format!("{}/revoke", second.origin)),
            })
            .await
            .unwrap();
        queue.flush().await;
        assert!(queue.load().await.unwrap().is_empty());
        let requests = second.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].1.is_empty());
        assert!(requests[0].2.contains("token=old-refresh-token"));
        assert!(!requests[0].2.contains("first-old-session"));
    }

    #[tokio::test]
    async fn queue_bounds_retention_count_bytes_and_token_size_without_extending_duplicates() {
        let queue = Revocations::new(Store(Arc::new(MemoryStore::default())));
        let origin = "https://server.example.test";
        let old = Pending {
            target: session(origin, "expired"),
            created_at: now() - RETENTION,
        };
        let kept = Pending {
            target: session(origin, "kept"),
            created_at: now() - 10,
        };
        queue
            .store
            .set(
                KEY.into(),
                serde_json::to_string(&vec![old, kept.clone()]).unwrap(),
            )
            .await
            .unwrap();
        queue.enqueue(kept.target.clone()).await.unwrap();
        let records = queue.load().await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].created_at, kept.created_at);
        for value in 0..25 {
            queue
                .enqueue(session(origin, &format!("old-{value}")))
                .await
                .unwrap();
        }
        assert_eq!(queue.load().await.unwrap().len(), MAX_RECORDS);
        for value in 0..20 {
            queue
                .enqueue(session(origin, &format!("{value}{}", "x".repeat(16000))))
                .await
                .unwrap();
        }
        assert!(queue.store.get(KEY.into()).await.unwrap().unwrap().len() <= MAX_BYTES);
        assert!(queue
            .enqueue(session(origin, &"x".repeat(MAX_TOKEN)))
            .await
            .is_err());
        for origin in [
            "http://untrusted.example.test",
            "https://user@server.example.test",
            "https://server.example.test/path",
            "https://server.example.test?other=1",
        ] {
            assert!(queue.enqueue(session(origin, "secret")).await.is_err());
        }
    }
}
