#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Offline installer coverage, with every host path redirected into a temporary tree.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ork-install-backups.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/deploy"
sed -e "s|/etc/orkbot|$tmp/etc/orkbot|g" \
  -e "s|/var/backups/orkbot|$tmp/backups|g" \
  -e "s|/usr/local/sbin|$tmp/sbin|g" \
  -e "s|/etc/systemd/system|$tmp/units|g" "$root/install-images.sh" >"$tmp/installer.sh"
mkdir -p "$tmp/sbin" "$tmp/units"
cp "$root/backup-prod.sh" "$root/backup-drill.sh" "$tmp/deploy/"
cp "$root/../systemd/orkbot-backup.service" "$root/../systemd/orkbot-backup.timer" "$tmp/deploy/"
: >"$tmp/deploy/docker-compose.images.yml"
: >"$tmp/deploy/.env.images.example"
cat >"$tmp/deploy/.env" <<'ENV'
POSTGRES_PASSWORD=fixture-postgres
POSTGRES_APP_PASSWORD=fixture-app-postgres
BETTER_AUTH_SECRET=fixture-auth
ENCRYPTION_KEY=fixture-encryption
SCREEN_PROXY_SECRET=fixture-screen
SANDBOX_SUPERVISOR_TOKEN=fixture-supervisor
OIDC_ISSUER=https://api.ork.run
OIDC_CLIENT_ID=fixture-client
SANDBOX_COMPUTER_EGRESS=open
ENV
cat >"$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *' config '*) cat .env ;;
  *' up --help '*) echo '--pull --wait-timeout' ;;
esac
STUB
cat >"$tmp/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
STUB
printf '#!/usr/bin/env bash\necho Linux\n' >"$tmp/bin/uname"
chmod +x "$tmp/bin/"*
export SYSTEMCTL_LOG="$tmp/systemctl.log"
run() { (cd "$tmp/deploy"; PATH="$tmp/bin:$PATH" bash "$tmp/installer.sh" --offline --install-backups "$@"); }
run --prepare-only >"$tmp/prepared.log" 2>&1 || { cat "$tmp/prepared.log" >&2; exit 1; }
[[ ! -e "$SYSTEMCTL_LOG" && ! -d "$tmp/etc/orkbot" ]]
mv "$tmp/deploy/orkbot-backup.timer" "$tmp/timer"
if run --prepare-only >"$tmp/missing.log" 2>&1; then echo 'missing backup timer was accepted' >&2; exit 1; fi
grep -q -- '--offline requires local orkbot-backup.timer' "$tmp/missing.log"
mv "$tmp/timer" "$tmp/deploy/orkbot-backup.timer"
if [[ "$EUID" == 0 ]]; then
  mkdir -p "$tmp/etc/orkbot"
  printf 'ORKBOT_BACKUP_KEEP=7\n' >"$tmp/etc/orkbot/backup.env"
  run >"$tmp/installed.log" 2>&1 || { cat "$tmp/installed.log" >&2; exit 1; }
  [[ -x "$tmp/sbin/orkbot-backup" && -x "$tmp/sbin/orkbot-backup-drill" ]]
  cmp "$tmp/deploy/orkbot-backup.timer" "$tmp/units/orkbot-backup.timer"
  grep -q '^ORKBOT_BACKUP_KEEP=7$' "$tmp/etc/orkbot/backup.env"
  grep -Fq "ORKBOT_DEPLOY_DIR=\"$tmp/deploy\"" "$tmp/etc/orkbot/backup.env"
  grep -qx 'enable --now orkbot-backup.timer' "$SYSTEMCTL_LOG"
  cp "$tmp/etc/orkbot/backup.env" "$tmp/original.env"
  run >"$tmp/rerun.log" 2>&1 || { cat "$tmp/rerun.log" >&2; exit 1; }
  cmp "$tmp/original.env" "$tmp/etc/orkbot/backup.env"
else
  if run >"$tmp/nonroot.log" 2>&1; then echo 'non-root host installation was accepted' >&2; exit 1; fi
  grep -q -- '--install-backups requires root' "$tmp/nonroot.log"
fi
echo 'image installer backup smoke passed'
