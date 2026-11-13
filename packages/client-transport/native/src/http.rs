// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Method, Request, Uri};
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use rustls::ClientConfig;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::task::AbortHandle;
use tokio_rustls::TlsConnector;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{client_config, verify_peer, TransportError, BUFFER_LIMIT, MAX_CHUNK};

#[derive(Clone, uniffi::Record)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, uniffi::Record)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<HttpHeader>,
    pub has_body: bool,
}

impl HttpRequest {
    /// Apply the same HTTP policy before opening a network channel or retaining an IPC request.
    pub fn validate(&self) -> Result<(), TransportError> {
        let (_, receiver) = mpsc::channel(1);
        request("installation.invalid", self.clone(), Upload { receiver })?;
        Ok(())
    }
}

#[derive(Clone, uniffi::Record)]
pub struct HttpResponseHead {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
}

struct Upload {
    receiver: mpsc::Receiver<Bytes>,
}

impl Body for Upload {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.receiver
            .poll_recv(cx)
            .map(|value| value.map(|bytes| Ok(Frame::data(bytes))))
    }

    fn is_end_stream(&self) -> bool {
        self.receiver.is_closed() && self.receiver.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        if self.is_end_stream() {
            SizeHint::with_exact(0)
        } else {
            SizeHint::default()
        }
    }
}

#[derive(Default)]
struct ResponseBody {
    body: Option<Incoming>,
    pending: Bytes,
    finished: bool,
}

#[derive(Default)]
struct State {
    started: AtomicBool,
    canceled: CancellationToken,
    drivers: StdMutex<Vec<AbortHandle>>,
    head: Mutex<Option<Result<HttpResponseHead, TransportError>>>,
    head_ready: Notify,
    body: Mutex<ResponseBody>,
    upload: Mutex<Option<mpsc::Sender<Bytes>>>,
}

impl State {
    async fn until_canceled<T>(
        &self,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, TransportError> {
        tokio::select! {
            biased;
            _ = self.canceled.cancelled() => Err(TransportError::Canceled),
            result = operation => Ok(result),
        }
    }

    fn register(&self, handle: AbortHandle) {
        let Ok(mut drivers) = self.drivers.lock() else {
            handle.abort();
            self.canceled.cancel();
            self.head_ready.notify_waiters();
            return;
        };
        if self.canceled.is_cancelled() {
            handle.abort();
        } else {
            drivers.push(handle);
        }
    }

    fn stop_drivers(&self) {
        if let Ok(drivers) = self.drivers.lock() {
            for driver in drivers.iter() {
                driver.abort();
            }
        }
    }

    fn cancel(&self) {
        self.canceled.cancel();
        self.stop_drivers();
        self.head_ready.notify_waiters();
    }

    async fn fail(&self, error: TransportError) {
        let mut head = self.head.lock().await;
        if head.is_none() {
            *head = Some(Err(error));
        }
        self.head_ready.notify_waiters();
        self.stop_drivers();
    }
}

/// One request per encrypted channel. Platform sockets carry bytes without seeing HTTP content.
#[derive(uniffi::Object)]
pub struct InstallationHttp {
    config: Arc<ClientConfig>,
    name: ServerName<'static>,
    fingerprint: String,
    authority: String,
    socket: Mutex<Option<DuplexStream>>,
    outgoing: Mutex<ReadHalf<DuplexStream>>,
    incoming: Mutex<WriteHalf<DuplexStream>>,
    state: Arc<State>,
}

impl Drop for InstallationHttp {
    fn drop(&mut self) {
        self.state.cancel();
    }
}

fn request(
    origin: &str,
    input: HttpRequest,
    body: Upload,
) -> Result<Request<Upload>, TransportError> {
    if input.path.len() > 16 * 1024
        || !input.path.starts_with('/')
        || input.path.starts_with("//")
        || input.method.len() > 20
        || input.headers.len() > 64
        || input
            .headers
            .iter()
            .map(|header| header.name.len() + header.value.len())
            .sum::<usize>()
            > 32 * 1024
    {
        return Err(TransportError::InvalidRequest);
    }
    let uri = input
        .path
        .parse::<Uri>()
        .map_err(|_| TransportError::InvalidRequest)?;
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err(TransportError::InvalidRequest);
    }
    let method =
        Method::from_bytes(input.method.as_bytes()).map_err(|_| TransportError::InvalidRequest)?;
    let mut request = Request::builder().method(method).uri(uri);
    for header in input.headers {
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|_| TransportError::InvalidRequest)?;
        if matches!(
            name.as_str(),
            "host"
                | "origin"
                | "connection"
                | "upgrade"
                | "content-length"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "proxy-connection"
                | "te"
                | "trailer"
                | "keep-alive"
                | "accept-encoding"
        ) {
            return Err(TransportError::InvalidRequest);
        }
        let value =
            HeaderValue::from_str(&header.value).map_err(|_| TransportError::InvalidRequest)?;
        request = request.header(name, value);
    }
    request
        .header("host", origin)
        .header("origin", "orkbot://")
        .header("accept-encoding", "identity")
        .body(body)
        .map_err(|_| TransportError::InvalidRequest)
}

