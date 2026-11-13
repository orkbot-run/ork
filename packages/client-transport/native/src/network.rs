// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::ServerName;
use rustls::ClientConfig;
use rustls_platform_verifier::BuilderVerifierExt;
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::task::AbortHandle;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{http::HeaderValue, Message};
use tokio_tungstenite::{client_async_with_config, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    HttpRequest, HttpResponseHead, InstallationHttp, TransportError, BUFFER_LIMIT, MAX_CHUNK,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    protocol: String,
    server_id: String,
    binding_version: u64,
    key_fingerprint: String,
    certificate: String,
}

/// Bound the HTTP upgrade response before the WebSocket library starts enforcing frame limits.
struct BootstrapStream {
    stream: MaybeTlsStream<TcpStream>,
    remaining: Option<usize>,
}

impl AsyncRead for BootstrapStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.remaining == Some(0) {
            return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
        }
        let before = output.filled().len();
        let result = Pin::new(&mut self.stream).poll_read(cx, output);
        if let Some(remaining) = &mut self.remaining {
            let count = output.filled().len() - before;
            if count > *remaining {
                return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
            }
            *remaining -= count;
        }
        result
    }
}

impl AsyncWrite for BootstrapStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, input)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

type Socket = WebSocketStream<BootstrapStream>;

async fn socket(address: &Url) -> Result<Socket, TransportError> {
    let host = address.host_str().ok_or(TransportError::InvalidRequest)?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let tcp = TcpStream::connect((
        host,
        address
            .port_or_known_default()
            .ok_or(TransportError::InvalidRequest)?,
    ))
    .await
    .map_err(|_| TransportError::NetworkRefused)?;
    tcp.set_nodelay(true)
        .map_err(|_| TransportError::NetworkRefused)?;
    let stream = if address.scheme() == "wss" {
        let mut config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13])
                .map_err(|_| TransportError::TlsRefused)?
                .with_platform_verifier()
                .map_err(|_| TransportError::TlsRefused)?
                .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        config.enable_early_data = false;
        config.resumption = rustls::client::Resumption::disabled();
        let name =
            ServerName::try_from(host.to_owned()).map_err(|_| TransportError::InvalidRequest)?;
        MaybeTlsStream::Rustls(
            TlsConnector::from(Arc::new(config))
                .connect(name, tcp)
                .await
                .map_err(|_| TransportError::TlsRefused)?,
        )
    } else {
        MaybeTlsStream::Plain(tcp)
    };
    let mut request = address
        .as_str()
        .into_client_request()
        .map_err(|_| TransportError::InvalidRequest)?;
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_static("orkbot://"));
    let config = WebSocketConfig::default()
        .read_buffer_size(BUFFER_LIMIT)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_CHUNK)
        .max_frame_size(Some(MAX_CHUNK))
        .max_message_size(Some(MAX_CHUNK));
    let (mut socket, _) = client_async_with_config(
        request,
        BootstrapStream {
            stream,
            remaining: Some(64 * 1024),
        },
        Some(config),
    )
    .await
    .map_err(|_| TransportError::NetworkRefused)?;
    socket.get_mut().remaining = None;
    Ok(socket)
}

/// The same bounded socket and pinned HTTP implementation runs on every native platform.
#[derive(uniffi::Object)]
pub struct InstallationConnection {
    origin: String,
    address: Url,
    server_id: String,
    binding_version: u64,
    fingerprint: String,
    started: AtomicBool,
    canceled: CancellationToken,
    inner: Mutex<Option<Arc<InstallationHttp>>>,
    drivers: Mutex<Vec<AbortHandle>>,
}

impl Drop for InstallationConnection {
    fn drop(&mut self) {
        self.cancel();
    }
}

