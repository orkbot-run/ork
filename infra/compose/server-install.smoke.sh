#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Offline tests only. No installer runs against the host's Docker or package manager.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
bash -n "$root/install-images.sh" "$root/server-install.sh"
PYTHONDONTWRITEBYTECODE=1 python3 "$root/server-install.test.py"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
real_python=$(command -v python3)
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" != *'--help'* ]] || { echo --retry-all-errors; exit 0; }
[[ -z "${ORKBOT_INSTALL_CODE:-}" ]] || { echo "code leaked to downloader" >&2; exit 1; }
out='' url=''
while (($#)); do
  case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
done
name="${url##*/}"
if [[ "$name" == restrict-computer-egress.sh ]]; then
  printf '#!/usr/bin/env bash\nprintf "firewall\\n" >> "$STUB_EVENTS"\nexit "${STUB_EGRESS_FAIL:-0}"\n' > "$out"
else
  cp "$STUB_ROOT/$name" "$out"
fi
STUB
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${ORKBOT_INSTALL_CODE:-}" ]] || { echo "code leaked to Docker" >&2; exit 1; }
hosts=0
for arg in "$@"; do [[ "$arg" != --host ]] || hosts=$((hosts + 1)); done
(( hosts <= 1 )) || { echo 'duplicate Docker host' >&2; exit 1; }
[[ "$1" != --host ]] || shift 2
case "$1" in
  info) [[ "$*" != *OperatingSystem* ]] || echo 'Linux'; [[ "$*" != *SecurityOptions* ]] || echo '[]'; exit 0 ;;
  version) echo 26.1.0; exit 0 ;;
  context) echo unix:///var/run/docker.sock; exit 0 ;;
  ps|volume) exit 0 ;;
esac
case " $* " in
  *' --help '*) echo '--pull --wait-timeout'; exit 0 ;;
  *' version '*) exit 0 ;;
  *' config '*)
    cat >/dev/null || true
    "$STUB_PYTHON" -c 'from pathlib import Path; print("\n".join(line.split("=",1)[0]+"="+line.split("=",1)[1].strip("\047\042") for line in Path(".env").read_text().splitlines() if "=" in line and not line.startswith("#")))'
    exit 0 ;;
  *' pull '*) echo pull >> "$STUB_EVENTS"; exit "${STUB_PULL_FAIL:-0}" ;;
  *' up '*) echo up >> "$STUB_EVENTS"; exit 0 ;;
