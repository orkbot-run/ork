// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::io::{Cursor, Read, Write};
use std::sync::{Arc, Mutex};

use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use sha2::{Digest, Sha256};
use x509_parser::prelude::{FromDer, X509Certificate};

uniffi::setup_scaffolding!();

const MAX_CHUNK: usize = 256 * 1024;
const BUFFER_LIMIT: usize = 64 * 1024;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum TransportError {
    #[error("Invalid installation certificate or key fingerprint")]
    InvalidIdentity,
    #[error("The installation TLS channel was refused")]
    TlsRefused,
    #[error("The installation TLS channel is closed")]
    Closed,
    #[error("The transport chunk is too large")]
    ChunkTooLarge,
}

#[derive(uniffi::Record)]
pub struct TransportOutput {
    pub encrypted: Vec<u8>,
    pub plaintext: Vec<u8>,
    pub handshaking: bool,
    pub peer_closed: bool,
}

struct Channel {
    connection: ClientConnection,
    fingerprint: String,
    verified: bool,
    closed: bool,
}

/// The relay transports only `encrypted` bytes. TLS state stays in the native application.
#[derive(uniffi::Object)]
pub struct InstallationTls {
    channel: Mutex<Channel>,
}

fn fingerprint(certificate: &[u8]) -> Result<String, TransportError> {
    let (remaining, certificate) =
        X509Certificate::from_der(certificate).map_err(|_| TransportError::InvalidIdentity)?;
    if !remaining.is_empty() {
        return Err(TransportError::InvalidIdentity);
    }
    let hash = Sha256::digest(certificate.tbs_certificate.subject_pki.raw);
    Ok(hash.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn installation_name(value: &str) -> Result<String, TransportError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(TransportError::InvalidIdentity);
    }
    Ok(format!(
        "{}.{}.installation.ork.invalid",
        &value[..32],
        &value[32..]
    ))
}

#[uniffi::export]
impl InstallationTls {
    #[uniffi::constructor]
    pub fn new(certificate: Vec<u8>, key_fingerprint: String) -> Result<Arc<Self>, TransportError> {
        if certificate.len() > 16 * 1024 || fingerprint(&certificate)? != key_fingerprint {
            return Err(TransportError::InvalidIdentity);
        }
        let name = installation_name(&key_fingerprint)?;
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(certificate))
            .map_err(|_| TransportError::InvalidIdentity)?;
        let provider = rustls::crypto::ring::default_provider();
        let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| TransportError::TlsRefused)?
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        config.enable_early_data = false;
        config.resumption = rustls::client::Resumption::disabled();
        let mut connection = ClientConnection::new(
            Arc::new(config),
            ServerName::try_from(name).map_err(|_| TransportError::InvalidIdentity)?,
        )
        .map_err(|_| TransportError::TlsRefused)?;
        connection.set_buffer_limit(Some(BUFFER_LIMIT));
        Ok(Arc::new(Self {
            channel: Mutex::new(Channel {
                connection,
                fingerprint: key_fingerprint,
                verified: false,
                closed: false,
            }),
        }))
    }

    pub fn receive(&self, encrypted: Vec<u8>) -> Result<TransportOutput, TransportError> {
        if encrypted.len() > MAX_CHUNK {
            return Err(TransportError::ChunkTooLarge);
        }
        let mut channel = self.channel.lock().map_err(|_| TransportError::Closed)?;
        if channel.closed {
            return Err(TransportError::Closed);
        }
        let mut input = Cursor::new(encrypted);
        let mut plaintext = Vec::new();
        let mut peer_closed = false;
        while input.position() < input.get_ref().len() as u64 {
            let count = channel
                .connection
                .read_tls(&mut input)
                .map_err(|_| TransportError::TlsRefused)?;
            if count == 0 {
                break;
            }
            let state = match channel.connection.process_new_packets() {
                Ok(state) => state,
                Err(_) => {
                    channel.closed = true;
                    return Err(TransportError::TlsRefused);
                }
            };
            peer_closed |= state.peer_has_closed();
            if !channel.connection.is_handshaking() && !channel.verified {
                let peer = channel
                    .connection
                    .peer_certificates()
                    .and_then(|certificates| certificates.first())
                    .ok_or(TransportError::TlsRefused)?;
                if fingerprint(peer.as_ref())? != channel.fingerprint {
                    channel.closed = true;
                    return Err(TransportError::TlsRefused);
                }
                if channel.connection.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3)
                    || channel.connection.alpn_protocol() != Some(b"http/1.1")
                {
                    channel.closed = true;
                    return Err(TransportError::TlsRefused);
                }
                channel.verified = true;
            }
            let mut chunk = [0u8; 16 * 1024];
            loop {
                match channel.connection.reader().read(&mut chunk) {
                    Ok(0) => break,
                    Ok(length) => plaintext.extend_from_slice(&chunk[..length]),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        channel.closed = true;
                        return Err(TransportError::TlsRefused);
                    }
                }
            }
        }
        if !channel.verified && !plaintext.is_empty() {
            channel.closed = true;
            return Err(TransportError::TlsRefused);
        }
        let mut output = Vec::new();
        channel
            .connection
            .write_tls(&mut output)
            .map_err(|_| TransportError::TlsRefused)?;
        if peer_closed {
            channel.closed = true;
        }
        Ok(TransportOutput {
            encrypted: output,
            plaintext,
            handshaking: channel.connection.is_handshaking(),
            peer_closed,
        })
    }

    pub fn send(&self, plaintext: Vec<u8>) -> Result<TransportOutput, TransportError> {
        if plaintext.len() > BUFFER_LIMIT {
            return Err(TransportError::ChunkTooLarge);
        }
        let mut channel = self.channel.lock().map_err(|_| TransportError::Closed)?;
        if channel.closed {
            return Err(TransportError::Closed);
        }
        if !channel.verified {
            return Err(TransportError::TlsRefused);
        }
        channel
            .connection
            .writer()
            .write_all(&plaintext)
            .map_err(|_| TransportError::TlsRefused)?;
        let mut encrypted = Vec::new();
        channel
            .connection
            .write_tls(&mut encrypted)
            .map_err(|_| TransportError::TlsRefused)?;
        Ok(TransportOutput {
            encrypted,
            plaintext: Vec::new(),
            handshaking: false,
            peer_closed: false,
        })
    }

    /// The native socket owner closes the associated relay channel after sending close-notify.
    pub fn close(&self) -> Result<Vec<u8>, TransportError> {
        let mut channel = self.channel.lock().map_err(|_| TransportError::Closed)?;
        if channel.closed {
            return Ok(Vec::new());
        }
        channel.connection.send_close_notify();
        channel.closed = true;
        let mut encrypted = Vec::new();
        channel
            .connection
            .write_tls(&mut encrypted)
            .map_err(|_| TransportError::TlsRefused)?;
        Ok(encrypted)
    }
}

#[cfg(test)]
mod tests;
