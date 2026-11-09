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

# Exercise only the package-list lock retry, without using the host package manager.
test_apt_update() (
  local scenario="$1" calls=0
  server_runtime="$tmp/apt-$scenario"
  mkdir -p "$server_runtime"
  source "$root/server-install.sh"
  server_privileged() {
    [[ "$*" == 'env LC_ALL=C apt-get update -qq' ]] || return 1
    calls=$((calls + 1))
    printf '%s\n' "$calls" >> "$server_runtime/calls"
    case "$scenario:$calls" in
      released:1|timeout:*|mixed:1)
        echo 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 42 (apt-get)' >&2
        echo 'E: Unable to lock directory /var/lib/apt/lists/' >&2
        [[ "$scenario" != mixed ]] || echo 'E: Repository signature is invalid' >&2
        return 100 ;;
      old-format:1)
        echo 'E: Could not get lock /var/lib/apt/lists/lock - open (11: Resource temporarily unavailable)' >&2
        echo 'E: Unable to lock directory /var/lib/apt/lists/' >&2
        return 100 ;;
      network:*) echo 'E: Repository signature is invalid' >&2; return 100 ;;
      *) echo 'W: Partial mirror failure' >&2 ;;
    esac
  }
  sleep() { [[ "$1" == 5 ]]; }
  if server_apt_update > "$server_runtime/output" 2>&1; then
    [[ "$scenario" == released || "$scenario" == old-format ]]
    [[ "$calls" == 2 ]]
    grep -q 'Waiting for the package manager' "$server_runtime/output"
    grep -q 'Partial mirror failure' "$server_runtime/output"
  else
    [[ "$scenario" == timeout || "$scenario" == network || "$scenario" == mixed ]]
    if [[ "$scenario" == timeout ]]; then
      [[ "$calls" == 61 ]]
      grep -q 'Could not get lock' "$server_runtime/output"
    else
      [[ "$calls" == 1 ]]
      grep -q 'Repository signature is invalid' "$server_runtime/output"
    fi
  fi
)
for scenario in released old-format timeout network mixed; do test_apt_update "$scenario"; done
if [[ "$EUID" != 0 ]]; then
  if ( source "$root/server-install.sh"; fail() { exit 1; }; server_secure_directory ) 2>/dev/null; then
    echo 'An unprivileged server installer was accepted.' >&2; exit 1
  fi
fi

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
  if [[ "$name" == server-install.sh ]]; then
    printf '\nserver_secure_directory() { :; }\n' >> "$out"
  fi
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
if [[ -f docker-compose.override.yml && ( " $* " == *' pull '* || " $* " == *' up '* ) && " $* " != *' --help '* && " $* " != *' -f docker-compose.override.yml '* ]]; then
  echo 'operator override omitted' >&2; exit 1
fi
case " $* " in
  *' --help '*) echo '--pull --wait-timeout'; exit 0 ;;
  *' version '*) exit 0 ;;
  *' config '*)
    cat >/dev/null || true
    "$STUB_PYTHON" -c 'from pathlib import Path; print("\n".join(line.split("=",1)[0]+"="+line.split("=",1)[1].strip("\047\042") for line in Path(".env").read_text().splitlines() if "=" in line and not line.startswith("#")))'
    exit 0 ;;
  *' pull '*) echo pull >> "$STUB_EVENTS"; exit "${STUB_PULL_FAIL:-0}" ;;
  *' run --rm --no-deps --pull never -T updates-init '*) echo updates-init >> "$STUB_EVENTS"; exit 0 ;;
  *' exec -T api node dist/cli/server-claim.js '*)
    echo claim >> "$STUB_EVENTS"
    [[ "${STUB_CLAIM_FAIL:-0}" == 0 ]] || exit 1
    printf 'Open this link to authorize the server:\nhttps://accounts.ork.run/account/connect-server#code=23456789AB\n\nOr enter this code at https://accounts.ork.run/account/connect-server:\n23456789AB\n'
    exit 0 ;;
  *' up '*)
    echo up >> "$STUB_EVENTS"
    if [[ "${STUB_UP_FAIL:-0}" != 0 ]]; then
      printf '%s\n' "${STUB_UP_PHASE:-services} failed" >&2
      exit "$STUB_UP_FAIL"
    fi
    exit 0 ;;
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
module.detect_public_ipv4=lambda: '8.8.8.8'
def request(url,payload=None,bearer=None):
    if url.endswith('/api/installations/progress'):
        assert bearer == 'b'*43
        with open(os.environ['STUB_EVENTS'],'a') as log: log.write('progress-'+payload['phase']+'\n')
        if os.environ.get('STUB_PROGRESS_FAIL'): raise module.SetupError('Status unavailable')
        return {'ok':True}
    with open(os.environ['STUB_EVENTS'],'a') as log: log.write(('redeem' if bearer else 'health')+'\n')
    if bearer:
        return {'url':payload['url'],'issuer':module.ISSUER,'clientId':'fixture-client','clientSecret':'fixture-secret','installationTicketId':'6d2d8377-3af0-4ca8-8c12-ab25ba2f7a6d','reportToken':'b'*43}
    if url.endswith('/api/auth/native/initialization'): return {'required': not bool(os.environ.get('STUB_ALREADY_INITIALIZED'))}
    if url.endswith('/api/auth/native/challenge'): return {'bootstrapRequired': not bool(os.environ.get('STUB_ALREADY_CLAIMED'))}
    if url.endswith('/api/auth/jwks'): return {'keys':[{'kty':'RSA'}]}
    if url.endswith('/rpc/health'): return {'json':{'ok':True,'version':'fixture'}}
    if url.endswith('/health'): return {'ok':True}
    if os.environ.get('STUB_NATIVE_ACCOUNTS'): return {'passwordAuth':False,'accountsLogin':True,'sso':None}
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
export PATH="$tmp/bin:$PATH" ORKBOT_DOWNLOAD_BASE=https://installer.example.com/0123456789abcdef0123456789abcdef01234567/infra/compose
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
if ORKBOT_DOWNLOAD_BASE=https://installer.example.com/main/infra/compose run_case unpinned; then
  echo 'An unpinned new server installation was accepted.' >&2; exit 1