#[uniffi::export(async_runtime = "tokio")]
impl InstallationHttp {
    #[uniffi::constructor]
    pub fn new(
        certificate: Vec<u8>,
        key_fingerprint: String,
        origin: String,
    ) -> Result<Arc<Self>, TransportError> {
        let url = Url::parse(&origin).map_err(|_| TransportError::InvalidRequest)?;
        if url.origin().ascii_serialization() != origin
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https"
                || (url.scheme() == "http" && crate::local_http_host(&url)))
        {
            return Err(TransportError::InvalidRequest);
        }
        let (config, name) = client_config(certificate, &key_fingerprint)?;
        let (inside, outside) = tokio::io::duplex(BUFFER_LIMIT);
        let (outgoing, incoming) = tokio::io::split(outside);
        Ok(Arc::new(Self {
            config,
            name,
            fingerprint: key_fingerprint,
            authority: url[url::Position::BeforeHost..url::Position::AfterPort].into(),
            socket: Mutex::new(Some(inside)),
            outgoing: Mutex::new(outgoing),
            incoming: Mutex::new(incoming),
            state: Arc::new(State::default()),
        }))
    }

    pub async fn start_request(&self, input: HttpRequest) -> Result<(), TransportError> {
        if self.state.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        let (sender, receiver) = mpsc::channel(2);
        let has_body = input.has_body;
        let request = request(&self.authority, input, Upload { receiver })?;
        let socket = self
            .socket
            .lock()
            .await
            .take()
            .ok_or(TransportError::AlreadyStarted)?;
        if has_body {
            *self.state.upload.lock().await = Some(sender);
        } else {
            drop(sender);
        }
        self.state.started.store(true, Ordering::SeqCst);
        let state = self.state.clone();
        let config = self.config.clone();
        let name = self.name.clone();
        let fingerprint = self.fingerprint.clone();
        let task = tokio::spawn(async move {
            if let Err(error) =
                execute(socket, config, name, fingerprint, request, state.clone()).await
            {
                state.fail(error).await;
            }
        });
        self.state.register(task.abort_handle());
        Ok(())
    }

    pub async fn take_encrypted(&self) -> Result<Option<Vec<u8>>, TransportError> {
        let mut bytes = vec![0; BUFFER_LIMIT];
        let result = self
            .state
            .until_canceled(async { self.outgoing.lock().await.read(&mut bytes).await })
            .await;
        let count = match result {
            Err(TransportError::Canceled) => return Ok(None),
            Err(error) => return Err(error),
            Ok(result) => result.map_err(|_| TransportError::Closed)?,
        };
        if count == 0 || self.state.canceled.is_cancelled() {
            return Ok(None);
        }
        bytes.truncate(count);
        Ok(Some(bytes))
    }

    pub async fn put_encrypted(&self, bytes: Vec<u8>) -> Result<(), TransportError> {
        if bytes.len() > MAX_CHUNK {
            return Err(TransportError::ChunkTooLarge);
        }
        if self.state.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        // Cancellation permanently closes this operation; a partial write is never retried.
        self.state
            .until_canceled(async { self.incoming.lock().await.write_all(&bytes).await })
            .await?
            .map_err(|_| TransportError::Closed)
    }

    pub async fn finish_incoming(&self) -> Result<(), TransportError> {
        self.state
            .until_canceled(async { self.incoming.lock().await.shutdown().await })
            .await?
            .map_err(|_| TransportError::Closed)
    }

    pub async fn write_body(&self, bytes: Vec<u8>) -> Result<(), TransportError> {
        if bytes.len() > BUFFER_LIMIT {
            return Err(TransportError::ChunkTooLarge);
        }
        if self.state.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        if !self.state.started.load(Ordering::SeqCst) {
            return Err(TransportError::NotStarted);
        }
        if bytes.is_empty() {
            return Ok(());
        }
        self.state
            .until_canceled(async {
                self.state
                    .upload
                    .lock()
                    .await
                    .as_ref()
                    .ok_or(TransportError::Closed)?
                    .send(Bytes::from(bytes))
                    .await
                    .map_err(|_| TransportError::Closed)
            })
            .await?
    }

    pub async fn finish_body(&self) -> Result<(), TransportError> {
        if !self.state.started.load(Ordering::SeqCst) {
            return Err(TransportError::NotStarted);
        }
        self.state
            .until_canceled(async {
                self.state.upload.lock().await.take();
            })
            .await
    }

    pub async fn response_head(&self) -> Result<HttpResponseHead, TransportError> {
        if self.state.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        if !self.state.started.load(Ordering::SeqCst) {
            return Err(TransportError::NotStarted);
        }
        loop {
            let ready = self.state.head_ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if self.state.canceled.is_cancelled() {
                return Err(TransportError::Canceled);
            }
            if let Some(head) = self.state.head.lock().await.as_ref() {
                return head.clone();
            }
            ready.await;
        }
    }

    pub async fn read_body(&self) -> Result<Option<Vec<u8>>, TransportError> {
        self.state
            .until_canceled(async {
                let mut response = self.state.body.lock().await;
                loop {
                    if !response.pending.is_empty() {
                        let length = response.pending.len().min(BUFFER_LIMIT);
                        return Ok(Some(response.pending.split_to(length).to_vec()));
                    }
                    if response.finished {
                        return Ok(None);
                    }
                    let body = response.body.as_mut().ok_or(TransportError::NotStarted)?;
                    match body.frame().await {
                        Some(Ok(frame)) => {
                            if let Ok(data) = frame.into_data() {
                                response.pending = data;
                            }
                        }
                        None => {
                            response.finished = true;
                            response.body = None;
                            self.state.stop_drivers();
                            return Ok(None);
                        }
                        Some(Err(_)) => {
                            response.finished = true;
                            response.body = None;
                            self.state.stop_drivers();
                            return Err(TransportError::HttpRefused);
                        }
                    }
                }
            })
            .await?
    }

    pub fn cancel(&self) {
        self.state.cancel();
    }
}