esac
exit 1
STUB
cat > "$tmp/bin/python3" <<'STUB'
#!/usr/bin/env bash
exec "$STUB_PYTHON" - "$@" <<'PY'
import importlib.util, json, os, sys
spec=importlib.util.spec_from_file_location('installer',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.argv=sys.argv[1:]
module.public_dns=lambda _: None
module.occupied_ports=lambda: False
module.terminal_prompt=lambda _: 'server.example.com'
def request(url,payload=None,bearer=None):
    if url.endswith('/api/installations/progress'):
        assert bearer == 'b'*43
        with open(os.environ['STUB_EVENTS'],'a') as log: log.write('progress-'+payload['phase']+'\n')
        if os.environ.get('STUB_PROGRESS_FAIL'): raise module.SetupError('Status unavailable')
        return {'ok':True}
    with open(os.environ['STUB_EVENTS'],'a') as log: log.write(('redeem' if bearer else 'health')+'\n')
    if bearer:
        return {'url':payload['url'],'issuer':module.ISSUER,'clientId':'fixture-client','clientSecret':'fixture-secret','installationTicketId':'6d2d8377-3af0-4ca8-8c12-ab25ba2f7a6d','reportToken':'b'*43}
    if url.endswith('/rpc/health'): return {'json':{'ok':True,'version':'fixture'}}
    if url.endswith('/health'): return {'ok':True}
    return {'passwordAuth':False,'sso':{'name':'Accounts','availability':'checking' if os.environ.get('STUB_BAD_SSO') else 'available'}}
module.request_json=request
if os.environ.get('STUB_BAD_SSO'):
    ticks=iter([0,181]); module.time.monotonic=lambda: next(ticks)
try: module.main()
except module.SetupError as error:
    print(str(error),file=sys.stderr); sys.exit(1)
PY
STUB
cat > "$tmp/bin/uname" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi
STUB
cat > "$tmp/bin/stat" <<'STUB'
#!/usr/bin/env bash
if [[ "$2" == %h ]]; then echo 1; else echo 700; fi
STUB
cat > "$tmp/bin/timeout" <<'STUB'
#!/usr/bin/env bash
shift 2
exec "$@"
STUB
cat > "$tmp/bin/sudo" <<'STUB'
#!/usr/bin/env bash
exec "$@"
STUB
for name in flock iptables; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/$name"
done
chmod +x "$tmp/bin/"*
export STUB_ROOT="$root" STUB_PYTHON="$real_python"
export PATH="$tmp/bin:$PATH" ORKBOT_DOWNLOAD_BASE=https://installer.example.com/pinned/infra/compose
code=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
run_case() {
  local name="$1"
  shift
  mkdir -p "$tmp/$name"
  export STUB_EVENTS="$tmp/$name/events"
  : > "$STUB_EVENTS"
  local -a installer=(bash "$root/install-images.sh" --server)
  [[ -n "${STUB_SERVER_PROMPT:-}" ]] || installer+=(--url https://server.example.com)
  (cd "$tmp/$name"; "${installer[@]}" "$@") > "$tmp/$name/output" 2>&1
}
run_case fresh --code "$code" || { cat "$tmp/fresh/output"; exit 1; }
grep -q '^Ork is ready at https://server.example.com$' "$tmp/fresh/output"
[[ "$(head -6 "$tmp/fresh/events")" == $'firewall\nredeem\nprogress-preparing\nprogress-pulling\npull\nprogress-starting' ]]
grep -q '^progress-ready$' "$tmp/fresh/events"
! grep -q -e "$code" -e fixture-secret "$tmp/fresh/output"
checksum=$(cksum "$tmp/fresh/.env")
run_case fresh || { cat "$tmp/fresh/output"; exit 1; }
! grep -q '^redeem$' "$tmp/fresh/events"
[[ "$(cksum "$tmp/fresh/.env")" == "$checksum" ]]
if STUB_PULL_FAIL=1 run_case pull-fails --code "$code"; then echo 'pull failure accepted' >&2; exit 1; fi
grep -q '^redeem$' "$tmp/pull-fails/events"
grep -q '^progress-failed$' "$tmp/pull-fails/events"
! grep -q '^up$' "$tmp/pull-fails/events"
! grep -q 'Ork is ready' "$tmp/pull-fails/output"
run_case pull-fails || { cat "$tmp/pull-fails/output"; exit 1; }
! grep -q '^redeem$' "$tmp/pull-fails/events"
grep -q '^progress-ready$' "$tmp/pull-fails/events"
if STUB_EGRESS_FAIL=1 run_case firewall-fails --code "$code"; then echo 'firewall failure accepted' >&2; exit 1; fi
! grep -q -e '^pull$' -e '^redeem$' -e '^up$' "$tmp/firewall-fails/events"
if STUB_BAD_SSO=1 run_case sso-fails --code "$code"; then echo 'unavailable Accounts accepted' >&2; exit 1; fi
! grep -q 'Ork is ready' "$tmp/sso-fails/output"
grep -q '^progress-failed$' "$tmp/sso-fails/events"
printf '%s\n' "$code" | run_case stdin --code-stdin || { cat "$tmp/stdin/output"; exit 1; }
grep -q '^redeem$' "$tmp/stdin/events"
run_case external --external-proxy --code "$code" || { cat "$tmp/external/output"; exit 1; }
[[ ! -e "$tmp/external/docker-compose.https.yml" ]]
run_case cached --pull-never --code "$code" || { cat "$tmp/cached/output"; exit 1; }
! grep -q '^pull$' "$tmp/cached/events"
STUB_SERVER_PROMPT=1 run_case server-domain --code "$code" || { cat "$tmp/server-domain/output"; exit 1; }
grep -q '^progress-ready$' "$tmp/server-domain/events"
STUB_SERVER_PROMPT=1 run_case server-domain || { cat "$tmp/server-domain/output"; exit 1; }
! grep -q '^redeem$' "$tmp/server-domain/events"
STUB_PROGRESS_FAIL=1 run_case status-unavailable --code "$code" || { cat "$tmp/status-unavailable/output"; exit 1; }
grep -q '^Ork is ready at' "$tmp/status-unavailable/output"

ORKBOT_INSTALL_CODE="$code" run_case env-code || { cat "$tmp/env-code/output"; exit 1; }
grep -q "^redeem$" "$tmp/env-code/events"

if DOCKER_CONTEXT=remote DOCKER_HOST=unix:///var/run/docker.sock run_case mixed-context --code "$code"; then
  echo 'mixed Docker context and host accepted' >&2; exit 1
fi
! grep -q -e '^redeem$' -e '^up$' "$tmp/mixed-context/events"

echo 'server installer smoke checks passed.'
