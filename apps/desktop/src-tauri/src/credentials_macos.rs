// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use sha2::{Digest, Sha256};

use super::{CredentialStore, STORAGE_ERROR};

const BLOCKED: &[u8] = b"1\n";

#[derive(Debug, PartialEq, Eq)]
enum BackendError {
    Unavailable,
    Failed,
}

/// This boundary keeps all regression tests independent of the real keychain.
trait Backend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, BackendError>;
    fn set(&self, key: &str, value: &str) -> Result<(), BackendError>;
    fn delete(&self, key: &str) -> Result<(), BackendError>;
}

/// Sync each newly created directory entry before any credential can be retired.
fn prepare_directory(directory: &Path) -> Result<(), String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !crate::local_stack::reparse_point(&metadata) => {}
        Ok(_) => return Err(STORAGE_ERROR.into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            prepare_directory(directory.parent().ok_or(STORAGE_ERROR)?)?;
            crate::local_stack::private_directory(directory).map_err(|_| STORAGE_ERROR)?;
        }
        Err(_) => return Err(STORAGE_ERROR.into()),
    }
    fs::File::open(directory.parent().ok_or(STORAGE_ERROR)?)
        .and_then(|parent| parent.sync_all())
        .map_err(|_| STORAGE_ERROR.into())
}

struct Tombstones(PathBuf);

impl Tombstones {
    fn new(directory: &Path) -> Result<Self, String> {
        prepare_directory(directory)?;
        let directory = directory.join("credential-state");
        prepare_directory(&directory)?;
        let state = Self(directory);
        state.validate()?;
        Ok(state)
    }

    fn validate(&self) -> Result<(), String> {
        let metadata = fs::symlink_metadata(&self.0).map_err(|_| STORAGE_ERROR)?;
        if !metadata.is_dir() || crate::local_stack::reparse_point(&metadata) {
            return Err(STORAGE_ERROR.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid only reads the process identity.
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return Err(STORAGE_ERROR.into());
            }
        }
        Ok(())
    }

    fn path(&self, key: &str) -> PathBuf {
        let hash = Sha256::digest(key.as_bytes());
        let name: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
        self.0.join(name)
    }

    fn blocked(&self, key: &str) -> Result<bool, String> {
        self.validate()?;
        let path = self.path(key);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(STORAGE_ERROR.into()),
            Ok(_) => {
                if crate::local_stack::read_owned_private(&path, BLOCKED.len() as u64).as_deref()
                    != Some(BLOCKED)
                {
                    return Err(STORAGE_ERROR.into());
                }
                Ok(true)
            }
        }
    }

    fn mark(&self, key: &str) -> Result<(), String> {
        if !self.blocked(key)? {
            crate::local_stack::write_private(&self.path(key), BLOCKED)
                .map_err(|_| STORAGE_ERROR)?;
        }
        self.sync()
    }

    fn clear(&self, key: &str) -> Result<(), String> {
        if self.blocked(key)? {
            fs::remove_file(self.path(key)).map_err(|_| STORAGE_ERROR)?;
            self.sync()?;
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), String> {
        fs::File::open(&self.0)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| STORAGE_ERROR.into())
    }
}

struct QuietStore<B> {
    backend: B,
    tombstones: Tombstones,
    memory: Mutex<HashMap<String, String>>,
}

impl<B: Backend> QuietStore<B> {
    fn new(directory: &Path, backend: B) -> Result<Self, String> {
        Ok(Self {
            backend,
            tombstones: Tombstones::new(directory)?,
            memory: Mutex::new(HashMap::new()),
        })
    }
}

