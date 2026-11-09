#!/bin/sh
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home" "$tmp/temporary"

cat >"$tmp/bin/curl" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$@" >>"$TEST_ROOT/curl-args"
if [ "${STUB_CURL_FAIL:-}" = 1 ]; then exit 22; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output=$2; shift 2; else url=$1; shift; fi
done
case "$url" in
  'https://api.github.com/repos/orkbot-run/ork/releases?per_page=100')
    if [ "${STUB_API+x}" ]; then
      printf '%s\n' "$STUB_API" >"$output"
    else
      printf '%s\n' '[{"tag_name":"desktop-stable","draft":false,"prerelease":false},{"tag_name":"v1.1.142","draft":false,"prerelease":false}]' >"$output"
    fi
    ;;
  https://api.github.com/repos/orkbot-run/ork/commits/v1.1.142)
    if [ "${STUB_RELEASE+x}" ]; then
      printf '%s\n' "$STUB_RELEASE" >"$output"
    else
      printf '%s\n' '{"sha":"a008fbde71f5fec493040fdd6c9d38763d2e2f9d"}' >"$output"
    fi
    ;;
  *) printf '%s\n' '# stub installer' >"$output" ;;
esac
EOF
cat >"$tmp/bin/bash" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$ORKBOT_DOWNLOAD_BASE" >"$TEST_ROOT/base"
pwd >"$TEST_ROOT/working-directory"
shift
printf '%s\n' "$@" >"$TEST_ROOT/installer-args"
case " $* " in *' --code-stdin '*) IFS= read -r code; printf '%s' "$code" >"$TEST_ROOT/stdin-code" ;; esac
EOF
chmod +x "$tmp/bin/curl" "$tmp/bin/bash"
export TEST_ROOT="$tmp" HOME="$tmp/home" TMPDIR="$tmp/temporary" PATH="$tmp/bin:$PATH"

code=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq
cat "$root/install.sh" | sh -s -- --code "$code" --external-proxy
base=https://raw.githubusercontent.com/orkbot-run/ork/a008fbde71f5fec493040fdd6c9d38763d2e2f9d/infra/compose
[ "$(cat "$tmp/base")" = "$base" ]
[ "$(cat "$tmp/working-directory")" = "$HOME/orkbot" ]
[ "$(cat "$tmp/installer-args")" = "$(printf '%s\n' --server --code "$code" --external-proxy)" ]
grep -Fqx "$base/install-images.sh" "$tmp/curl-args"
[ -z "$(ls -A "$TMPDIR")" ]

revision=0123456789abcdef0123456789abcdef01234567
rm "$tmp/curl-args"
cat "$root/install.sh" | sh -s -- --url https://server.example.test --revision "$revision" --code "$code"
[ "$(cat "$tmp/base")" = "https://raw.githubusercontent.com/orkbot-run/ork/$revision/infra/compose" ]
[ "$(cat "$tmp/installer-args")" = "$(printf '%s\n' --server --url https://server.example.test --code "$code")" ]
if grep -q 'api.github.com' "$tmp/curl-args"; then echo 'Explicit revision queried release metadata.' >&2; exit 1; fi

rm "$tmp/base" "$tmp/curl-args"
if cat "$root/install.sh" | sh -s -- --revision invalid >/dev/null 2>&1; then
  echo 'An invalid revision was accepted.' >&2
  exit 1
fi
[ ! -e "$tmp/curl-args" ]
if cat "$root/install.sh" | sh -s -- --revision "$revision" --revision "$revision" >/dev/null 2>&1; then
  echo 'A duplicate revision was accepted.' >&2
  exit 1
fi
if cat "$root/install.sh" | STUB_CURL_FAIL=1 sh -s -- --code "$code" >/dev/null 2>&1; then
  echo 'A failed download was accepted.' >&2
  exit 1
fi
[ ! -e "$tmp/base" ]
[ -z "$(ls -A "$TMPDIR")" ]

if cat "$root/install.sh" | STUB_API=invalid sh -s -- --code "$code" >/dev/null 2>&1; then
  echo 'Invalid release metadata was accepted.' >&2
  exit 1
fi
if cat "$root/install.sh" | STUB_RELEASE='{"sha":"main"}' sh -s -- --code "$code" >/dev/null 2>&1; then
  echo 'An unpinned release was accepted.' >&2
  exit 1