fi
grep -q 'server setup requires a pinned release' "$tmp/unpinned/output"
[[ ! -e "$tmp/unpinned/.env" ]]
run_case fresh --code "$code" || { cat "$tmp/fresh/output"; exit 1; }
grep -q '^Ork is ready at https://server.example.com$' "$tmp/fresh/output"
[[ "$(head -6 "$tmp/fresh/events")" == $'firewall\nredeem\nprogress-preparing\nprogress-pulling\npull\nprogress-starting' ]]
grep -q '^progress-ready$' "$tmp/fresh/events"
! grep -q -e "$code" -e fixture-secret "$tmp/fresh/output"
checksum=$(cksum "$tmp/fresh/.env")
run_case fresh || { cat "$tmp/fresh/output"; exit 1; }
! grep -q '^redeem$' "$tmp/fresh/events"
[[ "$(cksum "$tmp/fresh/.env")" == "$checksum" ]]
STUB_NATIVE_ACCOUNTS=1 run_case native || { cat "$tmp/native/output"; exit 1; }
grep -q '^Ork is ready at https://server.example.com$' "$tmp/native/output"
grep -q '^https://accounts.ork.run/account/connect-server#code=23456789AB$' "$tmp/native/output"
grep -q '^23456789AB$' "$tmp/native/output"
grep -q '^claim$' "$tmp/native/events"
grep -q '^updates-init$' "$tmp/native/events"
grep -q '^ORKBOT_UPDATER_TOKEN=' "$tmp/native/.env"
grep -q '^ORKBOT_COMPOSE_FILE=.*docker-compose.updates.yml' "$tmp/native/.env"
[[ -f "$tmp/native/.orkbot-compose-state.json" ]]
! grep -q 'orkbot://initialize?' "$tmp/native/output"
grep -q '^AUTH_ACCOUNTS_ENABLED=' "$tmp/native/.env"
grep -q '^ORKBOT_BOOTSTRAP_SECRET=' "$tmp/native/.env"
! grep -q '^redeem$' "$tmp/native/events"
cp -R "$tmp/native" "$tmp/modified-template"
rm "$tmp/modified-template/.orkbot-compose-state.json"
printf '\n# changed by the operator\n' >> "$tmp/modified-template/docker-compose.images.yml"
if STUB_NATIVE_ACCOUNTS=1 run_case modified-template; then echo 'Modified untracked templates were accepted' >&2; exit 1; fi
grep -q 'templates differ from the pinned release' "$tmp/modified-template/output"
! grep -q -e '^updates-init$' -e '^up$' "$tmp/modified-template/events"
rm "$tmp/native/.orkbot-compose-state.json" "$tmp/native/.orkbot-server.json"
"$real_python" - "$tmp/native/.env" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
content = path.read_text()
content = re.sub(r"(?m)^(ORKBOT_(?:COMPUTER_)?IMAGE_TAG)=.*$", r"\1=edge", content)
path.write_text(content)
PY
STUB_NATIVE_ACCOUNTS=1 STUB_ALREADY_INITIALIZED=1 run_case native || { cat "$tmp/native/output"; exit 1; }
grep -q "^ORKBOT_IMAGE_TAG='sha-0123456789abcdef0123456789abcdef01234567'" "$tmp/native/.env"
[[ -f "$tmp/native/.orkbot-compose-state.json" ]]
grep -q '^updates-init$' "$tmp/native/events"
native_before=$(cksum "$tmp/native/.env")
STUB_NATIVE_ACCOUNTS=1 STUB_ALREADY_INITIALIZED=1 run_case native || { cat "$tmp/native/output"; exit 1; }
! grep -q '^claim$' "$tmp/native/events"
! grep -q '^redeem$' "$tmp/native/events"
[[ "$(cksum "$tmp/native/.env")" == "$native_before" ]]
STUB_NATIVE_ACCOUNTS=1 STUB_ALREADY_CLAIMED=1 run_case native || { cat "$tmp/native/output"; exit 1; }
! grep -q '^claim$' "$tmp/native/events"
if STUB_NATIVE_ACCOUNTS=1 STUB_CLAIM_FAIL=1 run_case claim-fails; then echo 'claim failure accepted' >&2; exit 1; fi
grep -q 'could not generate server authorization' "$tmp/claim-fails/output"
if STUB_PULL_FAIL=1 run_case pull-fails --code "$code"; then echo 'pull failure accepted' >&2; exit 1; fi
grep -q '^redeem$' "$tmp/pull-fails/events"
grep -q '^progress-failed$' "$tmp/pull-fails/events"
! grep -q '^up$' "$tmp/pull-fails/events"
! grep -q 'Ork is ready' "$tmp/pull-fails/output"
run_case pull-fails || { cat "$tmp/pull-fails/output"; exit 1; }
! grep -q '^redeem$' "$tmp/pull-fails/events"
grep -q '^progress-ready$' "$tmp/pull-fails/events"
# Compose reports migration failure or unhealthy services through the same nonzero boundary.
for phase in migration health; do
  if STUB_UP_FAIL=1 STUB_UP_PHASE="$phase" run_case "$phase-fails" --code "$code"; then
    echo "$phase failure accepted" >&2; exit 1
  fi
  grep -q '^up$' "$tmp/$phase-fails/events"
  grep -q '^progress-failed$' "$tmp/$phase-fails/events"
  ! grep -q -e '^progress-ready$' -e '^health$' "$tmp/$phase-fails/events"
  ! grep -q 'Ork is ready' "$tmp/$phase-fails/output"
  grep -q 'Rerun the same command without --code' "$tmp/$phase-fails/output"
  before=$(cksum "$tmp/$phase-fails/.env")
  state_before=$(cksum "$tmp/$phase-fails/.orkbot-server.json")
  run_case "$phase-fails" || { cat "$tmp/$phase-fails/output"; exit 1; }
  ! grep -q '^redeem$' "$tmp/$phase-fails/events"
  [[ "$(cksum "$tmp/$phase-fails/.env")" == "$before" ]]
  [[ "$(cksum "$tmp/$phase-fails/.orkbot-server.json")" == "$state_before" ]]
  grep -q '^progress-ready$' "$tmp/$phase-fails/events"