impl<B: Backend> CredentialStore for QuietStore<B> {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let mut memory = self.memory.lock().map_err(|_| STORAGE_ERROR)?;
        let blocked = self.tombstones.blocked(key)?;
        if let Some(value) = memory.get(key) {
            return Ok(Some(value.clone()));
        }
        if blocked {
            return Ok(None);
        }
        match self.backend.get(key) {
            Ok(value) => {
                if let Some(value) = &value {
                    memory.insert(key.into(), value.clone());
                }
                Ok(value)
            }
            Err(BackendError::Unavailable) => {
                self.tombstones.mark(key)?;
                Ok(None)
            }
            Err(BackendError::Failed) => Err(STORAGE_ERROR.into()),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut memory = self.memory.lock().map_err(|_| STORAGE_ERROR)?;
        // Retire any predecessor before an OS call or a crash can interrupt replacement.
        self.tombstones.mark(key)?;
        memory.remove(key);
        match self.backend.set(key, value) {
            Ok(()) => {
                self.tombstones.clear(key)?;
                memory.insert(key.into(), value.into());
                Ok(())
            }
            Err(BackendError::Unavailable) => {
                memory.insert(key.into(), value.into());
                Ok(())
            }
            Err(BackendError::Failed) => Err(STORAGE_ERROR.into()),
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let mut memory = self.memory.lock().map_err(|_| STORAGE_ERROR)?;
        // The durable marker makes logical logout authoritative even when the OS refuses deletion.
        self.tombstones.mark(key)?;
        memory.remove(key);
        match self.backend.delete(key) {
            Ok(()) | Err(BackendError::Unavailable) => Ok(()),
            Err(BackendError::Failed) => Err(STORAGE_ERROR.into()),
        }
    }
}

#[cfg(target_os = "macos")]
struct SystemBackend;

#[cfg(target_os = "macos")]
fn no_interaction() -> Result<(), BackendError> {
    use security_framework::os::macos::keychain::{KeychainUserInteractionLock, SecKeychain};
    use std::sync::OnceLock;
    // This process-wide guard is never dropped or toggled by concurrent operations.
    static POLICY: OnceLock<Result<KeychainUserInteractionLock, ()>> = OnceLock::new();
    POLICY
        .get_or_init(|| SecKeychain::disable_user_interaction().map_err(|_| ()))
        .as_ref()
        .map(|_| ())
        .map_err(|_| BackendError::Failed)
}

#[cfg(target_os = "macos")]
fn backend_error(error: security_framework::base::Error) -> BackendError {
    match error.code() {
        // Locked storage, denied ACL, or absent keychain are optional persistence failures.
        -25308 | -25293 | -25291 | -25292 | -25307 => BackendError::Unavailable,
        _ => BackendError::Failed,
    }
}

#[cfg(target_os = "macos")]
fn legacy_options(key: &str) -> security_framework::passwords::PasswordOptions {
    use core_foundation::{base::TCFType, boolean::CFBoolean, string::CFString};
    use security_framework::passwords::PasswordOptions;
    use security_framework_sys::item::kSecUseDataProtectionKeychain;
    let mut options = PasswordOptions::new_generic_password(super::SERVICE, key);
    // Version 3.7 has no setter for selecting the legacy store; never search a different store.
    #[allow(deprecated)]
    options.query.push((
        // SAFETY: this is a static Security.framework CFString constant.
        unsafe { CFString::wrap_under_get_rule(kSecUseDataProtectionKeychain) },
        CFBoolean::false_value().into_CFType(),
    ));
    options
}

#[cfg(target_os = "macos")]
impl Backend for SystemBackend {
    fn get(&self, key: &str) -> Result<Option<String>, BackendError> {
        use security_framework::passwords::generic_password;
        no_interaction()?;
        match generic_password(legacy_options(key)) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| BackendError::Failed),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(backend_error(error)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), BackendError> {
        no_interaction()?;
        security_framework::passwords::set_generic_password_options(
            value.as_bytes(),
            legacy_options(key),
        )
        .map_err(backend_error)
    }

