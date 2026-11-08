// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

fn main() {
    println!("cargo:rerun-if-env-changed=ORKBOT_INSTALLER_REVISION");
    let revision = std::env::var("ORKBOT_INSTALLER_REVISION").ok().or_else(|| {
        let output = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    });
    for reference in [
        Some("HEAD".to_owned()),
        std::process::Command::new("git")
            .args(["symbolic-ref", "-q", "HEAD"])
            .output()
            .ok()
            .filter(|result| result.status.success())
            .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned()),
        Some("packed-refs".to_owned()),
    ]
    .into_iter()
    .flatten()
    {
        if let Ok(output) = std::process::Command::new("git")
            .args(["rev-parse", "--git-path", &reference])
            .output()
        {
            if output.status.success() {
                println!(
                    "cargo:rerun-if-changed={}",
                    String::from_utf8_lossy(&output.stdout).trim()
                );
            }
        }
    }
    if let Some(revision) = revision.filter(|value| {
        value.len() == 40
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        println!("cargo:rustc-env=ORKBOT_INSTALLER_REVISION={revision}");
    }
    for variable in [
        "ORK_ACCOUNTS_ISSUER",
        "ORK_ACCOUNTS_DESKTOP_CLIENT_ID",
        "ORKBOT_ENABLE_AUTO_UPDATE",
        "ORKBOT_DISABLE_AUTO_UPDATE",
        "TAURI_UPDATER_ENDPOINT",
        "TAURI_UPDATER_PUBLIC_KEY",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "setup_state",
            "setup_accounts_session",
            "setup_accounts_sign_in",
            "setup_accounts_logout",
            "list_servers",
            "set_default_server",
            "create_server_installation",
            "get_server_installation",
            "server_initialization_required",
            "create_server_pairing",
            "get_server_pairing",
            "approve_server_pairing",
            "cancel_server_pairing",
            "cancel_setup_connection",
            "remove_server",
            "connect_saved_server",
            "connect_server",
            "connect_local_server",
            "local_stack_state",
            "quit_setup",
            "clear_server_link",
            "native_command",
        ]),
    ))
    .expect("could not build the desktop capability manifest");
}
