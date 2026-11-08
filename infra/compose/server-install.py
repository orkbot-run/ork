#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Bounded Accounts enrollment and readiness checks for the Linux installer."""

import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ISSUER = "https://api.orkbot.run"
MAX_RESPONSE = 65536
ENV = Path(".env")
STATE = Path(".orkbot-server.json")
INSTALLATION = Path(".orkbot-installation.json")
PHASES = ("preparing", "pulling", "starting", "waiting-healthy", "ready", "failed")
SECRETS = (
    "POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY",
    "SCREEN_PROXY_SECRET", "SANDBOX_SUPERVISOR_TOKEN",
)


class SetupError(Exception):
    """An error whose message contains no credentials or remote response body."""


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    hostname = parsed.hostname or ""
    labels = hostname.split(".")
    if (parsed.scheme != "https" or parsed.netloc != hostname or parsed.path or
            parsed.query or parsed.fragment or len(hostname) > 253 or len(labels) < 2 or
            any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)):
        raise SetupError("Use an exact HTTPS origin with a DNS hostname and no port or path.")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return hostname
    raise SetupError("A public DNS hostname is required for automatic HTTPS.")


def regular(path, private=False):
    if not path.exists() and not path.is_symlink():
        return
    details = path.lstat()
    if (not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or
            details.st_uid != os.geteuid() or (private and details.st_mode & 0o077)):
        raise SetupError("Installation files must be owned regular files; credentials must have mode 600.")


def docker(*args):
    prefix = ["sudo", "docker"] if os.environ.get("ORKBOT_INSTALL_DOCKER_SUDO") == "1" else ["docker"]
    endpoint = os.environ.get("ORKBOT_INSTALL_DOCKER_HOST")
    if endpoint:
        prefix.extend(["--host", endpoint])
    try:
        result = subprocess.run(prefix + list(args), check=True, capture_output=True, text=True, timeout=30)
        return result.stdout
    except (subprocess.SubprocessError, OSError):
        raise SetupError("Could not inspect the existing Docker configuration.") from None


def environment():
    regular(ENV, private=True)
    if not ENV.exists():
        return {}
    output = docker("compose", "--env-file", str(ENV), "-f", "docker-compose.images.yml", "config", "--environment")
    return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)


def configured(url, env):
    if env.get("COMPOSE_PROJECT_NAME", "orkbot") != "orkbot":
        raise SetupError("The server installer cannot adopt a custom Compose project; keep using its existing commands.")
    client, secret = env.get("OIDC_CLIENT_ID", ""), env.get("OIDC_CLIENT_SECRET", "")
    if bool(client.strip()) != bool(secret.strip()):
        raise SetupError("The existing Accounts client is incomplete; keep its credentials and finish its server configuration manually.")
    if not client.strip():
        if env.get("AUTH_ACCOUNTS_ENABLED") != "true":
            return False
        bootstrap = env.get("ORKBOT_BOOTSTRAP_SECRET", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", bootstrap):
            raise SetupError("Existing native Accounts configuration is missing its initialization secret.")
        if env.get("OIDC_ISSUER", "") not in ("", ISSUER):
            raise SetupError("The existing Accounts issuer is invalid; its settings were kept.")
        if env.get("OIDC_REDIRECT_URI", ""):
            raise SetupError("Native Accounts cannot use an OIDC callback; keep the existing settings and resolve the conflict.")
        if any(env.get(key) != url for key in ("BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL")):
            if STATE.exists() or any(
                env.get(key, "") not in ("", "http://127.0.0.1:5173", url)
                for key in ("BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL")
            ):
                raise SetupError("The existing installation belongs to another URL; its settings were kept.")
            return False
        if env.get("AUTH_PASSWORD_ENABLED", "") not in ("", "false") or env.get("SIGNUPS_ENABLED") != "false":
            raise SetupError("Native Accounts settings are inconsistent; existing configuration was kept.")
        return True
    if env.get("OIDC_ISSUER") != ISSUER or any(env.get(key) != url for key in ("BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL")):
        raise SetupError("The existing installation belongs to another URL or issuer; its settings were kept.")
    if env.get("OIDC_REDIRECT_URI", "") not in ("", url + "/api/auth/callback/oidc"):
        raise SetupError("The existing Accounts callback does not match this server URL.")
    return True


def public_dns(hostname):
    try:
        addresses = {row[4][0] for row in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)}
    except OSError:
        raise SetupError("The server hostname does not resolve; configure its public DNS first.") from None
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise SetupError("Every DNS address for this server must be public.")


