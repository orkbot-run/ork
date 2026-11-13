// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::accept_async;

const SERVER: &str = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION: &str = "10000000-0000-4000-8000-000000000002";
const WORKSPACE: &str = "10000000-0000-4000-8000-000000000003";

struct RelayHeaders(String);
impl tokio_tungstenite::tungstenite::handshake::server::Callback for RelayHeaders {
    fn on_request(
        self,
        request: &tokio_tungstenite::tungstenite::handshake::server::Request,
        response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        assert_eq!(request.uri().path(), "/api/relay/v1/channels");
        assert_eq!(
            request.headers()["authorization"],
            format!("Bearer {}", self.0)
        );
        assert!(!format!("{:?}", request.headers()).contains("private-test-token"));
        Ok(response)
    }
}

fn relay_route(fingerprint: &str, origin: &str) -> RelayRoute {
    let claims = json!({ "purpose": "ork-relay-channel-v1", "aud": origin,
        "server_id": SERVER, "organization_id": ORGANIZATION, "workspace_id": WORKSPACE,
        "binding_version": 1, "installation_key": fingerprint });
    RelayRoute {
        origin: origin.into(),
        ticket: format!(
            "e30.{}.signature",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        ),
        organization_id: ORGANIZATION.into(),
        workspace_id: WORKSPACE.into(),
    }
}

#[test]
fn relay_refuses_account_tokens_wrong_scopes_and_noncanonical_routes_before_network() {
    let (_, _, fingerprint) = crate::tests::identity(false);
    let virtual_origin = format!("https://{SERVER}.installation.ork.invalid");
    let origin = "https://relay.example.test";
    let valid = relay_route(&fingerprint, origin);
    assert!(InstallationConnection::via_relay(
        virtual_origin.clone(),
        SERVER.into(),
        1,
        fingerprint.clone(),
        valid
    )
    .is_ok());
    for (name, value) in [
        ("purpose", json!("accounts-access-token")),
        ("aud", json!("https://accounts.example.test")),
        ("server_id", json!(WORKSPACE)),
        ("workspace_id", json!(SERVER)),
        ("organization_id", json!(SERVER)),
        ("binding_version", json!(2)),
        ("installation_key", json!("0".repeat(64))),
    ] {
        let mut route = relay_route(&fingerprint, origin);
        let payload = route.ticket.split('.').nth(1).unwrap();
        let mut claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        claims[name] = value;
        route.ticket = format!(
            "e30.{}.signature",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        assert!(
            InstallationConnection::via_relay(
                virtual_origin.clone(),
                SERVER.into(),
                1,
                fingerprint.clone(),
                route
            )
            .is_err(),
            "accepted {name}"
        );
    }
    for invalid in [
        "http://relay.example.test",
        "https://relay.example.test/",
        "https://relay.example.test?ticket=secret",
    ] {
        assert!(InstallationConnection::via_relay(
            virtual_origin.clone(),
            SERVER.into(),
            1,
            fingerprint.clone(),
            relay_route(&fingerprint, invalid)
        )
        .is_err());
    }
}

#[tokio::test]
async fn relay_capability_stays_outside_pinned_http_and_logical_origin_stays_inside() {
    let (cert, key, fingerprint) = crate::tests::identity(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("https://{}", listener.local_addr().unwrap());
    let route = relay_route(&fingerprint, &origin);
    let ticket = route.ticket.clone();
    let mut client = InstallationConnection::via_relay(
        format!("https://{SERVER}.installation.ork.invalid"),
        SERVER.into(),
        1,
        fingerprint.clone(),
        route,
    )
    .unwrap();
    // This fixture covers inner TLS and headers. The separate outer TLS test uses platform trust.
    Arc::get_mut(&mut client)
        .unwrap()
        .address
        .set_scheme("ws")
        .unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, RelayHeaders(ticket))
            .await
            .unwrap();
        socket.send(Message::Text(json!({ "protocol": "ork-installation-tls-v1", "serverId": SERVER,
            "bindingVersion": 1, "keyFingerprint": fingerprint, "certificate": STANDARD.encode(&cert),
            "origin": "http://127.0.0.1:5173" }).to_string().into())).await.unwrap();
        let (mut writer, mut reader) = socket.split();
        let (pump, inside) = tokio::io::duplex(BUFFER_LIMIT);
        let (mut incoming, mut outgoing) = tokio::io::split(pump);
        let input = tokio::spawn(async move {
            while let Some(Ok(Message::Binary(bytes))) = reader.next().await {
                assert!(!bytes.windows(18).any(|part| part == b"private-test-token"));
                if outgoing.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        let output = tokio::spawn(async move {
            let mut bytes = [0; 8192];
            while let Ok(length) = incoming.read(&mut bytes).await {
                if length == 0
                    || writer
                        .send(Message::Binary(bytes[..length].to_vec().into()))
                        .await
                        .is_err()
                {
                    break;
                }
            }
        });
        let stream = tokio_rustls::TlsAcceptor::from(crate::tests::server_config(cert, key))
            .accept(inside)
            .await
            .unwrap();
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(
                hyper_util::rt::TokioIo::new(stream),
                hyper::service::service_fn(
                    |request: hyper::Request<hyper::body::Incoming>| async move {
                        assert_eq!(request.headers()["host"], "127.0.0.1:5173");
                        assert_eq!(
                            request.headers()["authorization"],
                            "Bearer private-test-token"
                        );
                        assert_eq!(request.uri().path(), "/private");
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(
                            http_body_util::Full::new(bytes::Bytes::from_static(
                                b"private-response",
                            )),
                        ))
                    },
                ),
            )
            .await;
        input.abort();
        output.abort();
    });
    client.start_request(request()).await.unwrap();
    assert_eq!(client.response_head().await.unwrap().status, 200);
    assert_eq!(
        client.read_body().await.unwrap().unwrap(),
        b"private-response"
    );
    assert!(client.read_body().await.unwrap().is_none());
    client.cancel();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

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
