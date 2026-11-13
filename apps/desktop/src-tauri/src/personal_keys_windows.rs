// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE,
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};
use zeroize::{Zeroize, Zeroizing};

/// Credential Manager may roam generic entries. DPAPI keeps their private payload machine-bound.
pub(super) fn protect(input: &[u8], label: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    transform(input, label, true)
}
pub(super) fn unprotect(input: &[u8], label: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    transform(input, label, false)
}
fn transform(input: &[u8], label: &str, encrypt: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    if input.is_empty() || input.len() > 16 * 1024 || label.is_empty() || label.len() > 512 {
        return Err(super::ERROR.into());
    }
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: label.len() as u32,
        pbData: label.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: Both input buffers remain alive throughout the synchronous call and DPAPI treats
    // them as input. It allocates the output with LocalAlloc; every successful path frees it below.
    let accepted = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if accepted == 0 {
        return Err(super::ERROR.into());
    }
    if output.pbData.is_null() {
        return Err(super::ERROR.into());
    }
    // SAFETY: A successful DPAPI call owns a valid allocation of cbData bytes. Copy it into a
    // zeroizing Rust buffer and erase the OS buffer before releasing its allocation.
    let bytes = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let result = if bytes.len() <= 64 * 1024 {
        Ok(Zeroizing::new(bytes.to_vec()))
    } else {
        Err(super::ERROR.into())
    };
    bytes.zeroize();
    // SAFETY: This is the unchanged LocalAlloc pointer returned by DPAPI, released exactly once.
    unsafe {
        LocalFree(output.pbData.cast());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn machine_protected_private_material_requires_its_exact_application_scope_and_valid_ciphertext(
    ) {
        let secret = b"isolated personal device key material";
        let label = "run.orkbot.personal-device.self-check.fixture";
        let mut encrypted = protect(secret, label).unwrap();
        assert_ne!(&encrypted[..], secret);
        assert_eq!(&unprotect(&encrypted, label).unwrap()[..], secret);
        assert!(unprotect(&encrypted, "another-workspace").is_err());
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(unprotect(&encrypted, label).is_err());
    }
}
