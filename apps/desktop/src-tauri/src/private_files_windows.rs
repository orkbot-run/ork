// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    ffi::c_void,
    fs::File,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null_mut, NonNull},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl, GetTokenInformation,
        IsValidAcl, IsValidSid, IsWellKnownSid, TokenUser, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
        ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSID,
        SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Allocation(*mut c_void);
impl Drop for Allocation {
    fn drop(&mut self) {
        // SAFETY: Each allocation is returned by a Windows LocalAlloc-based security API.
        unsafe {
            LocalFree(self.0);
        }
    }
}

struct User(Vec<usize>);
impl User {
    fn current() -> io::Result<Self> {
        let mut token = null_mut();
        // SAFETY: The process pseudo-handle is valid; the returned token is owned below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken returned a new owned handle.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut size = 0;
        // SAFETY: The first call only queries the required buffer size.
        unsafe {
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
        }
        if size < std::mem::size_of::<TOKEN_USER>() as u32 || size > 64 * 1024 {
            return Err(io::Error::other("Could not read the current Windows user."));
        }
        let mut user = Self(vec![
            0;
            (size as usize).div_ceil(std::mem::size_of::<usize>())
        ]);
        // SAFETY: usize storage gives TOKEN_USER pointer alignment and enough bytes for the API.
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                user.0.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(user)
    }
    fn sid(&self) -> PSID {
        // SAFETY: A successful GetTokenInformation populated this stable, aligned allocation.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
    fn descriptor(&self) -> io::Result<Allocation> {
        let mut text = null_mut();
        // SAFETY: sid belongs to the live token information buffer; Windows allocates text.
        if unsafe { ConvertSidToStringSidW(self.sid(), &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _text = Allocation(text.cast());
        let mut length = 0;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated UTF-16 string.
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        // SAFETY: Only the initialized string up to its terminator is read.
        let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
            .map_err(|_| io::Error::other("Invalid Windows user."))?;
        descriptor(&format!("O:{sid}D:P(A;;FA;;;SY)(A;;FA;;;{sid})"))
    }
}

fn descriptor(value: &str) -> io::Result<Allocation> {
    let value: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut result = null_mut();
    // SAFETY: value is terminated and alive for the synchronous conversion; result is LocalAlloc-owned.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            value.as_ptr(),
            SDDL_REVISION_1,
            &mut result,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Allocation(result))
}

fn create(path: &Path, descriptor: &Allocation) -> io::Result<File> {
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: Both terminated path and descriptor outlive CreateFileW. CREATE_NEW prevents replacement.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a new owned file handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

/// Give private metadata its protected current-user/System ACL before writing any bytes.
pub(crate) fn temporary(directory: &Path) -> io::Result<tempfile::NamedTempFile> {
    let user = User::current()?;
    let descriptor = user.descriptor()?;
    tempfile::Builder::new().make_in(directory, |path| create(path, &descriptor))
}

/// Accept only our protected ACL and current owner, never an inherited or null DACL.
pub(crate) fn owned(file: &File) -> bool {
    let Ok(user) = User::current() else {
        return false;
    };
    let mut owner = null_mut();
    let mut acl: *mut ACL = null_mut();
    let mut sd = null_mut();
    // SAFETY: The file handle remains open; returned fields belong to the allocated descriptor.
    if unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    } != 0
    {
        return false;
    }
    let _sd = Allocation(sd);
    let Some(acl) = NonNull::new(acl) else {
        return false;
    };
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: All descriptor fields below were returned together by GetSecurityInfo.
    unsafe {
        if owner.is_null()
            || IsValidSid(owner) == 0
            || EqualSid(owner, user.sid()) == 0
            || IsValidAcl(acl.as_ptr()) == 0
            || GetSecurityDescriptorControl(sd, &mut control, &mut revision) == 0
            || control & SE_DACL_PROTECTED == 0
            || acl.as_ref().AceCount != 2
        {
            return false;
        }
        let mut own = false;
        let mut system = false;
        for index in 0..2 {
            let mut ace = null_mut();
            if GetAce(acl.as_ptr(), index, &mut ace) == 0 {
                return false;
            }
            let Some(ace) = NonNull::new(ace) else {
                return false;
            };
            let header = ace.cast::<ACE_HEADER>().as_ref();
            // ACCESS_ALLOWED_ACE_TYPE is zero. Other ACE types or inherited rights fail closed.
            if header.AceType != 0
                || header.AceFlags != 0
                || (header.AceSize as usize)
                    < std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart) + 8
            {
                return false;
            }
            let ace = ace.cast::<ACCESS_ALLOWED_ACE>().as_ref();
            let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
            if ace.Mask != FILE_ALL_ACCESS
                || IsValidSid(sid) == 0
                || GetLengthSid(sid) as usize
                    > header.AceSize as usize - std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart)
            {
                return false;
            }
            if EqualSid(sid, user.sid()) != 0 {
                own = true;
            } else if IsWellKnownSid(sid, WinLocalSystemSid) != 0 {
                system = true;
            } else {
                return false;
            }
        }
        own && system
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_files_require_the_current_owner_and_a_protected_nonpublic_acl() {
        let directory = tempfile::tempdir().unwrap();
        let private = temporary(directory.path()).unwrap();
        assert!(owned(private.as_file()));
        let ordinary = File::create(directory.path().join("ordinary")).unwrap();
        assert!(!owned(&ordinary));
        let everyone = descriptor("D:P(A;;FA;;;WD)").unwrap();
        let broad = create(&directory.path().join("broad"), &everyone).unwrap();
        assert!(!owned(&broad));
    }
}
