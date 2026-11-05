<!-- SPDX-FileCopyrightText: 2026 Rakazo contributors -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Apache-2.0 covers the imported guide. Ork revisions are PolyForm-covered. -->
<!-- Modified by Ork contributors for product naming, links, and recovery instructions. -->

# Troubleshooting

Follow **Troubleshoot** in an error to open its recovery steps. If someone else runs
your server, send them the error code and this guide.

## MCP OAuth redirect mismatch

**Code:** `MCP_OAUTH_REDIRECT_MISMATCH`

**Message:** "The sign-in address does not match this server's configuration."
Older versions show "MCP OAuth redirect URI is not allowed".

Ork builds the sign-in callback from the address in your browser. The API accepts
only the callback configured through `WEB_ORIGIN`, so a different hostname, port,
or scheme causes this error before the external service's sign-in page opens.

Check the browser address first.

1. Copy its origin: scheme, hostname, and port, without a path. For example,
   `https://app.example.com` or `http://127.0.0.1:5173`.
2. Compare it with the API's effective `WEB_ORIGIN`. If that setting has the address
   you intend to use, open Ork there. `localhost` and `127.0.0.1` are different hosts.
3. If the setting is wrong, update `WEB_ORIGIN`. Public deployments need an HTTPS
   origin, with `BETTER_AUTH_URL` and `API_URL` aligned as described in the
   [self-hosting guide](./self-host.md). In local source development, `API_URL`
   can still point to the separate API listener.
4. Restart the API with its updated environment. For Docker Compose, recreate the
   API service with the same Compose files and environment file you used to
   install it, because restarting the existing container keeps its old environment.
5. Open the chosen address and reconnect the integration.

A manually registered OAuth client also needs
`<WEB_ORIGIN>/mcp/oauth/callback` in its allowed redirect URIs. The external service
checks this separately. See [MCP servers](./self-host-integrations.md#mcp-servers).

## Ask an AI assistant

Share the relevant section and error code. This prompt gives the assistant enough
context to start without asking for a full configuration file:

```text
Help me troubleshoot Ork using https://orkbot.run/docs/troubleshooting/.

Error code: <code>
App version: <version>
Installation method: <published Docker images, source, or other>
What I was doing: <action that failed>

Read the relevant section first. Ask for missing details, explain each proposed
change, and say how to verify it. Request only the specific non-secret settings
you need. Do not request passwords, API keys, tokens, cookies, or an entire .env
file. Keep authentication and URL validation enabled.
```

Review commands before running them. If the error persists,
[report a bug](https://github.com/orkbot-run/ork/issues) with the error code, version,
installation method, and reproduction steps. Remove secrets and personal data first.
