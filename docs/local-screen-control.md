<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Local application screen control

Enable local computer access in the desktop app menu while connected to an app-managed local
installation. After the native confirmation, macOS asks for Screen Recording and Accessibility
permission. Allow both in System Settings, then enable access again. Capture requires macOS 14
or newer; ordinary local commands keep their existing platform requirements. No OS prompt is
shown at startup, during capability discovery, or in response to an agent tool call.

The desktop pairs a transient device using the active installation sign-in, connects outbound
through the existing device protocol, and discards that credential when native consent ends.
Document changes, switching installations, revocation, disconnection and app shutdown cancel
in-flight requests. The paired credential is tied to the sign-in session and is never sent to
the WebView or persisted. Remote and relay installation access is not enabled by this local
loopback transport.

Use `user_computer_observe` and `user_computer_act`, naming the application approved in the
chat. The existing owner-only direct-chat policy and per-application approvals remain in force;
workers keep every request pinned to the selected paired device id. Whole-desktop observation,
unscoped generic `computer_act`, and native command execution on Windows are not enabled by
screen permission. Shared workspaces, group chats, other people's bots and background triggers
do not gain access.

Supported actions are window-relative `click`, `move`, `type`, `scroll`, `key` and `wait`.
An exact, unambiguous running application name selects the target process. Coordinates must
remain inside its captured window. macOS uses a ScreenCaptureKit window filter and sends events
to that process. Windows uses PrintWindow and messages addressed to windows belonging to the
selected process. Neither driver falls back to capturing the desktop or injecting global input.
Accessibility element numbers, `set` and `menu` actions are currently refused by these drivers.

macOS depends on window-local input support in the system. If that support is unavailable,
Ork hides the screen tools. Windows supports individual keys through targeted window messages. Applications that
require physical/global input, accelerator translation, elevated privileges or refuse
PrintWindow may not respond. Key combinations are unavailable on Windows.

Capability discovery asks the actual matched device for `capabilities` and requires both
`screen` and `control`. A missing driver, denied permission, old client, disconnected device or
probe timeout disables screen tool discovery. The OS/platform label alone never advertises
screen support. Native helper processes are bounded by the host request deadline, killed when
requests are cancelled, and responses are bounded to the existing frame size.
