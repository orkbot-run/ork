// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use url::Url;

#[cfg(any(target_os = "macos", test))]
use std::{path::Path, time::SystemTime};

#[cfg(any(target_os = "macos", test))]
struct Association {
    domains: Vec<String>,
    team: String,
    expires: SystemTime,
}

#[cfg(any(target_os = "macos", test))]
fn bundle_contents(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && contents.parent()?.extension()? == "app")
        .then_some(contents)
}

#[cfg(any(target_os = "macos", test))]
fn domain(entry: &str) -> Option<&str> {
    let rp = entry.strip_prefix("webcredentials:")?;
    let rp = rp.strip_suffix("?mode=developer").unwrap_or(rp);
    if rp.len() > 253 || !rp.is_ascii() || rp != rp.to_ascii_lowercase() {
        return None;
    }
    let labels: Vec<_> = rp.split('.').collect();
    if labels.len() < 2
        || !labels
            .last()?
            .bytes()
            .any(|byte| byte.is_ascii_alphabetic())
    {
        return None;
    }
    labels
        .iter()
        .all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        .then_some(rp)
}

#[cfg(any(target_os = "macos", test))]
fn association(
    signed: &plist::Value,
    profile: &plist::Value,
    bundle_id: &str,
) -> Option<Association> {
    let signed = signed.as_dictionary()?;
    let profile = profile.as_dictionary()?;
    let entitlements = profile.get("Entitlements")?.as_dictionary()?;
    let team = profile
        .get("TeamIdentifier")?
        .as_array()?
        .first()?
        .as_string()?;
    if team.len() != 10
        || !team
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return None;
    }
    let app_id = format!("{team}.{bundle_id}");
    if signed
        .get("com.apple.application-identifier")?
        .as_string()?
        != app_id
        || entitlements
            .get("com.apple.application-identifier")?
            .as_string()?
            != app_id
    {
        return None;
    }
    let allowed = entitlements
        .get("com.apple.developer.associated-domains")?
        .as_array()?;
    let mut domains = Vec::new();
    for entry in signed
        .get("com.apple.developer.associated-domains")?
        .as_array()?
    {
        let entry = entry.as_string()?;
        let rp = domain(entry)?;
        if !allowed.iter().any(|value| {
            value
                .as_string()
                .is_some_and(|value| value == "*" || value == entry)
        }) {
            return None;
        }
        if entry.ends_with("?mode=developer")
            && (signed
                .get("com.apple.security.get-task-allow")
                .and_then(plist::Value::as_boolean)
                != Some(true)
                || entitlements
                    .get("com.apple.security.get-task-allow")
                    .and_then(plist::Value::as_boolean)
                    != Some(true))
        {
            return None;
        }
        if !domains.contains(&rp.to_owned()) {
            domains.push(rp.to_owned());
        }
    }
    Some(Association {
        domains,
        team: team.to_owned(),
        expires: profile.get("ExpirationDate")?.as_date()?.into(),
    })
}

#[cfg(any(target_os = "macos", test))]
fn verified_association(
    signed: &plist::Value,
    profile: &plist::Value,
    bundle_id: &str,
    verify: impl FnOnce(&str) -> bool,
) -> Option<Association> {
    let association = association(signed, profile, bundle_id)?;
    let requirement = format!(
        "=anchor apple generic and certificate leaf[subject.OU] = \"{}\"",
        association.team
    );
    verify(&requirement).then_some(association)
}

#[cfg(any(target_os = "macos", test))]
fn associated_ids(association: Option<&Association>, origin: &Url, now: SystemTime) -> Vec<String> {
    let Some(association) = association.filter(|association| association.expires > now) else {
        return Vec::new();
    };
    let Some(host) = origin.host_str().filter(|_| {
        origin.scheme() == "https" && origin.username().is_empty() && origin.password().is_none()
    }) else {
        return Vec::new();
    };
    association
        .domains
        .iter()
        .filter(|rp| {
            host == rp.as_str()
                || host
                    .strip_suffix(rp.as_str())
                    .is_some_and(|prefix| prefix.ends_with('.'))
        })
        .cloned()
        .collect()
}

