// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::path::Path;

use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, WebviewWindowBuilder};
use url::Url;

const PROFILE_NAMESPACE: &[u8] = b"orkbot-preview-webview-v2\0";

fn digest(origin: &Url, identity: (&str, &str)) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(PROFILE_NAMESPACE);
    hash.update(
        serde_json::to_vec(&(
            identity.0,
            identity.1,
            origin.origin().ascii_serialization(),
        ))
        .expect("profile scope can be serialized"),
    );
    hash.finalize().into()
}

#[cfg(any(not(target_os = "macos"), test))]
fn directory_name(origin: &Url, identity: (&str, &str)) -> String {
    let digest = digest(origin, identity);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(any(target_os = "macos", test))]
fn store_identifier(origin: &Url, identity: (&str, &str)) -> [u8; 16] {
    let mut identifier = [0; 16];
    identifier.copy_from_slice(&digest(origin, identity)[..16]);
    identifier
}

#[cfg(any(target_os = "macos", test))]
fn persistent_store_available(major_version: isize) -> bool {
    major_version >= 14
}

/// Isolate cookies by the verified central identity and complete server origin.
pub fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    directory: &Path,
    origin: &Url,
    identity: (&str, &str),
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    {
        let _ = directory;
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        if persistent_store_available(version.majorVersion) {
            builder.data_store_identifier(store_identifier(origin, identity))
        } else {
            // WKWebView silently falls back to its shared persistent store before macOS 14.
            builder.incognito(true)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(
            directory
                .join("webviews")
                .join(directory_name(origin, identity)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: (&str, &str) = ("https://accounts.example.com", "subject-a");

    #[test]
    fn profiles_are_stable_for_one_origin_and_isolate_ports_schemes_and_hosts() {
        let first = Url::parse("http://localhost:45173/one?value=1#part").unwrap();
        let same = Url::parse("http://localhost:45173/two").unwrap();
        assert_eq!(digest(&first, IDENTITY), digest(&same, IDENTITY));
        assert_eq!(
            directory_name(&first, IDENTITY),
            directory_name(&same, IDENTITY)
        );
        assert_eq!(
            store_identifier(&first, IDENTITY),
            store_identifier(&same, IDENTITY)
        );
        assert_eq!(directory_name(&first, IDENTITY).len(), 64);
        assert!(directory_name(&first, IDENTITY)
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        for other in [
            "http://localhost:45174",
            "https://localhost:45173",
            "http://127.0.0.1:45173",
        ] {
            let other = Url::parse(other).unwrap();
            assert_ne!(digest(&first, IDENTITY), digest(&other, IDENTITY));
            assert_ne!(
                store_identifier(&first, IDENTITY),
                store_identifier(&other, IDENTITY)
            );
        }
    }

    #[test]
    fn default_ports_share_the_same_canonical_origin() {
        assert_eq!(
            digest(
                &Url::parse("https://example.com:443/one").unwrap(),
                IDENTITY
            ),
            digest(&Url::parse("https://EXAMPLE.COM/two").unwrap(), IDENTITY),
        );
    }

    #[test]
    fn the_same_server_never_shares_a_profile_across_central_accounts() {
        let origin = Url::parse("https://server.example.com").unwrap();
        for identity in [
            (IDENTITY.0, "subject-b"),
            ("https://other-accounts.example.com", IDENTITY.1),
            ("https://accounts.example.comsubject-", "a"),
        ] {
            assert_ne!(digest(&origin, IDENTITY), digest(&origin, identity));
            assert_ne!(
                directory_name(&origin, IDENTITY),
                directory_name(&origin, identity)
            );
            assert_ne!(
                store_identifier(&origin, IDENTITY),
                store_identifier(&origin, identity)
            );
        }
    }

    #[test]
    fn older_macos_releases_require_an_ephemeral_store() {
        assert!(!persistent_store_available(12));
        assert!(!persistent_store_available(13));
        assert!(persistent_store_available(14));
        assert!(persistent_store_available(26));
    }
}
