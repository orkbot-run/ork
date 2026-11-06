// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{path::Path, sync::Arc};

#[cfg(any(target_os = "macos", all(test, unix)))]
#[path = "credentials_macos.rs"]
mod macos;

use sha2::{Digest, Sha256};
use url::Url;

const SERVICE: &str = "run.orkbot.desktop.preview.pairing.v1";
pub const STORAGE_ERROR: &str = "Could not access the system credential store.";

/// Tokens persist only in the system store; denied macOS access uses process memory.
pub trait CredentialStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

#[cfg(not(target_os = "macos"))]
pub struct SystemStore;

#[cfg(not(target_os = "macos"))]
impl CredentialStore for SystemStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|_| STORAGE_ERROR)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(STORAGE_ERROR.into()),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| STORAGE_ERROR.into())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|_| STORAGE_ERROR)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(STORAGE_ERROR.into()),
        }
    }
}

/// Hash structured fields so server ports, schemes and account IDs cannot collide.
pub fn key(origin: &Url, user_id: Option<&str>) -> String {
    let scope = serde_json::to_vec(&(SERVICE, origin.origin().ascii_serialization(), user_id))
        .expect("credential scopes can be serialized");
    Sha256::digest(scope)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Clone)]
pub struct Store(pub Arc<dyn CredentialStore>);

impl Default for Store {
    fn default() -> Self {
        #[cfg(not(target_os = "macos"))]
        {
            Self(Arc::new(SystemStore))
        }
        #[cfg(target_os = "macos")]
        {
            Self(Arc::new(macos::UnconfiguredStore))
        }
    }
}

impl Store {
    /// Configure nonsecret credential state without reading any system credentials.
    pub fn system(directory: &Path) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            macos::system(directory)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = directory;
            Ok(Self::default())
        }
    }

    pub async fn get(&self, key: String) -> Result<Option<String>, String> {
        let store = self.0.clone();
        tokio::task::spawn_blocking(move || store.get(&key))
            .await
            .map_err(|_| STORAGE_ERROR)?
    }

    pub async fn set(&self, key: String, value: String) -> Result<(), String> {
        let store = self.0.clone();
        tokio::task::spawn_blocking(move || store.set(&key, &value))
            .await
            .map_err(|_| STORAGE_ERROR)?
    }

    pub async fn delete(&self, key: String) -> Result<(), String> {
        let store = self.0.clone();
        tokio::task::spawn_blocking(move || store.delete(&key))
            .await
            .map_err(|_| STORAGE_ERROR)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_isolate_accounts_and_complete_server_origins() {
        let origin = Url::parse("https://example.com/path").unwrap();
        let first = key(&origin, Some("account-a"));
        assert_eq!(
            first,
            key(
                &Url::parse("https://EXAMPLE.com:443/other").unwrap(),
                Some("account-a")
            )
        );
        assert_ne!(first, key(&origin, Some("account-b")));
        assert_ne!(first, key(&origin, None));
        for server in [
            "https://example.com:8443",
            "http://example.com",
            "https://other.example.com",
        ] {
            assert_ne!(first, key(&Url::parse(server).unwrap(), Some("account-a")));
        }
        assert_ne!(
            key(&Url::parse("http://localhost:4000").unwrap(), Some("a")),
            key(&Url::parse("http://localhost:4001").unwrap(), Some("a"))
        );
    }
}