#[cfg(target_os = "macos")]
fn installed_association(bundle_id: &str) -> Option<&'static Association> {
    use std::{process::Command, sync::OnceLock};
    static ASSOCIATION: OnceLock<Option<Association>> = OnceLock::new();
    // Inspect signed metadata once. Expiration and selected-origin checks remain per request.
    ASSOCIATION
        .get_or_init(|| {
            if cfg!(debug_assertions) {
                return None;
            }
            let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
            if version.majorVersion < 13 || (version.majorVersion == 13 && version.minorVersion < 3)
            {
                return None;
            }
            let executable = std::env::current_exe().ok()?;
            let contents = bundle_contents(&executable)?;
            let profile = contents.join("embedded.provisionprofile");
            if !profile.is_file() {
                return None;
            }
            let signed = Command::new("/usr/bin/codesign")
                .args(["-d", "--entitlements", ":-"])
                .arg(&executable)
                .output()
                .ok()?;
            let decoded = Command::new("/usr/bin/security")
                .args(["cms", "-D", "-i"])
                .arg(profile)
                .output()
                .ok()?;
            if !signed.status.success() || !decoded.status.success() {
                return None;
            }
            verified_association(
                &plist::Value::from_reader_xml(signed.stdout.as_slice()).ok()?,
                &plist::Value::from_reader_xml(decoded.stdout.as_slice()).ok()?,
                bundle_id,
                |requirement| {
                    Command::new("/usr/bin/codesign")
                        .args(["--verify", "--strict", "--test-requirement", requirement])
                        .arg(contents.parent().expect("validated app bundle"))
                        .output()
                        .is_ok_and(|output| output.status.success())
                },
            )
        })
        .as_ref()
}

