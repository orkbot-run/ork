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
  unzip -p "$apk" "$entry" > "$temporary/$library"
  magic="$(od -An -tx1 -N4 "$temporary/$library" | tr -d ' \n')"
  [[ "$magic" == 7f454c46 ]] || { echo "Invalid native library: $library" >&2; exit 1; }
done

grep -E '^classes([0-9]+)?\.dex$' "$temporary/entries" > "$temporary/dex-files"
: > "$temporary/native-methods"
while IFS= read -r entry; do
  unzip -p "$apk" "$entry" > "$temporary/classes.dex"
  # DEX strings use modified UTF-8; inspect ASCII descriptors as bytes.
  "$tools/dexdump" "$temporary/classes.dex" | LC_ALL=C awk -v bindings="$temporary/native-methods" '
    /Class descriptor/ {
      print
      split($0, value, "\047")
      module = value[2] == "Lcom/orkbot/transport/OrkTransportModule;"
      name = signature = ""
    }
    module && /^[[:space:]]*name[[:space:]]*:/ { split($0, value, "\047"); name = value[2] }
    module && /^[[:space:]]*type[[:space:]]*:/ { split($0, value, "\047"); signature = value[2] }
    module && /^[[:space:]]*access[[:space:]]*:/ && /NATIVE/ {
      print name "\t" signature "\t" ($0 ~ /STATIC/ ? "static" : "instance") >> bindings
    }
  ' >> "$temporary/classes"
done < "$temporary/dex-files"
for descriptor in Lcom/sun/jna/Native\; Luniffi/ork_installation_transport/UniffiLib\; Lorg/rustls/platformverifier/CertificateVerifier\; Lcom/orkbot/transport/OrkTransportModule\;; do
  grep -Fq "'$descriptor'" "$temporary/classes" || { echo 'A required native binding was removed or renamed.' >&2; exit 1; }
done
method=initPlatformVerifier
expected="$(printf '%s\t%s\t%s' "$method" '(Landroid/content/Context;)V' instance)"
[[ "$(cat "$temporary/native-methods")" == "$expected" ]] || { echo 'Android verifier JNI declaration does not match the native bridge.' >&2; exit 1; }
ndk="${ANDROID_NDK_HOME:-$sdk/ndk}"
[[ -d "$ndk" ]] || { echo 'Android NDK symbol inspection tool is missing.' >&2; exit 1; }
nm="$(find "$ndk" -path '*/toolchains/llvm/prebuilt/*/bin/llvm-nm' | sort | tail -n 1)"
[[ -x "$nm" ]] || { echo 'Android NDK symbol inspection tool is missing.' >&2; exit 1; }
"$nm" -D --defined-only "$temporary/libork_installation_transport.so" | LC_ALL=C awk '{ print $NF }' > "$temporary/exports"
grep -Fxq "Java_com_orkbot_transport_OrkTransportModule_$method" "$temporary/exports" || { echo 'Android verifier JNI entry point is missing.' >&2; exit 1; }
echo 'Android APK signature, application ID and native bindings verified.'
