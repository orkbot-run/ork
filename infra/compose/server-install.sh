#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Sourced by install-images.sh, which owns downloads and generated secrets.

server_privileged() {
  if [[ "$EUID" == 0 ]]; then "$@"; else sudo "$@"; fi
}

server_apt_update() {
  local error_file status attempts=0
  error_file=$(mktemp "$server_runtime/apt-update.XXXXXX") || return 1
  while :; do
    if server_privileged env LC_ALL=C apt-get update -qq 2>"$error_file"; then
      cat "$error_file" >&2
      rm -f -- "$error_file"
      return 0
    else
      status=$?
    fi
    # APT's dpkg lock timeout does not cover the separate package-list lock.
    if ! grep -Eq '^E: Could not get lock /var/lib/apt/lists/lock(\. It is held by process [0-9]+ .+| - open \(11: Resource temporarily unavailable\))$' "$error_file" ||
      grep '^E: ' "$error_file" | grep -Evq '^E: (Could not get lock /var/lib/apt/lists/lock|Unable to lock directory /var/lib/apt/lists/)' ||
      (( attempts >= 60 )); then
      cat "$error_file" >&2
      rm -f -- "$error_file"
      return "$status"
    fi
    if (( attempts == 0 )); then
      echo 'Waiting for the package manager to release the package-list lock.' >&2
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
}

server_progress() {
  # Reporting is bounded and never turns a healthy server into a failed installation.
  timeout --foreground 60 python3 "$server_progress_helper" progress "$server_progress_url" "$1" || true
}

server_cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then server_progress failed; fi
  rm -rf -- "$server_runtime"
  cleanup
  return "$result"
}

server_packages() {
  local install_docker=false
  command -v docker >/dev/null 2>&1 || install_docker=true
  if [[ "$install_docker" == false ]] && command -v python3 >/dev/null 2>&1 &&
    command -v openssl >/dev/null 2>&1 && command -v iptables >/dev/null 2>&1; then
    return
  fi
  # Only the root-owned OS release file is sourced, never an operator dotenv file.
  # shellcheck source=/etc/os-release
  source /etc/os-release
  case "${ID:-}" in debian|ubuntu) ;; *) fail "automatic package setup supports Debian and Ubuntu; install Docker 26+, Compose, Python 3, OpenSSL and iptables first." ;; esac
  [[ "${VERSION_CODENAME:-}" =~ ^[a-z][a-z0-9]+$ ]] || fail "the distribution codename is unavailable."
  if [[ "$EUID" != 0 ]]; then
    command -v sudo >/dev/null 2>&1 || fail "package setup requires root or sudo."
    sudo -v || fail "could not obtain sudo access."
  fi
  if [[ "$install_docker" == true ]] && (dpkg-query -W -f='${db:Status-Status}\n' docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc 2>/dev/null || true) | grep -qx installed; then
    fail "conflicting container packages are installed; follow Docker's official package migration guide before retrying."
  fi
  echo "Installing server prerequisites from distribution and Docker repositories."
  server_apt_update
  server_privileged apt-get -o DPkg::Lock::Timeout=300 install -y -qq ca-certificates curl openssl python3 iptables
  if [[ "$install_docker" == true ]]; then
    local source=/etc/apt/sources.list.d/orkbot-docker.sources key=/etc/apt/keyrings/orkbot-docker.asc
    [[ ! -e "$source" && ! -L "$source" && ! -e "$key" && ! -L "$key" ]] || fail "Docker repository files already exist; finish Docker setup manually and rerun."
    # Existing repository and daemon configuration belongs to its operator.
    if compgen -G '/etc/apt/sources.list.d/*docker*' >/dev/null; then
      fail "a Docker repository is already configured; install Docker Engine and its Compose plugin, then rerun."
    fi
    curl_download "https://download.docker.com/linux/${ID}/gpg" "$server_runtime/docker.asc" || fail "could not fetch Docker's repository key."
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: %s\n' \
      "$ID" "$VERSION_CODENAME" "$server_arch" "$key" > "$server_runtime/docker.sources"
    server_privileged install -d -m 0755 /etc/apt/keyrings
    server_privileged install -m 0644 "$server_runtime/docker.asc" "$key"
    server_privileged install -m 0644 "$server_runtime/docker.sources" "$source"
    server_apt_update
    server_privileged apt-get -o DPkg::Lock::Timeout=300 install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    server_privileged systemctl enable --now docker
  fi
}

