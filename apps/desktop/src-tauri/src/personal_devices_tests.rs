// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::*;
use p256::{
    ecdsa::{signature::Signer, SigningKey},
    pkcs8::EncodePublicKey,
};
use std::{collections::HashMap, sync::atomic::AtomicBool};

#[derive(Default)]
struct Keys {
    values: Mutex<HashMap<String, SigningKey>>,
    deny_delete: AtomicBool,
}
impl DeviceKeys for Keys {
    fn create(&self, label: &str) -> Result<String, String> {
        let key = SigningKey::random(&mut rand_core::OsRng);
        let public = URL_SAFE_NO_PAD.encode(key.verifying_key().to_public_key_der().unwrap());
        if self
            .values
            .lock()
            .unwrap()
            .insert(label.into(), key)
            .is_some()
        {
            return Err("duplicate key".into());
        }
        Ok(public)
    }
    fn public_key(&self, label: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(label)
            .map(|key| URL_SAFE_NO_PAD.encode(key.verifying_key().to_public_key_der().unwrap())))
    }
    fn sign(&self, label: &str, message: &[u8]) -> Result<String, String> {
        let keys = self.values.lock().unwrap();
        let key = keys.get(label).ok_or("missing key")?;
        let signature: Signature = key.sign(message);
        Ok(URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes()))
    }
    fn forget(&self, label: &str) -> Result<(), String> {
        if self.deny_delete.load(Ordering::SeqCst) {
            return Err("OS storage unavailable".into());
        }
        self.values.lock().unwrap().remove(label);
        Ok(())
    }
}

fn vault(directory: &Path, keys: Arc<Keys>) -> PersonalDevices {
    PersonalDevices {
        directory: directory.into(),
        keys,
        epoch: AtomicU64::new(0),
        gate: Mutex::new(()),
        activation: tokio::sync::Mutex::new(()),
    }
}
fn account() -> Account {
    serde_json::from_value(json!({"issuer":"https://api.ork.run", "subject":"fixture-owner", "userinfo":{"sub":"fixture-owner"}, "expiresAt":0})).unwrap()
}
fn selection(server: &SigningKey) -> Selection {
    Selection {
        account: crate::settings::account_key(account().identity()),
        origin: "https://22222222-2222-4222-8222-222222222222.installation.ork.invalid".into(),
        direct_origin: Some("http://127.0.0.1:45173".into()),
        relay_origin: None,
        prefer_relay: false,
        target: crate::server_directory::WorkspaceTarget {
            organization_id: "11111111-1111-4111-8111-111111111111".into(),
            server_id: "22222222-2222-4222-8222-222222222222".into(),
            workspace_id: "33333333-3333-4333-8333-333333333333".into(),
            binding_version: 1,
            key_fingerprint: digest(server.verifying_key().to_public_key_der().unwrap()),
        },
    }
}
fn completed(credential: &Credential) -> Value {
    let target = &credential.selection.target;
    json!({"personalDevice":{"id":credential.device_id, "target":{
        "serverId":target.server_id, "workspaceId":target.workspace_id,
        "bindingVersion":target.binding_version, "keyFingerprint":target.key_fingerprint,
        "deviceId":credential.device_id,
    }}})
}
fn activate(vault: &PersonalDevices, selection: &Selection) -> Credential {
    let staged = vault.stage(selection, &account()).unwrap();
    let expected = completed(&staged.credential);
    vault.activate(staged, &expected).unwrap();
    vault.credential(selection).unwrap().unwrap()
}
fn challenge(credential: &Credential, server: &SigningKey) -> Value {
    let nonce = "A".repeat(43);
    let signature: Signature = server.sign(
        proof(credential, "ork-personal-device-server-v1", &nonce)
            .to_string()
            .as_bytes(),
    );
    json!({"version":1, "challenge":nonce,
        "expiresAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()+120,
        "target":completed(credential)["personalDevice"]["target"],
        "publicKey":URL_SAFE_NO_PAD.encode(server.verifying_key().to_public_key_der().unwrap()),
        "signature":URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes()),
    })
}