async fn execute(
    socket: DuplexStream,
    config: Arc<ClientConfig>,
    name: ServerName<'static>,
    fingerprint: String,
    request: Request<Upload>,
    state: Arc<State>,
) -> Result<(), TransportError> {
    let connector = TlsConnector::from(config);
    let stream = tokio::time::timeout(
        Duration::from_secs(8),
        connector.connect_with(name, socket, |connection| {
            connection.set_buffer_limit(Some(BUFFER_LIMIT))
        }),
    )
    .await
    .map_err(|_| TransportError::TlsRefused)?
    .map_err(|_| TransportError::TlsRefused)?;
    verify_peer(stream.get_ref().1, &fingerprint)?;
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_headers(64)
        .max_buf_size(32 * 1024)
        .handshake(TokioIo::new(stream))
        .await
        .map_err(|_| TransportError::HttpRefused)?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    state.register(driver.abort_handle());
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| TransportError::HttpRefused)?;
    let head = HttpResponseHead {
        status: response.status().as_u16(),
        headers: response
            .headers()
            .iter()
            .map(|(name, value)| {
                Ok(HttpHeader {
                    name: name.to_string(),
                    value: value
                        .to_str()
                        .map_err(|_| TransportError::HttpRefused)?
                        .into(),
                })
            })
            .collect::<Result<Vec<_>, TransportError>>()?,
    };
    state.body.lock().await.body = Some(response.into_body());
    *state.head.lock().await = Some(Ok(head));
    state.head_ready.notify_waiters();
    Ok(())
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
