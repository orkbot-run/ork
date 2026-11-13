#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

set -euo pipefail
apk="${1:?APK path is required}"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$sdk" && -f "$apk" ]] || { echo 'An Android SDK and built APK are required.' >&2; exit 1; }
signer="$(find "$sdk/build-tools" -name apksigner -type f | sort | tail -n 1)"
[[ -n "$signer" ]] || { echo 'Android build tools are missing.' >&2; exit 1; }
tools="$(dirname "$signer")"
"$signer" verify "$apk"
unzip -tq "$apk" > /dev/null
badging="$("$tools/aapt2" dump badging "$apk")"
[[ "$badging" == "package: name='run.orkbot.app' "* ]] || { echo 'Unexpected Android application ID.' >&2; exit 1; }

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
unzip -Z1 "$apk" > "$temporary/entries"
for library in libork_installation_transport.so libjnidispatch.so; do
  entry="lib/arm64-v8a/$library"
  grep -Fxq "$entry" "$temporary/entries" || { echo "Missing native library: $library" >&2; exit 1; }
  unzip -p "$apk" "$entry" > "$temporary/library"
  magic="$(od -An -tx1 -N4 "$temporary/library" | tr -d ' \n')"
  [[ "$magic" == 7f454c46 ]] || { echo "Invalid native library: $library" >&2; exit 1; }
done

grep -E '^classes([0-9]+)?\.dex$' "$temporary/entries" > "$temporary/dex-files"
while IFS= read -r entry; do
  unzip -p "$apk" "$entry" > "$temporary/classes.dex"
  # DEX strings use modified UTF-8; inspect ASCII descriptors as bytes.
  "$tools/dexdump" "$temporary/classes.dex" | LC_ALL=C awk '/Class descriptor/ { print }' >> "$temporary/classes"
done < "$temporary/dex-files"
for descriptor in Lcom/sun/jna/Native\; Luniffi/ork_installation_transport/UniffiLib\; Lorg/rustls/platformverifier/CertificateVerifier\; Lcom/orkbot/transport/OrkTransportModule\;; do
  grep -Fq "'$descriptor'" "$temporary/classes" || { echo 'A required native binding was removed or renamed.' >&2; exit 1; }
done
echo 'Android APK signature, application ID and native bindings verified.'
