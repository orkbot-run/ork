// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! Native transport for the existing server-owned host computer protocol.
//! Credentials never cross the WebView bridge. Consent lasts only for this app session.

use std::{
    convert::Infallible,
    fs,
    net::{Ipv4Addr, TcpListener},
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Body, Bytes, Frame, Incoming},
    Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch, Semaphore};

use crate::{
    host_runner::HostRunner,
    local_stack::{private_directory, read_owned_private, read_private, write_private},
};

const MAX_BODY: usize = 12 * 1024 * 1024;
type ResponseBody = http_body_util::combinators::UnsyncBoxBody<Bytes, Infallible>;

#[derive(Clone)]
pub struct Connection {
    pub url: String,
    pub token: String,
}

#[derive(Serialize, Deserialize)]
struct SavedConnection {
    token: String,
    port: u16,
}

#[derive(Default)]
struct Consent {
    owner: Option<String>,
    scope: Option<String>,
    allowed: bool,
    generation: u64,
}

pub struct HostComputer {
    pub connection: Connection,
    runner: HostRunner,
    consent: Mutex<Consent>,
    accepted_token: Arc<Mutex<String>>,
    scope_secret: String,
    shutdown: watch::Sender<bool>,
}

impl HostComputer {
    pub fn prepare(directory: &Path) -> Result<Self, String> {
        if !cfg!(unix) {
            return Err(
                "Host commands are not available on this platform in this desktop preview.".into(),
            );
        }
        private_directory(directory)?;
        let scope_file = directory.join("host-computer-scope-key");
        let scope_secret = match fs::symlink_metadata(&scope_file) {
            Ok(_) => read_owned_private(&scope_file, 64)
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|value| valid_token(value))
                .ok_or("Local computer settings are unavailable.")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let value = random_token()?;
                write_private(&scope_file, value.as_bytes())?;
                value
            }
            Err(_) => return Err("Local computer settings are unavailable.".into()),
        };
        let file = directory.join("host-computer.json");
        let saved = read_private(&file, 1024)
            .and_then(|bytes| serde_json::from_slice::<SavedConnection>(&bytes).ok())
            .filter(|saved| saved.port >= 1024 && valid_token(&saved.token));
        let port = saved.as_ref().map_or(0, |saved| saved.port);
        let mut token = saved.map(|saved| saved.token).unwrap_or(random_token()?);
        let listener = match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(listener) => listener,
            Err(error)
                if port != 0
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
                    ) =>
            {
                token = random_token()?;
                TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
                    .map_err(|_| "Local computer unavailable.")?
            }
            Err(_) => return Err("Local computer unavailable.".into()),
        };
        let port = listener
            .local_addr()
            .map_err(|_| "Local computer unavailable.")?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|_| "Local computer unavailable.")?;
        write_private(
            &file,
            &serde_json::to_vec(&SavedConnection {
                token: token.clone(),
                port,
            })
            .map_err(|_| "Local computer unavailable.")?,
        )?;
        let runner = HostRunner::new(directory.join("computers"));
        let (shutdown, cancel) = watch::channel(false);
        let accepted_token = Arc::new(Mutex::new(token.clone()));
        tauri::async_runtime::spawn(serve(
            listener,
            accepted_token.clone(),
            runner.clone(),
            cancel,
        ));
        Ok(Self {
            connection: Connection {
                url: format!("http://host.docker.internal:{port}"),
                token,
            },
            runner,
            consent: Mutex::new(Consent::default()),
            accepted_token,
            scope_secret,
            shutdown,
        })
    }

    /// The trusted legacy owner retains its existing credential; new scopes never share it.
    pub fn scoped_connection(&self, owner: &str, legacy: bool) -> Connection {
        if legacy {
            return self.connection.clone();
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(self.scope_secret.as_bytes())
            .expect("HMAC accepts a fixed native key");
        mac.update(b"orkbot-desktop-local-host-v1\0");
        mac.update(owner.as_bytes());
        let token = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Connection {
            url: self.connection.url.clone(),
            token,
        }
    }

    /// Switching authorization and retiring requests share the same lock as HTTP authentication.
    pub fn select_connection(&self, connection: &Connection) {
        let mut accepted = self
            .accepted_token
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *accepted != connection.token {
            self.activate(None);
            *accepted = connection.token.clone();
        }
    }

    pub fn activate(&self, owner: Option<String>) {
        let mut consent = self
            .consent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let scope = owner
            .as_deref()
            .and_then(|owner| owner.split_once(':'))
            .map(|(label, _)| label.to_owned());
        if consent.scope != scope || owner.is_none() {
            consent.allowed = false;
        }
        if consent.owner != owner {
            consent.generation += 1;
            self.runner.set_enabled(false);
            consent.owner = owner;
        }
        consent.scope = scope;
        self.runner
            .set_enabled(consent.owner.is_some() && consent.allowed);
    }

    /// A reload stops old requests but keeps this window's session consent for its next document.
    pub fn retire(&self, owner: &str) {
        let mut consent = self
            .consent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if consent.owner.as_deref() == Some(owner) {
            consent.generation += 1;
            consent.owner = None;
            self.runner.set_enabled(false);
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.runner.is_enabled()
    }

    /// A native prompt records its generation before opening; a later revoke invalidates it.
    pub fn intent(&self, owner: &str) -> Option<u64> {
        let consent = self
            .consent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (consent.owner.as_deref() == Some(owner)).then_some(consent.generation)
    }

    pub fn grant(&self, owner: &str, generation: u64) -> bool {
        let mut consent = self
            .consent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *self.shutdown.borrow()
            || consent.owner.as_deref() != Some(owner)
            || consent.generation != generation
        {
            return false;
        }
        consent.allowed = true;
        self.runner.set_enabled(true);
        true
    }

    /// A late native request may revoke only the document whose consent it captured.
    pub fn revoke_owner(&self, owner: &str) -> bool {
        let mut consent = self
            .consent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if consent.owner.as_deref() != Some(owner) {
            return false;
        }
        consent.generation += 1;
        consent.allowed = false;
        self.runner.set_enabled(false);
        true
    }

    #[cfg(test)]
    pub fn revoke(&self) {
        let mut consent = self
            .consent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        consent.generation += 1;
        consent.allowed = false;
        self.runner.set_enabled(false);
    }

    pub fn close(&self) {
        self.shutdown.send_replace(true);
        self.activate(None);
    }
}

impl Drop for HostComputer {
    fn drop(&mut self) {
        self.close();
    }
}

fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not secure local computer access.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn authorized(request: &Request<Incoming>, token: &str) -> bool {
    if request.headers().contains_key(hyper::header::ORIGIN) {
        return false;
    }
    let Some(credential) = request.headers().get(hyper::header::AUTHORIZATION) else {
        return false;
    };
    let actual = Sha256::digest(credential.as_bytes());
    let expected = Sha256::digest(format!("Bearer {token}").as_bytes());
    actual
        .iter()
        .zip(expected.iter())
        .fold(0, |diff, (a, b)| diff | (a ^ b))
        == 0
}

async fn serve(
    listener: TcpListener,
    token: Arc<Mutex<String>>,
    runner: HostRunner,
    mut shutdown: watch::Receiver<bool>,
) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    let connections = Arc::new(Semaphore::new(64));
    loop {
        let accepted = tokio::select! {
            _ = shutdown.changed() => break,
            result = listener.accept() => result,
        };
        let Ok((stream, _)) = accepted else {
            break;
        };
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            continue;
        };
        let token = token.clone();
        let runner = runner.clone();
        let mut cancel = shutdown.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                handle(request, token.clone(), runner.clone())
            });
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .max_headers(32)
                .max_buf_size(16 * 1024)
                .keep_alive(false);
            tokio::select! {
                _ = cancel.changed() => {},
                _ = builder.serve_connection(TokioIo::new(stream), service) => {},
            }
            drop(permit);
        });
    }
    runner.set_enabled(false);
}

