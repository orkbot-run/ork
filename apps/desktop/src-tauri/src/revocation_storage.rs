// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::credentials::{CredentialStore, STORAGE_ERROR};

const MAX_BYTES: usize = 128 * 1024;
// Windows Credential Manager counts UTF-16 bytes. Each ASCII fragment stays within 2 KiB.
const CHUNK_CHARS: usize = 1024;
const MAX_CHUNKS: usize = (MAX_BYTES.div_ceil(3) * 4).div_ceil(CHUNK_CHARS);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u8,
    bank: u8,
    chunks: usize,
    checksum: String,
}

/// Two bounded banks retain the last complete queue until the small manifest commits atomically.
pub struct ChunkedStore {
    backing: Arc<dyn CredentialStore>,
    operation: Mutex<()>,
    cleaned: AtomicBool,
}

impl ChunkedStore {
    pub fn new(backing: Arc<dyn CredentialStore>) -> Self {
        Self {
            backing,
            operation: Mutex::new(()),
            cleaned: AtomicBool::new(false),
        }
    }

    fn fragment(key: &str, bank: u8, index: usize) -> String {
        format!("{key}.bank{bank}.{index}")
    }

    fn index(&self, key: &str) -> Result<Option<Index>, String> {
        let Some(raw) = self.backing.get(key)? else {
            return Ok(None);
        };
        if raw.len() > CHUNK_CHARS {
            return Err(STORAGE_ERROR.into());
        }
        let index: Index = serde_json::from_str(&raw).map_err(|_| STORAGE_ERROR)?;
        if index.version != 1
            || index.bank > 1
            || index.chunks == 0
            || index.chunks > MAX_CHUNKS
            || index.checksum.len() != 64
            || !index.checksum.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(STORAGE_ERROR.into());
        }
        Ok(Some(index))
    }

    fn clear_range(&self, key: &str, bank: u8, start: usize, end: usize) -> bool {
        let mut clean = true;
        for index in start..end {
            clean &= self
                .backing
                .delete(&Self::fragment(key, bank, index))
                .is_ok();
        }
        clean
    }

    fn recover(&self, key: &str, active: Option<&Index>) {
        if self.cleaned.load(Ordering::SeqCst) {
            return;
        }
        let mut clean = true;
        for bank in 0..2 {
            let start = active
                .filter(|index| index.bank == bank)
                .map_or(0, |index| index.chunks);
            clean &= self.clear_range(key, bank, start, MAX_CHUNKS);
        }
        self.cleaned.store(clean, Ordering::SeqCst);
    }
}

