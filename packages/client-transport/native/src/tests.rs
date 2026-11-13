// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use rcgen::{CertificateParams, DnType, KeyPair, PublicKeyData};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection};

pub(crate) fn identity(expired: bool) -> (Vec<u8>, Vec<u8>, String) {
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let digest = Sha256::digest(key.subject_public_key_info());
    let fingerprint: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let name = installation_name(&fingerprint).unwrap();
    let mut params = CertificateParams::new(vec![name.clone()]).unwrap();
    params.distinguished_name.push(DnType::CommonName, name);
    if expired {
        params.not_after = rcgen::date_time_ymd(2020, 1, 1);
    }
    let cert = params.self_signed(&key).unwrap();
    (cert.der().to_vec(), key.serialize_der(), fingerprint)
}

pub(crate) fn server_config(certificate: Vec<u8>, key: Vec<u8>) -> Arc<ServerConfig> {
    let mut config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(certificate)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

fn server(certificate: Vec<u8>, key: Vec<u8>) -> ServerConnection {
    ServerConnection::new(server_config(certificate, key)).unwrap()
}

fn server_receive(server: &mut ServerConnection, encrypted: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut input = Cursor::new(encrypted);
    let mut plaintext = Vec::new();
    while input.position() < encrypted.len() as u64 {
        server.read_tls(&mut input).unwrap();
        server.process_new_packets().unwrap();
        let mut chunk = [0; 16 * 1024];
        loop {
            match server.reader().read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => plaintext.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("{error}"),
            }
        }
    }
    let mut output = Vec::new();
    server.write_tls(&mut output).unwrap();
    (output, plaintext)
}

fn handshake(
    client: &InstallationTls,
    server: &mut ServerConnection,
) -> Result<(), TransportError> {
    let mut output = client.receive(Vec::new())?;
    for _ in 0..20 {
        let (reply, _) = server_receive(server, &output.encrypted);
        output = client.receive(reply)?;
        if !output.handshaking && !server.is_handshaking() {
            server_receive(server, &output.encrypted);
            return Ok(());
        }
    }
    panic!("Handshake did not finish");
}

#[test]
fn tls13_carries_requests_files_streams_and_cancellation_as_opaque_bytes() {
    let (cert, key, fingerprint) = identity(false);
    let client = InstallationTls::new(cert.clone(), fingerprint).unwrap();
    let mut server = server(cert, key);
    handshake(&client, &mut server).unwrap();
    assert_eq!(
        server.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_3)
    );
    let request =
        b"POST /rpc/files HTTP/1.1\r\nHost: installation\r\nContent-Length: 2097152\r\n\r\n";
    let encrypted = client.send(request.to_vec()).unwrap().encrypted;
    assert!(!encrypted
        .windows(request.len())
        .any(|bytes| bytes == request));
    assert_eq!(server_receive(&mut server, &encrypted).1, request);
    let chunk = vec![0x42; 32 * 1024];
    let mut received = 0;
    for _ in 0..64 {
        let encrypted = client.send(chunk.clone()).unwrap().encrypted;
        received += server_receive(&mut server, &encrypted).1.len();
    }
    assert_eq!(received, 2 * 1024 * 1024);
    for event in [
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".as_slice(),
        b"5\r\nhello\r\n",
        b"0\r\n\r\n",
    ] {
        server.writer().write_all(event).unwrap();
        let mut encrypted = Vec::new();
        server.write_tls(&mut encrypted).unwrap();
        assert!(!encrypted.windows(event.len()).any(|bytes| bytes == event));
        let mut plaintext = Vec::new();
        for part in encrypted.chunks(7) {
            plaintext.extend(client.receive(part.to_vec()).unwrap().plaintext);
        }
        assert_eq!(plaintext, event);
    }
    let close = client.close_notify().unwrap();
    let mut input = Cursor::new(close);
    server.read_tls(&mut input).unwrap();
    assert!(server.process_new_packets().unwrap().peer_has_closed());
    assert!(matches!(
        client.send(Vec::new()),
        Err(TransportError::Closed)
    ));
}

#[test]
fn refuses_another_installation_certificate_and_expired_identity() {
    let (cert, _, fingerprint) = identity(false);
    let (other_cert, other_key, _) = identity(false);
    assert!(matches!(
        InstallationTls::new(other_cert.clone(), fingerprint.clone()),
        Err(TransportError::InvalidIdentity)
    ));
    let client = InstallationTls::new(cert, fingerprint).unwrap();
    assert!(handshake(&client, &mut server(other_cert, other_key)).is_err());
    let (expired, key, fingerprint) = identity(true);
    let client = InstallationTls::new(expired.clone(), fingerprint).unwrap();
    assert!(handshake(&client, &mut server(expired, key)).is_err());
}

#[test]
fn rejects_tampering_and_refuses_plaintext_before_identity_verification() {
    let (cert, key, fingerprint) = identity(false);
    let client = InstallationTls::new(cert.clone(), fingerprint).unwrap();
    assert!(matches!(
        client.send(b"secret".to_vec()),
        Err(TransportError::TlsRefused)
    ));
    let mut server = server(cert, key);
    handshake(&client, &mut server).unwrap();
    server
        .writer()
        .write_all(b"private workspace content")
        .unwrap();
    let mut encrypted = Vec::new();
    server.write_tls(&mut encrypted).unwrap();
    *encrypted.last_mut().unwrap() ^= 1;
    assert!(matches!(
        client.receive(encrypted),
        Err(TransportError::TlsRefused)
    ));
    assert!(matches!(
        client.receive(Vec::new()),
        Err(TransportError::Closed)
    ));
}

#[test]
fn bounds_inputs_and_validates_the_complete_certificate() {
    let (mut cert, _, fingerprint) = identity(false);
    let client = InstallationTls::new(cert.clone(), fingerprint.clone()).unwrap();
    assert!(matches!(
        client.receive(vec![0; MAX_CHUNK + 1]),
        Err(TransportError::ChunkTooLarge)
    ));
    assert!(matches!(
        client.send(vec![0; BUFFER_LIMIT + 1]),
        Err(TransportError::ChunkTooLarge)
    ));
    cert.extend_from_slice(b"trailing data");
    assert!(InstallationTls::new(cert, fingerprint).is_err());
    assert!(installation_name("../other-server").is_err());
}

#[test]
fn does_not_negotiate_tls12_when_the_peer_rejects_tls13() {
    let (certificate, key, fingerprint) = identity(false);
    let client = InstallationTls::new(certificate.clone(), fingerprint).unwrap();
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS12])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(certificate)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .unwrap();
    let mut server = ServerConnection::new(Arc::new(config)).unwrap();
    let hello = client.receive(Vec::new()).unwrap();
    server.read_tls(&mut Cursor::new(hello.encrypted)).unwrap();
    assert!(server.process_new_packets().is_err());
    assert_eq!(server.protocol_version(), None);
    assert!(client.send(b"private content".to_vec()).is_err());
}
