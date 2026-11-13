<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Personal device keys

`OrkIdentity` keeps P-256 keys in iOS Keychain or AndroidKeyStore. JavaScript receives public keys and signatures.

`apps/mobile/lib/personal-device.ts` checks logout and account changes during native calls. `personal-login.ts` verifies the installation proof.

Run the Keychain tests on a disposable iOS simulator with CocoaPods' `xcodeproj` gem available:

```sh
ruby apps/mobile/modules/orkbot-identity/tests/run-ios-tests.rb <simulator-uuid>
```

Results stay in a temporary Xcode bundle. The tests use their own app and Keychain access group.
