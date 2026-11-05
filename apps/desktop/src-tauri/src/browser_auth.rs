// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited browser-auth.ts and oauth-callback.ts, which remain Apache-2.0.
// The Rust implementation additions follow LICENSE.md.

use std::{
    collections::BTreeMap,
    convert::Infallible,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use http_body_util::Full;
use hyper::{
    body::Bytes,
    header::{
        CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HOST,
        REFERRER_POLICY, TRANSFER_ENCODING, X_CONTENT_TYPE_OPTIONS,
    },
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
    task::JoinSet,
};
use url::{Host, Position, Url};

const MAX_AUTHORIZATION_BYTES: usize = 16_384;
const MAX_OWNER_BYTES: usize = 512;
const MAX_ATTEMPTS: usize = 8;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_CONNECTIONS: usize = 16;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OAuthCallback {
    pub code: String,
    pub state: String,
}

/// The caller must revalidate this owner before delivering to a live, trusted app document.
pub type Callback = Arc<dyn Fn(&str, OAuthCallback) + Send + Sync>;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct AttemptKey {
    owner: String,
    authorization: String,
}

struct AttemptControl {
    id: u64,
    cancelled: AtomicBool,
    consumed: AtomicBool,
    cancel: watch::Sender<bool>,
}

impl AttemptControl {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel.send_replace(true);
    }
}

type Attempts = Arc<Mutex<BTreeMap<AttemptKey, Arc<AttemptControl>>>>;

/// Browser transport only. Providers own PKCE, token exchange, and account persistence.
pub struct BrowserAuth {
    attempts: Attempts,
    sequence: AtomicU64,
    on_callback: Callback,
    lifetime: Duration,
}

impl BrowserAuth {
    pub fn new(on_callback: Callback) -> Self {
        Self {
            attempts: Arc::new(Mutex::new(BTreeMap::new())),
            sequence: AtomicU64::new(0),
            on_callback,
            lifetime: ATTEMPT_LIFETIME,
        }
    }

    /// `owner` is a native window/document identity, never an identity supplied by remote JS.
    pub async fn open<F, Fut>(
        &self,
        owner: &str,
        authorization_url: &str,
        open_external: F,
    ) -> Result<(), String>
    where
        F: FnOnce(String) -> Fut + Send,
        Fut: Future<Output = Result<(), String>> + Send,
    {
        if owner.is_empty() || owner.len() > MAX_OWNER_BYTES {
            return Err("Invalid sign-in window.".into());
        }
        let authorization = Authorization::parse(authorization_url)?;
        let key = AttemptKey {
            owner: owner.to_owned(),
            authorization: authorization.url.as_str().to_owned(),
        };
        let (cancel, _) = watch::channel(false);
        let control = Arc::new(AttemptControl {
            id: self.sequence.fetch_add(1, Ordering::SeqCst),
            cancelled: AtomicBool::new(false),
            consumed: AtomicBool::new(false),
            cancel,
        });
        {
            let mut attempts = self
                .attempts
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if attempts.contains_key(&key) || attempts.len() >= MAX_ATTEMPTS {
                return Err("A sign-in attempt is already active. Cancel it and retry.".into());
            }
            attempts.insert(key.clone(), Arc::clone(&control));
        }
        let mut lease = AttemptLease::new(&self.attempts, &key, &control);

        let has_callback = authorization.callback.is_some();
        if let Some(callback) = authorization.callback {
            let listeners = tokio::select! {
                listeners = bind_callback(&callback.url, TcpListener::bind) => listeners?,
                _ = wait_cancelled(&control) => return Err("Sign-in cancelled.".into()),
            };
            if control.cancelled.load(Ordering::SeqCst) {
                return Err("Sign-in cancelled.".into());
            }
            let context = Arc::new(AttemptContext {
                key: key.clone(),
                registry: Arc::clone(&self.attempts),
                control: Arc::clone(&control),
                callback,
                on_callback: Arc::clone(&self.on_callback),
                connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            });
            tokio::spawn(run_attempt(listeners, context, self.lifetime));
        }

        tokio::select! {
            biased;
            _ = wait_cancelled(&control) => return Err("Sign-in cancelled.".into()),
            result = async { open_external(authorization.url.into()).await } => {
                result.map_err(|_| "Could not open the browser.")?;
            },
            _ = tokio::time::sleep(self.lifetime) => return Err("Sign-in expired. Retry to continue.".into()),
        }
        if control.cancelled.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled.".into());
        }
        if has_callback {
            lease.disarm();
        } else {
            lease.finish(false);
        }
        Ok(())
    }

    pub fn cancel_url(&self, owner: &str, authorization_url: &str) {
        if authorization_url.len() > MAX_AUTHORIZATION_BYTES {
            return;
        }
        let Ok(url) = Url::parse(authorization_url) else {
            return;
        };
        let key = AttemptKey {
            owner: owner.to_owned(),
            authorization: url.into(),
        };
        let control = self
            .attempts
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&key);
        if let Some(control) = control {
            control.cancel();
        }
    }

    pub fn cancel_owner(&self, owner: &str) {
        let controls = {
            let mut attempts = self
                .attempts
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let keys = attempts
                .keys()
                .filter(|key| key.owner == owner)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| attempts.remove(&key))
                .collect::<Vec<_>>()
        };
        for control in controls {
            control.cancel();
        }
    }

    pub fn cancel_all(&self) {
        let attempts = std::mem::take(
            &mut *self
                .attempts
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for (_, control) in attempts {
            control.cancel();
        }
    }
}

