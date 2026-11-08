#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Sourced by install-images.sh, which owns downloads and generated secrets.

server_privileged() {
  if [[ "$EUID" == 0 ]]; then "$@"; else sudo "$@"; fi
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
  server_privileged apt-get update -qq
  server_privileged apt-get install -y -qq ca-certificates curl openssl python3 iptables
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
    server_privileged apt-get update -qq
    server_privileged apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    server_privileged systemctl enable --now docker
  fi
}

server_main() {
  # Codes and the redeem response must never be exposed by shell tracing.
  set +x
  local server_url='' external_proxy=auto read_code=false server_arch
  local code="${server_install_code:-}"
  export -n code
  unset server_install_code ORKBOT_INSTALL_CODE
  # This mode stores credentials in .env; ambient development settings cannot override them.
  unset OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI AUTH_PASSWORD_ENABLED
  unset AUTH_ACCOUNTS_ENABLED ORKBOT_BOOTSTRAP_SECRET SIGNUPS_ENABLED
  unset BETTER_AUTH_URL WEB_ORIGIN API_URL ORKBOT_HOST SANDBOX_COMPUTER_EGRESS
  unset POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN
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
  server_url=$(python3 "$helper" server-url "$server_url") || fail "configure this server's public HTTPS domain and retry."
  external_proxy=$(python3 "$helper" proxy-mode "$server_url" "$external_proxy") || fail "existing HTTPS proxy configuration needs attention."
  server_progress_helper="$helper"
  server_progress_url="$server_url"
  trap server_cleanup EXIT
  timeout --foreground 60 python3 "$helper" preflight "$server_url" "$external_proxy" || fail "server preflight failed."
  # Keep operator files. An installer rerun is a resume, not an implicit upgrade.
  skip_existing=true
  required_files=("$COMPOSE_FILE" "$ENV_EXAMPLE")
  for filename in "${required_files[@]}"; do download "$filename"; done
  compose_files=(-f "$COMPOSE_FILE")
  override_present=''
  if [[ -f "$OVERRIDE_FILE" ]]; then compose_files+=(-f "$OVERRIDE_FILE"); override_present=1; fi
  if [[ "$external_proxy" != true ]]; then
    download docker-compose.https.yml
    download Caddyfile.prod
    compose_files+=(-f docker-compose.https.yml)
  fi
  local created_env=false
  if [[ ! -f .env ]]; then create_env; created_env=true; fi
  export ORKBOT_INSTALL_EXTERNAL_PROXY="$external_proxy"
  if [[ "$created_env" == true ]]; then
    python3 "$helper" pin-images "$DOWNLOAD_BASE" || fail "could not pin the application images."
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
  validate_required_secrets
  if [[ "$pull_never" != true ]]; then
    server_progress pulling
    timeout --foreground 900 "${server_docker[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" pull || fail "image pull failed; credentials were kept. Rerun the same command without --code."
  fi
  server_progress starting
  timeout --foreground 420 "${server_docker[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" up -d --pull never --wait --wait-timeout 300 || fail "services did not become healthy; existing data and credentials were kept. Rerun the same command without --code."
  server_progress waiting-healthy
  timeout --foreground 210 python3 "$helper" ready "$server_url" || fail "public HTTPS or Accounts is not ready; check DNS, inbound TCP 80/443, proxy settings and service logs, then rerun without --code."
  server_progress ready
  echo "Ork is ready at ${server_url}"
  local initialization
  initialization=$(timeout --foreground 60 python3 "$helper" initialization-link "$server_url") || fail "could not determine the server initialization status."
  if [[ -n "$initialization" ]]; then
    printf '%s\n' "$initialization"
  fi
  if [[ "$auth_mode" == native && -n "$initialization" ]]; then
    echo 'If you cannot open the authorization link, generate a code on this server with:'
    if [[ "$ORKBOT_INSTALL_DOCKER_SUDO" == 1 ]]; then printf 'sudo '; fi
    echo 'docker compose -f docker-compose.images.yml exec -T api node dist/cli/server-claim.js'
  fi
}