#[test]
fn pending_activation_has_no_authority_and_signs_only_the_exact_grant_bound_message() {
    let directory = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let vault = vault(directory.path(), keys.clone());
    let server = SigningKey::random(&mut rand_core::OsRng);
    let selection = selection(&server);
    let staged = vault.stage(&selection, &account()).unwrap();
    assert!(vault.credential(&selection).unwrap().is_none());
    let nonce = "A".repeat(43);
    let signature = vault
        .activation_proof(&staged, &nonce, "native-grant")
        .unwrap();
    let message = json!([
        "ork-personal-device-activation-v1",
        selection.target.server_id,
        selection.target.binding_version,
        selection.target.key_fingerprint,
        selection.target.workspace_id,
        staged.credential.device_id,
        nonce,
        digest("native-grant")
    ]);
    let key = VerifyingKey::from_public_key_der(
        &URL_SAFE_NO_PAD
            .decode(&staged.credential.public_key)
            .unwrap(),
    )
    .unwrap();
    key.verify(
        message.to_string().as_bytes(),
        &Signature::from_der(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(vault
        .activation_proof(&staged, "invalid", "native-grant")
        .is_err());
    let mut wrong = completed(&staged.credential);
    wrong["personalDevice"]["target"]["workspaceId"] =
        json!("44444444-4444-4444-8444-444444444444");
    assert!(vault.activate(staged, &wrong).is_err());
    assert!(vault.credential(&selection).unwrap().is_none());
    // A retry cleans the prior journaled reservation before creating another key.
    let _retry = vault.stage(&selection, &account()).unwrap();
    assert_eq!(keys.values.lock().unwrap().len(), 1);
}

#[test]
fn active_key_survives_restart_and_oauth_expiry_but_not_an_account_target_or_installation_copy() {
    let directory = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let server = SigningKey::random(&mut rand_core::OsRng);
    let selected = selection(&server);
    let first = vault(directory.path(), keys.clone());
    let credential = activate(&first, &selected);
    drop(first);
    let restored = vault(directory.path(), keys.clone());
    assert_eq!(
        restored.credential(&selected).unwrap().unwrap().device_id,
        credential.device_id
    );
    for variant in 0..5 {
        let mut changed = selected.clone();
        match variant {
            0 => changed.account = "a".repeat(64),
            1 => changed.target.workspace_id = "44444444-4444-4444-8444-444444444444".into(),
            2 => changed.target.binding_version += 1,
            3 => changed.target.key_fingerprint = "f".repeat(64),
            _ => changed.origin = "https://another.example.test".into(),
        }
        assert!(restored.credential(&changed).unwrap().is_none());
    }
    let mut changed_route = selected.clone();
    changed_route.direct_origin = Some("https://another-route.example.test".into());
    assert!(restored.credential(&changed_route).unwrap().is_some());
    let copied = tempfile::tempdir().unwrap();
    std::fs::copy(first_path(directory.path()), first_path(copied.path())).unwrap();
    std::fs::copy(
        directory.path().join("directory-device-id"),
        copied.path().join("directory-device-id"),
    )
    .unwrap();
    assert!(vault(copied.path(), keys).credential(&selected).is_err());
}

fn first_path(directory: &Path) -> PathBuf {
    directory.join("personal-devices-v1.json")
}

#[test]
fn offline_device_proof_requires_the_pinned_servers_fresh_exact_challenge() {
    let directory = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let vault = vault(directory.path(), keys);
    let server = SigningKey::random(&mut rand_core::OsRng);
    let credential = activate(&vault, &selection(&server));
    let challenge = challenge(&credential, &server);
    let signed = vault
        .offline_proof(&credential, &challenge, vault.epoch())
        .unwrap();
    let public =
        VerifyingKey::from_public_key_der(&URL_SAFE_NO_PAD.decode(&credential.public_key).unwrap())
            .unwrap();
    public
        .verify(
            proof(
                &credential,
                "ork-personal-device-login-v1",
                challenge["challenge"].as_str().unwrap(),
            )
            .to_string()
            .as_bytes(),
            &Signature::from_der(&URL_SAFE_NO_PAD.decode(signed).unwrap()).unwrap(),
        )
        .unwrap();
    for variant in 0..6 {
        let mut changed = challenge.clone();
        match variant {
            0 => changed["expiresAt"] = json!(0),
            1 => changed["expiresAt"] = json!(u64::MAX),
            2 => changed["target"]["bindingVersion"] = json!(2),
            3 => changed["target"]["deviceId"] = json!("44444444-4444-4444-8444-444444444444"),
            4 => changed["challenge"] = json!("B".repeat(43)),
            _ => {
                changed["publicKey"] = json!(URL_SAFE_NO_PAD.encode(
                    SigningKey::random(&mut rand_core::OsRng)
                        .verifying_key()
                        .to_public_key_der()
                        .unwrap()
                ))
            }
        }
        assert!(vault
            .offline_proof(&credential, &changed, vault.epoch())
            .is_err());
    }
    let epoch = vault.epoch();
    vault.invalidate();
    assert!(vault.offline_proof(&credential, &challenge, epoch).is_err());
}

#[test]
fn interrupted_logout_denies_authority_durably_before_os_key_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let first = vault(directory.path(), keys.clone());
    let server = SigningKey::random(&mut rand_core::OsRng);
    let selected = selection(&server);
    let credential = activate(&first, &selected);
    keys.deny_delete.store(true, Ordering::SeqCst);
    assert!(first.forget_all().is_err());
    assert_eq!(keys.values.lock().unwrap().len(), 1);
    assert!(first.credential(&selected).unwrap().is_none());
    let restarted = vault(directory.path(), keys.clone());
    assert!(restarted.credential(&selected).unwrap().is_none());
    assert!(restarted
        .offline_proof(
            &credential,
            &challenge(&credential, &server),
            restarted.epoch()
        )
        .is_err());
    assert!(restarted.stage(&selected, &account()).is_err());
    keys.deny_delete.store(false, Ordering::SeqCst);
    assert!(restarted.stage(&selected, &account()).is_err());
    restarted.after_interactive_sign_in().unwrap();
    let replacement = activate(&restarted, &selected);
    assert_ne!(replacement.device_id, credential.device_id);
    assert_eq!(keys.values.lock().unwrap().len(), 1);
    restarted.forget_all().unwrap();
    assert!(keys.values.lock().unwrap().is_empty());
    assert!(vault(directory.path(), keys)
        .credential(&selected)
        .unwrap()
        .is_none());
}

#[test]
fn logout_fences_an_already_staged_activation_and_corrupt_metadata_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let vault = vault(directory.path(), Arc::new(Keys::default()));
    let server = SigningKey::random(&mut rand_core::OsRng);
    let selected = selection(&server);
    let staged = vault.stage(&selected, &account()).unwrap();
    let result = completed(&staged.credential);
    vault.forget_all().unwrap();
    assert!(vault
        .activation_proof(&staged, &"A".repeat(43), "grant")
        .is_err());
    assert!(vault.activate(staged, &result).is_err());
    crate::local_stack::write_private(&vault.path(), b"corrupt").unwrap();
    assert!(vault.credential(&selected).is_err());
}

