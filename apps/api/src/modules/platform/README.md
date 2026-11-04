# Platform

Environment loading, HTTP limits, health checks, monitoring, diagnostics, and shared RPC context live here. The module also provides request tracking, throttling, and transaction-retry helpers. Domain behavior belongs in its own module, and executable lifecycle wiring stays in `app.ts`, `index.ts`, and `cli/`.

`loadEnv`, `createRouter`, and `createRouterContext` are the main setup entrypoints, with middleware and helpers imported by name from their files. `app.ts` supplies the filesystem URL used by `readDeployedWebBuild`.
