// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use futures_util::{SinkExt, StreamExt};
use rcgen::{CertificateParams, KeyPair, PublicKeyData};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::{rustls, TlsAcceptor};
use tokio_tungstenite::tungstenite::Message;

struct ProbeHeaders;

impl tokio_tungstenite::tungstenite::handshake::server::Callback for ProbeHeaders {
    fn on_request(
        self,
        request: &tokio_tungstenite::tungstenite::handshake::server::Request,
        response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        assert_eq!(request.uri().path(), "/api/installation-transport/v1");
        assert!(!request.headers().contains_key("authorization"));
        assert!(!request.headers().contains_key("cookie"));
        Ok(response)
    }
}

async fn installation(
    wrong_certificate: bool,
) -> (Selection, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let fingerprint = format!("{:x}", Sha256::digest(key.subject_public_key_info()));
    let name = format!(
        "{}.{}.installation.ork.invalid",
        &fingerprint[..32],
        &fingerprint[32..]
    );
    let cert = CertificateParams::new(vec![name])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    )
    .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server_id = "22222222-2222-4222-8222-222222222222";
    let logical = format!("https://{server_id}.installation.ork.invalid");
    let selection = Selection {
        account: "a".repeat(64),
        origin: logical.clone(),
        target: WorkspaceTarget {
            organization_id: "11111111-1111-4111-8111-111111111111".into(),
            server_id: server_id.into(),
            workspace_id: "33333333-3333-4333-8333-333333333333".into(),
            binding_version: 1,
            key_fingerprint: if wrong_certificate {
                "0".repeat(64)
            } else {
                fingerprint
            },
        },
        // Only the test's outer socket is loopback HTTP; all HTTP content uses pinned TLS 1.3.
        direct_origin: Some(format!("http://{}", listener.local_addr().unwrap())),
        relay_origin: None,
        prefer_relay: false,
    };
    let expected = selection.target.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, ProbeHeaders)
            .await
            .unwrap();
        socket.send(Message::Text(json!({
            "protocol":"ork-installation-tls-v1", "serverId":expected.server_id,
            "bindingVersion":expected.binding_version, "keyFingerprint":expected.key_fingerprint,
            "certificate":STANDARD.encode(cert.der()), "origin":logical,
        }).to_string().into())).await.unwrap();
        let (mut writer, mut reader) = socket.split();
        let (pump, inside) = tokio::io::duplex(64 * 1024);
        let (mut input, mut output) = tokio::io::split(pump);
        let incoming = tokio::spawn(async move {
            while let Some(Ok(Message::Binary(bytes))) = reader.next().await {
                if output.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            let _ = output.shutdown().await;
        });
        let outgoing = tokio::spawn(async move {
            let mut bytes = [0; 8192];
            while let Ok(length) = input.read(&mut bytes).await {
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
        if let Ok(stream) = TlsAcceptor::from(Arc::new(config)).accept(inside).await {
            assert_eq!(
                stream.get_ref().1.protocol_version(),
                Some(rustls::ProtocolVersion::TLSv1_3)
            );
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(
                hyper_util::rt::TokioIo::new(stream),
                hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    assert_eq!(request.method(), "GET");
                    assert_eq!(request.uri().path(), "/api/auth/capabilities");
                    assert!(request.headers()["host"].to_str().unwrap().ends_with(".installation.ork.invalid"));
                    assert!(!request.headers().contains_key("authorization"));
                    assert!(!request.headers().contains_key("cookie"));
                    observed.fetch_add(1, Ordering::SeqCst);
                    async {
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(http_body_util::Full::new(
                            &br#"{"passwordAuth":false,"accountsLogin":true,"nativeRenderer":"bundled-v1","protocol":{"min":1,"max":2}}"#[..],
                        )))
                    }
                }),
            ).await;
        }
        incoming.abort();
        outgoing.abort();
    });
    (selection, task, requests)
}

#[tokio::test]
async fn workspace_card_and_connect_probe_the_pinned_physical_route_not_the_logical_dns_name() {
    for connect in [false, true] {
        let (selection, server, requests) = installation(false).await;
        if connect {
            crate::server::probe_setup_server(
                &url::Url::parse(&selection.origin).unwrap(),
                Some(&selection.target),
            )
            .await
            .unwrap();
        }
        let expected = selection.clone();
        let direct = selection.direct_origin.clone().into_iter().collect();
        let result = selection
            .probe_direct_candidates(direct, |_| async {
                panic!("Healthy direct transport must not request a relay ticket")
            })
            .await
            .unwrap();
        assert_eq!(result, expected);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn a_workspace_probe_rejects_an_advertised_identity_with_the_wrong_certificate() {
    let (selection, server, requests) = installation(true).await;
    let direct = selection.direct_origin.clone().into_iter().collect();
    assert!(selection
        .probe_direct_candidates(direct, |_| async {
            panic!("A missing relay route cannot request a capability")
        })
        .await
        .is_err());
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_later_direct_route_is_tried_with_the_same_pinned_identity() {
    let (selection, server, requests) = installation(false).await;
    let available = selection.direct_origin.clone().unwrap();
    let offline = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let missing = format!("http://{}", offline.local_addr().unwrap());
    drop(offline);
    let target = selection.target.clone();
    let selected = selection
        .probe_direct_candidates(vec![missing, available.clone()], |_| async {
            panic!("A healthy direct route must not use the relay")
        })
        .await
        .unwrap();
    assert_eq!(selected.target, target);
    assert_eq!(selected.direct_origin.as_deref(), Some(available.as_str()));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.await.unwrap();
}

#[tokio::test]
async fn a_wrong_identity_on_one_route_cannot_override_the_pin_for_the_next() {
    let (wrong, wrong_server, wrong_requests) = installation(true).await;
    let (selection, server, requests) = installation(false).await;
    let available = selection.direct_origin.clone().unwrap();
    let selected = selection
        .probe_direct_candidates(
            vec![wrong.direct_origin.unwrap(), available.clone()],
            |_| async { panic!("A healthy direct route must not use the relay") },
        )
        .await
        .unwrap();
    assert_eq!(selected.direct_origin.as_deref(), Some(available.as_str()));
    assert_eq!(wrong_requests.load(Ordering::SeqCst), 0);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    wrong_server.await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn relay_is_requested_only_after_every_direct_route_fails() {
    let (mut selection, server, requests) = installation(false).await;
    server.abort();
    let direct = selection.direct_origin.clone().unwrap();
    selection.relay_origin = Some("https://relay.example.test".into());
    let expected = selection.target.clone();
    let result = selection
        .probe_direct_candidates(vec![direct], |route| async move {
            assert!(route.prefer_relay);
            assert_eq!(route.target, expected);
            Err("relay unavailable".to_owned())
        })
        .await;
    assert_eq!(result.unwrap_err(), "relay unavailable");
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}
