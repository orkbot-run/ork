// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use reqwest::{header, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::credentials::{self, Store, STORAGE_ERROR};

const PAIR_ERROR: &str = "Could not pair this computer.";
const MAX_BODY: usize = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    user_id: String,
    session_id: String,
    blocked: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credential {
    origin: String,
    user_id: String,
    session_id: String,
    device_id: String,
    token: String,
}

#[derive(Default)]
struct ServerState {
    generation: AtomicU64,
    operation: tokio::sync::Mutex<()>,
}

pub struct Attempt {
    server: Arc<ServerState>,
    generation: u64,
}

impl Attempt {
    pub fn is_current(&self) -> bool {
        self.generation == self.server.generation.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct Pairings {
    store: Store,
    servers: Mutex<HashMap<String, Arc<ServerState>>>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

pub fn secure_origin(url: &Url) -> Result<Url, String> {
    let origin = crate::server::normalize_server_url(url.as_str())?;
    let loopback = match origin.host() {
        Some(Host::Domain(name)) => name == "localhost" || name.ends_with(".localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if origin.scheme() != "https" && !loopback {
        return Err("Device pairing requires HTTPS or a loopback server.".into());
    }
    Ok(origin)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| PAIR_ERROR.into())
}

async fn json(mut response: Response) -> Result<serde_json::Value, String> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_BODY as u64)
    {
        return Err(PAIR_ERROR.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| PAIR_ERROR)? {
        if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
            return Err(PAIR_ERROR.into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| PAIR_ERROR.into())
}

/// A fresh, uncached server session is authoritative, never an account supplied by the page.
async fn session(client: &Client, origin: &Url, cookies: &str) -> Result<Option<Binding>, String> {
    let response = client
        .get(
            origin
                .join("/api/auth/get-session?disableCookieCache=true")
                .map_err(|_| PAIR_ERROR)?,
        )
        .header(header::COOKIE, cookies)
        .header(header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| PAIR_ERROR)?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    let value = json(response).await?;
    if value.is_null() {
        return Ok(None);
    }
    let user_id = value["user"]["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or(PAIR_ERROR)?;
    let session_id = value["session"]["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or(PAIR_ERROR)?;
    if value["session"]["userId"].as_str() != Some(user_id) {
        return Err(PAIR_ERROR.into());
    }
    Ok(Some(Binding {
        user_id: user_id.into(),
        session_id: session_id.into(),
        blocked: false,
    }))
}

async fn revoke(client: &Client, origin: &Url, token: &str) {
    if let Ok(target) = origin.join("/api/devices/self") {
        // No cookies and no redirect following: a token can only reach its own server.
        let _ = client.delete(target).bearer_auth(token).send().await;
    }
}

impl Pairings {
    /// Capture before asynchronous cookie access, which can race with logout too.
    pub fn attempt(&self, origin: &Url) -> Result<Attempt, String> {
        let server = self.server(&secure_origin(origin)?)?;
        let generation = server.generation.load(Ordering::SeqCst);
        Ok(Attempt { server, generation })
    }

    fn server(&self, origin: &Url) -> Result<Arc<ServerState>, String> {
        Ok(self
            .servers
            .lock()
            .map_err(|_| PAIR_ERROR)?
            .entry(origin.origin().ascii_serialization())
            .or_default()
            .clone())
    }

    async fn binding(&self, origin: &Url) -> Result<Option<Binding>, String> {
        let Some(raw) = self.store.get(credentials::key(origin, None)).await? else {
            return Ok(None);
        };
        if raw.len() > 2048 {
            return Err(STORAGE_ERROR.into());
        }
        let binding: Binding = serde_json::from_str(&raw).map_err(|_| STORAGE_ERROR)?;
        if !valid_id(&binding.user_id) || !valid_id(&binding.session_id) {
            return Err(STORAGE_ERROR.into());
        }
        Ok(Some(binding))
    }

    async fn save_binding(&self, origin: &Url, binding: &Binding) -> Result<(), String> {
        self.store
            .set(
                credentials::key(origin, None),
                serde_json::to_string(binding).map_err(|_| STORAGE_ERROR)?,
            )
            .await
    }

    async fn credential(
        &self,
        origin: &Url,
        binding: &Binding,
    ) -> Result<Option<Credential>, String> {
        let Some(raw) = self
            .store
            .get(credentials::key(origin, Some(&binding.user_id)))
            .await?
        else {
            return Ok(None);
        };
        if raw.len() > 4096 {
            return Err(STORAGE_ERROR.into());
        }
        let saved: Credential = serde_json::from_str(&raw).map_err(|_| STORAGE_ERROR)?;
        if saved.origin != origin.origin().ascii_serialization()
            || saved.user_id != binding.user_id
            || saved.session_id != binding.session_id
            || !valid_id(&saved.device_id)
            || saved.token.is_empty()
            || saved.token.len() > 1024
            || saved.token.chars().any(char::is_control)
        {
            return Err(STORAGE_ERROR.into());
        }
        Ok(Some(saved))
    }

    async fn forget(
        &self,
        client: &Client,
        origin: &Url,
        mut binding: Binding,
    ) -> Result<(), String> {
        let saved = self.credential(origin, &binding).await;
        binding.blocked = true;
        // Retain only a non-secret tombstone so a failed logout cannot re-pair on reload.
        let blocked = self.save_binding(origin, &binding).await;
        let deleted = self
            .store
            .delete(credentials::key(origin, Some(&binding.user_id)))
            .await;
        if let Ok(Some(saved)) = saved {
            revoke(client, origin, &saved.token).await;
        }
        blocked.and(deleted)
    }

    /// Call before server logout. Invalidate pending work before waiting for its origin lock.
    pub async fn clear(&self, origin: &Url) -> Result<(), String> {
        let origin = secure_origin(origin)?;
        let server = self.server(&origin)?;
        server.generation.fetch_add(1, Ordering::SeqCst);
        let _operation = server.operation.lock().await;
        if let Some(binding) = self.binding(&origin).await? {
            self.forget(&client()?, &origin, binding).await?;
        }
        Ok(())
    }

    /// Synchronize pairing only; computer access and transport remain a separate capability.
    pub async fn sync(
        &self,
        origin: &Url,
        cookies: &str,
        current: impl Fn() -> bool,
    ) -> Result<(), String> {
        let origin = secure_origin(origin)?;
        let attempt = self.attempt(&origin)?;
        let _operation = attempt.server.operation.lock().await;
        let live = || current() && attempt.is_current();
        if !live() {
            return Ok(());
        }
        let client = client()?;
        let previous = self.binding(&origin).await?;
        let signed_in = session(&client, &origin, cookies).await?;
        if !live() {
            return Ok(());
        }
        if let Some(previous) = previous.as_ref() {
            if signed_in.as_ref().is_none_or(|next| {
                next.user_id != previous.user_id || next.session_id != previous.session_id
            }) {
                self.forget(&client, &origin, previous.clone()).await?;
            } else if previous.blocked {
                return Ok(());
            } else if let Some(saved) = self.credential(&origin, previous).await? {
                let response = client
                    .post(
                        origin
                            .join("/api/devices/self/session")
                            .map_err(|_| PAIR_ERROR)?,
                    )
                    .header(header::COOKIE, cookies)
                    .bearer_auth(&saved.token)
                    .send()
                    .await
                    .map_err(|_| PAIR_ERROR)?;
                if response.status() == StatusCode::NO_CONTENT {
                    return Ok(());
                }
                if !matches!(
                    response.status(),
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                ) {
                    return Err(PAIR_ERROR.into());
                }
                self.forget(&client, &origin, previous.clone()).await?;
                return Ok(());
            }
        }
        let Some(binding) = signed_in else {
            return Ok(());
        };
        if !live() {
            return Ok(());
        }
        // Probe the actual store before minting a remote token. This also journals its owner.
        self.save_binding(&origin, &binding).await?;
        if !live() {
            return Ok(());
        }
        let response = client
            .post(origin.join("/api/devices/pair").map_err(|_| PAIR_ERROR)?)
            .header(header::COOKIE, cookies)
            .header(header::CACHE_CONTROL, "no-store")
            .json(&serde_json::json!({"name":"Ork Preview", "platform":platform()}))
            .send()
            .await
            .map_err(|_| PAIR_ERROR)?;
        let value = json(response).await?;
        let token = value["token"]
            .as_str()
            .filter(|token| {
                !token.is_empty() && token.len() <= 1024 && !token.chars().any(char::is_control)
            })
            .ok_or(PAIR_ERROR)?;
        let result = async {
            let device_id = value["deviceId"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or(PAIR_ERROR)?;
            if value["userId"].as_str() != Some(&binding.user_id) || !live() {
                return Err(PAIR_ERROR.into());
            }
            // Logout or session expiry during the pair request must not resurrect access.
            let verified = session(&client, &origin, cookies).await?;
            if !live()
                || verified.as_ref().is_none_or(|next| {
                    next.user_id != binding.user_id || next.session_id != binding.session_id
                })
            {
                return Err(PAIR_ERROR.into());
            }
            let saved = Credential {
                origin: origin.origin().ascii_serialization(),
                user_id: binding.user_id.clone(),
                session_id: binding.session_id.clone(),
                device_id: device_id.into(),
                token: token.into(),
            };
            self.store
                .set(
                    credentials::key(&origin, Some(&binding.user_id)),
                    serde_json::to_string(&saved).map_err(|_| STORAGE_ERROR)?,
                )
                .await?;
            if !live() {
                self.forget(&client, &origin, binding.clone()).await?;
                return Err(PAIR_ERROR.into());
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            revoke(&client, &origin, token).await;
        }
        result
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::CredentialStore;
    use http_body_util::Full;
    use hyper::{body::Bytes, service::service_fn};
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Notify;

    #[derive(Default)]
    struct MemoryStore {
        values: Mutex<HashMap<String, String>>,
        unavailable: AtomicBool,
        fail_token_write: AtomicBool,
        fail_delete: AtomicBool,
    }
    impl CredentialStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(STORAGE_ERROR.into());
            }
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if self.unavailable.load(Ordering::SeqCst)
                || (value.contains("\"token\"") && self.fail_token_write.load(Ordering::SeqCst))
            {
                return Err(STORAGE_ERROR.into());
            }
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(STORAGE_ERROR.into());
            }
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct FakeState {
        identity: Option<(String, String)>,
        pairs: usize,
        revoked: Vec<String>,
        requests: Vec<(String, String, String)>,
        resumed: bool,
        wrong_owner: bool,
        redirect: bool,
        delay: bool,
    }
    struct Server {
        origin: Url,
        state: Arc<Mutex<FakeState>>,
        started: Arc<Notify>,
        release: Arc<Notify>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Server {
        async fn new() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let state = Arc::new(Mutex::new(FakeState {
                identity: Some(("account-a".into(), "session-a".into())),
                pairs: 0,
                revoked: vec![],
                requests: vec![],
                resumed: true,
                wrong_owner: false,
                redirect: false,
                delay: false,
            }));
            let shared = state.clone();
            let started = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let signal = started.clone();
            let resume = release.clone();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let state = shared.clone();
                    let started = signal.clone();
                    let release = resume.clone();
                    tokio::spawn(async move {
                        let service = service_fn(
                            move |request: hyper::Request<hyper::body::Incoming>| {
                                let state = state.clone();
                                let started = started.clone();
                                let release = release.clone();
                                async move {
                                    let path = request.uri().path().to_owned();
                                    let authorization = request
                                        .headers()
                                        .get("authorization")
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or("")
                                        .to_owned();
                                    let cookies = request
                                        .headers()
                                        .get("cookie")
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or("")
                                        .to_owned();
                                    let delay = {
                                        let mut state = state.lock().unwrap();
                                        state.requests.push((
                                            path.clone(),
                                            authorization.clone(),
                                            cookies,
                                        ));
                                        path == "/api/devices/pair" && state.delay
                                    };
                                    if delay {
                                        started.notify_one();
                                        release.notified().await;
                                    }
                                    let mut state = state.lock().unwrap();
                                    let (status, body) = match path.as_str() {
                                        "/api/auth/get-session" => (
                                            200,
                                            match &state.identity {
                                                Some((user, session)) => {
                                                    serde_json::json!({"user":{"id":user}, "session":{"id":session,"userId":user}})
                                                }
                                                None => serde_json::Value::Null,
                                            },
                                        ),
                                        "/api/devices/pair" if state.redirect => {
                                            (302, serde_json::json!({}))
                                        }
                                        "/api/devices/pair" => {
                                            state.pairs += 1;
                                            (
                                                201,
                                                serde_json::json!({"deviceId":format!("device-{}",state.pairs), "userId": if state.wrong_owner {"other"} else {state.identity.as_ref().unwrap().0.as_str()},"token":format!("test-token-{}",state.pairs)}),
                                            )
                                        }
                                        "/api/devices/self/session" => (
                                            if state.resumed { 204 } else { 401 },
                                            serde_json::Value::Null,
                                        ),
                                        "/api/devices/self" => {
                                            state.revoked.push(authorization);
                                            (204, serde_json::Value::Null)
                                        }
                                        _ => (404, serde_json::Value::Null),
                                    };
                                    let response = hyper::Response::builder()
                                        .status(status)
                                        .header("content-type", "application/json")
                                        .header("location", "http://127.0.0.1:1/never")
                                        .body(Full::new(Bytes::from(if status == 204 {
                                            String::new()
                                        } else {
                                            body.to_string()
                                        })))
                                        .unwrap();
                                    Ok::<_, std::convert::Infallible>(response)
                                }
                            },
                        );
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                            .await;
                    });
                }
            });
            Self {
                origin,
                state,
                started,
                release,
                task,
            }
        }
    }
    fn pairings(store: &Arc<MemoryStore>) -> Arc<Pairings> {
        Arc::new(Pairings {
            store: Store(store.clone()),
            servers: Mutex::default(),
        })
    }
    fn has_token(store: &MemoryStore) -> bool {
        store
            .values
            .lock()
            .unwrap()
            .values()
            .any(|value| value.contains("\"token\""))
    }

    #[tokio::test]
    async fn logout_invalidates_attempts_still_reading_native_cookies() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        let attempt = access.attempt(&server.origin).unwrap();
        access.clear(&server.origin).await.unwrap();
        access
            .sync(&server.origin, "fixture", || attempt.is_current())
            .await
            .unwrap();
        assert!(server.state.lock().unwrap().requests.is_empty());
        assert!(!has_token(&store));
    }

    #[tokio::test]
    async fn a_swapped_account_envelope_is_never_resumed() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        let key = credentials::key(&server.origin, Some("account-a"));
        let mut saved: serde_json::Value =
            serde_json::from_str(&store.values.lock().unwrap()[&key]).unwrap();
        saved["userId"] = serde_json::json!("account-b");
        store.values.lock().unwrap().insert(key, saved.to_string());
        assert_eq!(
            access
                .sync(&server.origin, "fixture", || true)
                .await
                .unwrap_err(),
            STORAGE_ERROR
        );
        assert!(!server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(path, _, _)| path == "/api/devices/self/session"));
        access.clear(&server.origin).await.unwrap();
        assert!(!has_token(&store));
    }