fn empty(status: StatusCode) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()).boxed_unsync())
        .expect("valid response")
}

async fn handle(
    request: Request<Incoming>,
    token: Arc<Mutex<String>>,
    runner: HostRunner,
) -> Result<Response<ResponseBody>, Infallible> {
    let epoch = {
        let accepted = token.lock().unwrap_or_else(|error| error.into_inner());
        if !authorized(&request, &accepted) {
            return Ok(empty(StatusCode::UNAUTHORIZED));
        }
        if !runner.is_enabled() {
            return Ok(empty(StatusCode::FORBIDDEN));
        }
        runner.epoch()
    };
    if request.method() != hyper::Method::POST || request.uri() != "/computer" {
        return Ok(empty(StatusCode::NOT_FOUND));
    }
    let body = match tokio::time::timeout(
        Duration::from_secs(30),
        Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(_)) => return Ok(empty(StatusCode::PAYLOAD_TOO_LARGE)),
        Err(_) => return Ok(empty(StatusCode::REQUEST_TIMEOUT)),
    };
    let Ok(input) = serde_json::from_slice(&body) else {
        return Ok(empty(StatusCode::BAD_REQUEST));
    };
    let (sender, receiver) = mpsc::channel(8);
    let (cancel, cancelled) = watch::channel(false);
    tokio::spawn(async move {
        if let Err(message) = runner.run(input, sender.clone(), cancelled, epoch).await {
            let _ = sender.send(serde_json::json!({"error": message})).await;
        }
    });
    let body = Frames { receiver, cancel };
    Ok(Response::builder()
        .header(hyper::header::CONTENT_TYPE, "application/x-ndjson")
        .header(hyper::header::CACHE_CONTROL, "no-store")
        .body(body.boxed_unsync())
        .expect("valid response"))
}