server_secure_directory() {
  [[ "$EUID" == 0 ]] || fail "server setup requires root; run the installation command with sudo."
  local checked_directory="$PWD" directory_owner directory_mode
  [[ "$checked_directory" == "$(pwd -P)" ]] || fail "the deployment directory must not use symlinks."
  while :; do
    [[ ! -L "$checked_directory" ]] || fail "the deployment directory must not use symlinks."
    directory_owner=$(stat -c %u "$checked_directory") || fail "could not inspect the deployment directory."
    directory_mode=$(stat -c %a "$checked_directory") || fail "could not inspect the deployment directory."
    [[ "$directory_owner" == 0 && "$directory_mode" =~ ^[0-7]+$ ]] && (( (8#$directory_mode & 0022) == 0 )) || fail "the deployment directory and its parents must be owned by root and writable only by root."
    [[ "$checked_directory" != "$PWD" ]] || (( (8#$directory_mode & 0077) == 0 )) || fail "the deployment directory must be private to root."
    [[ "$checked_directory" != / ]] || break
    checked_directory="${checked_directory%/*}"
    [[ -n "$checked_directory" ]] || checked_directory=/
  done
}

server_main() {
  # Codes and the redeem response must never be exposed by shell tracing.
  set +x
  server_secure_directory
  local server_url='' external_proxy=auto read_code=false server_arch
  local code="${server_install_code:-}"
  export -n code
  unset server_install_code ORKBOT_INSTALL_CODE
  # This mode stores credentials in .env; ambient development settings cannot override them.
  unset OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI AUTH_PASSWORD_ENABLED
  unset AUTH_ACCOUNTS_ENABLED ORKBOT_BOOTSTRAP_SECRET SIGNUPS_ENABLED
  unset BETTER_AUTH_URL WEB_ORIGIN API_URL ORKBOT_HOST CADDYFILE_PATH SANDBOX_COMPUTER_EGRESS
  unset POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN
  unset ORKBOT_UPDATER_TOKEN ORKBOT_DEPLOY_DIR ORKBOT_DOCKER_SOCKET ORKBOT_COMPOSE_FILE ORKBOT_UPDATER_IMAGE_TAG COMPOSE_PROJECT_NAME
  while (($#)); do
    case "$1" in
      --server) shift ;;
      --url) (($# >= 2)) || fail "--url requires an HTTPS origin."; server_url="$2"; shift 2 ;;
      --code) (($# >= 2)) || fail "--code requires an installation code."; code="$2"; shift 2 ;;
      --code-stdin) read_code=true; shift ;;
      --external-proxy) external_proxy=true; shift ;;
      --local) skip_existing=true; shift ;;
      --pull-never) pull_never=true; shift ;;
      *) fail "Usage: bash install-images.sh --server [--url https://server.example.com] [--code CODE | --code-stdin] [--external-proxy] [--pull-never]" ;;
    esac
  done
  [[ -z "$server_url" || "$server_url" =~ ^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "--url must be an exact HTTPS origin, without a port, path or trailing slash."
  [[ "$(uname -s)" == Linux ]] || fail "--server requires Linux."
  case "$(uname -m)" in x86_64|amd64) server_arch=amd64 ;; aarch64|arm64) server_arch=arm64 ;; *) fail "--server supports amd64 and arm64." ;; esac
  if [[ "$read_code" == true ]]; then
    IFS= read -r -s code || [[ -n "$code" ]] || fail "no installation code was provided on stdin."
  fi
  [[ -z "$code" || "$code" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "the installation code has an invalid format."
  umask 077
  # Refuse shared working directories and symlinked credentials before downloading or sudo.
  [[ -d . && -O . && ! -L .env ]] || fail "run from an owned installation directory with a regular .env."
  local permissions
  permissions=$(stat -c %a .)
  (( (8#$permissions & 0022) == 0 )) || fail "the installation directory must not be writable by other users."
  [[ ! -L .orkbot-server.lock && ( ! -e .orkbot-server.lock || -f .orkbot-server.lock ) ]] || fail "invalid installation lock."
  if [[ -e .orkbot-server.lock ]]; then
    [[ -O .orkbot-server.lock && "$(stat -c %h .orkbot-server.lock)" == 1 ]] || fail "invalid installation lock ownership."
  fi
  exec 9>>.orkbot-server.lock
  flock -n 9 || fail "another server installation is running in this directory."

  server_packages
  # Use sudo for Docker when the current user has not joined its root-equivalent group.
  local -a server_docker=(docker)
  export ORKBOT_INSTALL_DOCKER_SUDO=0
  if ! command docker info >/dev/null 2>&1; then
    if [[ "$EUID" != 0 ]] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
      server_docker=(sudo docker)
      export ORKBOT_INSTALL_DOCKER_SUDO=1
      docker() { command sudo docker "$@"; }
    else
      fail "Docker Engine is unavailable; start it and rerun."
    fi
  fi
  local endpoint=''
  if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
    [[ -z "${DOCKER_HOST:-}" ]] || fail "choose one Docker context or host before running server setup."
    endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
  else
    endpoint="${DOCKER_HOST:-}"
    [[ -n "$endpoint" ]] || endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
  fi
  [[ "$endpoint" == unix:///* ]] || fail "server setup requires a local Docker Unix socket; remote Docker contexts cannot share this host's firewall."
  # Keep every later shell/Python invocation on this checked socket, even if the active context changes.
  export ORKBOT_INSTALL_DOCKER_HOST="$endpoint"
  server_docker+=(--host "$endpoint")
  if [[ "$ORKBOT_INSTALL_DOCKER_SUDO" == 1 ]]; then
    docker() { command sudo docker --host "$ORKBOT_INSTALL_DOCKER_HOST" "$@"; }
  else
    docker() { command docker --host "$ORKBOT_INSTALL_DOCKER_HOST" "$@"; }
  fi
  local docker_major
  docker_major=$(docker version --format '{{.Server.Version}}')
  [[ "${docker_major%%.*}" =~ ^[0-9]+$ ]] && (( ${docker_major%%.*} >= 26 )) || fail "Docker Engine 26 or newer is required; update the existing installation manually."
  docker compose version >/dev/null 2>&1 || fail "install the Docker Compose plugin and rerun."
  docker compose up --help | grep -q -- '--wait-timeout' || fail "update Docker Compose to a version supporting --wait-timeout."

  curl_download "${DOWNLOAD_BASE}/server-install.py" "$server_runtime/server-install.py" || fail "could not download server configuration support."
  local helper="$server_runtime/server-install.py"
  server_url=$(python3 "$helper" server-url "$server_url") || fail "configure this server's public HTTPS address and retry."
  external_proxy=$(python3 "$helper" proxy-mode "$server_url" "$external_proxy") || fail "existing HTTPS proxy configuration needs attention."
  server_progress_helper="$helper"
  server_progress_url="$server_url"
  trap server_cleanup EXIT
  timeout --foreground 60 python3 "$helper" preflight "$server_url" "$external_proxy" || fail "server preflight failed."
  [[ "$DOWNLOAD_BASE" =~ /[0-9a-f]{40}/infra/compose$ ]] || fail "server setup requires a pinned release; use the Ork installation command."
  # Keep operator files. An installer rerun is a resume, not an implicit upgrade.
  skip_existing=true
  local -a managed_templates=("$COMPOSE_FILE")
  required_files=("$COMPOSE_FILE" "$ENV_EXAMPLE")
  for filename in "${required_files[@]}"; do download "$filename"; done
  compose_files=(-f "$COMPOSE_FILE")
  override_present=''
  if [[ -f "$OVERRIDE_FILE" ]]; then compose_files+=(-f "$OVERRIDE_FILE"); override_present=1; fi
  if [[ "$external_proxy" != true ]]; then
    managed_templates+=(docker-compose.https.yml Caddyfile.prod)
    download docker-compose.https.yml
    download Caddyfile.prod
    python3 "$helper" ip-edge "$server_url" || fail "could not prepare HTTPS for this server."
    compose_files+=(-f docker-compose.https.yml)
  fi
  if [[ ! -e .orkbot-compose-state.json && ! -L .orkbot-compose-state.json ]]; then
    local template
    for template in "${managed_templates[@]}"; do
      curl_download "${DOWNLOAD_BASE}/${template}" "$server_runtime/$template" || fail "could not verify installation templates against the pinned release."
      cmp -s -- "$template" "$server_runtime/$template" || fail "installation templates differ from the pinned release; operator maintenance is required."
    done
    python3 "$helper" record-compose-state "${managed_templates[@]}" || fail "could not record the verified installation templates."
  fi
  python3 "$helper" validate-compose-state "${managed_templates[@]}" || fail "installation templates need operator maintenance before updates can be enabled."
  local created_env=false
  if [[ ! -f .env ]]; then create_env; created_env=true; fi
  export ORKBOT_INSTALL_EXTERNAL_PROXY="$external_proxy"
  if [[ "$created_env" == true ]]; then
    python3 "$helper" pin-images "$DOWNLOAD_BASE" || fail "could not pin the application images."
  elif [[ ! -e .orkbot-server.json ]]; then
    python3 "$helper" resume-initial-pin "$DOWNLOAD_BASE" || fail "could not safely resume image pinning."
  fi
  local configured
  configured=$(timeout --foreground 60 python3 "$helper" configured "$server_url") || fail "existing server configuration needs attention."
  validate_required_secrets

  # Check firewall support before consuming a one-use code.
  local provider
  provider=$(timeout --foreground 60 python3 "$helper" provider "$server_url")
  if [[ "$provider" == docker ]]; then
    local reason
    reason=$(egress_rules_unsupported)
    [[ -z "$reason" ]] || fail "restricted computer egress is unavailable ($reason); fix the host before retrying."
    download "$EGRESS_SCRIPT"
    server_privileged bash "./$EGRESS_SCRIPT" || fail "could not install restricted computer egress; services were not started."
  fi
  # The only process that receives the code performs one bounded HTTPS request.
  ORKBOT_INSTALL_CODE="$code" timeout --foreground 60 python3 "$helper" configure "$server_url" || fail "could not configure Accounts; existing credentials were kept."
  unset code
  server_progress preparing
  local auth_mode
  auth_mode=$(timeout --foreground 60 python3 "$helper" auth-mode "$server_url") || fail "could not validate Accounts configuration."
  if [[ "$auth_mode" == oidc ]]; then validate_accounts_config; fi
  if [[ "$auth_mode" == native ]]; then
    download docker-compose.updates.yml
    compose_files+=(-f docker-compose.updates.yml)
    local updater_files="$COMPOSE_FILE"
    [[ -z "$override_present" ]] || updater_files+=":$OVERRIDE_FILE"
    [[ "$external_proxy" == true ]] || updater_files+=":docker-compose.https.yml"
    updater_files+=":docker-compose.updates.yml"
    python3 "$helper" configure-updates "$DOWNLOAD_BASE" "${endpoint#unix://}" "$updater_files" || fail "could not configure server updates."
  fi
  validate_required_secrets
  if [[ "$pull_never" != true ]]; then
    server_progress pulling
    timeout --foreground 900 "${server_docker[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" pull || fail "image pull failed; credentials were kept. Rerun the same command without --code."
  fi
  if [[ "$auth_mode" == native ]]; then
    timeout --foreground 60 "${server_docker[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" --profile updates-init run --rm --no-deps --pull never -T updates-init || fail "could not initialize private server update configuration."
  fi
  server_progress starting
  timeout --foreground 420 "${server_docker[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" up -d --pull never --wait --wait-timeout 300 || fail "services did not become healthy; existing data and credentials were kept. Rerun the same command without --code."
  server_progress waiting-healthy
  timeout --foreground 210 python3 "$helper" ready "$server_url" || fail "public HTTPS or Accounts is not ready; check DNS, inbound TCP 80/443, proxy settings and service logs, then rerun without --code."
  server_progress ready
  echo "Ork is ready at ${server_url}"
  local initialization
  initialization=$(timeout --foreground 60 python3 "$helper" initialization-required "$server_url") || fail "could not determine the server initialization status."
  if [[ "$auth_mode" == native && "$initialization" == true ]]; then
    timeout --foreground 60 "${server_docker[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" exec -T api node dist/cli/server-claim.js || fail "could not generate server authorization; rerun this installer to try again."
    echo 'If the link or code expires, rerun this installer to get a new one.'
  fi
}