impl InstallationConnection {
    fn register(&self, handle: AbortHandle) {
        let mut drivers = self
            .drivers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.canceled.is_cancelled() {
            handle.abort();
        } else {
            drivers.push(handle);
        }
    }
    fn stop_drivers(&self) {
        for handle in self
            .drivers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
        {
            handle.abort();
        }
    }
    fn operation(&self) -> Result<Arc<InstallationHttp>, TransportError> {
        if self.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        self.inner
            .lock()
            .map_err(|_| TransportError::Closed)?
            .clone()
            .ok_or(TransportError::NotStarted)
    }
    async fn connect(&self) -> Result<Socket, TransportError> {
        let mut socket = socket(&self.address).await?;
        let message = socket
            .next()
            .await
            .ok_or(TransportError::NetworkRefused)?
            .map_err(|_| TransportError::NetworkRefused)?;
        let Message::Text(text) = message else {
            return Err(TransportError::InvalidIdentity);
        };
        if text.len() > 32 * 1024 {
            return Err(TransportError::InvalidIdentity);
        }
        let identity: Identity =
            serde_json::from_str(&text).map_err(|_| TransportError::InvalidIdentity)?;
        if identity.protocol != "ork-installation-tls-v1"
            || identity.server_id != self.server_id
            || identity.binding_version != self.binding_version
            || identity.key_fingerprint != self.fingerprint
            || identity.certificate.len() > 22 * 1024
        {
            return Err(TransportError::InvalidIdentity);
        }
        let certificate = STANDARD
            .decode(identity.certificate)
            .map_err(|_| TransportError::InvalidIdentity)?;
        let operation =
            InstallationHttp::new(certificate, self.fingerprint.clone(), self.origin.clone())?;
        if self.canceled.is_cancelled() {
            operation.cancel();
            return Err(TransportError::Canceled);
        }
        *self.inner.lock().map_err(|_| TransportError::Closed)? = Some(operation);
        Ok(socket)
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;

#[uniffi::export(async_runtime = "tokio")]
impl InstallationConnection {
    #[uniffi::constructor]
    pub fn new(
        origin: String,
        server_id: String,
        binding_version: u64,
        key_fingerprint: String,
    ) -> Result<Arc<Self>, TransportError> {
        let mut address = Url::parse(&origin).map_err(|_| TransportError::InvalidRequest)?;
        if address.origin().ascii_serialization() != origin
            || !address.username().is_empty()
            || address.password().is_some()
            || address.query().is_some()
            || address.fragment().is_some()
            || !(address.scheme() == "https"
                || (address.scheme() == "http"
                    && matches!(address.host_str(), Some("127.0.0.1" | "[::1]"))))
            || uuid::Uuid::parse_str(&server_id)
                .map(|id| id.to_string() != server_id)
                .unwrap_or(true)
            || binding_version == 0
            || binding_version > 9_007_199_254_740_991
        {
            return Err(TransportError::InvalidRequest);
        }
        crate::installation_name(&key_fingerprint)?;
        let scheme = if address.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        address
            .set_scheme(scheme)
            .map_err(|_| TransportError::InvalidRequest)?;
        address.set_path("/api/installation-transport/v1");
        Ok(Arc::new(Self {
            origin,
            address,
            server_id,
            binding_version,
            fingerprint: key_fingerprint,
            started: AtomicBool::new(false),
            canceled: CancellationToken::new(),
            inner: Mutex::new(None),
            drivers: Mutex::new(Vec::new()),
        }))
    }

    pub async fn start_request(&self, request: HttpRequest) -> Result<(), TransportError> {
        if self.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(TransportError::AlreadyStarted);
        }
        let connected = tokio::select! {
            biased;
            _ = self.canceled.cancelled() => Err(TransportError::Canceled),
            result = tokio::time::timeout(Duration::from_secs(8), self.connect()) =>
                result.map_err(|_| TransportError::NetworkRefused).and_then(|result| result),
        };
        let socket = match connected {
            Ok(socket) => socket,
            Err(error) => {
                self.cancel();
                return Err(error);
            }
        };
        let operation = match self.operation() {
            Ok(operation) => operation,
            Err(error) => {
                self.cancel();
                return Err(error);
            }
        };
        let (writer, mut reader) = socket.split();
        let writer = Arc::new(tokio::sync::Mutex::new(writer));
        let outgoing = writer.clone();
        let output = operation.clone();
        self.register(
            tokio::spawn(async move {
                while let Ok(Some(bytes)) = output.take_encrypted().await {
                    if outgoing
                        .lock()
                        .await
                        .send(Message::Binary(bytes.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                let _ = outgoing.lock().await.close().await;
                let _ = output.finish_incoming().await;
            })
            .abort_handle(),
        );
        let input = operation.clone();
        self.register(
            tokio::spawn(async move {
                while let Some(Ok(message)) = reader.next().await {
                    match message {
                        Message::Binary(bytes) => {
                            if input.put_encrypted(bytes.to_vec()).await.is_err() {
                                break;
                            }
                        }
                        Message::Ping(bytes) => {
                            if writer
                                .lock()
                                .await
                                .send(Message::Pong(bytes))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Message::Pong(_) => {}
                        _ => break,
                    }
                }
                let _ = input.finish_incoming().await;
            })
            .abort_handle(),
        );
        if let Err(error) = operation.start_request(request).await {
            self.cancel();
            return Err(error);
        }
        if self.canceled.is_cancelled() {
            return Err(TransportError::Canceled);
        }
        Ok(())
    }

    pub async fn write_body(&self, bytes: Vec<u8>) -> Result<bool, TransportError> {
        match self.operation()?.write_body(bytes).await {
            Ok(()) => Ok(true),
            Err(TransportError::Closed) => Ok(false),
            Err(error) => Err(error),
        }
    }
    pub async fn finish_body(&self) -> Result<(), TransportError> {
        self.operation()?.finish_body().await
    }
    pub async fn response_head(&self) -> Result<HttpResponseHead, TransportError> {
        self.operation()?.response_head().await
    }
    pub async fn read_body(&self) -> Result<Option<Vec<u8>>, TransportError> {
        let result = self.operation()?.read_body().await;
        if !matches!(result, Ok(Some(_))) {
            self.stop_drivers();
        }
        result
    }
    pub fn cancel(&self) {
        self.canceled.cancel();
        if let Ok(operation) = self.inner.lock() {
            if let Some(operation) = operation.as_ref() {
                operation.cancel();
            }
        }
        self.stop_drivers();
    }
}
