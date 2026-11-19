// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

fn main() {
    println!("cargo:rerun-if-changed=native/host-screen.swift");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let output =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("ork-host-screen");
        let target = std::env::var("TARGET").unwrap();
        let architecture = if target.starts_with("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-parse-as-library",
                "-O",
                "-target",
                &format!("{architecture}-apple-macosx12.0"),
                "native/host-screen.swift",
                "-o",
            ])
            .arg(&output)
            .status()
            .expect("Xcode Swift compiler is required for native screen control");
        assert!(status.success(), "could not compile native screen control");
        println!(
            "cargo:rustc-env=ORK_HOST_SCREEN_HELPER={}",
            output.display()
        );
    }

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
        "TAURI_UPDATER_BETA_ENDPOINT",
        "TAURI_UPDATER_PUBLIC_KEY",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "setup_state",
            "setup_accounts_session",
            "restore_connection",
            "setup_accounts_sign_in",
            "setup_accounts_logout",
            "list_servers",
            "list_workspaces",
            "workspace_catalog",
            "set_default_organization",
            "create_organization",
            "clear_workspace_link",
            "check_workspace",
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
            "connect_workspace",
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