impl Drop for BrowserAuth {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

struct AttemptLease {
    registry: Attempts,
    key: AttemptKey,
    control: Arc<AttemptControl>,
    armed: bool,
}

impl AttemptLease {
    fn new(registry: &Attempts, key: &AttemptKey, control: &Arc<AttemptControl>) -> Self {
        Self {
            registry: Arc::clone(registry),
            key: key.clone(),
            control: Arc::clone(control),
            armed: true,
        }
    }

    fn finish(&mut self, cancel: bool) {
        let removed = {
            let mut registry = self
                .registry
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if registry
                .get(&self.key)
                .is_some_and(|control| control.id == self.control.id)
            {
                registry.remove(&self.key)
            } else {
                None
            }
        };
        if cancel {
            if let Some(control) = removed {
                control.cancel();
            }
        }
        self.armed = false;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for AttemptLease {
    fn drop(&mut self) {
        if self.armed {
            self.finish(true);
        }
    }
}

struct Authorization {
    url: Url,
    callback: Option<CallbackTarget>,
}

struct CallbackTarget {
    url: Url,
    host: String,
    state: String,
}

impl Authorization {
    fn parse(input: &str) -> Result<Self, String> {
        if input.is_empty() || input.len() > MAX_AUTHORIZATION_BYTES {
            return Err("Invalid sign-in request.".into());
        }
        let url = Url::parse(input).map_err(|_| "Sign-in requires an HTTPS URL.")?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err("Sign-in requires an HTTPS URL.".into());
        }
        let redirects = values(&url, "redirect_uri");
        if redirects.is_empty() {
            return Ok(Self {
                url,
                callback: None,
            });
        }
        if redirects.len() != 1 {
            return Err("Sign-in requires one loopback redirect and state.".into());
        }
        let states = values(&url, "state");
        let callback = Url::parse(&redirects[0])
            .map_err(|_| "Sign-in requires a loopback redirect and state.")?;
        if callback.scheme() != "http"
            || !loopback_callback(&callback)
            || callback.port().is_none_or(|port| port < 1024)
            || !callback.username().is_empty()
            || callback.password().is_some()
            || callback.query().is_some()
            || callback.fragment().is_some()
            || states.len() != 1
            || states[0].is_empty()
        {
            return Err("Sign-in requires a loopback redirect and state.".into());
        }
        let host = callback[Position::BeforeHost..Position::AfterPort].to_owned();
        Ok(Self {
            url,
            callback: Some(CallbackTarget {
                url: callback,
                host,
                state: states[0].clone(),
            }),
        })
    }
}

fn values(url: &Url, key: &str) -> Vec<String> {
    url.query_pairs()
        .filter(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
        .collect()
}

fn loopback_callback(url: &Url) -> bool {
    matches!(url.host(), Some(Host::Domain("localhost")))
        || matches!(url.host(), Some(Host::Ipv4(address)) if address == Ipv4Addr::LOCALHOST)
        || matches!(url.host(), Some(Host::Ipv6(address)) if address == Ipv6Addr::LOCALHOST)
}

async fn bind_callback<F, Fut>(url: &Url, mut bind: F) -> Result<Vec<TcpListener>, String>
where
    F: FnMut(SocketAddr) -> Fut,
    Fut: Future<Output = io::Result<TcpListener>>,
{
    let port = url
        .port()
        .ok_or("Sign-in requires a loopback redirect and state.")?;
    let localhost = matches!(url.host(), Some(Host::Domain("localhost")));
    let addresses = if localhost {
        vec![
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]
    } else {
        match url.host() {
            Some(Host::Ipv4(address)) => vec![IpAddr::V4(address)],
            Some(Host::Ipv6(address)) => vec![IpAddr::V6(address)],
            _ => return Err("Sign-in requires a loopback redirect and state.".into()),
        }
    };
    let mut listeners = Vec::new();
    for address in addresses {
        match bind(SocketAddr::new(address, port)).await {
            Ok(listener) => listeners.push(listener),
            Err(error) if localhost && unavailable_family(&error) => {}
            Err(_) => {
                return Err(
                    "Could not listen for sign-in. Close other sign-in attempts and retry.".into(),
                )
            }
        }
    }
    if listeners.is_empty() {
        return Err("No loopback address is available.".into());
    }
    Ok(listeners)
}

fn unavailable_family(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(error.raw_os_error(), Some(code) if code == libc::EAFNOSUPPORT || code == libc::EADDRNOTAVAIL)
    }
    #[cfg(windows)]
    {
        matches!(error.raw_os_error(), Some(10047 | 10049))
    }
}

struct AttemptContext {
    key: AttemptKey,
    registry: Attempts,
    control: Arc<AttemptControl>,
    callback: CallbackTarget,
    on_callback: Callback,
    connections: Arc<Semaphore>,
}

async fn wait_cancelled(control: &AttemptControl) {
    let mut cancel = control.cancel.subscribe();
    while !control.cancelled.load(Ordering::SeqCst) {
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn run_attempt(
    listeners: Vec<TcpListener>,
    context: Arc<AttemptContext>,
    lifetime: Duration,
) {
    let mut lease = AttemptLease::new(&context.registry, &context.key, &context.control);
    let (complete, mut completed) = watch::channel(false);
    let mut servers = JoinSet::new();
    for listener in listeners {
        servers.spawn(serve_listener(
            listener,
            Arc::clone(&context),
            complete.clone(),
        ));
    }
    let cancel = tokio::select! {
        _ = wait_cancelled(&context.control) => true,
        _ = tokio::time::sleep(lifetime) => true,
        _ = completed.changed() => false,
        _ = servers.join_next() => true,
    };
    servers.abort_all();
    while servers.join_next().await.is_some() {}
    lease.finish(cancel);
}

async fn serve_listener(
    listener: TcpListener,
    context: Arc<AttemptContext>,
    complete: watch::Sender<bool>,
) {
    let mut connections = JoinSet::new();
    loop {
        let permit = tokio::select! {
            permit = Arc::clone(&context.connections).acquire_owned() => match permit { Ok(permit) => permit, Err(_) => return },
            _ = wait_cancelled(&context.control) => return,
        };
        let stream = tokio::select! {
            result = listener.accept() => match result { Ok((stream, _)) => stream, Err(_) => return },
            _ = wait_cancelled(&context.control) => return,
        };
        while connections.try_join_next().is_some() {}
        let context = Arc::clone(&context);
        let complete = complete.clone();
        connections.spawn(async move {
            let _permit = permit;
            serve_connection(stream, context, complete).await;
        });
    }
}

async fn serve_connection(
    stream: TcpStream,
    context: Arc<AttemptContext>,
    complete: watch::Sender<bool>,
) {
    let pending = Arc::new(Mutex::new(None));
    let delivery = Arc::clone(&pending);
    let target = Arc::clone(&context);
    let service = service_fn(move |request| {
        let pending = Arc::clone(&pending);
        let target = Arc::clone(&target);
        async move {
            let callback = validate_callback(&request, &target.callback);
            if let Some(callback) = callback {
                if !target.control.cancelled.load(Ordering::SeqCst)
                    && target
                        .control
                        .consumed
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    *pending.lock().unwrap_or_else(|error| error.into_inner()) = Some(callback);
                    return Ok::<_, Infallible>(response(
                        StatusCode::OK,
                        "You can close this tab and return to Ork.",
                    ));
                }
            }
            Ok::<_, Infallible>(response(
                StatusCode::BAD_REQUEST,
                "Sign-in callback rejected. Return to Ork to retry.",
            ))
        }
    });
    let mut builder = http1::Builder::new();
    builder
        .keep_alive(false)
        .max_buf_size(MAX_HEADER_BYTES)
        .max_headers(32)
        .timer(TokioTimer::new())
        .header_read_timeout(CONNECTION_TIMEOUT);
    let connection = builder.serve_connection(TokioIo::new(stream), service);
    let finished = tokio::select! {
        result = tokio::time::timeout(CONNECTION_TIMEOUT, connection) => matches!(result, Ok(Ok(()))),
        _ = wait_cancelled(&context.control) => false,
    };
    let callback = delivery
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(callback) = callback {
        let active = context
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&context.key)
            .is_some_and(|control| control.id == context.control.id);
        if finished && active && !context.control.cancelled.load(Ordering::SeqCst) {
            (context.on_callback)(&context.key.owner, callback);
        }
        complete.send_replace(true);
    }
}

fn validate_callback<B>(request: &Request<B>, callback: &CallbackTarget) -> Option<OAuthCallback> {
    let mut hosts = request.headers().get_all(HOST).iter();
    if request.method() != Method::GET
        || hosts.next()?.to_str().ok()? != callback.host
        || hosts.next().is_some()
        || request.headers().contains_key(TRANSFER_ENCODING)
        || request
            .headers()
            .get(CONTENT_LENGTH)
            .is_some_and(|length| length.as_bytes() != b"0")
    {
        return None;
    }
    let target = callback.url.join(&request.uri().to_string()).ok()?;
    if target.origin() != callback.url.origin()
        || target.path() != callback.url.path()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.query_pairs().any(|(name, _)| name == "error")
    {
        return None;
    }
    let states = values(&target, "state");
    let codes = values(&target, "code");
    if states.len() != 1 || states[0] != callback.state || codes.len() != 1 || codes[0].is_empty() {
        return None;
    }
    Some(OAuthCallback {
        code: codes[0].clone(),
        state: states[0].clone(),
    })
}

fn response(status: StatusCode, body: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(REFERRER_POLICY, "no-referrer")
        .header(
            CONTENT_SECURITY_POLICY,
            "default-src 'none'; frame-ancestors 'none'",
        )
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Full::new(Bytes::from_static(body.as_bytes())))
        .expect("The fixed callback response is valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    struct Callbacks {
        values: Mutex<Vec<(String, OAuthCallback)>>,
        changed: tokio::sync::Notify,
    }

