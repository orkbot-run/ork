// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::path::Path;

use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, WebviewWindowBuilder};
use url::Url;

const PROFILE_NAMESPACE: &[u8] = b"orkbot-preview-webview-v1\0";

fn digest(origin: &Url) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(PROFILE_NAMESPACE);
    hash.update(origin.origin().ascii_serialization());
    hash.finalize().into()
}

#[cfg(any(not(target_os = "macos"), test))]
fn directory_name(origin: &Url) -> String {
    let digest = digest(origin);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(any(target_os = "macos", test))]
fn store_identifier(origin: &Url) -> [u8; 16] {
    let mut identifier = [0; 16];
    identifier.copy_from_slice(&digest(origin)[..16]);
    identifier
}

#[cfg(any(target_os = "macos", test))]
fn persistent_store_available(major_version: isize) -> bool {
    major_version >= 14
}

/// Keep cookies isolated by the complete server origin, including localhost ports.
pub fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    directory: &Path,
    origin: &Url,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    {
        let _ = directory;
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        if persistent_store_available(version.majorVersion) {
            builder.data_store_identifier(store_identifier(origin))
        } else {
            // WKWebView silently falls back to its shared persistent store before macOS 14.
            builder.incognito(true)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(directory.join("webviews").join(directory_name(origin)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_are_stable_for_one_origin_and_isolate_ports_schemes_and_hosts() {
        let first = Url::parse("http://localhost:45173/one?value=1#part").unwrap();
        let same = Url::parse("http://localhost:45173/two").unwrap();
        assert_eq!(digest(&first), digest(&same));
        assert_eq!(directory_name(&first), directory_name(&same));
        assert_eq!(store_identifier(&first), store_identifier(&same));
        assert_eq!(directory_name(&first).len(), 64);
        assert!(directory_name(&first)
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        for other in [
            "http://localhost:45174",
            "https://localhost:45173",
            "http://127.0.0.1:45173",
        ] {
            let other = Url::parse(other).unwrap();
            assert_ne!(digest(&first), digest(&other));
            assert_ne!(store_identifier(&first), store_identifier(&other));
        }
    }

    #[test]
    fn default_ports_share_the_same_canonical_origin() {
        assert_eq!(
            digest(&Url::parse("https://example.com:443/one").unwrap()),
            digest(&Url::parse("https://EXAMPLE.COM/two").unwrap()),
        );
    }

    #[test]
    fn older_macos_releases_require_an_ephemeral_store() {
        assert!(!persistent_store_available(12));
        assert!(!persistent_store_available(13));
        assert!(persistent_store_available(14));
        assert!(persistent_store_available(26));
    }
}