/// WKWebView owns the ceremonies and verifies the domain's AASA. Never infer association from a URL.
pub fn rp_ids(origin: &Url, bundle_id: &str) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        associated_ids(installed_association(bundle_id), origin, SystemTime::now())
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Other system WebViews use standard WebAuthn capability detection.
        let _ = (origin, bundle_id);
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plist::{Dictionary, Value};
    use std::time::{Duration, UNIX_EPOCH};

    const BUNDLE: &str = "run.orkbot.desktop.preview";

    fn metadata() -> (Value, Value) {
        let signed = Dictionary::from_iter::<[(String, Value); 2]>([
            (
                "com.apple.application-identifier".into(),
                Value::String(format!("ABCDE12345.{BUNDLE}")),
            ),
            (
                "com.apple.developer.associated-domains".into(),
                Value::Array(vec![Value::String("webcredentials:app.example.com".into())]),
            ),
        ]);
        let profile = Dictionary::from_iter::<[(String, Value); 3]>([
            (
                "TeamIdentifier".into(),
                Value::Array(vec![Value::String("ABCDE12345".into())]),
            ),
            ("Entitlements".into(), Value::Dictionary(signed.clone())),
            (
                "ExpirationDate".into(),
                Value::Date((UNIX_EPOCH + Duration::from_secs(2_000_000_000)).into()),
            ),
        ]);
        (Value::Dictionary(signed), Value::Dictionary(profile))
    }

    #[test]
    fn only_matching_https_servers_receive_the_signed_relying_party() {
        let (signed, profile) = metadata();
        let association = association(&signed, &profile, BUNDLE).unwrap();
        assert_eq!(association.team, "ABCDE12345");
        for url in [
            "https://app.example.com",
            "https://login.app.example.com:8443/path",
        ] {
            assert_eq!(
                associated_ids(Some(&association), &Url::parse(url).unwrap(), UNIX_EPOCH),
                ["app.example.com"]
            );
        }
        for url in [
            "http://app.example.com",
            "https://evilapp.example.com",
            "https://app.example.com.evil.test",
            "https://example.com",
            "https://user@app.example.com",
            "https://localhost",
            "https://127.0.0.1",
        ] {
            assert!(
                associated_ids(Some(&association), &Url::parse(url).unwrap(), UNIX_EPOCH)
                    .is_empty()
            );
        }
    }

    #[test]
    fn absent_and_expired_associations_fail_closed() {
        let origin = Url::parse("https://app.example.com").unwrap();
        assert!(associated_ids(None, &origin, UNIX_EPOCH).is_empty());
        let (signed, profile) = metadata();
        let association = association(&signed, &profile, BUNDLE).unwrap();
        assert!(associated_ids(Some(&association), &origin, association.expires).is_empty());
        assert!(association_from_empty().is_none());
    }

    fn association_from_empty() -> Option<Association> {
        association(
            &Value::Dictionary(Dictionary::new()),
            &Value::Dictionary(Dictionary::new()),
            BUNDLE,
        )
    }

    #[test]
    fn profile_must_authorize_the_same_app_and_domain() {
        let (signed, mut profile) = metadata();
        assert!(association(&signed, &profile, "run.orkbot.desktop").is_none());
        let entitlements = profile
            .as_dictionary_mut()
            .unwrap()
            .get_mut("Entitlements")
            .unwrap()
            .as_dictionary_mut()
            .unwrap();
        entitlements.insert(
            "com.apple.developer.associated-domains".into(),
            Value::Array(vec![Value::String(
                "webcredentials:other.example.com".into(),
            )]),
        );
        assert!(association(&signed, &profile, BUNDLE).is_none());
        let entitlements = profile
            .as_dictionary_mut()
            .unwrap()
            .get_mut("Entitlements")
            .unwrap()
            .as_dictionary_mut()
            .unwrap();
        entitlements.insert(
            "com.apple.developer.associated-domains".into(),
            Value::Array(vec![Value::String("*".into())]),
        );
        assert!(association(&signed, &profile, BUNDLE).is_some());
    }

    #[test]
    fn malformed_domains_are_never_reported() {
        for invalid in [
            "app.example.com",
            "webcredentials:https://app.example.com",
            "webcredentials:localhost",
            "webcredentials:127.0.0.1",
            "webcredentials:*.example.com",
            "webcredentials:app.example.com:443",
            "webcredentials:APP.example.com",
            "webcredentials:app.example.com?mode=other",
            "webcredentials:app..com",
            "webcredentials:-app.example.com",
            "webcredentials:app.example.com/",
        ] {
            assert!(domain(invalid).is_none(), "{invalid}");
        }
        assert_eq!(
            domain("webcredentials:app.example.com?mode=developer"),
            Some("app.example.com")
        );
    }

    #[test]
    fn only_a_packaged_macos_executable_can_read_the_profile() {
        assert_eq!(
            bundle_contents(Path::new(
                "/Applications/Ork Preview.app/Contents/MacOS/orkbot-desktop-preview"
            )),
            Some(Path::new("/Applications/Ork Preview.app/Contents"))
        );
        for executable in [
            "/tmp/orkbot-desktop-preview",
            "/tmp/Contents/MacOS/orkbot",
            "/tmp/Ork.app/Resources/orkbot",
        ] {
            assert!(bundle_contents(Path::new(executable)).is_none());
        }
    }

    #[test]
    fn ad_hoc_or_wrong_team_signatures_cannot_authorize_valid_metadata() {
        let (signed, profile) = metadata();
        assert!(verified_association(&signed, &profile, BUNDLE, |_| false).is_none());
        assert!(
            verified_association(&signed, &profile, BUNDLE, |requirement| {
                assert_eq!(
                    requirement,
                    "=anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\""
                );
                true
            })
            .is_some()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codesign_parses_the_inline_requirement_and_rejects_an_ad_hoc_executable() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("ad-hoc-test");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        // Intel linkers can leave test binaries unsigned; prepare the same fixture on both CPUs.
        let signature = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            signature.status.success(),
            "{}",
            String::from_utf8_lossy(&signature.stderr)
        );
        let (signed, profile) = metadata();
        let result = verified_association(&signed, &profile, BUNDLE, |requirement| {
            let output = std::process::Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict", "--test-requirement", requirement])
                .arg(&executable)
                .env("LC_ALL", "C")
                .output()
                .unwrap();
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(
                error.contains("failed to satisfy specified code requirement"),
                "{error}"
            );
            output.status.success()
        });
        assert!(result.is_none());
    }

    #[test]
    fn developer_mode_needs_development_entitlements_in_both_app_and_profile() {
        let (mut signed, mut profile) = metadata();
        let domain = Value::Array(vec![Value::String(
            "webcredentials:app.example.com?mode=developer".into(),
        )]);
        signed.as_dictionary_mut().unwrap().insert(
            "com.apple.developer.associated-domains".into(),
            domain.clone(),
        );
        let profile_entitlements = profile
            .as_dictionary_mut()
            .unwrap()
            .get_mut("Entitlements")
            .unwrap()
            .as_dictionary_mut()
            .unwrap();
        profile_entitlements.insert("com.apple.developer.associated-domains".into(), domain);
        assert!(association(&signed, &profile, BUNDLE).is_none());
        signed.as_dictionary_mut().unwrap().insert(
            "com.apple.security.get-task-allow".into(),
            Value::Boolean(true),
        );
        assert!(association(&signed, &profile, BUNDLE).is_none());
        profile
            .as_dictionary_mut()
            .unwrap()
            .get_mut("Entitlements")
            .unwrap()
            .as_dictionary_mut()
            .unwrap()
            .insert(
                "com.apple.security.get-task-allow".into(),
                Value::Boolean(true),
            );
        assert_eq!(
            association(&signed, &profile, BUNDLE).unwrap().domains,
            ["app.example.com"]
        );
    }

    #[test]
    fn unsigned_test_process_reports_no_native_relying_parties() {
        assert!(rp_ids(&Url::parse("https://app.example.com").unwrap(), BUNDLE).is_empty());
    }
}