    #[tokio::test]
    async fn persists_and_resumes_only_the_authoritative_account_session() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let first = pairings(&store);
        first
            .sync(&server.origin, "session=fixture", || true)
            .await
            .unwrap();
        assert!(has_token(&store));
        let saved = first.binding(&server.origin).await.unwrap().unwrap();
        assert_eq!(saved.user_id, "account-a");
        assert!(first
            .credential(&server.origin, &saved)
            .await
            .unwrap()
            .is_some());
        let restarted = pairings(&store);
        restarted
            .sync(&server.origin, "session=fixture", || true)
            .await
            .unwrap();
        assert_eq!(server.state.lock().unwrap().pairs, 1);
        let state = server.state.lock().unwrap();
        assert!(state
            .requests
            .iter()
            .filter(|(path, _, _)| path == "/api/auth/get-session")
            .all(|(_, auth, cookies)| auth.is_empty() && cookies == "session=fixture"));
    }

    #[tokio::test]
    async fn account_or_session_switch_revokes_and_removes_the_previous_scope() {
        for next in [
            ("account-b", "session-b"),
            ("account-a", "replacement-session"),
        ] {
            let server = Server::new().await;
            let store = Arc::new(MemoryStore::default());
            let access = pairings(&store);
            access
                .sync(&server.origin, "fixture", || true)
                .await
                .unwrap();
            server.state.lock().unwrap().identity = Some((next.0.into(), next.1.into()));
            access
                .sync(&server.origin, "fixture", || true)
                .await
                .unwrap();
            {
                let state = server.state.lock().unwrap();
                assert_eq!(state.pairs, 2);
                assert_eq!(state.revoked, ["Bearer test-token-1"]);
            }
            if next.0 != "account-a" {
                assert!(!store
                    .values
                    .lock()
                    .unwrap()
                    .contains_key(&credentials::key(&server.origin, Some("account-a"))));
            }
            let saved = access.binding(&server.origin).await.unwrap().unwrap();
            assert_eq!((saved.user_id.as_str(), saved.session_id.as_str()), next);
        }
    }

    #[tokio::test]
    async fn server_scopes_are_independent_and_logout_keeps_a_failed_session_blocked() {
        let first = Server::new().await;
        let second = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        access
            .sync(&first.origin, "fixture", || true)
            .await
            .unwrap();
        access
            .sync(&second.origin, "fixture", || true)
            .await
            .unwrap();
        access.clear(&first.origin).await.unwrap();
        let restarted = pairings(&store);
        restarted
            .sync(&first.origin, "fixture", || true)
            .await
            .unwrap();
        assert_eq!(first.state.lock().unwrap().pairs, 1);
        assert_eq!(first.state.lock().unwrap().revoked, ["Bearer test-token-1"]);
        let binding = access.binding(&second.origin).await.unwrap().unwrap();
        assert!(access
            .credential(&second.origin, &binding)
            .await
            .unwrap()
            .is_some());
        assert!(first
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(path, _, _)| path == "/api/devices/self")
            .all(|(_, _, cookies)| cookies.is_empty()));
    }

    #[tokio::test]
    async fn remote_revocation_stays_blocked_until_a_new_session_and_signout_cleans_up() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        server.state.lock().unwrap().resumed = false;
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        assert_eq!(server.state.lock().unwrap().pairs, 1);
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        assert_eq!(server.state.lock().unwrap().pairs, 1);
        server.state.lock().unwrap().identity = Some(("account-a".into(), "new-session".into()));
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        assert_eq!(server.state.lock().unwrap().pairs, 2);
        server.state.lock().unwrap().identity = None;
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        assert!(!has_token(&store));
        assert_eq!(server.state.lock().unwrap().revoked.len(), 2);
    }

    #[tokio::test]
    async fn unavailable_storage_prevents_pairing_and_failed_persistence_revokes_the_new_token() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        store.unavailable.store(true, Ordering::SeqCst);
        assert!(access
            .sync(&server.origin, "fixture", || true)
            .await
            .is_err());
        assert!(server.state.lock().unwrap().requests.is_empty());
        store.unavailable.store(false, Ordering::SeqCst);
        store.fail_token_write.store(true, Ordering::SeqCst);
        assert!(access
            .sync(&server.origin, "fixture", || true)
            .await
            .is_err());
        assert!(!has_token(&store));
        assert_eq!(
            server.state.lock().unwrap().revoked,
            ["Bearer test-token-1"]
        );
    }

    #[tokio::test]
    async fn deletion_failure_still_revokes_and_blocks_and_can_be_retried() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        access
            .sync(&server.origin, "fixture", || true)
            .await
            .unwrap();
        store.fail_delete.store(true, Ordering::SeqCst);
        assert!(access.clear(&server.origin).await.is_err());
        assert!(
            access
                .binding(&server.origin)
                .await
                .unwrap()
                .unwrap()
                .blocked
        );
        assert_eq!(server.state.lock().unwrap().revoked.len(), 1);
        store.fail_delete.store(false, Ordering::SeqCst);
        access.clear(&server.origin).await.unwrap();
        assert!(!has_token(&store));
    }

    #[tokio::test]
    async fn delayed_pair_cannot_survive_logout_or_a_retired_document() {
        for logout in [true, false] {
            let server = Server::new().await;
            let store = Arc::new(MemoryStore::default());
            let access = pairings(&store);
            server.state.lock().unwrap().delay = true;
            let current = Arc::new(AtomicBool::new(true));
            let running = access.clone();
            let origin = server.origin.clone();
            let live = current.clone();
            let sync = tokio::spawn(async move {
                running
                    .sync(&origin, "fixture", || live.load(Ordering::SeqCst))
                    .await
            });
            server.started.notified().await;
            let clear = if logout {
                let running = access.clone();
                let origin = server.origin.clone();
                let clear = tokio::spawn(async move { running.clear(&origin).await });
                // Wait for the observable invalidation, without wall-clock sleeps.
                while access
                    .server(&server.origin)
                    .unwrap()
                    .generation
                    .load(Ordering::SeqCst)
                    == 0
                {
                    tokio::task::yield_now().await;
                }
                Some(clear)
            } else {
                current.store(false, Ordering::SeqCst);
                None
            };
            server.release.notify_one();
            assert!(sync.await.unwrap().is_err());
            if let Some(clear) = clear {
                clear.await.unwrap().unwrap();
            }
            assert!(!has_token(&store));
            assert_eq!(
                server.state.lock().unwrap().revoked,
                ["Bearer test-token-1"]
            );
        }
    }

    #[tokio::test]
    async fn rejects_wrong_owner_redirects_and_corrupt_entries() {
        let server = Server::new().await;
        let store = Arc::new(MemoryStore::default());
        let access = pairings(&store);
        server.state.lock().unwrap().wrong_owner = true;
        assert!(access
            .sync(&server.origin, "fixture", || true)
            .await
            .is_err());
        assert!(!has_token(&store));
        assert_eq!(
            server.state.lock().unwrap().revoked,
            ["Bearer test-token-1"]
        );
        server.state.lock().unwrap().redirect = true;
        assert!(access
            .sync(&server.origin, "fixture", || true)
            .await
            .is_err());
        store
            .values
            .lock()
            .unwrap()
            .insert(credentials::key(&server.origin, None), "invalid".into());
        assert_eq!(
            access
                .sync(&server.origin, "fixture", || true)
                .await
                .unwrap_err(),
            STORAGE_ERROR
        );
    }

    #[test]
    fn credentials_require_tls_outside_this_machine() {
        for origin in [
            "http://192.168.1.2",
            "http://server.local",
            "http://example.com",
            "https://user:secret@example.com",
        ] {
            assert!(secure_origin(&Url::parse(origin).unwrap()).is_err());
        }
        for origin in [
            "https://example.com",
            "http://localhost:4000",
            "http://127.0.0.1:4000",
            "http://[::1]:4000",
        ] {
            assert!(secure_origin(&Url::parse(origin).unwrap()).is_ok());
        }
    }
}
