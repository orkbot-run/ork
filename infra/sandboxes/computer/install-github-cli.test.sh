#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
set -euo pipefail
script="${1:?Installer path is required}"
work=$(mktemp -d "${TMPDIR:-/tmp}/ork-gh-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/archive/gh_2.100.0_linux_amd64/bin" "$work/archive/gh_2.100.0_linux_arm64/bin" "$work/dest"
printf 'fixture' > "$work/archive/gh_2.100.0_linux_amd64/bin/gh"
printf 'fixture' > "$work/archive/gh_2.100.0_linux_arm64/bin/gh"
tar -czf "$work/amd64.tar.gz" -C "$work/archive" gh_2.100.0_linux_amd64
tar -czf "$work/arm64.tar.gz" -C "$work/archive" gh_2.100.0_linux_arm64
amd64=$(shasum -a 256 "$work/amd64.tar.gz" | cut -d ' ' -f 1)
arm64=$(shasum -a 256 "$work/arm64.tar.gz" | cut -d ' ' -f 1)
python3 - "$script" "$work/installer" "$amd64" "$arm64" <<'PY'
from pathlib import Path
import sys
script = Path(sys.argv[1]).read_text()
script = script.replace('e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be', sys.argv[3])
script = script.replace('ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961', sys.argv[4])
Path(sys.argv[2]).write_text(script)
PY
cat > "$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$ORK_TEST_DIR/calls"
url=''; output=''
while (($#)); do
  case "$1" in
    https://*) url="$1"; shift ;;
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$url" == *github.com/cli/cli/releases/download* && "${ORK_TEST_FALLBACK:-0}" == 1 ]]; then exit 22; fi
if [[ "${ORK_TEST_BAD_ARCHIVE:-0}" == 1 ]]; then printf corrupt > "$output"; else cp "$ORK_TEST_DIR/$ORK_TEST_ARCH.tar.gz" "$output"; fi
MOCK
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH" ORK_TEST_DIR="$work"
for architecture in amd64 arm64; do
  export ORK_TEST_ARCH="$architecture"
  for fallback in 0 1; do
    : > "$work/calls"
    ORK_TEST_FALLBACK="$fallback" sh "$work/installer" 2.100.0 "$architecture" "$work/dest" >/dev/null
    test "$(cat "$work/dest/gh")" = fixture
    grep -q -- '--retry 2 --retry-all-errors --retry-max-time 180' "$work/calls"
    if [[ "$fallback" == 1 ]]; then
      if [[ "$architecture" == amd64 ]]; then asset=542974264; else asset=542974279; fi
      grep -q "api.github.com/repos/cli/cli/releases/assets/$asset" "$work/calls"
    fi
  done
done
if ORK_TEST_BAD_ARCHIVE=1 sh "$work/installer" 2.100.0 arm64 "$work/dest" >/dev/null 2>&1; then
  echo 'A corrupt GitHub CLI archive was accepted.' >&2
  exit 1
fi
