#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Resolve both deployment layouts without opening Docker or host backup storage.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ork-backup-compose.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/deploy with spaces/infra/compose"
deploy="$tmp/deploy with spaces"
cat >"$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$DOCKER_ARGS"
# Deliberately no running api: resolution must finish before any backup writes.
STUB
chmod +x "$tmp/bin/docker"
: >"$deploy/.env"
run() {
  local output status=0
  output=$(PATH="$tmp/bin:$PATH" DOCKER_ARGS="$tmp/args" ORKBOT_DEPLOY_DIR="$deploy" bash "$root/backup-prod.sh" 2>&1) || status=$?
  [[ $status == 1 && "$output" == *"api service is not running"* ]] || { echo "$output" >&2; exit 1; }
}
files() { awk 'previous == "-f" {print} {previous=$0}' "$tmp/args"; }
: >"$deploy/infra/compose/docker-compose.prod.yml"
run
[[ "$(files)" == "$deploy/infra/compose/docker-compose.prod.yml" ]]
: >"$deploy/docker-compose.images.yml"
: >"$deploy/docker-compose.override.yml"
run
[[ "$(files)" == "$deploy/infra/compose/docker-compose.prod.yml" ]]
rm "$deploy/infra/compose/docker-compose.prod.yml"
run
[[ "$(files)" == "$deploy/docker-compose.images.yml"$'\n'"$deploy/docker-compose.override.yml" ]]
: >"$deploy/custom.yml"
printf "export ORKBOT_COMPOSE_FILE='custom.yml:docker-compose.override.yml'  # updater stack\n" >"$deploy/.env"
run
[[ "$(files)" == "$deploy/custom.yml"$'\n'"$deploy/docker-compose.override.yml" ]]
export ORKBOT_COMPOSE_FILE="docker-compose.images.yml"
run
[[ "$(files)" == "$deploy/docker-compose.images.yml" ]]
export ORKBOT_COMPOSE_FILE="missing.yml"
rm "$tmp/args"
if output=$(run 2>&1); then echo 'missing explicit Compose file accepted' >&2; exit 1; fi
[[ "$output" == *'Compose file is missing or unreadable'* && ! -e "$tmp/args" ]]
unset ORKBOT_COMPOSE_FILE
: >"$deploy/.env"
rm "$deploy/docker-compose.images.yml"
if output=$(run 2>&1); then echo 'missing stack accepted' >&2; exit 1; fi
[[ "$output" == *'No Compose stack found'* && ! -e "$tmp/args" ]]
echo 'backup Compose resolution smoke passed'