    impl Callbacks {
        async fn wait(&self) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if !self.values.lock().unwrap().is_empty() {
                        return;
                    }
                    self.changed.notified().await;
                }
            })
            .await
            .unwrap();
        }
    }

    fn fixture() -> (BrowserAuth, Arc<Callbacks>) {
        let callbacks = Arc::new(Callbacks::default());
        let captured = Arc::clone(&callbacks);
        let auth = BrowserAuth::new(Arc::new(move |owner, callback| {
            captured
                .values
                .lock()
                .unwrap()
                .push((owner.to_owned(), callback));
            captured.changed.notify_one();
        }));
        (auth, callbacks)
    }

    fn callback_url() -> Url {
        let reservation = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        Url::parse(&format!(
            "http://127.0.0.1:{}/callback",
            reservation.local_addr().unwrap().port()
        ))
        .unwrap()
    }

    fn authorization(callback: &Url) -> String {
        let mut url = Url::parse("https://provider.example.com/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("redirect_uri", callback.as_str())
            .append_pair("state", "test-state");
        url.into()
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    fn return_url(callback: &Url, query: &str) -> Url {
        let mut callback = callback.clone();
        callback.set_query(Some(query));
        callback
    }

    async fn wait_closed(callback: &Url) {
        let port = callback.port().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async move {
            loop {
                if TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .is_err()
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn raw_request(callback: &Url, request: &str) -> io::Result<String> {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut stream =
                TcpStream::connect((Ipv4Addr::LOCALHOST, callback.port().unwrap())).await?;
            stream.write_all(request.as_bytes()).await?;
            let mut response = Vec::new();
            stream.take(16 * 1024).read_to_end(&mut response).await?;
            Ok(String::from_utf8_lossy(&response).into_owned())
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Test callback timed out"))?
    }

    #[tokio::test]
    async fn listens_before_opening_the_browser_and_delivers_only_code_and_state_to_the_owner() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        let url = authorization(&callback);
        let request = return_url(&callback, "code=example-code&state=test-state");
        auth.open("window-a", &url, move |_| async move {
            let response = client().get(request).send().await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[REFERRER_POLICY], "no-referrer");
            assert_eq!(
                response.headers()[CONTENT_SECURITY_POLICY],
                "default-src 'none'; frame-ancestors 'none'"
            );
            let body = response.text().await.unwrap();
            assert!(!body.contains("example-code"));
            assert!(!body.contains("test-state"));
            Ok(())
        })
        .await
        .unwrap();
        callbacks.wait().await;
        {
            let values = callbacks.values.lock().unwrap();
            assert_eq!(
                values.as_slice(),
                &[(
                    "window-a".to_owned(),
                    OAuthCallback {
                        code: "example-code".to_owned(),
                        state: "test-state".to_owned()
                    }
                )]
            );
            assert_eq!(
                serde_json::to_value(&values[0].1).unwrap(),
                serde_json::json!({"code":"example-code","state":"test-state"})
            );
        }
        wait_closed(&callback).await;
        assert!(client()
            .get(return_url(&callback, "code=replay&state=test-state"))
            .send()
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejected_callbacks_do_not_consume_the_attempt() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        auth.open("window-a", &authorization(&callback), |_| async { Ok(()) })
            .await
            .unwrap();
        for query in [
            "code=x&state=wrong",
            "code=x&state=test-state&state=wrong",
            "code=x&code=y&state=test-state",
            "code=&state=test-state",
            "error=denied&state=test-state",
            "code=x&state=test-state&error=",
        ] {
            assert_eq!(
                client()
                    .get(return_url(&callback, query))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                400
            );
        }
        let mut wrong_path = return_url(&callback, "code=x&state=test-state");
        wrong_path.set_path("/callback/wrong");
        assert_eq!(client().get(wrong_path).send().await.unwrap().status(), 400);
        assert_eq!(
            client()
                .post(return_url(&callback, "code=x&state=test-state"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert_eq!(
            client()
                .get(return_url(&callback, "code=x&state=test-state"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        callbacks.wait().await;
        assert_eq!(callbacks.values.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn concurrent_valid_callbacks_are_consumed_only_once() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        auth.open("window-a", &authorization(&callback), |_| async { Ok(()) })
            .await
            .unwrap();
        let client = client();
        let first = client
            .get(return_url(&callback, "code=first-code&state=test-state"))
            .send();
        let second = client
            .get(return_url(&callback, "code=second-code&state=test-state"))
            .send();
        let (first, second) = tokio::join!(first, second);
        assert_eq!(
            [first, second]
                .iter()
                .filter(|response| response
                    .as_ref()
                    .is_ok_and(|response| response.status() == 200))
                .count(),
            1
        );
        callbacks.wait().await;
        assert_eq!(callbacks.values.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn host_headers_and_absolute_request_origins_must_match_exactly() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        auth.open("window-a", &authorization(&callback), |_| async { Ok(()) })
            .await
            .unwrap();
        let authority = &callback[Position::BeforeHost..Position::AfterPort];
        for request in [
            "GET /callback?code=x&state=test-state HTTP/1.1\r\nHost: unrelated.example.com\r\nConnection: close\r\n\r\n".to_owned(),
            format!("GET http://unrelated.example.com/callback?code=x&state=test-state HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"),
            format!("GET /callback?code=x&state=test-state HTTP/1.1\r\nHost: {authority}\r\nHost: {authority}\r\nConnection: close\r\n\r\n"),
        ] {
            if let Ok(response) = raw_request(&callback, &request).await { assert!(!response.starts_with("HTTP/1.1 200")); }
        }
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert_eq!(
            client()
                .get(return_url(&callback, "code=x&state=test-state"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        callbacks.wait().await;
    }

    #[tokio::test]
    async fn oversized_headers_are_rejected_without_consuming_an_attempt() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        auth.open("window-a", &authorization(&callback), |_| async { Ok(()) })
            .await
            .unwrap();
        let request = format!("GET /callback?code=oversized&state=test-state HTTP/1.1\r\nHost: {}\r\nX-Padding: {}\r\nConnection: close\r\n\r\n", &callback[Position::BeforeHost..Position::AfterPort], "x".repeat(MAX_HEADER_BYTES + 1));
        if let Ok(response) = raw_request(&callback, &request).await {
            assert!(!response.starts_with("HTTP/1.1 200"));
        }
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert_eq!(
            client()
                .get(return_url(&callback, "code=accepted&state=test-state"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        callbacks.wait().await;
    }

    #[tokio::test]
    async fn browser_failures_close_the_listener_and_hide_private_error_details() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        let error = auth
            .open("window-a", &authorization(&callback), |_| async {
                Err("private browser configuration".to_owned())
            })
            .await
            .unwrap_err();
        assert_eq!(error, "Could not open the browser.");
        wait_closed(&callback).await;
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert!(auth.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_is_scoped_to_the_window_and_authorization_url() {
        let (auth, callbacks) = fixture();
        let first = callback_url();
        let second = callback_url();
        auth.open("window-a", &authorization(&first), |_| async { Ok(()) })
            .await
            .unwrap();
        auth.open("window-b", &authorization(&second), |_| async { Ok(()) })
            .await
            .unwrap();
        auth.cancel_url("window-b", &authorization(&first));
        assert_eq!(auth.attempts.lock().unwrap().len(), 2);
        auth.cancel_owner("window-a");
        wait_closed(&first).await;
        assert_eq!(
            client()
                .get(return_url(&second, "code=second&state=test-state"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        callbacks.wait().await;
        assert_eq!(callbacks.values.lock().unwrap()[0].0, "window-b");
        assert_eq!(callbacks.values.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cancelling_a_pending_browser_open_releases_its_port_and_attempt() {
        let (auth, callbacks) = fixture();
        let auth = Arc::new(auth);
        let callback = callback_url();
        let url = authorization(&callback);
        let opened = Arc::new(tokio::sync::Notify::new());
        let entering = Arc::clone(&opened);
        let opening = {
            let auth = Arc::clone(&auth);
            tokio::spawn(async move {
                auth.open("window-a", &url, |_| async move {
                    entering.notify_one();
                    std::future::pending::<Result<(), String>>().await
                })
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), opened.notified())
            .await
            .unwrap();
        auth.cancel_owner("window-a");
        assert!(opening.await.unwrap().is_err());
        wait_closed(&callback).await;
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert!(auth.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropping_an_open_future_cancels_its_listener() {
        let (auth, callbacks) = fixture();
        let auth = Arc::new(auth);
        let callback = callback_url();
        let url = authorization(&callback);
        let opened = Arc::new(tokio::sync::Notify::new());
        let entering = Arc::clone(&opened);
        let opening = {
            let auth = Arc::clone(&auth);
            tokio::spawn(async move {
                auth.open("window-a", &url, |_| async move {
                    entering.notify_one();
                    std::future::pending::<Result<(), String>>().await
                })
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), opened.notified())
            .await
            .unwrap();
        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());
        wait_closed(&callback).await;
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert!(auth.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn completed_cancellation_cannot_remove_a_new_attempt_with_the_same_url() {
        let (auth, callbacks) = fixture();
        let callback = callback_url();
        let url = authorization(&callback);
        auth.open("window-a", &url, |_| async { Ok(()) })
            .await
            .unwrap();
        auth.cancel_url("window-a", &url);
        wait_closed(&callback).await;
        auth.open("window-a", &url, |_| async { Ok(()) })
            .await
            .unwrap();
        assert_eq!(
            client()
                .get(return_url(&callback, "code=new-attempt&state=test-state"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        callbacks.wait().await;
        assert_eq!(callbacks.values.lock().unwrap()[0].1.code, "new-attempt");
    }

    #[tokio::test]
    async fn duplicate_attempts_and_capacity_overflow_do_not_open_another_browser() {
        let (auth, _) = fixture();
        let first = callback_url();
        let first_url = authorization(&first);
        auth.open("window-a", &first_url, |_| async { Ok(()) })
            .await
            .unwrap();
        let opened = AtomicBool::new(false);
        assert!(auth
            .open("window-a", &first_url, |_| async {
                opened.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!opened.load(Ordering::SeqCst));
        let mut callbacks = vec![first];
        for _ in 1..MAX_ATTEMPTS {
            let callback = callback_url();
            auth.open("window-a", &authorization(&callback), |_| async { Ok(()) })
                .await
                .unwrap();
            callbacks.push(callback);
        }
        assert!(auth
            .open(
                "window-b",
                "https://provider.example.com/device",
                |_| async {
                    opened.store(true, Ordering::SeqCst);
                    Ok(())
                }
            )
            .await
            .is_err());
        assert!(!opened.load(Ordering::SeqCst));
        auth.cancel_all();
        for callback in callbacks {
            wait_closed(&callback).await;
        }
        assert!(auth.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn polling_flows_open_without_any_callback_listener() {
        let (auth, callbacks) = fixture();
        let opened = Arc::new(Mutex::new(None));
        let captured = Arc::clone(&opened);
        auth.open(
            "window-a",
            "https://provider.example.com/device",
            move |url| async move {
                *captured.lock().unwrap() = Some(url);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(
            opened.lock().unwrap().as_deref(),
            Some("https://provider.example.com/device")
        );
        assert!(auth.attempts.lock().unwrap().is_empty());
        assert!(callbacks.values.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn expiry_closes_all_listeners_without_delivering_a_callback() {
        let (mut auth, callbacks) = fixture();
        auth.lifetime = Duration::from_millis(40);
        let callback = callback_url();
        auth.open("window-a", &authorization(&callback), |_| async { Ok(()) })
            .await
            .unwrap();
        wait_closed(&callback).await;
        assert!(callbacks.values.lock().unwrap().is_empty());
        assert!(auth.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_occupied_callback_port_never_opens_the_browser() {
        let (auth, _) = fixture();
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let callback = Url::parse(&format!(
            "http://{}/callback",
            occupied.local_addr().unwrap()
        ))
        .unwrap();
        let opened = AtomicBool::new(false);
        assert!(auth
            .open("window-a", &authorization(&callback), |_| async {
                opened.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!opened.load(Ordering::SeqCst));
        assert!(auth.attempts.lock().unwrap().is_empty());
    }

    #[test]
    fn authorization_validation_rejects_unsafe_urls_and_ambiguous_parameters() {
        for input in [
            "",
            "http://provider.example.com/authorize",
            "file:///tmp/auth",
            "javascript:alert(1)",
            "https://user:secret@provider.example.com/authorize",
        ] {
            assert!(Authorization::parse(input).is_err(), "{input}");
        }
        assert!(Authorization::parse(&format!(
            "https://provider.example.com/{}",
            "x".repeat(MAX_AUTHORIZATION_BYTES)
        ))
        .is_err());
        for redirect in [
            "https://remote.example.com/callback",
            "http://0.0.0.0:54321/callback",
            "http://127.0.0.1:80/callback",
            "http://localhost:54321/callback?other=x",
            "http://localhost:54321/callback#part",
            "http://user:secret@localhost:54321/callback",
            "http://app.localhost:54321/callback",
            "http://localhost.:54321/callback",
            "http://127.0.0.2:54321/callback",
        ] {
            let callback = Url::parse(redirect).unwrap();
            assert!(
                Authorization::parse(&authorization(&callback)).is_err(),
                "{redirect}"
            );
        }
        let callback = callback_url();
        let mut url = Url::parse(&authorization(&callback)).unwrap();
        url.query_pairs_mut().append_pair("state", "duplicate");
        assert!(Authorization::parse(url.as_str()).is_err());
        let mut url = Url::parse(&authorization(&callback)).unwrap();
        url.query_pairs_mut()
            .append_pair("redirect_uri", callback.as_str());
        assert!(Authorization::parse(url.as_str()).is_err());
        let mut url = Url::parse("https://provider.example.com/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("redirect_uri", callback.as_str());
        assert!(Authorization::parse(url.as_str()).is_err());
        url.query_pairs_mut().append_pair("state", "");
        assert!(Authorization::parse(url.as_str()).is_err());
        assert!(Authorization::parse(
            "https://provider.example.com/authorize?redirect_uri=&state=x"
        )
        .is_err());
    }

    fn unavailable_error() -> io::Error {
        #[cfg(unix)]
        {
            io::Error::from_raw_os_error(libc::EAFNOSUPPORT)
        }
        #[cfg(windows)]
        {
            io::Error::from_raw_os_error(10047)
        }
    }

    #[tokio::test]
    async fn localhost_skips_only_an_unavailable_address_family() {
        let callback = Url::parse("http://localhost:54321/callback").unwrap();
        for unavailable_v4 in [true, false] {
            let listeners = bind_callback(&callback, move |address| async move {
                if address.is_ipv4() == unavailable_v4 {
                    Err(unavailable_error())
                } else {
                    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await
                }
            })
            .await
            .unwrap();
            assert_eq!(listeners.len(), 1);
        }
        assert!(
            bind_callback(&callback, |_| async { Err(unavailable_error()) })
                .await
                .is_err()
        );
        assert!(bind_callback(&callback, |_| async {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "test permission",
            ))
        })
        .await
        .is_err());
    }

    #[tokio::test]
    async fn a_conflict_in_one_localhost_family_closes_the_other_listener() {
        let callback = callback_url();
        let mut local = callback.clone();
        local.set_host(Some("localhost")).unwrap();
        let error = bind_callback(&local, |address| async move {
            if address.is_ipv6() {
                Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "occupied test address",
                ))
            } else {
                TcpListener::bind(address).await
            }
        })
        .await;
        assert!(error.is_err());
        assert!(
            TcpListener::bind((Ipv4Addr::LOCALHOST, callback.port().unwrap()))
                .await
                .is_ok()
        );
    }

    #[test]
    fn ipv6_loopback_callbacks_validate_without_expanding_the_host_allowlist() {
        let callback = Url::parse("http://[::1]:54321/callback").unwrap();
        let parsed = Authorization::parse(&authorization(&callback)).unwrap();
        assert_eq!(parsed.callback.unwrap().host, "[::1]:54321");
        for host in ["[::]", "[::ffff:127.0.0.1]", "[fc00::1]"] {
            let callback = Url::parse(&format!("http://{host}:54321/callback")).unwrap();
            assert!(Authorization::parse(&authorization(&callback)).is_err());
        }
    }
}
