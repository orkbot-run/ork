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

fn diagnostic_message(stage: &str, code: Option<i64>, requested: bool) -> Option<String> {
    if !requested
        || ![
            "random",
            "create",
            "read",
            "sign",
            "verify",
            "delete",
            "deleted-read",
            "lookup",
            "access-control",
            "generate",
        ]
        .contains(&stage)
    {
        return None;
    }
    let detail = match code {
        Some(code) => format!("code={}", i32::try_from(code).ok()?),
        None => "category=operation".into(),
    };
    Some(format!("ORK_PERSONAL_KEY_CHECK stage={stage} {detail}"))
}

fn check_requested(arguments: &[String]) -> bool {
    arguments.len() == 2 && arguments[1] == "--personal-device-key-check"
}

fn diagnose(stage: &str, code: Option<i64>) {
    if let Some(message) = diagnostic_message(
        stage,
        code,
        check_requested(&std::env::args().collect::<Vec<_>>()),
    ) {
        eprintln!("{message}");
    }
}

/// Runs inside the signed app bundle so the OS evaluates its real provisioning entitlements.
pub(crate) fn check_cli() -> Option<bool> {
    let arguments: Vec<_> = std::env::args().collect();
    if !arguments
        .iter()
        .any(|value| value == "--personal-device-key-check")
    {
        return None;
    }
    if !check_requested(&arguments) {
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
    getrandom::fill(&mut nonce).map_err(|_| {
        diagnose("random", None);
        ERROR
    })?;
    let label = format!(
        "run.orkbot.personal-device.self-check.{}",
        URL_SAFE_NO_PAD.encode(nonce)
    );
    let keys = SystemKeys;
    let mut stage = "create";
    let checked = (|| {
        let public = keys.create(&label)?;
        stage = "read";
        if keys.public_key(&label)?.as_deref() != Some(&public) {
            return Err(ERROR.to_owned());
        }
        let message = format!(
            "ork-personal-device-key-check-v1:{}",
            URL_SAFE_NO_PAD.encode(nonce)
        );
        stage = "sign";
        let signature = URL_SAFE_NO_PAD
            .decode(keys.sign(&label, message.as_bytes())?)
            .map_err(|_| ERROR)?;
        stage = "verify";
        let key =
            VerifyingKey::from_public_key_der(&URL_SAFE_NO_PAD.decode(public).map_err(|_| ERROR)?)
                .map_err(|_| ERROR)?;
        key.verify(
            message.as_bytes(),
            &Signature::from_der(&signature).map_err(|_| ERROR)?,
        )
        .map_err(|_| ERROR.to_owned())
    })();
    if checked.is_err() {
        diagnose(stage, None);
    }
    let deleted = keys.forget(&label);
    if deleted.is_err() {
        diagnose("delete", None);
    }
    checked.and(deleted)?;
    let remaining = keys
        .public_key(&label)
        .inspect_err(|_| diagnose("deleted-read", None))?;
    if remaining.is_some() {
        diagnose("deleted-read", None);
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
    use core_foundation::{
        base::{CFType, TCFType},
        boolean::CFBoolean,
        dictionary::CFDictionary,
        string::{CFString, CFStringRef},
    };
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        item::{
            CloudSync, ItemClass, ItemSearchOptions, KeyClass, Location, Reference, SearchResult,
        },
        key::{Algorithm, GenerateKeyOptions, KeyType, SecKey},
    };
    use security_framework_sys::{
        item::{
            kSecAttrLabel, kSecAttrSynchronizable, kSecClass, kSecClassKey,
            kSecUseAuthenticationUI, kSecUseDataProtectionKeychain,
        },
        keychain_item::SecItemDelete,
    };

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        // This public Security constant is not exported by security-framework-sys 2.17.
        static kSecUseAuthenticationUIFail: CFStringRef;
    }

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
            Err(error) => {
                diagnose("lookup", Some(i64::from(error.code())));
                Err(ERROR.into())
            }
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

    fn deletion_query(label: &str) -> CFDictionary<CFString, CFType> {
        // SAFETY: These are process-lifetime Security CFString constants. Get-rule wrappers
        // retain them, and the resulting dictionary retains each scoped key and value.
        unsafe {
            CFDictionary::from_CFType_pairs(&[
                (
                    CFString::wrap_under_get_rule(kSecClass),
                    CFString::wrap_under_get_rule(kSecClassKey).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrLabel),
                    CFString::new(label).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecUseDataProtectionKeychain),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrSynchronizable),
                    CFBoolean::false_value().as_CFType(),
                ),
                // UISkip is search-only. UIFail preserves noninteractive deletion.
                (
                    CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
                    CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).as_CFType(),
                ),
            ])
        }
    }

    fn delete_status(label: &str) -> i32 {
        let query = deletion_query(label);
        // SAFETY: The owned dictionary remains alive for the synchronous Security call.
        unsafe { SecItemDelete(query.as_concrete_TypeRef()) }
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
            .map_err(|error| {
                diagnose("access-control", Some(i64::from(error.code())));
                ERROR
            })?;
            let mut options = GenerateKeyOptions::default();
            options
                .set_key_type(KeyType::ec_sec_prime_random())
                .set_size_in_bits(256)
                .set_label(label)
                .set_location(Location::DataProtectionKeychain)
                .set_access_control(access)
                .set_synchronizable(false);
            // The private SecKey never has an external representation requested by this app.
            let created = SecKey::new(&options).map_err(|error| {
                diagnose("generate", Some(error.code() as i64));
                ERROR
            })?;
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
                .map_err(|error| {
                    diagnose("sign", Some(error.code() as i64));
                    ERROR.into()
                })
        }
        fn forget(&self, label: &str) -> Result<(), String> {
            match delete_status(label) {
                0 | -25300 => Ok(()),
                code => {
                    diagnose("delete", Some(i64::from(code)));
                    Err(ERROR.into())
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn deletion_keeps_exact_key_label_protection_scope_and_disallows_interaction() {
            let label = "run.orkbot.personal-device.scope-assertion";
            let dictionary = deletion_query(label);
            // SAFETY: The same system-owned constants are retained by the dictionary above.
            unsafe {
                let value = |key| dictionary.get(CFString::wrap_under_get_rule(key)).clone();
                assert_eq!(
                    value(kSecClass),
                    CFString::wrap_under_get_rule(kSecClassKey).as_CFType()
                );
                assert_eq!(value(kSecAttrLabel), CFString::new(label).as_CFType());
                assert_eq!(
                    value(kSecUseDataProtectionKeychain),
                    CFBoolean::true_value().as_CFType()
                );
                assert_eq!(
                    value(kSecAttrSynchronizable),
                    CFBoolean::false_value().as_CFType()
                );
                assert_eq!(
                    value(kSecUseAuthenticationUI),
                    CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).as_CFType()
                );
            }
        }

        #[test]
        fn deleting_a_nonexistent_random_key_reaches_authorization_instead_of_invalid_parameters() {
            let mut nonce = [0u8; 24];
            getrandom::fill(&mut nonce).unwrap();
            let label = format!(
                "run.orkbot.personal-device.nonexistent-canary.{}",
                URL_SAFE_NO_PAD.encode(nonce)
            );
            assert!(key(&label).unwrap().is_none());
            // Unsigned unit tests have no application-identifier entitlement. A signed app
            // reaches item-not-found; an unsigned process must still fail authorization.
            let status = delete_status(&label);
            assert!(
                matches!(status, -25300 | -34018),
                "Unexpected OSStatus: {status}"
            );
            assert_eq!(SystemKeys.forget(&label).is_ok(), status == -25300);
            assert!(key(&label).unwrap().is_none());
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn diagnostics_require_the_exact_native_check_and_only_static_stages_and_statuses() {
        let arguments = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        assert!(check_requested(&arguments(&[
            "app",
            "--personal-device-key-check"
        ])));
        for values in [
            vec!["app"],
            vec!["app", "--personal-device-key-check", "other"],
            vec!["app", "--other"],
        ] {
            assert!(!check_requested(&arguments(&values)));
        }
        assert_eq!(
            diagnostic_message("lookup", Some(-34018), true).as_deref(),
            Some("ORK_PERSONAL_KEY_CHECK stage=lookup code=-34018")
        );
        assert_eq!(
            diagnostic_message("verify", None, true).as_deref(),
            Some("ORK_PERSONAL_KEY_CHECK stage=verify category=operation")
        );
        assert!(diagnostic_message("lookup", Some(-34018), false).is_none());
        assert!(diagnostic_message("private-label", None, true).is_none());
        assert!(diagnostic_message("lookup", Some(i64::MAX), true).is_none());
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
