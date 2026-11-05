// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited private desktop settings storage, which remains Apache-2.0.
// The new Rust implementation additions follow LICENSE.md.

use std::fs::{self, DirBuilder, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::server::normalize_server_url;

const SETTINGS_FILE: &str = "setup.json";
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;
const SAVE_ERROR: &str = "Could not save the server address.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstanceMode {
    Existing,
    New,
}

#[derive(Clone, Debug)]
pub struct Setup {
    pub mode: InstanceMode,
    pub server_url: Url,
    pub account: Option<String>,
}

impl Setup {
    pub fn belongs_to(&self, identity: (&str, &str)) -> bool {
        self.account.as_deref() == Some(account_key(identity).as_str())
    }
}

pub fn account_key(identity: (&str, &str)) -> String {
    let value = serde_json::to_vec(&identity).expect("account identity can be serialized");
    let digest = Sha256::digest(value);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_account(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_managed_origin(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some_and(|port| port >= 1024)
}

/// Load only the preview's bounded, regular settings file, without following a final symlink.
pub fn load(dir: &Path) -> Option<Setup> {
    let directory = fs::symlink_metadata(dir).ok()?;
    if !directory.is_dir() || is_reparse_point(&directory) {
        return None;
    }
    let path = dir.join(SETTINGS_FILE);
    let before = fs::symlink_metadata(&path).ok()?;
    if !before.is_file() || is_reparse_point(&before) || before.len() > MAX_SETTINGS_BYTES {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    let file = options.open(path).ok()?;
    let after = file.metadata().ok()?;
    if !after.is_file() || is_reparse_point(&after) || !same_file(&before, &after) {
        return None;
    }
    let mut contents = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut contents)
        .ok()?;
    if contents.len() as u64 > MAX_SETTINGS_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(&contents).ok()?;
    let object = value.as_object()?;
    if object.len() != 2 + usize::from(object.contains_key("account")) {
        return None;
    }
    let account = match object.get("account") {
        Some(value) => Some(
            value
                .as_str()
                .filter(|value| valid_account(value))?
                .to_owned(),
        ),
        None => None,
    };
    let mode = match object.get("mode")?.as_str()? {
        "existing" => InstanceMode::Existing,
        "new" => InstanceMode::New,
        _ => return None,
    };
    let server_url = normalize_server_url(object.get("serverUrl")?.as_str()?).ok()?;
    if mode == InstanceMode::New && !valid_managed_origin(&server_url) {
        return None;
    }
    Some(Setup {
        mode,
        server_url,
        account,
    })
}

/// Atomically replace preview settings with a normalized origin and no credentials or headers.
pub fn save(dir: &Path, setup: &Setup) -> Result<(), String> {
    let origin = normalize_server_url(setup.server_url.as_str())?;
    if setup.mode == InstanceMode::New && !valid_managed_origin(&origin) {
        return Err(SAVE_ERROR.into());
    }
    if setup
        .account
        .as_deref()
        .is_some_and(|value| !valid_account(value))
    {
        return Err(SAVE_ERROR.into());
    }
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|_| SAVE_ERROR)?;
    let directory = fs::symlink_metadata(dir).map_err(|_| SAVE_ERROR)?;
    if !directory.is_dir() || is_reparse_point(&directory) {
        return Err(SAVE_ERROR.into());
    }
    let mut value = json!({
        "mode": setup.mode,
        "serverUrl": origin.origin().ascii_serialization(),
    });
    if let Some(account) = &setup.account {
        value["account"] = json!(account);
    }
    let contents = serde_json::to_vec(&value).map_err(|_| SAVE_ERROR)?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(|_| SAVE_ERROR)?;
    temporary.write_all(&contents).map_err(|_| SAVE_ERROR)?;
    temporary.as_file().sync_all().map_err(|_| SAVE_ERROR)?;
    temporary
        .persist(dir.join(SETTINGS_FILE))
        .map_err(|_| SAVE_ERROR)?;
    Ok(())
}

/// Restore the absence of a saved choice if a candidate window cannot be shown.
pub fn clear(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(SETTINGS_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SAVE_ERROR.into()),
    }
}

#[cfg(unix)]
fn no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
}

#[cfg(windows)]
fn no_follow(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_FLAG_OPEN_REPARSE_POINT opens a link itself instead of its destination.
    options.custom_flags(0x0020_0000);
}

#[cfg(unix)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT includes symbolic links and junctions.
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(unix)]
fn same_file(before: &Metadata, after: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev() && before.ino() == after.ino()
}