impl CredentialStore for ChunkedStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let _operation = self.operation.lock().map_err(|_| STORAGE_ERROR)?;
        let index = self.index(key)?;
        let Some(index) = index else {
            self.recover(key, None);
            return Ok(None);
        };
        let mut encoded = String::new();
        for part in 0..index.chunks {
            let fragment = self
                .backing
                .get(&Self::fragment(key, index.bank, part))?
                .ok_or(STORAGE_ERROR)?;
            if fragment.is_empty()
                || fragment.len() > CHUNK_CHARS
                || !fragment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            {
                return Err(STORAGE_ERROR.into());
            }
            encoded.push_str(&fragment);
        }
        let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| STORAGE_ERROR)?;
        if bytes.len() > MAX_BYTES || format!("{:x}", Sha256::digest(&bytes)) != index.checksum {
            return Err(STORAGE_ERROR.into());
        }
        let value = String::from_utf8(bytes).map_err(|_| STORAGE_ERROR)?;
        self.recover(key, Some(&index));
        Ok(Some(value))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if value.is_empty() || value.len() > MAX_BYTES {
            return Err(STORAGE_ERROR.into());
        }
        let _operation = self.operation.lock().map_err(|_| STORAGE_ERROR)?;
        let previous = self.index(key)?;
        self.recover(key, previous.as_ref());
        let bank = previous.as_ref().map_or(0, |index| 1 - index.bank);
        let encoded = URL_SAFE_NO_PAD.encode(value);
        let result = (|| {
            for (part, bytes) in encoded.as_bytes().chunks(CHUNK_CHARS).enumerate() {
                self.backing.set(
                    &Self::fragment(key, bank, part),
                    std::str::from_utf8(bytes).map_err(|_| STORAGE_ERROR)?,
                )?;
            }
            self.backing.set(
                key,
                &serde_json::to_string(&Index {
                    version: 1,
                    bank,
                    chunks: encoded.len().div_ceil(CHUNK_CHARS),
                    checksum: format!("{:x}", Sha256::digest(value.as_bytes())),
                })
                .map_err(|_| STORAGE_ERROR)?,
            )
        })();
        if result.is_err() {
            // A crash or ambiguous manifest write leaves at most these two fixed banks for recovery.
            self.cleaned.store(false, Ordering::SeqCst);
            return result;
        }
        if let Some(previous) = previous {
            if !self.clear_range(key, previous.bank, 0, previous.chunks) {
                self.cleaned.store(false, Ordering::SeqCst);
            }
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let _operation = self.operation.lock().map_err(|_| STORAGE_ERROR)?;
        // Retire the manifest first. A crash cannot resurrect credentials from unreferenced fragments.
        self.backing.delete(key)?;
        self.cleaned.store(false, Ordering::SeqCst);
        self.recover(key, None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct SmallStore {
        values: Mutex<HashMap<String, String>>,
        remaining_writes: Mutex<Option<usize>>,
    }
    impl CredentialStore for SmallStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if value.encode_utf16().count() * 2 > 2048 {
                return Err(STORAGE_ERROR.into());
            }
            let mut remaining = self.remaining_writes.lock().unwrap();
            if let Some(count) = remaining.as_mut() {
                if *count == 0 {
                    return Err(STORAGE_ERROR.into());
                }
                *count -= 1;
            }
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[test]
    fn windows_sized_entries_store_the_complete_bounded_queue_and_cleanup_both_banks() {
        let backing = Arc::new(SmallStore::default());
        let store = ChunkedStore::new(backing.clone());
        let value = "token-ą".repeat(16_000);
        assert!(value.len() <= MAX_BYTES);
        store.set("queue", &value).unwrap();
        assert_eq!(store.get("queue").unwrap().as_deref(), Some(value.as_str()));
        store.set("queue", "shorter replacement").unwrap();
        let restarted = ChunkedStore::new(backing.clone());
        assert_eq!(
            restarted.get("queue").unwrap().as_deref(),
            Some("shorter replacement")
        );
        assert_eq!(backing.values.lock().unwrap().len(), 2);
        restarted.delete("queue").unwrap();
        assert!(backing.values.lock().unwrap().is_empty());
        assert_eq!(ChunkedStore::new(backing).get("queue").unwrap(), None);
    }

    #[test]
    fn interrupted_fragment_or_manifest_writes_preserve_the_last_complete_queue() {
        for successful_writes in 0..=8 {
            let backing = Arc::new(SmallStore::default());
            let store = ChunkedStore::new(backing.clone());
            store.set("queue", "last complete queue").unwrap();
            *backing.remaining_writes.lock().unwrap() = Some(successful_writes);
            let replacement = "new credential".repeat(400);
            assert!(store.set("queue", &replacement).is_err());
            *backing.remaining_writes.lock().unwrap() = None;
            let restarted = ChunkedStore::new(backing.clone());
            assert_eq!(
                restarted.get("queue").unwrap().as_deref(),
                Some("last complete queue")
            );
            assert_eq!(backing.values.lock().unwrap().len(), 2);
        }
    }

    #[test]
    fn missing_or_changed_fragments_fail_closed_and_unreferenced_fragments_never_restore_a_queue() {
        let backing = Arc::new(SmallStore::default());
        let store = ChunkedStore::new(backing.clone());
        store.set("queue", "credential").unwrap();
        backing.set("queue.bank0.0", "Y2hhbmdlZA").unwrap();
        assert!(store.get("queue").is_err());
        backing.delete("queue.bank0.0").unwrap();
        assert!(store.get("queue").is_err());
        backing.delete("queue").unwrap();
        backing.set("queue.bank1.0", "c2VjcmV0").unwrap();
        assert_eq!(
            ChunkedStore::new(backing.clone()).get("queue").unwrap(),
            None
        );
        assert!(backing.values.lock().unwrap().is_empty());
    }
}
