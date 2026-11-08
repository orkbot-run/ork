#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

set -euo pipefail
script="${1:?Gradle preparation script is required}"
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ork-gradle-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/runner"
printf 'verified archive' > "$work/archive"
export ORK_TEST_ROOT="$work"
cat > "$work/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "${ORK_TEST_GH_FAILURE:-0}" == 0 ]] || exit 1
case "$*" in
  *releases/tags/*) printf '%s' '{"assets":[{"name":"gradle-9.3.1-bin.zip","state":"uploaded","url":"https://api.github.com/repos/gradle/gradle-distributions/releases/assets/123"}]}' ;;
  *releases/assets/*) cat "$ORK_TEST_ROOT/archive" ;;
  *) exit 1 ;;
esac
MOCK
cat > "$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
output=''
url=''
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */releases/tags/*) printf '%s' '{"assets":[{"name":"gradle-9.3.1-bin.zip","state":"uploaded","url":"https://api.github.com/repos/gradle/gradle-distributions/releases/assets/123"}]}' > "$output" ;;
  */releases/assets/*) cp "$ORK_TEST_ROOT/archive" "$output" ;;
  *.sha256) if [[ "${ORK_TEST_BAD_CHECKSUM:-0}" == 1 ]]; then printf '%064d' 0 > "$output"; else shasum -a 256 "$ORK_TEST_ROOT/archive" | cut -d ' ' -f 1 > "$output"; fi ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$work/bin/gh" "$work/bin/curl"
export PATH="$work/bin:$PATH" RUNNER_TEMP="$work/runner"
for failure in 0 1; do
  printf '%s\n' 'distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-bin.zip' > "$work/wrapper.properties"
  ORK_TEST_GH_FAILURE="$failure" bash "$script" "$work/wrapper.properties"
  grep -q '^distributionUrl=file\\:' "$work/wrapper.properties"
  grep -Eq '^distributionSha256Sum=[0-9a-f]{64}$' "$work/wrapper.properties"
done
printf '%s\n' 'distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-bin.zip' > "$work/wrapper.properties"
if ORK_TEST_BAD_CHECKSUM=1 bash "$script" "$work/wrapper.properties" 2>/dev/null; then
  echo 'A distribution with a mismatched checksum was accepted.' >&2
  exit 1
fi