fi

rm "$tmp/curl-args"
python3 - "$root/install.sh" <<'PY'
import os, subprocess, sys
script = open(sys.argv[1], "rb").read()
result = subprocess.run(["sh", "-s", "--", "--revision", "0123456789abcdef0123456789abcdef01234567"], input=script, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
assert result.returncode == 0, result.stderr
assert open(os.path.join(os.environ["TEST_ROOT"], "installer-args")).read().strip() == "--server"
PY

python3 - "$root/install.sh" "$code" <<'PY'
import os, pty, select, sys, time
script = open(sys.argv[1], "rb").read()
code = sys.argv[2].encode()
read_fd, write_fd = os.pipe()
pid, terminal = pty.fork()
if pid == 0:
    os.close(write_fd)
    os.dup2(read_fd, 0)
    os.close(read_fd)
    os.execvp("sh", ["sh", "-s", "--", "--revision", "0123456789abcdef0123456789abcdef01234567", "--code-stdin"])
os.close(read_fd)
os.write(write_fd, script)
os.close(write_fd)
output = b""
deadline = time.monotonic() + 10
sent = False
while time.monotonic() < deadline:
    if not select.select([terminal], [], [], 0.2)[0]:
        continue
    try:
        chunk = os.read(terminal, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    if not sent and b"Installation code: " in output:
        os.write(terminal, code + b"\n")
        sent = True
_, status = os.waitpid(pid, 0)
assert sent and os.waitstatus_to_exitcode(status) == 0, output
assert code not in output
root = os.environ["TEST_ROOT"]
assert open(os.path.join(root, "stdin-code"), "rb").read() == code
args = open(os.path.join(root, "installer-args"), "rb").read()
assert b"--code-stdin" in args and code not in args
PY

printf "ORKBOT_IMAGE_TAG='sha-%s'\n" "$revision" >"$HOME/orkbot/.env"
cat "$root/install.sh" | sh -s -- --revision "$revision"
[ "$(cat "$tmp/installer-args")" = '--server' ]
rm "$tmp/curl-args"
if cat "$root/install.sh" | sh -s -- --revision a008fbde71f5fec493040fdd6c9d38763d2e2f9d >"$tmp/mismatch" 2>&1; then
  echo 'A revision that mismatches the installed image was accepted.' >&2
  exit 1
fi
grep -q 'does not match the installed image version' "$tmp/mismatch"
[ ! -e "$tmp/curl-args" ]
cat "$root/install.sh" | sh -s --
[ "$(cat "$tmp/base")" = "https://raw.githubusercontent.com/orkbot-run/ork/$revision/infra/compose" ]
if grep -q 'api.github.com' "$tmp/curl-args"; then echo 'Resume queried release metadata.' >&2; exit 1; fi
printf '%s\n' 'ORKBOT_IMAGE_TAG=edge' >"$HOME/orkbot/.env"
if cat "$root/install.sh" | sh -s -- >/dev/null 2>&1; then echo 'Unpinned resume was accepted.' >&2; exit 1; fi
cat "$root/install.sh" | sh -s -- --revision "$revision"
[ "$(cat "$tmp/base")" = "https://raw.githubusercontent.com/orkbot-run/ork/$revision/infra/compose" ]
printf '%s\n' "ORKBOT_IMAGE_TAG=sha-$revision" "ORKBOT_IMAGE_TAG=sha-$revision" >"$HOME/orkbot/.env"
if cat "$root/install.sh" | sh -s -- >/dev/null 2>&1; then echo 'Ambiguous resume was accepted.' >&2; exit 1; fi

# Exercise prerequisite installation using isolated commands, without invoking apt or sudo.
mkdir "$tmp/python-bin"
sed -n '/^ensure_python3() {/,/^}$/p' "$root/install.sh" >"$tmp/python-helper"
ln -s "$(command -v awk)" "$tmp/python-bin/awk"
for command in env mktemp cat rm grep; do ln -s "$(command -v "$command")" "$tmp/python-bin/$command"; done
printf '#!/bin/sh\nexit 0\n' >"$tmp/python-bin/sleep"
chmod +x "$tmp/python-bin/sleep"
cat >"$tmp/python-bin/uname" <<'EOF'
#!/bin/sh
printf '%s\n' "${TEST_OS:-Linux}"
EOF
cat >"$tmp/python-bin/id" <<'EOF'
#!/bin/sh
printf '%s\n' "${TEST_UID:-0}"
EOF
cat >"$tmp/python-bin/apt-get" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$TEST_ROOT/apt-calls"
[ "${TEST_APT_FAIL:-0}" != 1 ] || exit 1
if [ "$1" = update ] && [ "${TEST_APT_LOCK:-}" != '' ] && [ ! -e "$TEST_ROOT/apt-unlocked" ]; then
  printf '%s\n' 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 42 (apt-get)' >&2
  if [ "$TEST_APT_LOCK" = mixed ]; then printf '%s\n' 'E: Repository failed' >&2; fi
  [ "$TEST_APT_LOCK" != once ] || : >"$TEST_ROOT/apt-unlocked"
  exit 100
fi
if [ "$1" = -o ] && [ "$2" = DPkg::Lock::Timeout=300 ] && [ "$3" = install ]; then
  printf '#!/bin/sh\nexit 0\n' >"$TEST_ROOT/python-bin/python3"
  /bin/chmod +x "$TEST_ROOT/python-bin/python3"
fi
EOF
cat >"$tmp/python-bin/sudo" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$TEST_ROOT/sudo-calls"
[ "$1" != -v ] || exit 0
exec "$@"
EOF
chmod +x "$tmp/python-bin/uname" "$tmp/python-bin/id" "$tmp/python-bin/apt-get" "$tmp/python-bin/sudo"
printf '%s\n' 'ID=debian' >"$tmp/os-release"
PATH="$tmp/python-bin" /bin/sh -c '. "$1"; ensure_python3 "$2"' _ "$tmp/python-helper" "$tmp/os-release"
[ "$(cat "$tmp/apt-calls")" = "$(printf '%s\n' 'update -qq' '-o DPkg::Lock::Timeout=300 install -y -qq python3')" ]
rm "$tmp/python-bin/python3" "$tmp/apt-calls"
printf '%s\n' 'ID="ubuntu"' >"$tmp/os-release"
TEST_UID=1000 PATH="$tmp/python-bin" /bin/sh -c '. "$1"; ensure_python3 "$2"' _ "$tmp/python-helper" "$tmp/os-release"
[ "$(cat "$tmp/sudo-calls")" = "$(printf '%s\n' '-v' 'env LC_ALL=C apt-get update -qq' 'apt-get -o DPkg::Lock::Timeout=300 install -y -qq python3')" ]
rm "$tmp/python-bin/python3" "$tmp/apt-calls"
printf '%s\n' 'ID=alpine' >"$tmp/os-release"
if PATH="$tmp/python-bin" /bin/sh -c '. "$1"; ensure_python3 "$2"' _ "$tmp/python-helper" "$tmp/os-release" >/dev/null 2>&1; then
  echo 'An unsupported distribution attempted automatic Python installation.' >&2
  exit 1
fi
[ ! -e "$tmp/apt-calls" ]
printf '%s\n' 'ID=debian' >"$tmp/os-release"
if TEST_APT_FAIL=1 PATH="$tmp/python-bin" /bin/sh -c '. "$1"; ensure_python3 "$2"' _ "$tmp/python-helper" "$tmp/os-release" >/dev/null 2>&1; then
  echo 'A failed Python installation was accepted.' >&2
  exit 1
fi
rm -f "$tmp/python-bin/python3" "$tmp/apt-calls" "$tmp/apt-unlocked"
TEST_APT_LOCK=once PATH="$tmp/python-bin" /bin/sh -c '. "$1"; ensure_python3 "$2"' _ "$tmp/python-helper" "$tmp/os-release" >/dev/null 2>&1
[ "$(grep -c '^update -qq$' "$tmp/apt-calls")" -eq 2 ]
rm -f "$tmp/python-bin/python3" "$tmp/apt-calls" "$tmp/apt-unlocked"
if TEST_APT_LOCK=mixed PATH="$tmp/python-bin" /bin/sh -c '. "$1"; ensure_python3 "$2"' _ "$tmp/python-helper" "$tmp/os-release" >/dev/null 2>&1; then
  echo 'An unrelated repository failure was retried or accepted.' >&2; exit 1
fi
[ "$(grep -c '^update -qq$' "$tmp/apt-calls")" -eq 1 ]
echo 'Installer entry point smoke checks passed.'