#[test]
fn personal_authority_never_becomes_a_central_bearer_and_checks_both_device_epoch_and_account_generation(
) {
    let directory = tempfile::tempdir().unwrap();
    let mut state = crate::tests::test_state(directory.path());
    state.personal_devices = vault(directory.path(), Arc::new(Keys::default()));
    let server = SigningKey::random(&mut rand_core::OsRng);
    let credential = activate(&state.personal_devices, &selection(&server));
    let authorization = state
        .accounts
        .personal_authorization(&credential, state.personal_devices.epoch())
        .unwrap();
    assert!(state.accounts.is_current(&authorization));
    assert!(authorization.directory_bearer().is_err());
    assert!(crate::require_account(&state, &authorization).is_err());
    assert!(crate::require_native_account(&state, &authorization).is_ok());
    assert_eq!(
        serde_json::to_value(&authorization.account).unwrap()["expiresAt"],
        0
    );
    state.personal_devices.invalidate();
    assert!(crate::require_native_account(&state, &authorization).is_err());
    state.accounts.invalidate();
    assert!(!state.accounts.is_current(&authorization));
}

#[test]
fn saved_company_other_account_and_other_workspace_choices_never_fall_back_to_a_personal_key() {
    let directory = tempfile::tempdir().unwrap();
    let vault = vault(directory.path(), Arc::new(Keys::default()));
    let server = SigningKey::random(&mut rand_core::OsRng);
    let selected = selection(&server);
    let credential = activate(&vault, &selected);
    let choice = crate::settings::Setup {
        mode: crate::settings::InstanceMode::Existing,
        server_url: url::Url::parse(&selected.origin).unwrap(),
        account: Some(selected.account.clone()),
        workspace: Some(selected.target.clone()),
    };
    assert_eq!(
        vault.saved(&choice).unwrap().unwrap().device_id,
        credential.device_id
    );
    let mut wrong = choice.clone();
    wrong.account = Some("a".repeat(64));
    assert!(vault.saved(&wrong).unwrap().is_none());
    wrong = choice.clone();
    wrong.workspace.as_mut().unwrap().workspace_id = "44444444-4444-4444-8444-444444444444".into();
    assert!(vault.saved(&wrong).unwrap().is_none());
    wrong = choice;
    wrong.workspace.as_mut().unwrap().organization_id =
        "55555555-5555-4555-8555-555555555555".into();
    assert!(vault.saved(&wrong).unwrap().is_none());
}
