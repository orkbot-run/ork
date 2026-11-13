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

fn workspace_digest(
    origin: &Url,
    identity: (&str, &str),
    workspace: Option<&crate::server_directory::WorkspaceTarget>,
    epoch: &str,
) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"orkbot-login-workspace-webview-v2\0");
    hash.update(digest(origin, identity));
    hash.update(epoch.as_bytes());
    hash.update(serde_json::to_vec(&workspace).expect("workspace identity can be serialized"));
    hash.finalize().into()
}

pub fn valid_epoch(epoch: &str) -> bool {
    epoch.len() == 64
        && epoch
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
fn directory_name(origin: &Url, identity: (&str, &str)) -> String {
    let digest = digest(origin, identity);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
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
    workspace: Option<&crate::server_directory::WorkspaceTarget>,
    epoch: &str,
) -> WebviewWindowBuilder<'a, R, M> {
    let digest = workspace_digest(origin, identity, workspace, epoch);
    #[cfg(target_os = "macos")]
    {
        let _ = directory;
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        if persistent_store_available(version.majorVersion) {
            let mut identifier = [0; 16];
            identifier.copy_from_slice(&digest[..16]);
            builder.data_store_identifier(identifier)
        } else {
            // WKWebView silently falls back to its shared persistent store before macOS 14.
            builder.incognito(true)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(
            directory.join("webviews").join(
                digest
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: (&str, &str) = ("https://accounts.example.com", "subject-a");

    #[test]
    fn workspaces_and_rebindings_never_share_a_browser_profile() {
        let origin = Url::parse("https://server.example.com").unwrap();
        let mut target = crate::server_directory::WorkspaceTarget {
            organization_id: "10000000-0000-4000-8000-000000000001".into(),
            server_id: "20000000-0000-4000-8000-000000000001".into(),
            workspace_id: "30000000-0000-4000-8000-000000000001".into(),
            binding_version: 1,
            key_fingerprint: "a".repeat(64),
        };
        let first = workspace_digest(&origin, IDENTITY, Some(&target), &"a".repeat(64));
        assert_ne!(
            first,
            workspace_digest(&origin, IDENTITY, None, &"a".repeat(64))
        );
        assert_eq!(
            first,
            workspace_digest(&origin, IDENTITY, Some(&target), &"a".repeat(64))
        );
        target.workspace_id = "30000000-0000-4000-8000-000000000002".into();
        assert_ne!(
            first,
            workspace_digest(&origin, IDENTITY, Some(&target), &"a".repeat(64))
        );
        target.workspace_id = "30000000-0000-4000-8000-000000000001".into();
        target.binding_version = 2;
        assert_ne!(
            first,
            workspace_digest(&origin, IDENTITY, Some(&target), &"a".repeat(64))
        );
    }

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

    #[test]
    fn a_new_login_cannot_reuse_the_previous_accounts_draft_profile() {
        let origin = Url::parse("https://server.example.test").unwrap();
        let first = workspace_digest(&origin, IDENTITY, None, &"a".repeat(64));
        assert_eq!(
            first,
            workspace_digest(&origin, IDENTITY, None, &"a".repeat(64))
        );
        assert_ne!(
            first,
            workspace_digest(&origin, IDENTITY, None, &"b".repeat(64))
        );
        assert!(valid_epoch(&"a".repeat(64)));
        for invalid in ["", "../old", &"g".repeat(64), &"A".repeat(64)] {
            assert!(!valid_epoch(invalid));
        }
    }
}
