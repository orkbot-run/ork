// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use std::future::Future;
use std::sync::atomic::AtomicUsize;

use hyper::service::service_fn;
use hyper::Response;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

fn get(path: &str) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        path: path.into(),
        headers: vec![],
        has_body: false,
    }
}

fn response(bytes: &'static [u8]) -> Response<Upload> {
    let (sender, receiver) = mpsc::channel(1);
    sender.try_send(Bytes::from_static(bytes)).unwrap();
    Response::new(Upload { receiver })
}

struct Relay {
    client: Arc<InstallationHttp>,
    captured: Arc<StdMutex<Vec<u8>>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.client.cancel();
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn forward(
    mut read: impl tokio::io::AsyncRead + Unpin,
    mut write: impl tokio::io::AsyncWrite + Unpin,
    captured: Arc<StdMutex<Vec<u8>>>,
) {
    let mut buffer = [0; 4096];
    while let Ok(count) = read.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        captured.lock().unwrap().extend_from_slice(&buffer[..count]);
        if write.write_all(&buffer[..count]).await.is_err() {
            break;
        }
    }
    let _ = write.shutdown().await;
}

async fn connect<F, Fut>(
    client: Arc<InstallationHttp>,
    config: Arc<rustls::ServerConfig>,
    handler: F,
) -> Relay
where
    F: Fn(Request<Incoming>) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Response<Upload>> + Send + 'static,
{
    let backend = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_addr = backend.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = backend.accept().await.unwrap();
        socket.set_nodelay(true).unwrap();
        let Ok(stream) = TlsAcceptor::from(config).accept(socket).await else {
            return;
        };
        assert_eq!(
            stream.get_ref().1.protocol_version(),
            Some(rustls::ProtocolVersion::TLSv1_3)
        );
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(
                TokioIo::new(stream),
                service_fn(move |request| {
                    let future = handler(request);
                    async move { Ok::<_, Infallible>(future.await) }
                }),
            )
            .await;
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let captured = Arc::new(StdMutex::new(Vec::new()));
    let relay_capture = captured.clone();
    let relay = tokio::spawn(async move {
        let (mut app, _) = listener.accept().await.unwrap();
        let mut installation = TcpStream::connect(backend_addr).await.unwrap();
        app.set_nodelay(true).unwrap();
        installation.set_nodelay(true).unwrap();
        let (app_read, app_write) = app.split();
        let (server_read, server_write) = installation.split();
        tokio::join!(
            forward(app_read, server_write, relay_capture.clone()),
            forward(server_read, app_write, relay_capture),
        );
    });
    let socket = TcpStream::connect(address).await.unwrap();
    socket.set_nodelay(true).unwrap();
    let (mut read, mut write) = socket.into_split();
    let writer = client.clone();
    let outgoing = tokio::spawn(async move {
        while let Ok(Some(bytes)) = writer.take_encrypted().await {
            if write.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = write.shutdown().await;
    });
    let reader = client.clone();
    let incoming = tokio::spawn(async move {
        let mut buffer = [0; 8192];
        while let Ok(count) = read.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            for part in buffer[..count].chunks(997) {
                if reader.put_encrypted(part.to_vec()).await.is_err() {
                    return;
                }
            }
        }
        let _ = reader.finish_incoming().await;
    });
    Relay {
        client,
        captured,
        tasks: vec![server, relay, incoming, outgoing],
    }
}

async fn local<F, Fut>(handler: F) -> Relay
where
    F: Fn(Request<Incoming>) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Response<Upload>> + Send + 'static,
{
    let (cert, key, fingerprint) = crate::tests::identity(false);
    let client =
        InstallationHttp::new(cert.clone(), fingerprint, "https://server.example".into()).unwrap();
    connect(client, crate::tests::server_config(cert, key), handler).await
}

fn client() -> Arc<InstallationHttp> {
    let (certificate, _, fingerprint) = crate::tests::identity(false);
    InstallationHttp::new(certificate, fingerprint, "https://server.example".into()).unwrap()
}

#[tokio::test]
async fn cancellation_wakes_reads_before_a_request_starts() {
    let client = client();
    let reader = client.clone();
    let pending = tokio::spawn(async move { reader.take_encrypted().await });
    tokio::task::yield_now().await;
    client.cancel();
    assert!(tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .expect("cancel must wake a pending encrypted read")
        .unwrap()
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn cancellation_wakes_blocked_encrypted_writes() {
    let client = client();
    let writer = client.clone();
    let pending = tokio::spawn(async move { writer.put_encrypted(vec![0; MAX_CHUNK]).await });
    tokio::task::yield_now().await;
    client.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("cancel must wake a backpressured encrypted write")
            .unwrap(),
        Err(TransportError::Canceled)
    ));
}