def occupied_ports():
    for name in ("tcp", "tcp6", "udp", "udp6"):
        path = Path("/proc/net") / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines()[1:]:
            fields = line.split()
            port = int(fields[1].rsplit(":", 1)[1], 16)
            if (name.startswith("tcp") and fields[3] == "0A" and port in (80, 443)) or (name.startswith("udp") and port == 443):
                return True
    return False


def saved_settings():
    regular(STATE, private=True)
    if not STATE.exists():
        return None
    try:
        saved = json.loads(STATE.read_text())
        if (not isinstance(saved, dict) or set(saved) != {"url", "externalProxy"} or
                not isinstance(saved.get("url"), str) or not isinstance(saved.get("externalProxy"), bool)):
            raise ValueError()
        origin(saved["url"])
        return saved
    except (ValueError, KeyError, TypeError):
        raise SetupError("The saved server installation state is invalid.") from None


def terminal_prompt(message):
    try:
        with open("/dev/tty", "r") as reader, open("/dev/tty", "w") as writer:
            writer.write(message)
            writer.flush()
            value = reader.readline(1025)
            if not value or len(value) > 1024:
                raise SetupError("No server configuration was entered.")
            return value.strip()
    except OSError:
        raise SetupError("Run this command in a server terminal, or provide --url and --external-proxy when needed.") from None


def server_url(value):
    if value:
        origin(value)
        return value
    saved = saved_settings()
    if saved:
        return saved["url"]
    value = terminal_prompt("Server domain (for example ork.example.com): ")
    if not value.startswith("https://"):
        value = "https://" + value
    origin(value)
    return value


def proxy_mode(url, mode):
    if mode not in ("true", "auto"):
        raise SetupError("Invalid proxy configuration.")
    saved = saved_settings()
    if saved:
        if saved["url"] != url or (mode == "true" and not saved["externalProxy"]):
            raise SetupError("Keep the existing URL and proxy mode when resuming this installation.")
        return saved["externalProxy"]
    if mode == "true":
        return True
    if not occupied_ports():
        return False
    answer = terminal_prompt("Ports 80 or 443 are in use. Use your existing HTTPS proxy? [y/N]: ")
    if answer.lower() not in ("y", "yes"):
        raise SetupError("Keep the existing proxy; configure it or free ports 80 and 443 before retrying.")
    print("Route " + url + " through your HTTPS proxy to 127.0.0.1:5173. Keep the API and supervisor ports private.", file=sys.stderr)
    return True


def preflight(url, external):
    hostname = origin(url)
    regular(ENV, private=True)
    for name in ("docker-compose.images.yml", ".env.images.example", "docker-compose.override.yml", "docker-compose.https.yml", "Caddyfile.prod", "restrict-computer-egress.sh"):
        regular(Path(name))
    regular(STATE, private=True)
    regular(INSTALLATION, private=True)
    if STATE.exists():
        try:
            saved = json.loads(STATE.read_text())
        except (ValueError, OSError):
            raise SetupError("The saved server installation state is invalid.") from None
        if saved != {"url": url, "externalProxy": external}:
            raise SetupError("Keep the existing URL and proxy mode when resuming this installation.")
    # Never adopt another Compose project's database using newly generated secrets.
    directories = docker("ps", "-a", "--filter", "label=com.docker.compose.project=orkbot", "--format", '{{.Label "com.docker.compose.project.working_dir"}}').splitlines()
    if any(directory != str(Path.cwd()) for directory in directories):
        raise SetupError("Another Ork Compose installation already uses this Docker host; use its installation directory.")
    if not ENV.exists() and docker("volume", "ls", "--filter", "label=com.docker.compose.project=orkbot", "-q").strip():
        raise SetupError("Existing Ork volumes need their original .env; restore it before continuing.")
    if shutil.disk_usage(".").free < 5 * 1024 ** 3:
        raise SetupError("At least 5 GiB of free disk space is required before pulling server images.")
    public_dns(hostname)
    if not external and occupied_ports() and not STATE.exists():
        raise SetupError("Ports 80 or 443 are occupied; configure the existing proxy and use --external-proxy.")


