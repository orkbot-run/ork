// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited desktop application menu. Rust additions follow LICENSE.md.

use tauri::{
    menu::{
        AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    AppHandle,
};

use crate::locale::Locale;

#[derive(Clone, Copy, Default)]
pub struct MenuFlags {
    pub app_open: bool,
    pub local_server: bool,
    pub computer_access: bool,
    pub revoke_computer_access: bool,
    pub updates: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Ui(&'static str),
    Settings,
    ChangeServer,
    StopLocalServer,
    CheckForUpdates,
    ComputerAccess,
    RevokeComputerAccess,
    ResetZoom,
    ZoomIn,
    ZoomOut,
    ToggleFullScreen,
    Minimize,
    ToggleMaximize,
    CloseWindow,
    Quit,
}

pub fn action(id: &str) -> Option<MenuAction> {
    Some(match id {
        "ui-new" => MenuAction::Ui("new"),
        "ui-new-group" => MenuAction::Ui("new-group"),
        "ui-integrations" => MenuAction::Ui("integrations"),
        "ui-find" => MenuAction::Ui("find"),
        "ui-search" => MenuAction::Ui("search"),
        "ui-back" => MenuAction::Ui("back"),
        "ui-forward" => MenuAction::Ui("forward"),
        "ui-next-bot" => MenuAction::Ui("next-bot"),
        "ui-previous-bot" => MenuAction::Ui("previous-bot"),
        "ui-command-menu" => MenuAction::Ui("command-menu"),
        "ui-toggle-sidebar" => MenuAction::Ui("toggle-sidebar"),
        "ui-chat-panel" => MenuAction::Ui("chat-panel"),
        "ui-shortcuts" => MenuAction::Ui("shortcuts"),
        "settings" => MenuAction::Settings,
        "change-server" => MenuAction::ChangeServer,
        "stop-local-stack" => MenuAction::StopLocalServer,
        "check-updates" => MenuAction::CheckForUpdates,
        "computer-access" => MenuAction::ComputerAccess,
        "revoke-computer-access" => MenuAction::RevokeComputerAccess,
        "reset-zoom" => MenuAction::ResetZoom,
        "zoom-in" => MenuAction::ZoomIn,
        "zoom-out" => MenuAction::ZoomOut,
        "fullscreen" => MenuAction::ToggleFullScreen,
        "minimize" => MenuAction::Minimize,
        "maximize" => MenuAction::ToggleMaximize,
        "close-window" => MenuAction::CloseWindow,
        "quit" => MenuAction::Quit,
        _ => return None,
    })
}

type Item = MenuItemKind<tauri::Wry>;

fn item(
    app: &AppHandle,
    locale: &Locale,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
    enabled: bool,
) -> tauri::Result<Item> {
    Ok(Item::MenuItem(MenuItem::with_id(
        app,
        id,
        locale.text(label),
        enabled,
        accelerator,
    )?))
}

fn separator(app: &AppHandle) -> tauri::Result<Item> {
    Ok(Item::Predefined(PredefinedMenuItem::separator(app)?))
}

fn submenu(
    app: &AppHandle,
    id: &str,
    label: &str,
    items: Vec<Item>,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let menu = Submenu::with_id(app, id, label, true)?;
    for item in items {
        match item {
            Item::MenuItem(item) => menu.append(&item)?,
            Item::Predefined(item) => menu.append(&item)?,
            Item::Submenu(item) => menu.append(&item)?,
            Item::Check(item) => menu.append(&item)?,
            Item::Icon(item) => menu.append(&item)?,
        }
    }
    Ok(menu)
}

fn server_items(app: &AppHandle, locale: &Locale, flags: MenuFlags) -> tauri::Result<Vec<Item>> {
    let mut items = Vec::new();
    if flags.computer_access {
        items.push(item(
            app,
            locale,
            "computer-access",
            "Computer Access…",
            None,
            flags.app_open,
        )?);
    }
    if flags.revoke_computer_access {
        items.push(item(
            app,
            locale,
            "revoke-computer-access",
            "Revoke Local Computer Access",
            None,
            flags.app_open,
        )?);
    }
    items.push(item(
        app,
        locale,
        "change-server",
        "Change Ork Server…",
        Some("CmdOrCtrl+Shift+K"),
        true,
    )?);
    if flags.local_server {
        items.push(item(
            app,
            locale,
            "stop-local-stack",
            "Stop Local Stack",
            None,
            true,
        )?);
    }
    Ok(items)
}

/// Install native menus; the root handles only the finite actions returned by `action`.
pub fn install(app: &AppHandle, locale: &Locale, flags: MenuFlags) -> tauri::Result<()> {
    let name = app.config().product_name.as_deref().unwrap_or("Ork");
    let about = || {
        PredefinedMenuItem::about(
            app,
            Some(&locale.format("About {name}", &[("name", name)])),
            Some(AboutMetadata {
                name: Some(name.to_owned()),
                version: Some(app.package_info().version.to_string()),
                ..Default::default()
            }),
        )
        .map(Item::Predefined)
    };
    let settings = || {
        item(
            app,
            locale,
            "settings",
            "Settings…",
            Some("CmdOrCtrl+,"),
            flags.app_open,
        )
    };
    let updates = || {
        item(
            app,
            locale,
            "check-updates",
            "Check for Updates…",
            None,
            true,
        )
    };
    let new = || {
        item(
            app,
            locale,
            "ui-new",
            "New…",
            Some("CmdOrCtrl+N"),
            flags.app_open,
        )
    };
    let group = || {
        item(
            app,
            locale,
            "ui-new-group",
            "New Group Chat",
            Some("CmdOrCtrl+Shift+N"),
            flags.app_open,
        )
    };
    let integrations = || {
        item(
            app,
            locale,
            "ui-integrations",
            "Connect Apps…",
            Some("CmdOrCtrl+Shift+M"),
            flags.app_open,
        )
    };
    let mut menus = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let mut application = vec![about()?, settings()?];
        if flags.updates {
            application.push(updates()?);
        }
        application.push(separator(app)?);
        application.extend(server_items(app, locale, flags)?);
        application.extend([
            separator(app)?,
            Item::Predefined(PredefinedMenuItem::hide(
                app,
                Some(&locale.format("Hide {name}", &[("name", name)])),
            )?),
            Item::Predefined(PredefinedMenuItem::hide_others(
                app,
                Some(&locale.text("Hide Others")),
            )?),
            Item::Predefined(PredefinedMenuItem::show_all(
                app,
                Some(&locale.text("Show All")),
            )?),
            separator(app)?,
            Item::Predefined(PredefinedMenuItem::quit(
                app,
                Some(&locale.format("Quit {name}", &[("name", name)])),
            )?),
        ]);
        menus.push(submenu(app, "application", name, application)?);
        menus.push(submenu(
            app,
            "file",
            &locale.text("File"),
            vec![new()?, group()?, separator(app)?, integrations()?],
        )?);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut file = vec![
            new()?,
            group()?,
            separator(app)?,
            integrations()?,
            separator(app)?,
            settings()?,
        ];
        file.extend(server_items(app, locale, flags)?);
        if flags.updates {
            file.push(separator(app)?);
            file.push(updates()?);
        }
        file.push(separator(app)?);
        #[cfg(windows)]
        file.push(Item::Predefined(PredefinedMenuItem::quit(
            app,
            Some(&locale.text("Exit")),
        )?));
        #[cfg(not(windows))]
        file.push(item(
            app,
            locale,
            "quit",
            "Quit",
            Some("CmdOrCtrl+Q"),
            true,
        )?);
        menus.push(submenu(app, "file", &locale.text("File"), file)?);
    }

    let mut edit = Vec::new();
    // Tauri exposes native undo/redo only on macOS. Other WebViews retain their editing shortcuts.
    #[cfg(target_os = "macos")]
    edit.extend([
        Item::Predefined(PredefinedMenuItem::undo(app, Some(&locale.text("Undo")))?),
        Item::Predefined(PredefinedMenuItem::redo(app, Some(&locale.text("Redo")))?),
        separator(app)?,
    ]);
    edit.extend([
        Item::Predefined(PredefinedMenuItem::cut(app, Some(&locale.text("Cut")))?),
        Item::Predefined(PredefinedMenuItem::copy(app, Some(&locale.text("Copy")))?),
        Item::Predefined(PredefinedMenuItem::paste(app, Some(&locale.text("Paste")))?),
        Item::Predefined(PredefinedMenuItem::select_all(
            app,
            Some(&locale.text("Select All")),
        )?),
        separator(app)?,
        item(
            app,
            locale,
            "ui-find",
            "Find…",
            Some("CmdOrCtrl+F"),
            flags.app_open,
        )?,
        item(
            app,
            locale,
            "ui-search",
            "Search Bots…",
            Some("CmdOrCtrl+Shift+F"),
            flags.app_open,
        )?,
    ]);
    menus.push(submenu(app, "edit", &locale.text("Edit"), edit)?);

    let mut view = vec![
        item(
            app,
            locale,
            "ui-toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+B"),
            flags.app_open,
        )?,
        item(
            app,
            locale,
            "ui-chat-panel",
            "Chat Details",
            Some("CmdOrCtrl+Shift+,"),
            flags.app_open,
        )?,
        separator(app)?,
        item(
            app,
            locale,
            "reset-zoom",
            "Actual Size",
            Some("CmdOrCtrl+0"),
            true,
        )?,
        item(app, locale, "zoom-in", "Zoom In", Some("CmdOrCtrl+="), true)?,
        item(
            app,
            locale,
            "zoom-out",
            "Zoom Out",
            Some("CmdOrCtrl+-"),
            true,
        )?,
        separator(app)?,
    ];
    #[cfg(target_os = "macos")]
    view.push(Item::Predefined(PredefinedMenuItem::fullscreen(
        app,
        Some(&locale.text("Toggle Full Screen")),
    )?));
    #[cfg(not(target_os = "macos"))]
    view.push(item(
        app,
        locale,
        "fullscreen",
        "Toggle Full Screen",
        Some("F11"),
        true,
    )?);
    menus.push(submenu(app, "view", &locale.text("View"), view)?);

    menus.push(submenu(
        app,
        "go",
        &locale.text("Go"),
        vec![
            item(
                app,
                locale,
                "ui-back",
                "Back",
                Some(if cfg!(target_os = "macos") {
                    "Cmd+["
                } else {
                    "Alt+Left"
                }),
                flags.app_open,
            )?,
            item(
                app,
                locale,
                "ui-forward",
                "Forward",
                Some(if cfg!(target_os = "macos") {
                    "Cmd+]"
                } else {
                    "Alt+Right"
                }),
                flags.app_open,
            )?,
            separator(app)?,
            item(
                app,
                locale,
                "ui-next-bot",
                "Next Bot",
                Some("Ctrl+Tab"),
                flags.app_open,
            )?,
            item(
                app,
                locale,
                "ui-previous-bot",
                "Previous Bot",
                Some("Ctrl+Shift+Tab"),
                flags.app_open,
            )?,
            separator(app)?,
            item(
                app,
                locale,
                "ui-command-menu",
                "Command Menu…",
                Some("CmdOrCtrl+K"),
                flags.app_open,
            )?,
        ],
    )?);

    let mut window = Vec::new();
    #[cfg(not(target_os = "linux"))]
    window.extend([
        Item::Predefined(PredefinedMenuItem::minimize(
            app,
            Some(&locale.text("Minimize")),
        )?),
        Item::Predefined(PredefinedMenuItem::maximize(
            app,
            Some(&locale.text("Zoom")),
        )?),
        Item::Predefined(PredefinedMenuItem::close_window(
            app,
            Some(&locale.text(if cfg!(target_os = "macos") {
                "Close Window"
            } else {
                "Close"
            })),
        )?),
    ]);
    #[cfg(target_os = "linux")]
    window.extend([
        item(app, locale, "minimize", "Minimize", None, true)?,
        item(app, locale, "maximize", "Zoom", None, true)?,
        item(app, locale, "close-window", "Close", Some("Ctrl+W"), true)?,
    ]);
    #[cfg(target_os = "macos")]
    window.extend([
        separator(app)?,
        Item::Predefined(PredefinedMenuItem::bring_all_to_front(
            app,
            Some(&locale.text("Bring All to Front")),
        )?),
    ]);
    let windows = submenu(app, WINDOW_SUBMENU_ID, &locale.text("Window"), window)?;
    menus.push(windows.clone());
    let help = vec![item(
        app,
        locale,
        "ui-shortcuts",
        "Keyboard Shortcuts",
        Some("CmdOrCtrl+/"),
        flags.app_open,
    )?];
    #[cfg(not(target_os = "macos"))]
    let help = {
        let mut items = help;
        items.push(about()?);
        items
    };
    let help = submenu(app, HELP_SUBMENU_ID, &locale.text("Help"), help)?;
    menus.push(help.clone());

    let menu = Menu::new(app)?;
    for submenu in menus {
        menu.append(&submenu)?;
    }
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    {
        windows.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_menu_ids_map_only_to_known_shared_commands() {
        for (id, command) in [
            ("new", "new"),
            ("new-group", "new-group"),
            ("integrations", "integrations"),
            ("find", "find"),
            ("search", "search"),
            ("back", "back"),
            ("forward", "forward"),
            ("next-bot", "next-bot"),
            ("previous-bot", "previous-bot"),
            ("command-menu", "command-menu"),
            ("toggle-sidebar", "toggle-sidebar"),
            ("chat-panel", "chat-panel"),
            ("shortcuts", "shortcuts"),
        ] {
            assert_eq!(action(&format!("ui-{id}")), Some(MenuAction::Ui(command)));
        }
        for unknown in [
            "",
            "new",
            "ui-unknown",
            "ui-new;quit",
            "plugin:opener|open_url",
        ] {
            assert_eq!(action(unknown), None);
        }
    }

    #[test]
    fn server_window_and_update_actions_have_separate_ids() {
        assert_eq!(action("change-server"), Some(MenuAction::ChangeServer));
        assert_eq!(
            action("stop-local-stack"),
            Some(MenuAction::StopLocalServer)
        );
        assert_eq!(action("check-updates"), Some(MenuAction::CheckForUpdates));
        assert_eq!(action("settings"), Some(MenuAction::Settings));
        assert_eq!(action("reset-zoom"), Some(MenuAction::ResetZoom));
        assert_eq!(action("close-window"), Some(MenuAction::CloseWindow));
        assert_eq!(action("quit"), Some(MenuAction::Quit));
    }
}
