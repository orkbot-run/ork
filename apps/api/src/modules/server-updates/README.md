<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Server updates

Only the explicitly delegated installation owner can request updates. Authorization checks the native identity recorded for the session.

The adapter triggers its configured channel. Acknowledgement records only the request.

Requests persist before submission. Database claims enforce a one-hour cooldown. Automatic updates require separate consent and checks run every six hours. Interrupted submissions become unknown and are never retried automatically.

Composition supplies the private binding and adapter. No host commands run here.
