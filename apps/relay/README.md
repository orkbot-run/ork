<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Installation relay

The relay pairs outbound installation sockets with native clients. Installation TLS remains encrypted between the client and the self-hosted server, including request headers, files and response streams. Accounts redeems each short-lived ticket once and checks the current workspace access and installation lease before admitting a socket.

Run one process per relay origin. Its socket registry lives in memory, so multiple replicas behind a load balancer cannot pair channels. Stop the old process before starting its replacement. Connections close during a restart and clients must obtain fresh tickets. A shared registry and cross-process routing are required before enabling replicas.

## Run locally

From the repository root:

```sh
pnpm --filter @orkbot/relay build
ORK_ACCOUNTS_ISSUER=https://accounts.example.test \
ORK_RELAY_ORIGIN=https://relay.example.test \
pnpm --filter @orkbot/relay start
```

Both origins must use HTTPS. Put a TLS 1.3 reverse proxy in front of port 3210, enable WebSocket upgrades, disable request buffering and keep upgrade headers and query strings out of access logs. The proxy must reach this process directly. Configure the same relay origin as `ACCOUNTS_RELAY_ORIGIN` in Accounts. Installations discover it through signed central leases.

The server image also contains the relay. Set `ORKBOT_SERVER_IMAGE` to an immutable image reference, export the two origins above, and run:

```sh
docker compose -f infra/relay/docker-compose.yml up -d
```

The Compose service binds port 3210 to loopback for a host TLS proxy. It receives no database login, signing key, provider credential or Accounts bearer token. `/health` reports process availability only. Ticket redemption still requires Accounts.

## Limits and failure behavior

An installation control lease lasts at most 45 seconds and renews every 10 seconds. Local database leadership lasts 60 seconds to cover a lost central release response. Known central refusal closes remote channels and persists an installation verification barrier. Relay outages leave direct and local routes independent.

Each installation permits 32 pending attachments and 256 active channels. Pairing has an eight-second deadline. Frames are bounded to 256 KiB, forwarding applies backpressure, and closing either peer closes its partner. Pending attachment secrets and accepted tickets are never reused.

`pnpm --filter @orkbot/relay test` exercises socket pairing, replay rejection, expiry, renewal, cancellation, encrypted file transfer and actual TLS proxying. The cross-repository workspace protocol suite additionally uses the real Accounts database and ticket verifier.