    fn delete(&self, key: &str) -> Result<(), BackendError> {
        no_interaction()?;
        match security_framework::passwords::delete_generic_password_options(legacy_options(key)) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(backend_error(error)),
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn system(directory: &Path) -> Result<super::Store, String> {
    Ok(super::Store(std::sync::Arc::new(QuietStore::new(
        directory,
        SystemBackend,
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
    use super::*;
    use std::sync::{mpsc, Arc};

    #[derive(Default)]
    struct FakeBackend {
        values: Mutex<HashMap<String, String>>,
        failure: Mutex<Option<BackendError>>,
        calls: Mutex<Vec<&'static str>>,
        markers: Option<PathBuf>,
        block_set: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    }

    impl FakeBackend {
        fn result(&self, operation: &'static str) -> Result<(), BackendError> {
            self.calls.lock().unwrap().push(operation);
            match self.failure.lock().unwrap().as_ref() {
                Some(BackendError::Unavailable) => Err(BackendError::Unavailable),
                Some(BackendError::Failed) => Err(BackendError::Failed),
                None => Ok(()),
            }
        }

        fn assert_marked(&self, key: &str) {
            if let Some(directory) = &self.markers {
                assert!(Tombstones(directory.clone()).blocked(key).unwrap());
            }
        }
    }

    impl Backend for Arc<FakeBackend> {
        fn get(&self, key: &str) -> Result<Option<String>, BackendError> {
            self.result("get")?;
            Ok(self.values.lock().unwrap().get(key).cloned())
        }

        fn set(&self, key: &str, value: &str) -> Result<(), BackendError> {
            self.assert_marked(key);
            if let Some((entered, release)) = self.block_set.lock().unwrap().take() {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            self.result("set")?;
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }

        fn delete(&self, key: &str) -> Result<(), BackendError> {
            self.assert_marked(key);
            self.result("delete")?;
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn backend(directory: &Path) -> Arc<FakeBackend> {
        Arc::new(FakeBackend {
            markers: Some(directory.join("credential-state")),
            ..Default::default()
        })
    }

    #[test]
    fn construction_never_accesses_system_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn fresh_install_prepares_an_absent_application_directory_without_os_access() {
        let directory = tempfile::tempdir().unwrap();
        let application = directory.path().join("fresh").join("application");
        let backend = backend(&application);
        let store = QuietStore::new(&application, backend.clone()).unwrap();
        assert!(store.tombstones.0.is_dir());
        store.tombstones.validate().unwrap();
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn denied_read_is_absent_and_cannot_resurrect_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        backend
            .values
            .lock()
            .unwrap()
            .insert("account".into(), "old-token".into());
        *backend.failure.lock().unwrap() = Some(BackendError::Unavailable);
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(store.get("account").unwrap(), None);
        assert!(store.tombstones.blocked("account").unwrap());
        drop(store);
        *backend.failure.lock().unwrap() = None;
        let restarted = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(restarted.get("account").unwrap(), None);
        assert_eq!(*backend.calls.lock().unwrap(), ["get"]);
        assert_eq!(backend.values.lock().unwrap()["account"], "old-token");
    }

    #[test]
    fn denied_write_uses_only_memory_until_a_successful_persistent_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        backend
            .values
            .lock()
            .unwrap()
            .insert("account".into(), "old-token".into());
        *backend.failure.lock().unwrap() = Some(BackendError::Unavailable);
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        store.set("account", "session-token").unwrap();
        assert_eq!(
            store.get("account").unwrap().as_deref(),
            Some("session-token")
        );
        assert_eq!(fs::read(store.tombstones.path("account")).unwrap(), BLOCKED);
        assert_eq!(backend.values.lock().unwrap()["account"], "old-token");
        drop(store);
        let restarted = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(restarted.get("account").unwrap(), None);
        *backend.failure.lock().unwrap() = None;
        restarted.set("account", "new-token").unwrap();
        assert!(!restarted.tombstones.blocked("account").unwrap());
        drop(restarted);
        let restarted = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(
            restarted.get("account").unwrap().as_deref(),
            Some("new-token")
        );
    }

    #[test]
    fn successful_write_keeps_the_process_session_when_further_reads_are_denied() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        store.set("account", "new-token").unwrap();
        assert!(!store.tombstones.blocked("account").unwrap());
        *backend.failure.lock().unwrap() = Some(BackendError::Unavailable);
        assert_eq!(store.get("account").unwrap().as_deref(), Some("new-token"));
        assert_eq!(*backend.calls.lock().unwrap(), ["set"]);
        store.delete("account").unwrap();
        assert_eq!(store.get("account").unwrap(), None);
        assert!(store.tombstones.blocked("account").unwrap());
        drop(store);
        *backend.failure.lock().unwrap() = None;
        let restarted = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(restarted.get("account").unwrap(), None);
        assert_eq!(*backend.calls.lock().unwrap(), ["set", "delete"]);
    }

    #[test]
    fn restored_session_remains_available_only_until_delete_or_process_restart() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        backend
            .values
            .lock()
            .unwrap()
            .insert("account".into(), "restored-token".into());
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(
            store.get("account").unwrap().as_deref(),
            Some("restored-token")
        );
        *backend.failure.lock().unwrap() = Some(BackendError::Unavailable);
        assert_eq!(
            store.get("account").unwrap().as_deref(),
            Some("restored-token")
        );
        assert_eq!(*backend.calls.lock().unwrap(), ["get"]);
        drop(store);
        let restarted = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(restarted.get("account").unwrap(), None);
        assert!(restarted.tombstones.blocked("account").unwrap());
        assert_eq!(*backend.calls.lock().unwrap(), ["get", "get"]);
    }

    #[test]
    fn denied_delete_clears_memory_and_durably_blocks_only_the_selected_key() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        backend.values.lock().unwrap().extend([
            ("account".into(), "old-token".into()),
            ("other".into(), "other-token".into()),
        ]);
        *backend.failure.lock().unwrap() = Some(BackendError::Unavailable);
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        store.set("account", "session-token").unwrap();
        store.delete("account").unwrap();
        assert_eq!(store.get("account").unwrap(), None);
        drop(store);
        *backend.failure.lock().unwrap() = None;
        let restarted = QuietStore::new(directory.path(), backend.clone()).unwrap();
        assert_eq!(restarted.get("account").unwrap(), None);
        assert_eq!(
            restarted.get("other").unwrap().as_deref(),
            Some("other-token")
        );
        assert_eq!(backend.values.lock().unwrap()["account"], "old-token");
    }

    #[test]
    fn successful_delete_still_leaves_a_safe_marker_until_the_next_write() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        store.set("account", "token").unwrap();
        store.delete("account").unwrap();
        assert!(backend.values.lock().unwrap().is_empty());
        assert!(store.tombstones.blocked("account").unwrap());
        store.set("account", "replacement").unwrap();
        assert!(!store.tombstones.blocked("account").unwrap());
    }

    #[test]
    fn unexpected_backend_errors_fail_closed_instead_of_becoming_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        *backend.failure.lock().unwrap() = Some(BackendError::Failed);
        let store = QuietStore::new(directory.path(), backend).unwrap();
        assert_eq!(store.get("read").unwrap_err(), STORAGE_ERROR);
        assert_eq!(store.set("write", "token").unwrap_err(), STORAGE_ERROR);
        assert_eq!(store.delete("delete").unwrap_err(), STORAGE_ERROR);
        assert!(store.memory.lock().unwrap().is_empty());
    }

    #[test]
    fn marker_io_failure_prevents_os_writes_and_deletes() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        fs::remove_dir(&store.tombstones.0).unwrap();
        fs::write(&store.tombstones.0, b"invalid directory").unwrap();
        assert_eq!(store.get("account").unwrap_err(), STORAGE_ERROR);
        assert_eq!(store.set("account", "token").unwrap_err(), STORAGE_ERROR);
        assert_eq!(store.delete("account").unwrap_err(), STORAGE_ERROR);
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn symlink_or_corrupt_marker_is_never_treated_as_absent() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        let store = QuietStore::new(directory.path(), backend.clone()).unwrap();
        let path = store.tombstones.path("account");
        fs::write(&path, b"invalid").unwrap();
        assert!(store.get("account").is_err());
        fs::remove_file(&path).unwrap();
        let target = directory.path().join("unrelated");
        fs::write(&target, b"unrelated contents").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(store.get("account").is_err());
        assert!(store.set("account", "token").is_err());
        assert!(store.delete("account").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"unrelated contents");
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_delete_cannot_be_undone_by_an_older_inflight_write() {
        let directory = tempfile::tempdir().unwrap();
        let backend = backend(directory.path());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *backend.block_set.lock().unwrap() = Some((entered_tx, release_rx));
        let store = Arc::new(QuietStore::new(directory.path(), backend.clone()).unwrap());
        let writer = store.clone();
        let writing = std::thread::spawn(move || writer.set("account", "new-token"));
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let deleting = store.clone();
        let deletion = std::thread::spawn(move || deleting.delete("account"));
        release_tx.send(()).unwrap();
        writing.join().unwrap().unwrap();
        deletion.join().unwrap().unwrap();
        assert_eq!(store.get("account").unwrap(), None);
        assert!(backend.values.lock().unwrap().is_empty());
        assert!(store.tombstones.blocked("account").unwrap());
        assert_eq!(*backend.calls.lock().unwrap(), ["set", "delete"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_process_policy_disallows_interaction_without_accessing_credentials() {
        no_interaction().unwrap();
        assert!(
            !security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                .unwrap()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[allow(deprecated)]
    fn native_query_preserves_service_key_and_never_searches_the_dp_store() {
        use core_foundation::{base::TCFType, boolean::CFBoolean, string::CFString};
        let options = legacy_options("credential-key");
        let fields: HashMap<String, _> = options
            .query
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect();
        assert_eq!(fields.len(), 4);
        assert_eq!(
            fields["svce"].downcast::<CFString>().unwrap().to_string(),
            super::super::SERVICE
        );
        assert_eq!(
            fields["acct"].downcast::<CFString>().unwrap().to_string(),
            "credential-key"
        );
        let selector = unsafe {
            CFString::wrap_under_get_rule(
                security_framework_sys::item::kSecUseDataProtectionKeychain,
            )
        };
        assert_eq!(
            fields[&selector.to_string()],
            CFBoolean::false_value().into_CFType()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_statuses_distinguish_denied_access_from_corruption() {
        for code in [-25308, -25293, -25291, -25292, -25307] {
            assert_eq!(
                backend_error(security_framework::base::Error::from_code(code)),
                BackendError::Unavailable
            );
        }
        for code in [-50, -25295, -26275] {
            assert_eq!(
                backend_error(security_framework::base::Error::from_code(code)),
                BackendError::Failed
            );
        }
    }
}
