<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Devices

This module pairs user devices, authorizes forwarding requests, and keeps device access tied to sign-in sessions. It revokes devices when their session ends and enforces the pairing limit, using injected workspace adapters for socket transport and connected-device state.

`mountUserDeviceRoutes` installs the HTTP handlers using `UserDeviceRouteDeps`. Authentication lifecycle hooks call `endUserDeviceSession` to revoke paired devices or transfer them to a replacement session. Computer operations remain in `computers`.
