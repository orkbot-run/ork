// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::pkcs8::EncodePublicKey;

const ERROR: &str = "Could not access this installation's personal device key.";

#[cfg(windows)]
#[path = "personal_keys_windows.rs"]
mod windows;

/// This interface is native-only. Callers expose closed login proofs, never a signing IPC.
pub(crate) trait DeviceKeys: Send + Sync {
    fn create(&self, label: &str) -> Result<String, String>;
    fn public_key(&self, label: &str) -> Result<Option<String>, String>;
    fn sign(&self, label: &str, message: &[u8]) -> Result<String, String>;
    fn forget(&self, label: &str) -> Result<(), String>;
}

pub(crate) struct SystemKeys;

/// Runs inside the signed app bundle so the OS evaluates its real provisioning entitlements.
pub(crate) fn check_cli() -> Option<bool> {
    let arguments: Vec<_> = std::env::args().collect();
    if !arguments
        .iter()
        .any(|value| value == "--personal-device-key-check")
    {
        return None;
    }
    if arguments.len() != 2 {
        return Some(false);
    }
    Some(check_system_key().is_ok())
}

fn check_system_key() -> Result<(), String> {
    use p256::{
        ecdsa::{signature::Verifier, Signature, VerifyingKey},
        pkcs8::DecodePublicKey,
    };
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| ERROR)?;
    let label = format!(
        "run.orkbot.personal-device.self-check.{}",
        URL_SAFE_NO_PAD.encode(nonce)
    );
    let keys = SystemKeys;
    let checked = (|| {
        let public = keys.create(&label)?;
        if keys.public_key(&label)?.as_deref() != Some(&public) {
            return Err(ERROR.to_owned());
        }
        let message = format!(
            "ork-personal-device-key-check-v1:{}",
            URL_SAFE_NO_PAD.encode(nonce)
        );
        let signature = URL_SAFE_NO_PAD
            .decode(keys.sign(&label, message.as_bytes())?)
            .map_err(|_| ERROR)?;
        let key =
            VerifyingKey::from_public_key_der(&URL_SAFE_NO_PAD.decode(public).map_err(|_| ERROR)?)
                .map_err(|_| ERROR)?;
        key.verify(
            message.as_bytes(),
            &Signature::from_der(&signature).map_err(|_| ERROR)?,
        )
        .map_err(|_| ERROR.to_owned())
    })();
    let deleted = keys.forget(&label);
    checked.and(deleted)?;
    if keys.public_key(&label)?.is_some() {
        return Err(ERROR.into());
    }
    Ok(())
}

