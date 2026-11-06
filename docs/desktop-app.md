# Desktop app

The desktop app for Mac, Windows and Linux runs the same Ork as the web, and can also run
everything on your own computer.

## Install

Download it from [orkbot.run](https://orkbot.run). The Linux AppImage needs FUSE 2.

## Choose a server

The first time it opens, the app asks which server to use:

- **Ork Cloud**: sign in to your orkbot.run account.
- **This computer**: run your own Ork locally in Docker. If Docker isn't installed, the app links
  to Docker Desktop, OrbStack and Docker Engine. Everything, including your bots' computers, then
  runs on your machine. It is yours alone: once you create your account, it accepts no other.
- **Existing instance**: connect to a Ork server you or your team already run. Enter its
  **Server address** and choose **Check connection**.

To switch later, use **Change Ork Server…** in the app menu (Cmd+Shift+K, or Ctrl+Shift+K on
Windows and Linux).

> [!NOTE]
> A local server keeps running after you quit the app, so routines still run. Choose
> **Stop Local Stack** in the app menu to shut it down.

## Native feature availability

Tauri is now the desktop runtime. Local host control, screen control and native passkeys
remain unavailable while their native transports and platform permissions are completed.
The selected server still provides its configured bot computers. See
[migration status](./desktop-tauri-migration.md) for the feature inventory.

## Updates

Current diagnostic builds do not have a configured signed update feed. Install a newer
Tauri package manually. Automatic updates remain disabled by default.

## Shortcuts

Windows and Linux use Ctrl where macOS uses Cmd. The desktop app lists them in its menus.

- Cmd+N: create a bot, group or space.
- Cmd+K: open the command menu to jump to any bot.
- Cmd+1 to Cmd+9 (desktop app): open one of the first nine bots in the sidebar.
- Ctrl+Tab / Ctrl+Shift+Tab (desktop app): switch to the next or previous bot.
- Cmd/Ctrl+Shift+Down / Cmd/Ctrl+Shift+Up (browser): switch to the next or previous bot.
- Cmd+[ / Cmd+] (Alt+Left / Alt+Right on Windows and Linux, desktop app): go back or forward.
- Cmd+F (desktop app): search.
- Cmd+B: show or hide the sidebar.
- Cmd+, (desktop app): open Settings.
- Esc in the message box: stop the bot's reply.
- Typing anywhere outside a text field starts a message.

The dock icon shows a badge count of unread chats.
