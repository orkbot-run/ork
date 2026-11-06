// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::host_computer::Connection;
use crate::local_stack::{
    read_owned_private, reparse_point, LocalStack, StateListener, LEGACY_PROJECT_NAME,
};

const CHANGED: &str = "Accounts sign-in changed. Try again.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub directory: PathBuf,
    pub project_name: String,
}

fn valid_owner(owner: &str) -> bool {
    owner.len() == 64
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn regular_directory_or_missing(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_dir() && !reparse_point(&metadata),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Ownership is an explicit operator-verified binding, never a saved picker choice.
fn legacy_owner(directory: &Path) -> Option<String> {
    let marker = directory.join(".desktop-owner");
    let directory_metadata = fs::symlink_metadata(directory).ok()?;
    let marker_metadata = fs::symlink_metadata(&marker).ok()?;
    if !directory_metadata.is_dir()
        || reparse_point(&directory_metadata)
        || !marker_metadata.is_file()
        || reparse_point(&marker_metadata)
    {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and does not mutate process credentials.
        let uid = unsafe { libc::geteuid() };
        if directory_metadata.uid() != uid
            || marker_metadata.uid() != uid
            || directory_metadata.mode() & 0o077 != 0
            || marker_metadata.mode() & 0o077 != 0
        {
            return None;
        }
    }
    let bytes = read_owned_private(&marker, 66)?;
    let value = std::str::from_utf8(&bytes).ok()?;
    let value = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    valid_owner(value).then(|| value.to_owned())
}

impl Scope {
    pub fn for_account(root: &Path, owner: &str) -> Result<Self, String> {
        if !valid_owner(owner) {
            return Err(CHANGED.into());
        }
        let legacy = root.join("stack");
        if legacy_owner(&legacy).as_deref() == Some(owner) {
            return Ok(Self {
                directory: legacy,
                project_name: LEGACY_PROJECT_NAME.into(),
            });
        }
        let parent = root.join("stacks");
        let directory = parent.join(owner);
        if !regular_directory_or_missing(&parent) || !regular_directory_or_missing(&directory) {
            return Err("The local server directory is not a regular directory.".into());
        }
        Ok(Self {
            directory,
            project_name: format!("orkbot-desktop-{}", &owner[..32]),
        })
    }
}

struct Selected {
    owner: String,
    scope: Scope,
    stack: Arc<LocalStack>,
    enabled: bool,
    intent: u64,
}

/// Retained Arcs serialize later stops and starts for the same Compose project.
pub struct AccountStacks {
    template: Arc<LocalStack>,
    selected: Option<Selected>,
    known: HashMap<(String, PathBuf), Arc<LocalStack>>,
}

impl AccountStacks {
    pub fn new(template: LocalStack) -> Self {
        Self {
            template: Arc::new(template),
            selected: None,
            known: HashMap::new(),
        }
    }

    pub fn snapshot(&self) -> Arc<LocalStack> {
        self.selected
            .as_ref()
            .map_or_else(|| self.template.clone(), |selected| selected.stack.clone())
    }

    pub fn deactivate(&mut self) -> Arc<LocalStack> {
        if let Some(selected) = &mut self.selected {
            selected.enabled = false;
        }
        let stack = self.snapshot();
        stack.abort();
        stack
    }

    pub fn is_selected(&self, stack: &Arc<LocalStack>) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|selected| selected.enabled && Arc::ptr_eq(&selected.stack, stack))
    }

    pub fn accepts_output(&self, owner: &str, directory: &Path, intent: u64) -> bool {
        self.selected.as_ref().is_some_and(|selected| {
            selected.enabled
                && selected.owner == owner
                && selected.scope.directory == directory
                && selected.intent == intent
        })
    }

    pub fn owner(&self) -> Option<&str> {
        self.selected
            .as_ref()
            .filter(|selected| selected.enabled)
            .map(|selected| selected.owner.as_str())
    }

    pub fn select(
        &mut self,
        root: &Path,
        owner: &str,
        listener: impl FnOnce(&Scope) -> Option<StateListener>,
        host: impl FnOnce(&Scope) -> Option<Connection>,
        current: impl Fn() -> bool,
    ) -> Result<Arc<LocalStack>, String> {
        if !current() {
            return Err(CHANGED.into());
        }
        let scope = Scope::for_account(root, owner)?;
        if !current() {
            return Err(CHANGED.into());
        }
        let key = (owner.to_owned(), scope.directory.clone());
        let stack = self
            .known
            .entry(key)
            .or_insert_with(|| {
                Arc::new(self.template.scoped(
                    scope.directory.clone(),
                    scope.project_name.clone(),
                    owner.to_owned(),
                    listener(&scope),
                    host(&scope),
                ))
            })
            .clone();
        if !current() {
            return Err(CHANGED.into());
        }
        if !self.is_selected(&stack) {
            self.deactivate();
        }
        self.selected = Some(Selected {
            owner: owner.into(),
            scope,
            stack: stack.clone(),
            enabled: true,
            intent: stack.intent(),
        });
        Ok(stack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        local_stack::{private_directory, write_private},
        settings,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use url::Url;

    fn owner(value: &str) -> String {
        value.repeat(64)
    }

    fn stacks(root: &Path) -> AccountStacks {
        AccountStacks::new(LocalStack::new(
            root.join("stack"),
            root.join("resources"),
            "edge".into(),
            None,
            None,
        ))
    }

    fn select(stacks: &mut AccountStacks, root: &Path, owner: &str) -> Arc<LocalStack> {
        stacks
            .select(root, owner, |_| None, |_| None, || true)
            .unwrap()
    }

    #[test]
    fn two_accounts_have_distinct_persistent_directories_and_compose_projects() {
        let root = tempfile::tempdir().unwrap();
        let first = Scope::for_account(root.path(), &owner("a")).unwrap();
        let second = Scope::for_account(root.path(), &owner("b")).unwrap();
        assert_eq!(first.directory, root.path().join("stacks").join(owner("a")));
        assert_eq!(
            first.project_name,
            format!("orkbot-desktop-{}", "a".repeat(32))
        );
        assert_ne!(first.directory, second.directory);
        assert_ne!(first.project_name, second.project_name);
        assert_eq!(Scope::for_account(root.path(), &owner("a")).unwrap(), first);
        assert!(!root.path().join("stacks").exists());
    }

    #[test]
    fn saved_setup_and_old_local_bookmark_never_claim_an_unbound_legacy_database() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("stack");
        private_directory(&legacy).unwrap();
        write_private(&legacy.join(".env"), b"keep-original-database-credentials").unwrap();
        write_private(&legacy.join(".desktop-web-url"), b"http://127.0.0.1:45173").unwrap();
        settings::save(
            root.path(),
            &settings::Setup {
                mode: settings::InstanceMode::New,
                server_url: Url::parse("http://127.0.0.1:45173").unwrap(),
                account: Some(owner("a")),
            },
        )
        .unwrap();
        let mut stacks = stacks(root.path());
        let selected = select(&mut stacks, root.path(), &owner("a"));
        assert!(!selected.matches_saved_url("http://127.0.0.1:45173"));
        assert!(!legacy.join(".desktop-owner").exists());
        assert_eq!(
            fs::read(legacy.join(".env")).unwrap(),
            b"keep-original-database-credentials"
        );
        assert_eq!(
            fs::read(legacy.join(".desktop-web-url")).unwrap(),
            b"http://127.0.0.1:45173"
        );
        assert!(!root.path().join("stacks").exists());
    }

    #[cfg(unix)]
    #[test]
    fn only_the_trusted_legacy_owner_keeps_its_existing_project_and_bookmark() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("stack");
        private_directory(&legacy).unwrap();
        write_private(
            &legacy.join(".desktop-owner"),
            format!("{}\n", owner("a")).as_bytes(),
        )
        .unwrap();
        write_private(&legacy.join(".desktop-web-url"), b"http://127.0.0.1:45173").unwrap();
        let first = Scope::for_account(root.path(), &owner("a")).unwrap();
        assert_eq!(first.directory, legacy);
        assert_eq!(first.project_name, LEGACY_PROJECT_NAME);
        let second = Scope::for_account(root.path(), &owner("b")).unwrap();
        assert_ne!(second.directory, legacy);
        let mut stacks = stacks(root.path());
        let first_stack = select(&mut stacks, root.path(), &owner("a"));
        assert!(first_stack.matches_saved_url("http://127.0.0.1:45173"));
        let second_stack = select(&mut stacks, root.path(), &owner("b"));
        assert!(!second_stack.matches_saved_url("http://127.0.0.1:45173"));
        assert_eq!(
            fs::read(legacy.join(".desktop-owner")).unwrap(),
            format!("{}\n", owner("a")).as_bytes()
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_binding_rejects_public_or_symlinked_markers_and_scope_parents() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("stack");
        private_directory(&legacy).unwrap();
        let marker = legacy.join(".desktop-owner");
        write_private(&marker, owner("a").as_bytes()).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
        assert_ne!(
            Scope::for_account(root.path(), &owner("a"))
                .unwrap()
                .directory,
            legacy
        );
        fs::remove_file(&marker).unwrap();
        let target = root.path().join("owner");
        write_private(&target, owner("a").as_bytes()).unwrap();
        symlink(&target, &marker).unwrap();
        assert_ne!(
            Scope::for_account(root.path(), &owner("a"))
                .unwrap()
                .directory,
            legacy
        );
        symlink(&legacy, root.path().join("stacks")).unwrap();
        assert!(Scope::for_account(root.path(), &owner("b")).is_err());
    }

    #[test]
    fn switching_accounts_cancels_old_intents_and_output_without_retargeting_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let mut stacks = stacks(root.path());
        let first = select(&mut stacks, root.path(), &owner("a"));
        let first_intent = first.intent();
        let first_scope = Scope::for_account(root.path(), &owner("a")).unwrap();
        assert!(stacks.accepts_output(&owner("a"), &first_scope.directory, first_intent));
        let second = select(&mut stacks, root.path(), &owner("b"));
        assert_ne!(first.intent(), first_intent);
        assert!(!stacks.is_selected(&first));
        assert!(!stacks.accepts_output(&owner("a"), &first_scope.directory, first_intent));
        assert!(stacks.is_selected(&second));
        let returned = select(&mut stacks, root.path(), &owner("a"));
        assert!(Arc::ptr_eq(&first, &returned));
        assert!(!stacks.accepts_output(&owner("a"), &first_scope.directory, first_intent));
        assert!(stacks.accepts_output(&owner("a"), &first_scope.directory, returned.intent()));
        stacks.deactivate();
        assert!(!stacks.is_selected(&returned));
        assert!(!stacks.accepts_output(&owner("a"), &first_scope.directory, first_intent));
    }

    #[test]
    fn stale_verified_account_cannot_change_the_selected_scope() {
        let root = tempfile::tempdir().unwrap();
        let mut stacks = stacks(root.path());
        let first = select(&mut stacks, root.path(), &owner("a"));
        let checks = AtomicUsize::new(0);
        let result = stacks.select(
            root.path(),
            &owner("b"),
            |_| None,
            |_| None,
            || checks.fetch_add(1, Ordering::SeqCst) < 2,
        );
        assert!(result.is_err());
        assert!(stacks.is_selected(&first));
        assert_eq!(stacks.owner(), Some(owner("a").as_str()));
        assert!(!root.path().join("stacks").exists());
    }
}