def atomic(path, content):
    regular(path, private=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=".")
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(".", os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_environment(values):
    content = ENV.read_text()
    replaced = set()
    lines = []
    for line in content.splitlines():
        match = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=", line)
        key = match.group(1) if match else None
        if key in values:
            if key not in replaced:
                # Single-quoted dotenv values are literal, including Compose's dollar interpolation.
                lines.append(key + "='" + values[key] + "'")
                replaced.add(key)
        else:
            lines.append(line)
    for key, value in values.items():
        if key not in replaced:
            lines.append(key + "='" + value + "'")
    atomic(ENV, "\n".join(lines) + "\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request_json(url, payload=None, bearer=None):
    headers = {"Accept": "application/json", "User-Agent": "Ork-Server-Installer", "Cache-Control": "no-store"}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            if response.status != 200:
                raise SetupError("The server returned an unexpected HTTP status.")
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise SetupError("The server response exceeded the allowed size.")
            return json.loads(body)
    except (urllib.error.URLError, OSError, ValueError):
        raise SetupError("The HTTPS request failed or returned an invalid response.") from None


def safe_credential(value):
    # Prevent dotenv/Compose injection and unreasonable credential sizes without narrowing to one vendor's encoding.
    return isinstance(value, str) and 1 <= len(value) <= 4096 and all(33 <= ord(char) <= 126 and char not in "'\\" for char in value)


def configure(url):
    code = os.environ.pop("ORKBOT_INSTALL_CODE", "")
    env = environment()
    hostname = origin(url)
    values = {}
    ticket, token = None, None
    already_configured = configured(url, env)
    if not already_configured and code and env.get("AUTH_ACCOUNTS_ENABLED") != "true":
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", code):
            raise SetupError("Invalid installation code.")
        # Exactly one request. An ambiguous transport failure requires a newly issued code.
        result = request_json(ISSUER + "/api/installations/redeem", {"url": url}, code)
        if (not isinstance(result, dict) or result.get("url") != url or result.get("issuer") != ISSUER or
                not safe_credential(result.get("clientId")) or not safe_credential(result.get("clientSecret"))):
            raise SetupError("Accounts returned an invalid installation configuration.")
        ticket, token = result.get("installationTicketId"), result.get("reportToken")
        if ticket is not None or token is not None:
            if (not isinstance(ticket, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", ticket) or
                    not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token)):
                raise SetupError("Accounts returned an invalid installation status credential.")
        values.update(OIDC_ISSUER=ISSUER, OIDC_CLIENT_ID=result["clientId"], OIDC_CLIENT_SECRET=result["clientSecret"])
    elif not already_configured:
        if env.get("AUTH_ACCOUNTS_ENABLED") != "true" or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}", env.get("ORKBOT_BOOTSTRAP_SECRET", "")
        ):
            raise SetupError("Existing configuration cannot be initialized automatically; keep the original credentials.")
        values.update(AUTH_ACCOUNTS_ENABLED="true", SIGNUPS_ENABLED="false", OIDC_REDIRECT_URI="")
    values.update({
        "BETTER_AUTH_URL": url, "WEB_ORIGIN": url, "API_URL": url, "ORKBOT_HOST": hostname,
        "AUTH_PASSWORD_ENABLED": "false",
    })
    if env.get("OIDC_CLIENT_ID") or values.get("OIDC_CLIENT_ID"):
        values["OIDC_REDIRECT_URI"] = url + "/api/auth/callback/oidc"
    if env.get("SANDBOX_PROVIDER", "docker") == "docker":
        values["SANDBOX_COMPUTER_EGRESS"] = "restricted"
    write_environment(values)
    state = {"url": url, "externalProxy": os.environ.get("ORKBOT_INSTALL_EXTERNAL_PROXY") == "true"}
    atomic(STATE, json.dumps(state) + "\n")
    if ticket is not None:
        atomic(INSTALLATION, json.dumps({"url": url, "installationTicketId": ticket, "reportToken": token}) + "\n")


def progress(url, phase):
    if phase not in PHASES:
        raise SetupError("Invalid installation phase.")
    regular(INSTALLATION, private=True)
    if not INSTALLATION.exists():
        return
    try:
        value = json.loads(INSTALLATION.read_text())
        if (not isinstance(value, dict) or value.get("url") != url or
                not isinstance(value.get("reportToken"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value["reportToken"]) or
                not isinstance(value.get("installationTicketId"), str) or
                not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value["installationTicketId"])):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise SetupError("The saved installation status credential is invalid.") from None
    for attempt in range(3 if phase == "ready" else 1):
        try:
            request_json(ISSUER + "/api/installations/progress", {"phase": phase}, value["reportToken"])
            return
        except SetupError:
            if phase == "ready" and attempt < 2:
                time.sleep(attempt + 1)
    print("Could not update Accounts installation status; the server configuration was kept.", file=sys.stderr)


