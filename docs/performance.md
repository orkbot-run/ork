<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Rakazo contributors -->
<!-- Modified by Ork contributors for the Tauri desktop transition. -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Desktop performance measurements

Tauri uses the operating system WebView. The previous Electron launch benchmark has
been removed with that runtime. Historical macOS comparisons remain in
`apps/desktop/benchmarks`; they are not measurements of the current Linux build.

Build an installer and record artifact sizes with:

```sh
pnpm --filter @orkbot/desktop bundle
node apps/desktop/scripts/tauri-metrics.mjs apps/desktop/src-tauri/target/release/bundle
```

The native CI workflow uploads this size report alongside unsigned installers. Compare
the same platform, architecture and build mode. Runtime launch time, idle memory and CPU
still require platform-specific measurements including the WebView child processes.
Use disposable test accounts and servers, without production data or provider credentials.