done
if STUB_EGRESS_FAIL=1 run_case firewall-fails --code "$code"; then echo 'firewall failure accepted' >&2; exit 1; fi
! grep -q -e '^pull$' -e '^redeem$' -e '^up$' "$tmp/firewall-fails/events"
if STUB_BAD_SSO=1 run_case sso-fails --code "$code"; then echo 'unavailable Accounts accepted' >&2; exit 1; fi
! grep -q 'Ork is ready' "$tmp/sso-fails/output"
grep -q '^progress-failed$' "$tmp/sso-fails/events"
printf '%s\n' "$code" | run_case stdin --code-stdin || { cat "$tmp/stdin/output"; exit 1; }
grep -q '^redeem$' "$tmp/stdin/events"
run_case external --external-proxy --code "$code" || { cat "$tmp/external/output"; exit 1; }
[[ ! -e "$tmp/external/docker-compose.https.yml" ]]
# Saved external-proxy mode and operator files survive an unattended rerun.
printf '# operator override\nservices: {}\n' > "$tmp/external/docker-compose.override.yml"
printf 'operator data sentinel\n' > "$tmp/external/data-sentinel"
external_before=$(cksum "$tmp/external/.env")
external_state_before=$(cksum "$tmp/external/.orkbot-server.json")
external_override_before=$(cksum "$tmp/external/docker-compose.override.yml")
external_compose_before=$(cksum "$tmp/external/docker-compose.images.yml")
STUB_SERVER_PROMPT=1 run_case external || { cat "$tmp/external/output"; exit 1; }
! grep -q '^redeem$' "$tmp/external/events"
[[ "$(cksum "$tmp/external/.env")" == "$external_before" ]]
[[ "$(cksum "$tmp/external/.orkbot-server.json")" == "$external_state_before" ]]
[[ "$(cksum "$tmp/external/docker-compose.override.yml")" == "$external_override_before" ]]
[[ "$(cksum "$tmp/external/docker-compose.images.yml")" == "$external_compose_before" ]]
[[ ! -e "$tmp/external/docker-compose.https.yml" ]]
grep -q '^operator data sentinel$' "$tmp/external/data-sentinel"
grep -q '^progress-ready$' "$tmp/external/events"
run_case cached --pull-never --code "$code" || { cat "$tmp/cached/output"; exit 1; }
! grep -q '^pull$' "$tmp/cached/events"
STUB_SERVER_PROMPT=1 run_case server-domain --code "$code" || { cat "$tmp/server-domain/output"; exit 1; }
grep -q '^Ork is ready at https://8.8.8.8$' "$tmp/server-domain/output"
grep -q "^CADDYFILE_PATH='./Caddyfile.ip.prod'$" "$tmp/server-domain/.env"
grep -q 'profile shortlived' "$tmp/server-domain/Caddyfile.ip.prod"
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
