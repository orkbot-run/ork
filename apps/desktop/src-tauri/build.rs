// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

fn main() {
    for variable in [
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
            "connect_server",
            "connect_local_server",
            "local_stack_state",
            "quit_setup",
            "native_command",
        ]),
    ))
    .expect("could not build the desktop capability manifest");
}
