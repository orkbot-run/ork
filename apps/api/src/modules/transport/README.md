<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Installation transport lifecycle

`startInstallationRelay` elects one API process through the installation database and maintains its short central transport lease. Each request opens a separate outbound data socket. The existing installation transport terminates TLS and dispatches authenticated HTTP.

`installationHttpListener` preserves the configured logical origin when passing decrypted HTTP to Hono. An inner TLS socket must not turn a Docker loopback HTTP installation into a different HTTPS authority.

Relay failures close remote channels without stopping direct or local access. A known central refusal aborts workspace authority and writes a durable personal verification barrier before reading device IDs. Shutdown releases local leadership only after Accounts confirms release. An unconfirmed shutdown retains the longer local lease until it expires, so a replacement process cannot overlap the old central lease.
