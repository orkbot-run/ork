#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

set -euo pipefail
gradle="${1:?Gradle executable is required}"
mirror="${2:?Maven mirror init script is required}"
args=(app:assembleRelease :orkbot-notifications:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2
  "-Dorg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g")
if "$gradle" "${args[@]}" --init-script "$mirror"; then
  exit 0
fi
echo 'The build with the Maven Central mirror failed; retrying with the original repositories.' >&2
"$gradle" "${args[@]}"
