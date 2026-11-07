// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use sha2::{Digest, Sha256};

use super::{CredentialStore, STORAGE_ERROR};

const MAX_BYTES: u64 = 1024 * 1024;

/// macOS sessions use account-private files without invoking Keychain or prompting.
/// Other processes running as the same OS user can access this directory.
struct FileStore {
    directory: PathBuf,
    operation: Mutex<()>,
}

impl FileStore {
    fn new(directory: &Path) -> Result<Self, String> {
        crate::local_stack::private_directory(directory).map_err(|_| STORAGE_ERROR)?;
        let directory = directory.join("credentials");
        crate::local_stack::private_directory(&directory).map_err(|_| STORAGE_ERROR)?;
        let store = Self {
            directory,
            operation: Mutex::new(()),
        };
        store.validate()?;
        // Persist both newly created directory entries before accepting any session writes.
        for directory in [
            store.directory.parent().ok_or(STORAGE_ERROR)?,
            store
                .directory
                .parent()
                .and_then(Path::parent)
                .ok_or(STORAGE_ERROR)?,
        ] {
            fs::File::open(directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| STORAGE_ERROR)?;
        }
        Ok(store)
    }

    fn validate(&self) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        for (directory, mask) in [
            (self.directory.parent().ok_or(STORAGE_ERROR)?, 0o022),
            (self.directory.as_path(), 0o077),
        ] {
            let metadata = fs::symlink_metadata(directory).map_err(|_| STORAGE_ERROR)?;
            // SAFETY: geteuid only reads the process identity.
            if !metadata.is_dir()
                || crate::local_stack::reparse_point(&metadata)
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & mask != 0
            {
                return Err(STORAGE_ERROR.into());
            }
        }
        Ok(())
    }

    fn path(&self, key: &str) -> PathBuf {
        let hash = Sha256::digest(key.as_bytes());
        let name: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
        self.directory.join(name)
    }

    fn read(&self, key: &str) -> Result<Option<String>, String> {
        self.validate()?;
        let path = self.path(key);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(STORAGE_ERROR.into()),
            Ok(_) => {
                let bytes = crate::local_stack::read_owned_private(&path, MAX_BYTES)
                    .ok_or(STORAGE_ERROR)?;
                if bytes.is_empty() {
                    return Ok(None);
                }
                String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| STORAGE_ERROR.into())
            }
        }
    }

    fn write(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        // Validate any predecessor before replacing it; never follow an untrusted file.
        self.read(key)?;
        crate::local_stack::write_private(&self.path(key), bytes).map_err(|_| STORAGE_ERROR)?;
        fs::File::open(&self.directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| STORAGE_ERROR.into())
    }
}

impl CredentialStore for FileStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let _operation = self.operation.lock().map_err(|_| STORAGE_ERROR)?;
        self.read(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let _operation = self.operation.lock().map_err(|_| STORAGE_ERROR)?;
        if value.is_empty() || value.len() as u64 > MAX_BYTES {
            return Err(STORAGE_ERROR.into());
        }
        self.write(key, value.as_bytes())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let _operation = self.operation.lock().map_err(|_| STORAGE_ERROR)?;
        // An atomic empty replacement durably retires a token before logout succeeds.
        self.write(key, b"")
    }
}

#[cfg(target_os = "macos")]
pub(super) fn system(directory: &Path) -> Result<super::Store, String> {
    Ok(super::Store(std::sync::Arc::new(FileStore::new(
        directory,
    )?)))
}

#[cfg(target_os = "macos")]
pub(super) struct UnconfiguredStore;

#[cfg(target_os = "macos")]
impl CredentialStore for UnconfiguredStore {
    fn get(&self, _key: &str) -> Result<Option<String>, String> {
        Err(STORAGE_ERROR.into())
    }
    fn set(&self, _key: &str, _value: &str) -> Result<(), String> {
        Err(STORAGE_ERROR.into())
    }
    fn delete(&self, _key: &str) -> Result<(), String> {
        Err(STORAGE_ERROR.into())
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    use super::*;

    fn permissions(path: &Path, mode: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn a_new_store_recovers_the_saved_session_and_its_rotation_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        {
            let store = FileStore::new(directory.path()).unwrap();
            assert_eq!(store.get("account").unwrap(), None);
            store.set("account", "initial-refresh-token").unwrap();
            store.set("other-account", "another-refresh-token").unwrap();
        }
        {
            let store = FileStore::new(directory.path()).unwrap();
            assert_eq!(
                store.get("account").unwrap().as_deref(),
                Some("initial-refresh-token")
            );
            store.set("account", "rotated-refresh-token").unwrap();
        }
        let restarted = FileStore::new(directory.path()).unwrap();
        assert_eq!(
            restarted.get("account").unwrap().as_deref(),
            Some("rotated-refresh-token")
        );
        assert_eq!(
            restarted.get("other-account").unwrap().as_deref(),
            Some("another-refresh-token")
        );
    }

    #[test]
    fn logout_survives_restart_and_later_sign_in_can_replace_the_retired_value() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        store.set("account", "refresh-before-logout").unwrap();
        store.set("other", "other-session").unwrap();
        store.delete("account").unwrap();
        assert!(fs::read(store.path("account")).unwrap().is_empty());
        drop(store);

        let restarted = FileStore::new(directory.path()).unwrap();
        assert_eq!(restarted.get("account").unwrap(), None);
        assert_eq!(
            restarted.get("other").unwrap().as_deref(),
            Some("other-session")
        );
        restarted.delete("account").unwrap();
        restarted.set("account", "new-refresh-token").unwrap();
        drop(restarted);
        assert_eq!(
            FileStore::new(directory.path())
                .unwrap()
                .get("account")
                .unwrap()
                .as_deref(),
            Some("new-refresh-token")
        );
    }