#[cfg(windows)]
fn same_file(_before: &Metadata, _after: &Metadata) -> bool {
    // The handle was opened as a reparse point and checked above.
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_url(dir: &Path) -> Option<Url> {
        super::load(dir).map(|setup| setup.server_url)
    }
    fn save_url(dir: &Path, url: &Url) -> Result<(), String> {
        super::save(
            dir,
            &Setup {
                mode: InstanceMode::Existing,
                server_url: url.clone(),
                account: None,
            },
        )
    }
    #[test]
    fn managed_choices_are_explicit_and_cannot_target_a_remote_server() {
        let dir = tempfile::tempdir().unwrap();
        let setup = Setup {
            mode: InstanceMode::New,
            server_url: Url::parse("http://127.0.0.1:45173").unwrap(),
            account: None,
        };
        super::save(dir.path(), &setup).unwrap();
        assert_eq!(super::load(dir.path()).unwrap().mode, InstanceMode::New);
        for target in [
            "https://example.com",
            "http://192.168.1.2:45173",
            "http://localhost:45173",
            "http://127.0.0.1:80",
        ] {
            assert!(super::save(
                dir.path(),
                &Setup {
                    mode: InstanceMode::New,
                    server_url: Url::parse(target).unwrap(),
                    account: None,
                }
            )
            .is_err());
            assert_eq!(
                super::load(dir.path()).unwrap().server_url,
                setup.server_url
            );
        }
        super::clear(dir.path()).unwrap();
        assert!(super::load(dir.path()).is_none());
    }

    #[test]
    fn persists_the_account_binding_without_storing_the_identity_or_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "test-subject");
        let setup = Setup {
            mode: InstanceMode::Existing,
            server_url: Url::parse("https://product.example.test").unwrap(),
            account: Some(account_key(identity)),
        };
        super::save(dir.path(), &setup).unwrap();
        let saved = super::load(dir.path()).unwrap();
        assert!(saved.belongs_to(identity));
        assert!(!saved.belongs_to((identity.0, "other-subject")));
        assert!(!saved.belongs_to(("https://other.example.test", identity.1)));
        let contents = fs::read_to_string(dir.path().join(SETTINGS_FILE)).unwrap();
        assert!(!contents.contains(identity.0));
        assert!(!contents.contains(identity.1));
        for account in [
            json!(null),
            json!(17),
            json!("invalid"),
            json!("z".repeat(64)),
        ] {
            fs::write(dir.path().join(SETTINGS_FILE), json!({
                "mode": "existing", "serverUrl": "https://product.example.test", "account": account,
            }).to_string()).unwrap();
            assert!(super::load(dir.path()).is_none());
        }
    }

    #[test]
    fn saves_only_the_normalized_origin_and_can_replace_existing_settings() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("preview");
        let first = Url::parse("https://orkbot.example.com/path?query=1#fragment").unwrap();
        save_url(&dir, &first).unwrap();
        let value: Value =
            serde_json::from_slice(&fs::read(dir.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"mode": "existing", "serverUrl": "https://orkbot.example.com"})
        );
        assert_eq!(
            load_url(&dir).unwrap().as_str(),
            "https://orkbot.example.com/"
        );

        let second = Url::parse("http://localhost:45173/").unwrap();
        save_url(&dir, &second).unwrap();
        assert_eq!(load_url(&dir), Some(second));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn ignores_absent_malformed_oversized_and_nonregular_settings() {
        let root = tempfile::tempdir().unwrap();
        assert!(load_url(&root.path().join("missing")).is_none());
        assert!(load_url(root.path()).is_none());
        let path = root.path().join(SETTINGS_FILE);
        for contents in [
            "not JSON",
            "{}",
            r#"{"mode":"new","serverUrl":"https://example.com"}"#,
            r#"{"mode":"existing","serverUrl":"https://user:secret@example.com"}"#,
            r#"{"mode":"existing","serverUrl":"http://example.com"}"#,
            r#"{"mode":"existing","serverUrl":"https://example.com","headers":{}}"#,
            r#"{"mode":"existing","serverUrl":17}"#,
        ] {
            fs::write(&path, contents).unwrap();
            assert!(load_url(root.path()).is_none(), "{contents}");
        }
        fs::write(&path, vec![b' '; MAX_SETTINGS_BYTES as usize + 1]).unwrap();
        assert!(load_url(root.path()).is_none());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(load_url(root.path()).is_none());
    }

    #[test]
    fn invalid_origins_leave_the_previous_file_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let initial = Url::parse("https://orkbot.example.com").unwrap();
        save_url(dir.path(), &initial).unwrap();
        for url in [
            "https://user:secret@example.com",
            "http://example.com",
            "file:///tmp/ork",
        ] {
            assert!(save_url(dir.path(), &Url::parse(url).unwrap()).is_err());
            assert_eq!(load_url(dir.path()), Some(initial.clone()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn creates_private_settings_without_changing_existing_directory_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("preview");
        save_url(&dir, &Url::parse("https://example.com").unwrap()).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            fs::metadata(dir.join(SETTINGS_FILE)).unwrap().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o750)).unwrap();
        save_url(&dir, &Url::parse("https://other.example.com").unwrap()).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o750);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_read_final_symlinks_and_replaces_them_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("preview");
        fs::create_dir(&dir).unwrap();
        let other = root.path().join("other.json");
        let contents = r#"{"mode":"existing","serverUrl":"https://other.example.com"}"#;
        fs::write(&other, contents).unwrap();
        symlink(&other, dir.join(SETTINGS_FILE)).unwrap();
        assert!(load_url(&dir).is_none());
        let url = Url::parse("https://example.com").unwrap();
        save_url(&dir, &url).unwrap();
        assert_eq!(fs::read_to_string(&other).unwrap(), contents);
        assert_eq!(load_url(&dir), Some(url));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_read_or_write_through_a_symlinked_settings_directory() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let actual = root.path().join("actual");
        let link = root.path().join("preview");
        let url = Url::parse("https://example.com").unwrap();
        save_url(&actual, &url).unwrap();
        symlink(&actual, &link).unwrap();
        assert!(load_url(&link).is_none());
        assert!(save_url(&link, &url).is_err());
    }
}