#[tokio::test]
async fn cancellation_wakes_queued_upload_and_finish_calls() {
    let client = client();
    let mut request = get("/upload");
    request.method = "POST".into();
    request.has_body = true;
    client.start_request(request).await.unwrap();
    client.write_body(vec![0; BUFFER_LIMIT]).await.unwrap();
    client.write_body(vec![0; BUFFER_LIMIT]).await.unwrap();
    let writer = client.clone();
    let upload = tokio::spawn(async move { writer.write_body(vec![0; BUFFER_LIMIT]).await });
    tokio::task::yield_now().await;
    let finisher = client.clone();
    let finish = tokio::spawn(async move { finisher.finish_body().await });
    tokio::task::yield_now().await;
    client.cancel();
    for pending in [upload, finish] {
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap(),
            Err(TransportError::Canceled)
        ));
    }
}

#[tokio::test]
async fn tls_http_streams_large_files_and_keeps_the_relay_opaque() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let completed = Arc::new(AtomicUsize::new(0));
        let observed = completed.clone();
        let relay = local(move |mut request| {
            let observed = observed.clone();
            async move {
                assert_eq!(request.method(), Method::POST);
                assert_eq!(request.uri(), "/api/files?workspace=example");
                assert_eq!(request.headers()["host"], "server.example");
                assert_eq!(request.headers()["origin"], "orkbot://");
                assert_eq!(
                    request.headers()["authorization"],
                    "Bearer secret-test-token"
                );
                let mut received = 0;
                while let Some(frame) = request.body_mut().frame().await {
                    if let Ok(data) = frame.unwrap().into_data() {
                        assert!(data.iter().all(|byte| *byte == 0x42));
                        received += data.len();
                    }
                }
                observed.store(received, Ordering::SeqCst);
                let (sender, receiver) = mpsc::channel(2);
                tokio::spawn(async move {
                    for _ in 0..256 {
                        if sender
                            .send(
                                Bytes::from_static(b"private-file-content-0123456789\n")
                                    .repeat(256)
                                    .into(),
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
                Response::builder()
                    .status(201)
                    .header("content-type", "application/octet-stream")
                    .body(Upload { receiver })
                    .unwrap()
            }
        })
        .await;
        relay
            .client
            .start_request(HttpRequest {
                method: "POST".into(),
                path: "/api/files?workspace=example".into(),
                headers: vec![HttpHeader {
                    name: "authorization".into(),
                    value: "Bearer secret-test-token".into(),
                }],
                has_body: true,
            })
            .await
            .unwrap();
        for _ in 0..64 {
            relay
                .client
                .write_body(vec![0x42; 32 * 1024])
                .await
                .unwrap();
        }
        relay.client.finish_body().await.unwrap();
        assert_eq!(relay.client.response_head().await.unwrap().status, 201);
        assert_eq!(completed.load(Ordering::SeqCst), 2 * 1024 * 1024);
        let mut downloaded = Vec::new();
        while let Some(bytes) = relay.client.read_body().await.unwrap() {
            assert!(bytes.len() <= BUFFER_LIMIT);
            downloaded.extend(bytes);
        }
        assert_eq!(
            downloaded,
            b"private-file-content-0123456789\n".repeat(256 * 256)
        );
        assert!(relay.client.read_body().await.unwrap().is_none());
        let captured = relay.captured.lock().unwrap();
        for secret in [
            b"secret-test-token".as_slice(),
            b"/api/files",
            b"private-file-content",
        ] {
            assert!(!captured
                .windows(secret.len())
                .any(|window| window == secret));
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn sse_arrives_before_completion_and_cancellation_wakes_all_readers() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let (sender, receiver) = mpsc::channel(2);
        let receiver = Arc::new(StdMutex::new(Some(receiver)));
        let relay = local(move |_| {
            let receiver = receiver.lock().unwrap().take().unwrap();
            async move {
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Upload { receiver })
                    .unwrap()
            }
        })
        .await;
        relay
            .client
            .start_request(get("/api/events"))
            .await
            .unwrap();
        sender
            .send(Bytes::from_static(b"data: first\n\n"))
            .await
            .unwrap();
        assert_eq!(relay.client.response_head().await.unwrap().status, 200);
        assert_eq!(
            relay.client.read_body().await.unwrap().unwrap(),
            b"data: first\n\n"
        );
        let first = relay.client.clone();
        let second = relay.client.clone();
        let a = tokio::spawn(async move { first.read_body().await });
        let b = tokio::spawn(async move { second.read_body().await });
        tokio::task::yield_now().await;
        relay.client.cancel();
        assert!(matches!(a.await.unwrap(), Err(TransportError::Canceled)));
        assert!(matches!(b.await.unwrap(), Err(TransportError::Canceled)));
        assert!(matches!(
            relay.client.response_head().await,
            Err(TransportError::Canceled)
        ));
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn stalled_requests_do_not_delay_other_installations() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let stalled = client();
        stalled
            .start_request(get("/never-connected"))
            .await
            .unwrap();
        let relay = local(|_| async { response(b"independent") }).await;
        relay.client.start_request(get("/ready")).await.unwrap();
        assert_eq!(relay.client.response_head().await.unwrap().status, 200);
        assert_eq!(
            relay.client.read_body().await.unwrap().unwrap(),
            b"independent"
        );
        let waiting = stalled.clone();
        let pending = tokio::spawn(async move { waiting.response_head().await });
        stalled.cancel();
        assert!(matches!(
            pending.await.unwrap(),
            Err(TransportError::Canceled)
        ));
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn refuses_the_actual_wrong_peer_and_expired_certificates_before_http() {
    tokio::time::timeout(Duration::from_secs(5), async {
        for expired in [false, true] {
            let (cert, key, fingerprint) = crate::tests::identity(expired);
            let client = if expired {
                InstallationHttp::new(cert.clone(), fingerprint, "https://server.example".into())
                    .unwrap()
            } else {
                client()
            };
            let calls = Arc::new(AtomicUsize::new(0));
            let seen = calls.clone();
            let relay = connect(client, crate::tests::server_config(cert, key), move |_| {
                seen.fetch_add(1, Ordering::SeqCst);
                async { response(b"must not run") }
            })
            .await;
            relay.client.start_request(get("/private")).await.unwrap();
            assert!(matches!(
                relay.client.response_head().await,
                Err(TransportError::TlsRefused)
            ));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn refuses_redirect_replay_and_reusing_an_operation() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let relay = local(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            async {
                let mut result = response(b"redirect");
                *result.status_mut() = hyper::StatusCode::TEMPORARY_REDIRECT;
                result.headers_mut().insert(
                    "location",
                    HeaderValue::from_static("https://other.example/private"),
                );
                result
            }
        })
        .await;
        relay.client.start_request(get("/private")).await.unwrap();
        assert_eq!(relay.client.response_head().await.unwrap().status, 307);
        assert!(matches!(
            relay.client.start_request(get("/again")).await,
            Err(TransportError::AlreadyStarted)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn premature_eof_fails_without_an_automatic_retry() {
    let client = client();
    client.start_request(get("/private")).await.unwrap();
    client.finish_incoming().await.unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), client.response_head())
            .await
            .unwrap(),
        Err(TransportError::TlsRefused)
    ));
}

#[tokio::test]
async fn a_truncated_http_body_is_an_error_and_is_never_replayed() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let relay = local(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            async {
                let mut response = response(b"short");
                response
                    .headers_mut()
                    .insert("content-length", HeaderValue::from_static("100"));
                response
            }
        })
        .await;
        relay.client.start_request(get("/truncated")).await.unwrap();
        match relay.client.response_head().await {
            Ok(head) => {
                assert_eq!(head.status, 200);
                loop {
                    match relay.client.read_body().await {
                        Ok(Some(_)) => continue,
                        Err(TransportError::HttpRefused) => break,
                        _ => panic!("truncated body must not be treated as complete"),
                    }
                }
            }
            Err(TransportError::HttpRefused) => {}
            _ => panic!("unexpected response"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn validates_origins_request_headers_and_buffer_bounds() {
    let (cert, _, fingerprint) = crate::tests::identity(false);
    for origin in [
        "http://server.example",
        "https://server.example/",
        "https://user@server.example",
        "https://server.example?x=1",
        "https://server.example#x",
        "https://server.example/path",
        "https://server.example:443",
    ] {
        assert!(
            matches!(
                InstallationHttp::new(cert.clone(), fingerprint.clone(), origin.into()),
                Err(TransportError::InvalidRequest)
            ),
            "{origin}"
        );
    }
    for origin in [
        "https://server.example",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
    ] {
        assert!(
            InstallationHttp::new(cert.clone(), fingerprint.clone(), origin.into()).is_ok(),
            "{origin}"
        );
    }
    for path in [
        "https://other.example/private",
        "//other.example/private",
        "relative",
        "/\r\nInjected: yes",
    ] {
        let client = client();
        assert!(matches!(
            client.start_request(get(path)).await,
            Err(TransportError::InvalidRequest)
        ));
    }
    for name in [
        "Host",
        "Origin",
        "Connection",
        "Content-Length",
        "Transfer-Encoding",
        "Upgrade",
        "Proxy-Authorization",
        "Accept-Encoding",
    ] {
        let client = client();
        let mut input = get("/private");
        input.headers.push(HttpHeader {
            name: name.into(),
            value: "bad".into(),
        });
        assert!(matches!(
            client.start_request(input).await,
            Err(TransportError::InvalidRequest)
        ));
    }
    let client = client();
    assert!(matches!(
        client.put_encrypted(vec![0; MAX_CHUNK + 1]).await,
        Err(TransportError::ChunkTooLarge)
    ));
    assert!(matches!(
        client.write_body(vec![0; BUFFER_LIMIT + 1]).await,
        Err(TransportError::ChunkTooLarge)
    ));
    assert!(matches!(
        client.write_body(vec![0]).await,
        Err(TransportError::NotStarted)
    ));
    assert!(matches!(
        client.response_head().await,
        Err(TransportError::NotStarted)
    ));
}