    #[test]
    fn created_directories_and_replaced_files_remain_private() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("application");
        let store = FileStore::new(&directory).unwrap();
        assert_eq!(fs::metadata(&directory).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            fs::metadata(&store.directory).unwrap().mode() & 0o777,
            0o700
        );
        for value in [Some("first-token"), Some("rotated-token"), None] {
            match value {
                Some(value) => store.set("account", value).unwrap(),
                None => store.delete("account").unwrap(),
            }
            let metadata = fs::metadata(store.path("account")).unwrap();
            assert_eq!(metadata.mode() & 0o777, 0o600);
            // SAFETY: geteuid only reads the process identity.
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        }
    }

    #[test]
    fn directory_symlinks_cannot_redirect_new_or_existing_stores() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let linked_app = directory.path().join("linked-app");
        symlink(outside.path(), &linked_app).unwrap();
        assert!(FileStore::new(&linked_app).is_err());
        assert!(!outside.path().join("credentials").exists());

        let application = directory.path().join("application");
        let store = FileStore::new(&application).unwrap();
        fs::remove_dir(&store.directory).unwrap();
        symlink(outside.path(), &store.directory).unwrap();
        assert!(FileStore::new(&application).is_err());
        assert!(store.get("account").is_err());
        assert!(store.set("account", "must-not-leak").is_err());
        assert!(store.delete("account").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_symlink_at_a_credential_path_is_never_read_replaced_or_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        let outside = directory.path().join("outside-secret");
        crate::local_stack::write_private(&outside, b"outside-value").unwrap();
        symlink(&outside, store.path("account")).unwrap();
        assert!(store.get("account").is_err());
        assert!(store.set("account", "replacement").is_err());
        assert!(store.delete("account").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside-value");
        assert!(fs::symlink_metadata(store.path("account"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn public_permissions_fail_closed_without_changing_the_saved_value() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        store.set("account", "private-value").unwrap();
        for (path, public_mode, restored_mode) in [
            (directory.path().to_path_buf(), 0o777, 0o700),
            (store.directory.clone(), 0o755, 0o700),
            (store.path("account"), 0o644, 0o600),
        ] {
            permissions(&path, public_mode);
            assert!(store.get("account").is_err());
            assert!(store.set("account", "must-not-persist").is_err());
            assert!(store.delete("account").is_err());
            permissions(&path, restored_mode);
            assert_eq!(
                FileStore::new(directory.path())
                    .unwrap()
                    .get("account")
                    .unwrap()
                    .as_deref(),
                Some("private-value")
            );
        }
    }

    #[test]
    fn existing_public_credential_directory_is_rejected_without_chmod() {
        let directory = tempfile::tempdir().unwrap();
        let credentials = directory.path().join("credentials");
        fs::create_dir(&credentials).unwrap();
        permissions(&credentials, 0o755);
        assert!(FileStore::new(directory.path()).is_err());
        assert_eq!(fs::metadata(&credentials).unwrap().mode() & 0o777, 0o755);
    }

    #[test]
    fn arbitrary_keys_stay_bounded_to_opaque_files_in_the_private_directory() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        let keys = [
            "../../escaped",
            "/absolute/path",
            "nested/key",
            "",
            "different-account",
        ];
        for (index, key) in keys.iter().enumerate() {
            store.set(key, &format!("fixture-session-{index}")).unwrap();
        }
        let restarted = FileStore::new(directory.path()).unwrap();
        for (index, key) in keys.iter().enumerate() {
            assert_eq!(
                restarted.get(key).unwrap(),
                Some(format!("fixture-session-{index}"))
            );
        }
        let entries = fs::read_dir(&store.directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), keys.len());
        for entry in entries {
            assert!(entry.file_type().unwrap().is_file());
            let name = entry.file_name().into_string().unwrap();
            assert_eq!(name.len(), 64);
            assert!(name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn malformed_existing_values_fail_without_erasing_or_overwriting_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        for bytes in [vec![0xff, 0xfe], vec![b'x'; MAX_BYTES as usize + 1]] {
            crate::local_stack::write_private(&store.path("account"), &bytes).unwrap();
            assert!(store.get("account").is_err());
            assert!(store.set("account", "must-not-overwrite").is_err());
            assert!(store.delete("account").is_err());
            assert_eq!(fs::read(store.path("account")).unwrap(), bytes);
        }
    }

    #[test]
    fn rejected_new_values_preserve_the_last_persisted_session() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        let largest = "t".repeat(MAX_BYTES as usize);
        store.set("account", &largest).unwrap();
        assert!(store.set("account", "").is_err());
        assert!(store
            .set("account", &"t".repeat(MAX_BYTES as usize + 1))
            .is_err());
        assert_eq!(
            FileStore::new(directory.path())
                .unwrap()
                .get("account")
                .unwrap(),
            Some(largest)
        );
    }

    #[test]
    fn failed_persistence_never_becomes_a_successful_memory_only_session() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileStore::new(directory.path()).unwrap();
        fs::create_dir(store.path("account")).unwrap();
        assert!(store.set("account", "must-not-live-in-memory").is_err());
        assert!(store.get("account").is_err());
        assert!(store.delete("account").is_err());
        assert!(FileStore::new(directory.path())
            .unwrap()
            .get("account")
            .is_err());
        assert_eq!(fs::read_dir(store.path("account")).unwrap().count(), 0);
        fs::remove_dir(store.path("account")).unwrap();
        assert_eq!(store.get("account").unwrap(), None);
    }
}
