// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use crate::{
    accounts::Account,
    installation_transport::Selection,
    personal_keys::{DeviceKeys, SystemKeys},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::{
    ecdsa::{signature::Verifier, Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

const ERROR: &str = "Could not continue with this personal installation.";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Credential {
    version: u8,
    pub device_id: String,
    label: String,
    pub public_key: String,
    pub selection: Selection,
    pub account: Account,
    #[serde(default)]
    pub profile_epoch: String,
    active: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u8,
    denied: bool,
    records: Vec<Credential>,
}

pub(crate) struct PersonalDevices {
    directory: PathBuf,
    keys: Arc<dyn DeviceKeys>,
    epoch: AtomicU64,
    gate: Mutex<()>,
    activation: tokio::sync::Mutex<()>,
}

pub(crate) struct Staged {
    pub credential: Credential,
    epoch: u64,
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn uuid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ERROR)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

impl PersonalDevices {
    /// Construction never opens a keychain or creates a device credential.
    pub fn system(directory: &Path) -> Self {
        Self {
            directory: directory.to_owned(),
            keys: Arc::new(SystemKeys),
            epoch: AtomicU64::new(0),
            gate: Mutex::new(()),
            activation: tokio::sync::Mutex::new(()),
        }
    }

    fn path(&self) -> PathBuf {
        self.directory.join("personal-devices-v1.json")
    }

    fn root(&self) -> Result<String, String> {
        let canonical = std::fs::canonicalize(&self.directory).map_err(|_| ERROR)?;
        let device = crate::server_directory::device_id(&self.directory)?;
        Ok(digest(
            serde_json::to_vec(&(canonical.to_string_lossy(), device)).map_err(|_| ERROR)?,
        ))
    }

    fn label(&self, selection: &Selection, id: &str) -> Result<String, String> {
        let scope = digest(
            serde_json::to_vec(&(selection.account.as_str(), &selection.target))
                .map_err(|_| ERROR)?,
        );
        Ok(format!(
            "run.orkbot.personal-device.v1.{}.{}.{}",
            self.root()?,
            scope,
            id
        ))
    }

    fn read(&self) -> Result<Registry, String> {
        let bytes = match std::fs::symlink_metadata(self.path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registry {
                    version: 1,
                    denied: false,
                    records: vec![],
                })
            }
            Err(_) => return Err(ERROR.into()),
            Ok(_) => {
                crate::local_stack::read_owned_private(&self.path(), MAX_BYTES).ok_or(ERROR)?
            }
        };
        let registry: Registry = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if registry.version != 1 || registry.records.len() > 128 {
            return Err(ERROR.into());
        }
        let mut seen = std::collections::HashSet::new();
        for record in &registry.records {
            let identity = record.account.identity();
            if record.version != 1
                || !record.selection.valid()
                || identity.0
                    != crate::server_directory::origin()
                        .origin()
                        .ascii_serialization()
                || record.selection.account != crate::settings::account_key(identity)
                || !crate::server_directory::uuid(&record.device_id)
                || record.label != self.label(&record.selection, &record.device_id)?
                || !seen.insert(&record.label)
                || (record.active && !valid_public(&record.public_key))
            {
                return Err(ERROR.into());
            }
        }
        Ok(registry)
    }

    fn write(&self, registry: &Registry) -> Result<(), String> {
        let bytes = serde_json::to_vec(registry).map_err(|_| ERROR)?;
        if bytes.len() > MAX_BYTES as usize {
            return Err(ERROR.into());
        }
        crate::local_stack::write_private(&self.path(), &bytes)?;
        #[cfg(unix)]
        std::fs::File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| ERROR)?;
        Ok(())
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    pub async fn activation_lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.activation.lock().await
    }
    pub fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Persist denial before touching OS storage so an interrupted logout cannot restore a key.
    pub fn forget_all(&self) -> Result<(), String> {
        self.invalidate();
        let _guard = self.gate.lock().map_err(|_| ERROR)?;
        let mut registry = self.read()?;
        registry.denied = true;
        self.write(&registry)?;
        for record in &registry.records {
            self.keys.forget(&record.label)?;
        }
        registry.records.clear();
        self.write(&registry)
    }

    /// Only a completed interactive Accounts login may clear a prior logout barrier.
    pub fn after_interactive_sign_in(&self) -> Result<(), String> {
        let _guard = self.gate.lock().map_err(|_| ERROR)?;
        let mut registry = self.read()?;
        if !registry.denied {
            return Ok(());
        }
        for record in &registry.records {
            self.keys.forget(&record.label)?;
        }
        registry.records.clear();
        registry.denied = false;
        self.write(&registry)
    }

    pub fn stage(
        &self,
        selection: &Selection,
        account: &Account,
        profile_epoch: &str,
    ) -> Result<Staged, String> {
        let _guard = self.gate.lock().map_err(|_| ERROR)?;
        if !selection.valid()
            || !crate::profile::valid_epoch(profile_epoch)
            || selection.account != crate::settings::account_key(account.identity())
        {
            return Err(ERROR.into());
        }
        let mut registry = self.read()?;
        if registry.denied {
            return Err(ERROR.into());
        }
        for record in registry
            .records
            .iter()
            .filter(|record| registry.denied || !record.active)
        {
            self.keys.forget(&record.label)?;
        }
        registry.records.retain(|record| record.active);
        if registry.records.len() >= 128 {
            return Err(ERROR.into());
        }
        let id = uuid()?;
        let mut credential = Credential {
            version: 1,
            label: self.label(selection, &id)?,
            device_id: id,
            public_key: String::new(),
            selection: selection.clone(),
            account: account.clone(),
            profile_epoch: profile_epoch.to_owned(),
            active: false,
        };
        registry.records.push(credential.clone());
        // Journal the label before OS key creation so a crash leaves a recoverable reservation.
        self.write(&registry)?;
        credential.public_key = self.keys.create(&credential.label)?;
        if !valid_public(&credential.public_key) {
            return Err(ERROR.into());
        }
        Ok(Staged {
            credential,
            epoch: self.epoch(),
        })
    }

    pub fn activation_proof(
        &self,
        staged: &Staged,
        challenge: &str,
        grant: &str,
    ) -> Result<String, String> {
        if staged.epoch != self.epoch() || !crate::server_login::valid_challenge(challenge) {
            return Err(ERROR.into());
        }
        let mut message = proof(
            &staged.credential,
            "ork-personal-device-activation-v1",
            challenge,
        );
        message
            .as_array_mut()
            .ok_or(ERROR)?
            .push(json!(digest(grant)));
        let signature = self
            .keys
            .sign(&staged.credential.label, message.to_string().as_bytes())?;
        if staged.epoch != self.epoch() {
            return Err(ERROR.into());
        }
        Ok(signature)
    }

    pub fn activate(&self, staged: Staged, completed: &Value) -> Result<(), String> {
        let _guard = self.gate.lock().map_err(|_| ERROR)?;
        let mut registry = self.read()?;
        let credential = &staged.credential;
        let device = &completed["personalDevice"];
        if staged.epoch != self.epoch()
            || registry.denied
            || device["id"] != credential.device_id
            || !same_target(
                &credential.selection,
                &device["target"],
                &credential.device_id,
            )
            || self.keys.public_key(&credential.label)?.as_deref() != Some(&credential.public_key)
        {
            return Err(ERROR.into());
        }
        let record = registry
            .records
            .iter_mut()
            .find(|record| record.label == credential.label)
            .ok_or(ERROR)?;
        *record = Credential {
            active: true,
            ..staged.credential
        };
        self.write(&registry)
    }

    pub fn credential(&self, selection: &Selection) -> Result<Option<Credential>, String> {
        let _guard = self.gate.lock().map_err(|_| ERROR)?;
        let registry = self.read()?;
        if registry.denied {
            return Ok(None);
        }
        for record in registry
            .records
            .into_iter()
            .filter(|record| {
                record.active
                    && crate::profile::valid_epoch(&record.profile_epoch)
                    && record.selection.account == selection.account
                    && record.selection.origin == selection.origin
                    && record.selection.target == selection.target
            })
            .rev()
        {
            if self.keys.public_key(&record.label)?.as_deref() == Some(&record.public_key) {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    /// Restore only the explicitly saved workspace. A company selection never falls back to personal.
    pub fn saved(&self, setup: &crate::settings::Setup) -> Result<Option<Credential>, String> {
        let selection = {
            let _guard = self.gate.lock().map_err(|_| ERROR)?;
            let registry = self.read()?;
            if registry.denied {
                return Ok(None);
            }
            registry
                .records
                .into_iter()
                .find(|record| {
                    record.active
                        && setup.account.as_deref() == Some(record.selection.account.as_str())
                        && setup.workspace.as_ref() == Some(&record.selection.target)
                        && setup.server_url.origin().ascii_serialization()
                            == record.selection.origin
                })
                .map(|record| record.selection)
        };
        selection
            .map(|selection| self.credential(&selection))
            .transpose()
            .map(Option::flatten)
    }

    pub fn offline_proof(
        &self,
        credential: &Credential,
        challenge: &Value,
        epoch: u64,
    ) -> Result<String, String> {
        let nonce = challenge["challenge"]
            .as_str()
            .filter(|nonce| crate::server_login::valid_challenge(nonce))
            .ok_or(ERROR)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| ERROR)?
            .as_secs();
        let expires = challenge["expiresAt"].as_u64().ok_or(ERROR)?;
        let public = challenge["publicKey"].as_str().ok_or(ERROR)?;
        let signature = challenge["signature"].as_str().ok_or(ERROR)?;
        let public_bytes = URL_SAFE_NO_PAD.decode(public).map_err(|_| ERROR)?;
        let server = VerifyingKey::from_public_key_der(&public_bytes).map_err(|_| ERROR)?;
        let signature = Signature::from_der(&URL_SAFE_NO_PAD.decode(signature).map_err(|_| ERROR)?)
            .map_err(|_| ERROR)?;
        if epoch != self.epoch()
            || challenge["version"] != 1
            || expires <= now
            || expires > now + 125
            || digest(&public_bytes) != credential.selection.target.key_fingerprint
            || !same_target(
                &credential.selection,
                &challenge["target"],
                &credential.device_id,
            )
            || server
                .verify(
                    proof(credential, "ork-personal-device-server-v1", nonce)
                        .to_string()
                        .as_bytes(),
                    &signature,
                )
                .is_err()
            || self
                .credential(&credential.selection)?
                .as_ref()
                .map(|record| &record.label)
                != Some(&credential.label)
        {
            return Err(ERROR.into());
        }
        let signature = self.keys.sign(
            &credential.label,
            proof(credential, "ork-personal-device-login-v1", nonce)
                .to_string()
                .as_bytes(),
        )?;
        if epoch != self.epoch() {
            return Err(ERROR.into());
        }
        Ok(signature)
    }
}

fn valid_public(value: &str) -> bool {
    value.len() <= 256
        && URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .is_some_and(|bytes| VerifyingKey::from_public_key_der(&bytes).is_ok())
}

fn same_target(selection: &Selection, value: &Value, device: &str) -> bool {
    let target = &selection.target;
    value["serverId"] == target.server_id
        && value["workspaceId"] == target.workspace_id
        && value["bindingVersion"] == target.binding_version
        && value["keyFingerprint"] == target.key_fingerprint
        && value["deviceId"] == device
}

fn proof(credential: &Credential, purpose: &str, nonce: &str) -> Value {
    let target = &credential.selection.target;
    json!([
        purpose,
        target.server_id,
        target.binding_version,
        target.key_fingerprint,
        target.workspace_id,
        credential.device_id,
        nonce
    ])
}

#[cfg(test)]
#[path = "personal_devices_tests.rs"]
mod tests;
