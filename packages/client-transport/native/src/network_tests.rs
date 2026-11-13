// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::accept_async;

const SERVER: &str = "10000000-0000-4000-8000-000000000001";

fn request() -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        path: "/private".into(),
        has_body: false,
        headers: vec![crate::HttpHeader {
            name: "authorization".into(),
            value: "Bearer private-test-token".into(),
        }],
    }
}

async fn upgrade_headers(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).await.unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() <= 8192);
    }
    bytes
}

async fn peer(
    message: Message,
    fingerprint: String,
) -> (Arc<InstallationConnection>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        if socket.send(message).await.is_ok() {
            let next = tokio::time::timeout(Duration::from_secs(1), socket.next()).await;
            assert!(
                !matches!(next, Ok(Some(Ok(Message::Binary(_))))),
                "HTTP must not start before checking the selected identity"
            );
        }
    });
    (
        InstallationConnection::new(origin, SERVER.into(), 1, fingerprint).unwrap(),
        server,
    )
}

#[tokio::test]
async fn refuses_wrong_server_binding_fingerprint_certificate_and_protocol_before_tls() {
    let (cert, _, fingerprint) = crate::tests::identity(false);
    let (other, _, _) = crate::tests::identity(false);
    let envelope = json!({ "protocol": "ork-installation-tls-v1", "serverId": SERVER,
        "bindingVersion": 1, "keyFingerprint": fingerprint, "certificate": STANDARD.encode(cert) });
    let changes = [
        ("serverId", json!("20000000-0000-4000-8000-000000000001")),
        ("bindingVersion", json!(2)),
        ("keyFingerprint", json!("0".repeat(64))),
        ("certificate", json!(STANDARD.encode(other))),
        ("certificate", json!("invalid!")),
        ("protocol", json!("other-protocol")),
        ("unexpected", json!(true)),
    ];
    for (name, value) in changes {
        let mut changed = envelope.clone();
        changed[name] = value;
        let (client, server) = peer(
            Message::Text(changed.to_string().into()),
            fingerprint.clone(),
        )
        .await;
        assert!(matches!(
            client.start_request(request()).await,
            Err(TransportError::InvalidIdentity)
        ));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn refuses_binary_or_oversized_identity_messages() {
    let (_, _, fingerprint) = crate::tests::identity(false);
    for message in [
        Message::Binary(vec![0; 128].into()),
        Message::Text("a".repeat(33 * 1024).into()),
        Message::Text("a".repeat(MAX_CHUNK + 1).into()),
    ] {
        let (client, server) = peer(message, fingerprint.clone()).await;
        assert!(client.start_request(request()).await.is_err());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_closes_a_pending_upgrade_without_exposing_the_product_bearer() {
    let (_, _, fingerprint) = crate::tests::identity(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = InstallationConnection::new(
        format!("http://{}", listener.local_addr().unwrap()),
        SERVER.into(),
        1,
        fingerprint,
    )
    .unwrap();
    let (ready, accepted) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let bytes = upgrade_headers(&mut stream).await;
        assert!(!String::from_utf8_lossy(&bytes).contains("private-test-token"));
        ready.send(()).unwrap();
        assert_eq!(stream.read(&mut [0; 1]).await.unwrap(), 0);
    });
    let pending = client.clone();
    let opening = tokio::spawn(async move { pending.start_request(request()).await });
    accepted.await.unwrap();
    client.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), opening)
            .await
            .unwrap()
            .unwrap(),
        Err(TransportError::Canceled)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn bounds_an_unfinished_http_upgrade_response() {
    let (_, _, fingerprint) = crate::tests::identity(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = InstallationConnection::new(
        format!("http://{}", listener.local_addr().unwrap()),
        SERVER.into(),
        1,
        fingerprint,
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        upgrade_headers(&mut stream).await;
        let _ = stream
            .write_all(b"HTTP/1.1 101 Switching Protocols\r\nX-Large: ")
            .await;
        for _ in 0..32 {
            if stream.write_all(&[b'a'; 4096]).await.is_err() {
                return;
            }
        }
        let _ = stream.read(&mut [0; 1]).await;
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), client.start_request(request()))
            .await
            .unwrap(),
        Err(TransportError::NetworkRefused)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn does_not_follow_an_upgrade_redirect() {
    let (_, _, fingerprint) = crate::tests::identity(false);
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = destination.local_addr().unwrap();
    let called = Arc::new(AtomicBool::new(false));
    let seen = called.clone();
    let other = tokio::spawn(async move {
        let (mut stream, _) = destination.accept().await.unwrap();
        seen.store(true, Ordering::SeqCst);
        let mut buffer = [0; 8192];
        let _ = stream.read(&mut buffer).await;
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            .await;
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = InstallationConnection::new(
        format!("http://{}", listener.local_addr().unwrap()),
        SERVER.into(),
        1,
        fingerprint,
    )
    .unwrap();
    let first = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        upgrade_headers(&mut stream).await;
        stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: ws://{address}/other\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
    });
    assert!(matches!(
        client.start_request(request()).await,
        Err(TransportError::NetworkRefused)
    ));
    assert!(!called.load(Ordering::SeqCst));
    first.await.unwrap();
    other.abort();
}

#[tokio::test]
async fn outer_tls_rejects_an_untrusted_certificate() {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let cert = rcgen::CertificateParams::new(vec!["127.0.0.1".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (_, _, fingerprint) = crate::tests::identity(false);
    let client = InstallationConnection::new(
        format!("https://{}", listener.local_addr().unwrap()),
        SERVER.into(),
        1,
        fingerprint,
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(crate::tests::server_config(
            cert.der().to_vec(),
            key.serialize_der(),
        ));
        assert!(acceptor.accept(stream).await.is_err());
    });
    assert!(matches!(
        client.start_request(request()).await,
        Err(TransportError::TlsRefused)
    ));
    server.await.unwrap();
}