def ready(url):
    deadline = time.monotonic() + 180
    while True:
        try:
            public_dns(origin(url))
            rpc = request_json(url + "/rpc/health", {"json": {}})
            capabilities = request_json(url + "/api/auth/capabilities")
            if (not isinstance(rpc, dict) or not isinstance(rpc.get("json"), dict) or rpc["json"].get("ok") is not True or
                    not isinstance(rpc["json"].get("version"), str) or not isinstance(capabilities, dict)):
                raise SetupError("The public origin did not respond like an Ork server.")
            sso = capabilities.get("sso")
            legacy_available = (isinstance(sso, dict) and isinstance(sso.get("name"), str) and
                                bool(sso["name"].strip()) and sso.get("availability") == "available")
            if capabilities.get("passwordAuth") is not False or not (capabilities.get("accountsLogin") is True or legacy_available):
                raise SetupError("Accounts sign-in is not available yet.")
            if capabilities.get("accountsLogin") is True:
                keys = request_json(ISSUER + "/api/auth/jwks")
                if not isinstance(keys, dict) or not isinstance(keys.get("keys"), list) or not keys["keys"]:
                    raise SetupError("Accounts signing keys are not available yet.")
            return
        except SetupError:
            if time.monotonic() >= deadline:
                raise SetupError("Public HTTPS, API health and Accounts did not become ready in time.") from None
            time.sleep(3)


def pin_images(base):
    match = re.search(r"/([0-9a-f]{40})/infra/compose$", base)
    if not match:
        return
    values = {}
    for key in ("ORKBOT_IMAGE_TAG", "ORKBOT_COMPUTER_IMAGE_TAG"):
        value = os.environ.get(key) or "sha-" + match.group(1)
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", value):
            raise SetupError("The configured image tag is invalid.")
        values[key] = value
    # Explicit mirror image names remain untouched, as do all pre-existing .env files.
    write_environment(values)


def initialization_required(url):
    env = environment()
    if env.get("AUTH_ACCOUNTS_ENABLED") != "true" or env.get("OIDC_CLIENT_ID"):
        return False
    secret = env.get("ORKBOT_BOOTSTRAP_SECRET", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", secret):
        raise SetupError("The initialization secret is unavailable; keep the existing configuration.")
    state = request_json(url + "/api/auth/native/initialization")
    if not isinstance(state, dict) or type(state.get("required")) is not bool:
        raise SetupError("Could not determine whether server initialization is required.")
    if state["required"]:
        challenge = request_json(url + "/api/auth/native/challenge", {})
        if not isinstance(challenge, dict) or type(challenge.get("bootstrapRequired")) is not bool:
            raise SetupError("Could not determine whether server authorization is required.")
        if not challenge["bootstrapRequired"]:
            return False
        return True
    return False


def main():
    operation, url = sys.argv[1:3]
    if operation == "server-url":
        print(server_url(url))
        return
    if operation == "pin-images":
        pin_images(url)
        return
    origin(url)
    if operation == "proxy-mode":
        print("true" if proxy_mode(url, sys.argv[3]) else "false")
    elif operation == "progress":
        progress(url, sys.argv[3])
    elif operation == "preflight":
        preflight(url, sys.argv[3] == "true")
    elif operation == "configured":
        print("true" if configured(url, environment()) else "false")
    elif operation == "auth-mode":
        env = environment()
        if not configured(url, env):
            raise SetupError("Accounts configuration is incomplete.")
        print("native" if env.get("AUTH_ACCOUNTS_ENABLED") == "true" and not env.get("OIDC_CLIENT_ID") else "oidc")
    elif operation == "provider":
        print(environment().get("SANDBOX_PROVIDER", "docker") or "docker")
    elif operation == "configure":
        configure(url)
    elif operation == "ready":
        ready(url)
    elif operation == "initialization-required":
        print("true" if initialization_required(url) else "false")
    else:
        raise SetupError("Unknown server installer operation.")


if __name__ == "__main__":
    try:
        main()
    except (SetupError, OSError) as error:
        # Do not render arbitrary OS errors, requests, response bodies or tracebacks with secrets.
        message = str(error) if isinstance(error, SetupError) else "Could not safely read or save installation files."
        print("Ork setup failed: " + message, file=sys.stderr)
        sys.exit(1)