struct Frames {
    receiver: mpsc::Receiver<serde_json::Value>,
    cancel: watch::Sender<bool>,
}

impl Body for Frames {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match self.receiver.poll_recv(cx) {
            Poll::Ready(Some(frame)) => {
                let mut bytes = serde_json::to_vec(&frame).expect("JSON frame");
                bytes.push(b'\n');
                Poll::Ready(Some(Ok(Frame::data(Bytes::from(bytes)))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn account_host_tokens_are_native_keyed_and_old_servers_cannot_use_new_consent() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        let first = host.scoped_connection(&"a".repeat(64), false);
        let second = host.scoped_connection(&"b".repeat(64), false);
        assert_ne!(first.token, second.token);
        assert_ne!(first.token, host.connection.token);
        assert_eq!(
            host.scoped_connection(&"a".repeat(64), false).token,
            first.token
        );
        assert_eq!(
            host.scoped_connection(&"a".repeat(64), true).token,
            host.connection.token
        );
        let mut legacy_mac =
            Hmac::<Sha256>::new_from_slice(host.connection.token.as_bytes()).unwrap();
        legacy_mac.update(b"orkbot-desktop-local-host-v1\0");
        legacy_mac.update("b".repeat(64).as_bytes());
        let forged: String = legacy_mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_ne!(forged, second.token);
        let url = host
            .connection
            .url
            .replace("host.docker.internal", "127.0.0.1")
            + "/computer";
        let client = reqwest::Client::new();
        host.select_connection(&first);
        host.activate(Some("server-a:document".into()));
        assert!(host.grant(
            "server-a:document",
            host.intent("server-a:document").unwrap()
        ));
        host.select_connection(&second);
        assert!(!host.is_enabled());
        host.activate(Some("server-b:document".into()));
        assert!(host.grant(
            "server-b:document",
            host.intent("server-b:document").unwrap()
        ));
        assert!(!host.revoke_owner("server-a:document"));
        assert!(host.is_enabled());
        for token in [&host.connection.token, &first.token, &forged] {
            assert_eq!(
                client
                    .post(&url)
                    .bearer_auth(token)
                    .body("invalid")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
        }
        assert_eq!(
            client
                .post(&url)
                .bearer_auth(&second.token)
                .body("invalid")
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        host.close();
        let reopened = HostComputer::prepare(root.path()).unwrap();
        assert_eq!(
            reopened.scoped_connection(&"b".repeat(64), false).token,
            second.token
        );
        reopened.close();
    }

    #[test]
    fn consent_is_scoped_to_the_live_document_and_revoke_invalidates_open_prompts() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        assert!(!host.is_enabled());
        assert_eq!(host.intent("server-2:other"), None);
        host.activate(Some("server-1:one".into()));
        let intent = host.intent("server-1:one").unwrap();
        host.revoke();
        assert!(!host.grant("server-1:one", intent));
        assert!(host.grant("server-1:one", host.intent("server-1:one").unwrap()));
        assert!(host.is_enabled());
        host.activate(Some("server-2:two".into()));
        assert!(!host.is_enabled());
        assert!(!host.grant("server-1:one", intent));
        host.close();
    }

    #[test]
    fn reload_cancels_old_work_but_only_the_same_window_keeps_session_consent() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        host.activate(Some("server-1:one".into()));
        host.grant("server-1:one", host.intent("server-1:one").unwrap());
        host.retire("server-1:one");
        assert!(!host.is_enabled());
        host.activate(Some("server-1:two".into()));
        assert!(host.is_enabled());
        host.activate(Some("server-2:three".into()));
        assert!(!host.is_enabled());
        host.close();
        assert!(!host.grant("server-2:three", 0));
    }

    #[tokio::test]
    async fn credential_auth_consent_and_existing_ndjson_contract() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        let url = host
            .connection
            .url
            .replace("host.docker.internal", "127.0.0.1")
            + "/computer";
        let client = reqwest::Client::new();
        for builder in [
            client.post(&url),
            client.post(&url).bearer_auth("wrong"),
            client
                .post(&url)
                .bearer_auth(&host.connection.token)
                .header("origin", ""),
        ] {
            assert_eq!(builder.send().await.unwrap().status(), 401);
        }
        let call = || {
            client
                .post(&url)
                .bearer_auth(&host.connection.token)
                .json(&serde_json::json!({"method":"environment","botId":"fixture"}))
        };
        assert_eq!(call().send().await.unwrap().status(), 403);
        host.activate(Some("fixture".into()));
        assert!(host.grant("fixture", host.intent("fixture").unwrap()));
        let response = call().send().await.unwrap();
        assert_eq!(response.status(), 200);
        let frames = response
            .text()
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert!(frames[0]["value"]["home"].is_string());
        assert_eq!(frames.last(), Some(&serde_json::json!({"done":true})));
        host.revoke();
        assert_eq!(call().send().await.unwrap().status(), 403);
    }

    #[tokio::test]
    async fn closing_http_response_stops_the_owned_command_group() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        host.activate(Some("fixture".into()));
        host.grant("fixture", host.intent("fixture").unwrap());
        let url = host
            .connection
            .url
            .replace("host.docker.internal", "127.0.0.1")
            + "/computer";
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let post = |input| {
            client
                .post(&url)
                .bearer_auth(&host.connection.token)
                .json(&input)
        };
        let provision = post(serde_json::json!({"method":"provision", "botId":"fixture"}))
            .send()
            .await
            .unwrap();
        assert!(provision.text().await.unwrap().contains("\"done\":true"));
        let mut response = post(serde_json::json!({"method":"execute", "botId":"fixture", "command":{"argv":["/bin/sh", "-c", "echo $$; sleep 60 & wait"]}})).send().await.unwrap();
        let pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let chunk = response.chunk().await.unwrap().unwrap();
                for line in std::str::from_utf8(&chunk).unwrap().lines() {
                    let frame: serde_json::Value = serde_json::from_str(line).unwrap();
                    if let Some(output) = frame["value"]["data"].as_str() {
                        return output.trim().parse::<i32>().unwrap();
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(unsafe { libc::kill(-pid, 0) }, 0);
        drop(response);
        tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(-pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("disconnect must stop the entire process group");
    }

    #[tokio::test]
    async fn revocation_also_invalidates_requests_still_reading_their_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        host.activate(Some("fixture".into()));
        host.grant("fixture", host.intent("fixture").unwrap());
        let origin = host
            .connection
            .url
            .replace("host.docker.internal", "127.0.0.1");
        reqwest::Client::new()
            .post(format!("{origin}/computer"))
            .bearer_auth(&host.connection.token)
            .json(&serde_json::json!({"method":"provision","botId":"fixture"}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let port = url::Url::parse(&origin).unwrap().port().unwrap();
        let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        let body = serde_json::json!({"method":"execute","botId":"fixture","command":{"argv":["/bin/sh","-c","touch should-not-exist"]}}).to_string();
        let headers = format!("POST /computer HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nExpect: 100-continue\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", host.connection.token, body.len());
        stream.write_all(headers.as_bytes()).await.unwrap();
        let mut accepted = [0; 25];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut accepted))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&accepted, b"HTTP/1.1 100 Continue\r\n\r\n");
        host.revoke();
        host.grant("fixture", host.intent("fixture").unwrap());
        stream.write_all(body.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.contains("Not allowed on this computer"));
        let workspace = root
            .path()
            .join("computers/desktop-computers")
            .join(format!("{:x}", Sha256::digest(b"fixture")));
        assert!(!workspace.join("should-not-exist").exists());
    }

    #[test]
    fn existing_server_adapter_runs_against_the_native_transport() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        host.activate(Some("fixture".into()));
        host.grant("fixture", host.intent("fixture").unwrap());
        let harness = r#"
import assert from 'node:assert/strict';
import { HostComputerSandbox } from '../../packages/adapters/src/host-computer-sandbox.ts';
const host = new HostComputerSandbox(process.env.ORK_TEST_HOST_URL, process.env.ORK_TEST_HOST_TOKEN);
const context = {operationId:'fixture',traceId:'fixture',spaceId:'fixture',userId:'fixture',runId:'fixture',signal:new AbortController().signal};
const ref = await host.provision({botId:'fixture',homePath:''}, context);
assert.equal(ref.botId, 'fixture');
assert.equal(ref.kind, 'desktop');
assert.match(ref.providerRef, /^host:[0-9a-f]{64}$/);
await host.prepare(ref, context);
assert.equal(await host.isRunning(ref, context), true);
assert.equal((await host.environment(ref, context)).platform, process.platform);
await host.workspaceDirectories(ref, {action:'ensure',paths:['bots/fixture']}, context);
const content = new Uint8Array([0, 255, 42]);
await host.writeFile(ref, {path:'bots/fixture/data.bin',content}, context);
assert.deepEqual(await host.readFile(ref, 'bots/fixture/data.bin', context), content);
assert.equal((await host.listFiles(ref, 'bots/fixture', context))[0].path, 'bots/fixture/data.bin');
const events = [];
for await (const event of host.execute(ref, {argv:['/bin/sh','-c',"printf fixture-output; printf fixture-error >&2; exit 7"]}, context)) events.push(event);
assert(events.some(event => event.type === 'stdout' && event.data === 'fixture-output'));
assert(events.some(event => event.type === 'stderr' && event.data === 'fixture-error'));
assert(events.some(event => event.type === 'exit' && event.code === 7));
assert(Number.isFinite(Date.parse((await host.snapshot(ref, context)).createdAt)));
const exported = [];
for await (const file of host.exportWorkspace(ref, context)) exported.push(file);
assert.equal(exported.length, 1);
assert.deepEqual(exported[0].content, content);
await host.workspaceDirectories(ref, {action:'remove',parent:'bots',names:['fixture']}, context);
assert.deepEqual(await host.workspaceDirectories(ref, {action:'list'}, context), []);
await host.stop(ref, context);
assert.equal(await host.isRunning(ref, context), false);
assert.equal((await host.provision({botId:'fixture',homePath:''}, context)).fresh, false);
await host.destroy(ref, context);
assert.equal(await host.isRunning(ref, context), false);
"#;
        let result = std::process::Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "-e", harness])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
            .env(
                "ORK_TEST_HOST_URL",
                host.connection
                    .url
                    .replace("host.docker.internal", "127.0.0.1"),
            )
            .env("ORK_TEST_HOST_TOKEN", &host.connection.token)
            .output()
            .expect("Node and workspace dependencies are required by tauri:prepare");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[tokio::test]
    async fn occupied_port_rotates_credentials_and_restart_requires_consent() {
        let root = tempfile::tempdir().unwrap();
        let host = HostComputer::prepare(root.path()).unwrap();
        let token = host.connection.token.clone();
        let another = HostComputer::prepare(root.path()).unwrap();
        assert_ne!(another.connection.token, token);
        assert_ne!(another.connection.url, host.connection.url);
        assert!(!another.is_enabled());
    }
}
