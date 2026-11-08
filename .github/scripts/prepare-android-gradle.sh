#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

set -euo pipefail

wrapper="${1:?Gradle wrapper properties path is required}"
runner_temp="${RUNNER_TEMP:?RUNNER_TEMP is required}"
work=$(mktemp -d "$runner_temp/ork-gradle.XXXXXX")

# Keep the exact version and distribution type selected by Expo's generated wrapper.
python3 - "$wrapper" > "$work/distribution" <<'PY'
import re, sys
from pathlib import Path

lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
values = [line.partition("=")[2].replace("\\:", ":") for line in lines if line.startswith("distributionUrl=")]
if len(values) != 1:
    raise SystemExit("Expected one generated Gradle distribution URL.")
match = re.fullmatch(r"https://services\.gradle\.org/distributions/(gradle-([0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?)-(?:bin|all)\.zip)", values[0])
if not match:
    raise SystemExit("The generated Gradle distribution URL is unsupported.")
print(match.group(1))
print(match.group(2))
PY
archive=$(sed -n '1p' "$work/distribution")
version=$(sed -n '2p' "$work/distribution")
curl_opts=(--fail --silent --show-error --location --connect-timeout 15 --max-time 300 --retry 4 --retry-delay 2 --retry-all-errors --proto '=https' --proto-redir '=https')

if ! gh api -H 'Accept: application/vnd.github+json' \
  "repos/gradle/gradle-distributions/releases/tags/v${version}" > "$work/release.json"; then
  curl "${curl_opts[@]}" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/gradle/gradle-distributions/releases/tags/v${version}" \
    -o "$work/release.json"
fi
asset=$(jq -er --arg name "$archive" \
  '[.assets[] | select(.name == $name and .state == "uploaded") | .url] | if length == 1 then .[0] else error("Gradle asset is missing or ambiguous") end' \
  "$work/release.json")
[[ "$asset" =~ ^https://api\.github\.com/repos/gradle/gradle-distributions/releases/assets/[0-9]+$ ]] || {
  echo 'Gradle asset URL is invalid.' >&2; exit 1;
}
if ! gh api -H 'Accept: application/octet-stream' "${asset#https://api.github.com/}" > "$work/$archive"; then
  curl "${curl_opts[@]}" -H 'Accept: application/octet-stream' "$asset" -o "$work/$archive"
fi
curl "${curl_opts[@]}" "https://services.gradle.org/distributions/$archive.sha256" -o "$work/sha256"
checksum=$(tr -d '\r\n' < "$work/sha256")
[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || { echo 'Gradle checksum is invalid.' >&2; exit 1; }
python3 - "$work/$archive" "$checksum" <<'PY' || {
import hashlib, hmac, sys
from pathlib import Path

digest = hashlib.sha256()
with Path(sys.argv[1]).open("rb") as archive:
    for chunk in iter(lambda: archive.read(1024 * 1024), b""):
        digest.update(chunk)
if not hmac.compare_digest(digest.hexdigest(), sys.argv[2]):
    sys.exit(1)
PY
  echo 'Gradle distribution checksum does not match.' >&2; exit 1;
}

python3 - "$wrapper" "$work/$archive" "$checksum" <<'PY'
import sys
from pathlib import Path

wrapper = Path(sys.argv[1])
lines = wrapper.read_text(encoding="utf-8").splitlines()
lines = [line for line in lines if not line.startswith("distributionSha256Sum=")]
local_url = Path(sys.argv[2]).resolve().as_uri().replace(":", "\\:", 1)
lines = ["distributionUrl=" + local_url if line.startswith("distributionUrl=") else line for line in lines]
lines.append("distributionSha256Sum=" + sys.argv[3])
wrapper.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
