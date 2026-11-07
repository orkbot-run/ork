<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- Modified by Ork contributors for the Tauri desktop cleanup. Inherited material remains Apache-2.0. -->

# Desktop app

The Tauri desktop app for Mac, Windows and Linux includes the React interface and
connects it to your Ork server. It can also run the server on your own computer.

## Install

Build it from source or download a diagnostic installer from the `desktop-tauri.yml`
Actions artifacts. See [Tauri desktop development](desktop-tauri.md). The Linux
AppImage needs FUSE 2.

## Choose a server

Setup opens with the saved server choice:

- **This computer**: run your own Ork locally in Docker. If Docker isn't installed, the app links
  to Docker Desktop, OrbStack and Docker Engine. Everything, including your bots' computers, then
  runs on your machine. It is yours alone: once you create your account, it accepts no other.
- **Existing instance**: connect to a Ork server you or your team already run. Enter its
  **Server address** and choose **Connect**.

To switch later, use **Change Ork Server…** in the app menu (Cmd+Shift+K, or Ctrl+Shift+K on
Windows and Linux).

> [!NOTE]
> A local server keeps running after you quit the app, so routines still run. Choose
> **Stop Local Stack** in the app menu to shut it down.

## Let bots use this computer

The desktop app can give bots access to the computer it runs on, to run commands and work with your
files.

- With **This computer**, the app asks **Where should bots run?** Choose **Docker** to keep bots in
  their own isolated computers, or **Use this Mac** (**Use this computer** on Windows and Linux) to
  let them work directly on yours. **Computer Access…** in the app menu changes this later, and
  **Revoke Local Computer Access** turns it off.
- With any server, turn on **Let bots use this computer** in **Settings → General** under
  **Computers**. Your computer then shows as **Connected** or **Offline** there. Access belongs to
  the account that turned it on and ends when that account signs out, resets its password or signs
  out everywhere. Signing back in to the same account restores it without asking again.

Either way, the app asks **Allow bots to use this computer?** before access is granted. See
[The bot's computer](./computer.md#use-your-own-computer).

> [!WARNING]
> With **Use this Mac**, bots can run commands without asking. Don't choose it for a server other
> people use.

## Updates

Updates are available only in builds configured with a signed Tauri update feed.
Default diagnostic builds have updates disabled. In a configured build, the app checks
and downloads updates in the background, then asks before installation.
**Check for Updates…** in the app menu checks now. See [Desktop releases](desktop-release.md).

The interface updates with the desktop app. Updating the server keeps the installed
interface in place. If the server requires a newer client, **Update Ork** opens the
download page.

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
