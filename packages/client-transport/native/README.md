<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Installation transport

`InstallationHttp` runs one HTTP request inside a pinned TLS 1.3 channel.
The platform supplies encrypted bytes. Rustls verifies the certificate, its installation DNS name and validity, then checks the peer's SPKI fingerprint against the selected catalog entry before Hyper sends HTTP.
Never take the expected fingerprint from the socket envelope.

Uploads and downloads use bounded chunks with backpressure. Read response headers, then pull body chunks until EOF. Cancel the operation when its account or workspace closes, including while a read or write is waiting. Requests keep their logical server authority and product bearer inside TLS. Redirects and failed mutations are returned to the caller without automatic replay.

The server's `/api/installation-transport/v1` WebSocket sends a public certificate envelope, followed by binary TLS bytes. Its certificate uses the enrolled installation key, so renewing it preserves the catalog fingerprint. Application authentication and workspace authorization run inside that channel.

`InstallationConnection` owns the socket on all native platforms. The outer WebSocket uses system certificate trust. Its upgrade, certificate envelope and binary frames have size limits. Cookies, redirects and TLS session resumption are disabled. The inner installation pin is checked independently of outer TLS.

The Expo module registers a request before starting its network operation. A cancellation received during registration prevents that operation from being sent. Native account sessions and monotonic workspace revisions fence pending reads, uploads and responses. Swift and Kotlin keep this lifecycle state, while Rust handles network I/O. The shared fetch adapter pulls response bytes only when the caller reads them.

Expo prebuild compiles the module from source. Local builds require rustup and the platform SDK. Android also requires the NDK. Cloud builds can install Rust in ignored build output after checking the installer checksum. Apple output includes device and simulator libraries, and Android output includes all four supported ABIs with 16 KB page alignment. Generated bindings and binaries stay untracked.

Production relay routing, the desktop application bridge and end-to-end native acceptance remain release gates. The loopback proxy below tests opaque forwarding, without claiming production relay availability.

Run the Rust checks from this directory:

```sh
cargo fmt -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --lib
```

On macOS, generate Swift bindings and run the cross-language test after installing the repository's dependencies:

```sh
cargo build --locked --features bindgen
cargo run --locked --features bindgen --bin ork-transport-bindgen -- generate \
  --library target/debug/libork_installation_transport.dylib \
  --language swift --out-dir /tmp/ork-transport-bindings --no-format
pnpm --workspace-root exec tsx packages/client-transport/native/apple/tests/run.ts /tmp/ork-transport-bindings
```

The test starts a loopback installation and an opaque TCP relay, then sends files and event streams from Swift through Rust to Node. It checks cancellation, an incorrect fingerprint and the absence of HTTP content in captured relay bytes. The fixture uses generated test keys and removes its files and sockets when it exits.