fn public_der(bytes: &[u8]) -> Result<String, String> {
    p256::PublicKey::from_sec1_bytes(bytes)
        .and_then(|key| {
            key.to_public_key_der()
                .map_err(|_| p256::elliptic_curve::Error)
        })
        .map(|der| URL_SAFE_NO_PAD.encode(der.as_bytes()))
        .map_err(|_| ERROR.into())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        item::{
            CloudSync, ItemClass, ItemSearchOptions, KeyClass, Location, Reference, SearchResult,
        },
        key::{Algorithm, GenerateKeyOptions, KeyType, SecKey},
    };

    fn query(label: &str) -> ItemSearchOptions {
        let mut query = ItemSearchOptions::new();
        query
            .class(ItemClass::key())
            .label(label)
            .ignore_legacy_keychains()
            .cloud_sync(CloudSync::MatchSyncNo)
            .skip_authenticated_items(true);
        query
    }

    fn key(label: &str) -> Result<Option<SecKey>, String> {
        let mut query = query(label);
        query
            .key_class(KeyClass::private())
            .load_refs(true)
            .limit(2);
        match query.search() {
            Err(error) if error.code() == -25300 => Ok(None),
            Ok(mut found) if found.len() == 1 => match found.pop() {
                Some(SearchResult::Ref(Reference::Key(key))) => Ok(Some(key)),
                _ => Err(ERROR.into()),
            },
            _ => Err(ERROR.into()),
        }
    }

    fn public(key: &SecKey) -> Result<String, String> {
        let bytes = key
            .public_key()
            .and_then(|key| key.external_representation())
            .ok_or(ERROR)?;
        public_der(bytes.bytes())
    }

    impl DeviceKeys for SystemKeys {
        fn create(&self, label: &str) -> Result<String, String> {
            if key(label)?.is_some() {
                return Err(ERROR.into());
            }
            let access = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )
            .map_err(|_| ERROR)?;
            let mut options = GenerateKeyOptions::default();
            options
                .set_key_type(KeyType::ec_sec_prime_random())
                .set_size_in_bits(256)
                .set_label(label)
                .set_location(Location::DataProtectionKeychain)
                .set_access_control(access)
                .set_synchronizable(false);
            // The private SecKey never has an external representation requested by this app.
            let created = SecKey::new(&options).map_err(|_| ERROR)?;
            let result = public(&created);
            if result.is_err() {
                let _ = self.forget(label);
            }
            result
        }
        fn public_key(&self, label: &str) -> Result<Option<String>, String> {
            key(label)?.map(|key| public(&key)).transpose()
        }
        fn sign(&self, label: &str, message: &[u8]) -> Result<String, String> {
            let key = key(label)?.ok_or(ERROR)?;
            key.create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message)
                .map(|signature| URL_SAFE_NO_PAD.encode(signature))
                .map_err(|_| ERROR.into())
        }
        fn forget(&self, label: &str) -> Result<(), String> {
            match query(label).delete() {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err(ERROR.into()),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    use p256::{
        ecdsa::{signature::Signer, Signature, SigningKey},
        pkcs8::{DecodePrivateKey, EncodePrivateKey},
    };
    use zeroize::Zeroizing;
    const SERVICE: &str = "run.orkbot.personal-device.v1";

    fn machine() -> Result<String, String> {
        #[cfg(target_os = "linux")]
        {
            let value = std::fs::read_to_string("/etc/machine-id").map_err(|_| ERROR)?;
            let value = value.trim();
            if value.len() != 32
                || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                || value.bytes().all(|byte| byte == b'0')
            {
                return Err(ERROR.into());
            }
            Ok(value.to_ascii_lowercase())
        }
        #[cfg(target_os = "windows")]
        {
            Ok("windows-dpapi-machine-v1".into())
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Err(ERROR.into())
        }
    }
    fn entry(label: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, label).map_err(|_| ERROR.into())
    }
    fn key(label: &str) -> Result<Option<SigningKey>, String> {
        let value = match entry(label)?.get_password() {
            Ok(value) => Zeroizing::new(value),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err(ERROR.into()),
        };
        let (stored_machine, encoded) = value.split_once('\n').ok_or(ERROR)?;
        if stored_machine != machine()? {
            return Err(ERROR.into());
        }
        let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).map_err(|_| ERROR)?);
        #[cfg(windows)]
        let bytes = super::windows::unprotect(&bytes, label)?;
        SigningKey::from_pkcs8_der(&bytes)
            .map(Some)
            .map_err(|_| ERROR.into())
    }
    impl DeviceKeys for SystemKeys {
        fn create(&self, label: &str) -> Result<String, String> {
            if key(label)?.is_some() {
                return Err(ERROR.into());
            }
            let key = SigningKey::random(&mut rand_core::OsRng);
            let der = key.to_pkcs8_der().map_err(|_| ERROR)?;
            #[cfg(windows)]
            let protected = super::windows::protect(der.as_bytes(), label)?;
            #[cfg(windows)]
            let stored = &protected[..];
            #[cfg(not(windows))]
            let stored = der.as_bytes();
            let secret = Zeroizing::new(format!(
                "{}\n{}",
                machine()?,
                URL_SAFE_NO_PAD.encode(stored)
            ));
            let public = public_der(key.verifying_key().to_encoded_point(false).as_bytes())?;
            entry(label)?.set_password(&secret).map_err(|_| ERROR)?;
            Ok(public)
        }
        fn public_key(&self, label: &str) -> Result<Option<String>, String> {
            key(label)?
                .map(|key| public_der(key.verifying_key().to_encoded_point(false).as_bytes()))
                .transpose()
        }
        fn sign(&self, label: &str, message: &[u8]) -> Result<String, String> {
            let key = key(label)?.ok_or(ERROR)?;
            let signature: Signature = key.sign(message);
            Ok(URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes()))
        }
        fn forget(&self, label: &str) -> Result<(), String> {
            match entry(label)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(ERROR.into()),
            }
        }
    }
}
