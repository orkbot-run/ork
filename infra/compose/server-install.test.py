#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Offline server installer tests. No host packages, Docker daemon or credentials."""

import http.server
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import threading
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("server_install", ROOT / "server-install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
URL = "https://server.example.com"
CODE = "a" * 43
TICKET = "6d2d8377-3af0-4ca8-8c12-ab25ba2f7a6d"
REPORT_TOKEN = "b" * 43


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.temporary.name)
        self.env = {
            "OIDC_ISSUER": installer.ISSUER, "OIDC_CLIENT_ID": "", "OIDC_CLIENT_SECRET": "",
            "BETTER_AUTH_URL": "http://127.0.0.1:5173", "WEB_ORIGIN": "http://127.0.0.1:5173",
            "API_URL": "http://127.0.0.1:5173", "SANDBOX_PROVIDER": "docker",
        }
        self.write_env()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(os.chdir, self.previous)

    def write_env(self):
        installer.ENV.write_text("\n".join(key + "=" + value for key, value in self.env.items()) + "\nENCRYPTION_KEY=keep-this-key\nPOSTGRES_PASSWORD=keep-this-password\n# operator note\n")
        installer.ENV.chmod(0o600)

    def configured_env(self):
        self.env.update(OIDC_CLIENT_ID="existing-id", OIDC_CLIENT_SECRET="existing-secret")
        for key in ("BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL"):
            self.env[key] = URL
        return self.env

    def result(self, **changes):
        return {"url": URL, "issuer": installer.ISSUER, "clientId": "new-id", "clientSecret": "new-secret", **changes}

    def test_pinned_source_uses_published_full_commit_tags(self):
        commit = "f" * 40
        with patch.dict(os.environ, {"ORKBOT_IMAGE_TAG": "", "ORKBOT_COMPUTER_IMAGE_TAG": ""}):
            installer.pin_images("https://mirror.example.com/ork/" + commit + "/infra/compose")
        self.assertIn("ORKBOT_IMAGE_TAG='sha-" + commit + "'", installer.ENV.read_text())
        self.assertIn("ORKBOT_COMPUTER_IMAGE_TAG='sha-" + commit + "'", installer.ENV.read_text())
        with patch.dict(os.environ, {"ORKBOT_IMAGE_TAG": "custom-release", "ORKBOT_COMPUTER_IMAGE_TAG": "custom-computer"}):
            with self.assertRaises(installer.SetupError):
                installer.pin_images("https://mirror.example.com/ork/" + commit + "/infra/compose")
        self.assertIn("ORKBOT_IMAGE_TAG='sha-" + commit + "'", installer.ENV.read_text())
        before = installer.ENV.read_bytes()
        installer.pin_images("https://mirror.example.com/ork/main/infra/compose")
        self.assertEqual(before, installer.ENV.read_bytes())

    def test_updates_pin_configuration_and_preserve_token_on_resume(self):
        files = "docker-compose.images.yml:docker-compose.https.yml:docker-compose.updates.yml"
        base = "https://mirror.example.com/ork/" + "f" * 40 + "/infra/compose"
        with patch.object(installer, "environment", return_value={}):
            installer.configure_updates(base, "/var/run/docker.sock", files)
        configured = installer.ENV.read_text()
        self.assertIn("ORKBOT_UPDATER_IMAGE_TAG='sha-" + "f" * 40 + "'", configured)
        self.assertIn("ORKBOT_COMPOSE_FILE='" + files + "'", configured)
        token = next(line.split("'", 2)[1] for line in configured.splitlines() if line.startswith("ORKBOT_UPDATER_TOKEN="))
        with patch.object(installer, "environment", return_value={"ORKBOT_UPDATER_TOKEN": token}):
            installer.configure_updates(base, "/var/run/docker.sock", files)
        self.assertIn("ORKBOT_UPDATER_TOKEN='" + token + "'", installer.ENV.read_text())

    def test_updates_reject_conflicting_stack_or_unsafe_socket(self):
        files = "docker-compose.images.yml:docker-compose.updates.yml"
        with patch.object(installer, "environment", return_value={"ORKBOT_DEPLOY_DIR": "/other"}):
            with self.assertRaises(installer.SetupError):
                installer.configure_updates("https://mirror.example.com/" + "f" * 40 + "/infra/compose", "/var/run/docker.sock", files)
        with self.assertRaises(installer.SetupError):
            installer.configure_updates("https://mirror.example.com/main/infra/compose", "/tmp/socket:other", files)

    def test_compose_template_fingerprints_do_not_bless_later_edits(self):
        template = Path("docker-compose.images.yml")
        template.write_text("original template\n")
        installer.record_compose_state([str(template)])
        state = Path(".orkbot-compose-state.json")
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(state.read_text()), {
            "files": {str(template): hashlib.sha256(template.read_bytes()).hexdigest()}
        })
        with self.assertRaises(installer.SetupError):
            installer.validate_compose_state([str(template), "docker-compose.https.yml"])
        original = state.read_bytes()
        template.write_text("operator modification\n")
        installer.record_compose_state([str(template)])
        self.assertEqual(state.read_bytes(), original)
        with self.assertRaises(installer.SetupError):
            installer.validate_compose_state([str(template)])

    def test_interrupted_native_image_pin_resumes_without_replacing_secrets(self):
        commit = "f" * 40
        self.env.update(AUTH_ACCOUNTS_ENABLED="true", ORKBOT_IMAGE_TAG="edge", ORKBOT_COMPUTER_IMAGE_TAG="edge")
        self.write_env()
        with patch.object(installer, "environment", return_value=self.env):
            installer.resume_initial_pin("https://mirror.example.com/" + commit + "/infra/compose")
        content = installer.ENV.read_text()
        self.assertIn("ORKBOT_IMAGE_TAG='sha-" + commit + "'", content)
        self.assertIn("ORKBOT_COMPUTER_IMAGE_TAG='sha-" + commit + "'", content)
        self.assertIn("ENCRYPTION_KEY=keep-this-key", content)
        self.env["ORKBOT_IMAGE_TAG"] = "custom"
        with patch.object(installer, "environment", return_value=self.env), self.assertRaises(installer.SetupError):
            installer.resume_initial_pin("https://mirror.example.com/" + commit + "/infra/compose")

    def test_exact_public_origin_only(self):
        self.assertEqual(installer.origin(URL), "server.example.com")
        self.assertEqual(installer.origin("https://8.8.8.8"), "8.8.8.8")
        for value in ("http://server.example.com", URL + "/", URL + "/a", URL + "?a=b", URL + "#x", URL + ":443", "https://user@server.example.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.1", "https://192.0.2.1", "https://999.999.999.999", "https://SERVER.example.com", "https://-bad.example.com", "https://server..com", "https://$(id).example.com"):
            with self.subTest(value=value), self.assertRaises(installer.SetupError):
                installer.origin(value)

    def test_public_address_is_detected_and_existing_url_is_preserved(self):
        with patch.object(installer.socket, "socket") as factory:
            factory.return_value.__enter__.return_value.getsockname.return_value = ("8.8.8.8", 1234)
            self.assertEqual(installer.server_url(""), "https://8.8.8.8")
            factory.return_value.__enter__.return_value.connect.assert_called_once_with(("192.0.2.1", 9))
            factory.return_value.__enter__.return_value.getsockname.return_value = ("10.0.0.2", 1234)
            with self.assertRaises(installer.SetupError):
                installer.server_url("")
        with patch.object(installer.socket, "socket", side_effect=OSError()), self.assertRaises(installer.SetupError):
            installer.server_url("")
        installer.atomic(installer.STATE, json.dumps({"url": URL, "externalProxy": True}))
        with patch.object(installer.socket, "socket") as factory:
            self.assertEqual(installer.server_url(""), URL)
            self.assertTrue(installer.proxy_mode(URL, "auto"))
        factory.assert_not_called()
        with self.assertRaises(installer.SetupError):
            installer.proxy_mode("https://other.example.com", "auto")

    def test_ip_proxy_config_uses_public_acme_and_refuses_operator_changes(self):
        source = Path(__file__).resolve().parent / "Caddyfile.prod"
        Path("Caddyfile.prod").write_text(source.read_text())
        installer.ip_edge("https://8.8.8.8")
        target = Path("Caddyfile.ip.prod")
        content = target.read_text()
        self.assertIn("default_sni 8.8.8.8", content)
        self.assertIn("profile shortlived", content)
        self.assertIn("disable_tlsalpn_challenge", content)
        installer.ip_edge("https://8.8.8.8")
        target.write_text("operator configuration")
        with self.assertRaises(installer.SetupError):
            installer.ip_edge("https://8.8.8.8")
        self.assertEqual(target.read_text(), "operator configuration")

    def test_ip_proxy_does_not_replace_operator_configuration(self):
        self.env.update(AUTH_ACCOUNTS_ENABLED="true", ORKBOT_BOOTSTRAP_SECRET="z" * 43, CADDYFILE_PATH="./operator.caddy")
        self.write_env()
        before = installer.ENV.read_bytes()
        with patch.dict(os.environ, {"ORKBOT_INSTALL_EXTERNAL_PROXY": "false"}), patch.object(installer, "environment", return_value=self.env), self.assertRaises(installer.SetupError):
            installer.configure("https://8.8.8.8")
        self.assertEqual(installer.ENV.read_bytes(), before)

    def test_terminal_prompt_requires_a_terminal_and_bounds_input(self):
        with patch("builtins.open", side_effect=OSError()), self.assertRaises(installer.SetupError):
            installer.terminal_prompt("Domain: ")
        for answer in ("", "a" * 1025):
            terminal = io.StringIO(answer)
            terminal.write = lambda value: len(value)
            with patch("builtins.open", return_value=terminal), self.assertRaises(installer.SetupError):
                installer.terminal_prompt("Domain: ")

    @unittest.skipUnless(hasattr(os, "openpty"), "A POSIX terminal is required")
    def test_domain_prompt_works_with_a_nonseekable_terminal(self):
        master, slave = os.openpty()
        original_open = open
        terminal = os.ttyname(slave)
        try:
            os.write(master, b"server.example.com\n")
            with patch("builtins.open", side_effect=lambda path, mode: original_open(terminal if path == "/dev/tty" else path, mode)):
                self.assertEqual(installer.terminal_prompt("Domain: "), "server.example.com")
        finally:
            os.close(master)
            os.close(slave)

    def test_proxy_is_detected_without_changing_the_existing_proxy(self):
        with patch.object(installer, "occupied_ports", return_value=False), patch.object(installer, "terminal_prompt") as prompt:
            self.assertFalse(installer.proxy_mode(URL, "auto"))
        prompt.assert_not_called()
        with patch.object(installer, "occupied_ports", return_value=True), patch.object(installer, "terminal_prompt", return_value="yes"):
            self.assertTrue(installer.proxy_mode(URL, "auto"))
        with patch.object(installer, "occupied_ports", return_value=True), patch.object(installer, "terminal_prompt", return_value="no"), self.assertRaises(installer.SetupError):
            installer.proxy_mode(URL, "auto")

    def test_saved_settings_reject_malformed_types_and_additional_fields(self):
        for value in ({"url": 42, "externalProxy": False}, {"url": URL, "externalProxy": "false"}, {"url": URL, "externalProxy": False, "extra": "value"}, []):
            installer.atomic(installer.STATE, json.dumps(value))
            with self.subTest(value=value), self.assertRaises(installer.SetupError):
                installer.server_url("")

    def test_dns_rejects_any_private_result(self):
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch.object(installer.socket, "getaddrinfo", return_value=public):
            installer.public_dns("server.example.com")
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "192.0.2.1"):
            with self.subTest(address=address), patch.object(installer.socket, "getaddrinfo", return_value=public + [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]), self.assertRaises(installer.SetupError):
                installer.public_dns("server.example.com")

    def test_existing_client_resumes_without_consuming_code(self):
        self.configured_env()
        self.write_env()
        with patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json") as request:
            installer.configure(URL)
        request.assert_not_called()
        content = installer.ENV.read_text()
        self.assertIn("OIDC_CLIENT_SECRET=existing-secret", content)
        self.assertIn("ENCRYPTION_KEY=keep-this-key", content)
        self.assertIn("POSTGRES_PASSWORD=keep-this-password", content)
        self.assertIn("# operator note", content)
        self.assertIn("AUTH_PASSWORD_ENABLED='false'", content)
        self.assertIn("SANDBOX_COMPUTER_EGRESS='restricted'", content)
        self.assertEqual(installer.ENV.stat().st_mode & 0o777, 0o600)

    def test_new_native_server_configures_without_enrollment_and_resumes(self):
        bootstrap = "z" * 43
        self.env.update(AUTH_ACCOUNTS_ENABLED="true", ORKBOT_BOOTSTRAP_SECRET=bootstrap)
        self.write_env()
        with patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": ""}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json") as request:
            installer.configure(URL)
        request.assert_not_called()
        content = installer.ENV.read_text()
        self.assertIn("ORKBOT_BOOTSTRAP_SECRET=" + bootstrap, content)
        self.assertIn("AUTH_ACCOUNTS_ENABLED='true'", content)
        self.assertIn("SIGNUPS_ENABLED='false'", content)
        self.assertIn("OIDC_REDIRECT_URI=''", content)
        self.assertEqual(json.loads(installer.STATE.read_text()), {"url": URL, "externalProxy": False})
        self.env.update(BETTER_AUTH_URL=URL, WEB_ORIGIN=URL, API_URL=URL, OIDC_REDIRECT_URI="", SIGNUPS_ENABLED="false")
        with patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json") as request:
            installer.configure(URL)
        request.assert_not_called()
        self.assertIn("ORKBOT_BOOTSTRAP_SECRET=" + bootstrap, installer.ENV.read_text())
        with patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json") as request:
            installer.configure(URL)
        request.assert_not_called()
        self.assertIn("OIDC_REDIRECT_URI=''", installer.ENV.read_text())
        self.assertNotIn("OIDC_CLIENT_ID='new-id'", installer.ENV.read_text())

    def test_native_server_refuses_missing_bootstrap_and_wrong_origin(self):
        for changes in ({"AUTH_ACCOUNTS_ENABLED": "true"}, {"AUTH_ACCOUNTS_ENABLED": "true", "ORKBOT_BOOTSTRAP_SECRET": "short"}):
            before = installer.ENV.read_bytes()
            with self.subTest(changes=changes), patch.object(installer, "environment", return_value={**self.env, **changes}), self.assertRaises(installer.SetupError):
                installer.configure(URL)
            self.assertEqual(before, installer.ENV.read_bytes())
        installer.atomic(installer.STATE, json.dumps({"url": "https://other.example.com", "externalProxy": False}))
        with self.assertRaises(installer.SetupError):
            installer.configured(URL, {**self.env, "AUTH_ACCOUNTS_ENABLED": "true", "ORKBOT_BOOTSTRAP_SECRET": "z" * 43})

    def test_initialization_is_required_only_before_claim(self):
        env = {**self.env, "AUTH_ACCOUNTS_ENABLED": "true", "ORKBOT_BOOTSTRAP_SECRET": "z" * 43}
        for required in (True, False):
            with self.subTest(required=required), patch.object(installer, "environment", return_value=env), patch.object(installer, "request_json", side_effect=[{"required": required}, {"bootstrapRequired": True}]):
                self.assertEqual(installer.initialization_required(URL), required)
        with patch.object(installer, "environment", return_value=env), patch.object(installer, "request_json", side_effect=[{"required": True}, {"bootstrapRequired": False}]):
            self.assertFalse(installer.initialization_required(URL))
        with patch.object(installer, "environment", return_value=env), patch.object(installer, "request_json", side_effect=[{"required": True}, {"bootstrapRequired": "false"}]), self.assertRaises(installer.SetupError):
            installer.initialization_required(URL)
        with patch.object(installer, "environment", return_value=env), patch.object(installer, "request_json", return_value={"required": "true"}), self.assertRaises(installer.SetupError):
            installer.initialization_required(URL)

    def test_legacy_oidc_does_not_issue_a_native_claim(self):
        for enabled in ("true", "false"):
            env = {**self.env, "AUTH_ACCOUNTS_ENABLED": enabled, "OIDC_CLIENT_ID": "legacy-client"}
            with self.subTest(enabled=enabled), patch.object(installer, "environment", return_value=env), patch.object(installer, "request_json") as request:
                self.assertFalse(installer.initialization_required(URL))
                request.assert_not_called()

    def test_new_client_redeems_once_and_saves_literal_values(self):
        with patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json", return_value=self.result(clientSecret='dollar$double"quote')) as request:
            installer.configure(URL)
        request.assert_called_once_with(installer.ISSUER + "/api/installations/redeem", {"url": URL}, CODE)
        text = installer.ENV.read_text()
        self.assertIn("OIDC_CLIENT_SECRET='dollar$double\"quote'", text)
        self.assertNotIn(CODE, text)
        self.assertNotIn(CODE, installer.STATE.read_text())
        self.assertEqual(json.loads(installer.STATE.read_text()), {"url": URL, "externalProxy": False})

    def test_status_credential_is_private_and_separate_from_docker_environment(self):
        with patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json", return_value=self.result(installationTicketId=TICKET, reportToken=REPORT_TOKEN)):
            installer.configure(URL)
        self.assertEqual(json.loads(installer.INSTALLATION.read_text()), {"url": URL, "installationTicketId": TICKET, "reportToken": REPORT_TOKEN})
        self.assertEqual(installer.INSTALLATION.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(REPORT_TOKEN, installer.ENV.read_text())
        self.assertNotIn(CODE, installer.INSTALLATION.read_text())
        before = installer.INSTALLATION.read_bytes()
        self.configured_env()
        with patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json") as request:
            installer.configure(URL)
        request.assert_not_called()
        self.assertEqual(before, installer.INSTALLATION.read_bytes())

    def test_progress_has_a_fixed_endpoint_phase_only_and_bounded_best_effort_retries(self):
        installer.atomic(installer.INSTALLATION, json.dumps({"url": URL, "installationTicketId": TICKET, "reportToken": REPORT_TOKEN}))
        with patch.object(installer, "request_json", return_value={}) as request:
            installer.progress(URL, "pulling")
        request.assert_called_once_with(installer.ISSUER + "/api/installations/progress", {"phase": "pulling"}, REPORT_TOKEN)
        with patch.object(installer, "request_json", side_effect=installer.SetupError("Unavailable")) as request, patch.object(installer.time, "sleep") as sleep, patch("sys.stderr", new_callable=io.StringIO) as output:
            installer.progress(URL, "ready")
        self.assertEqual(request.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertNotIn(REPORT_TOKEN, output.getvalue())
        with patch.object(installer, "request_json") as request, self.assertRaises(installer.SetupError):
            installer.progress(URL, "arbitrary-status")
        request.assert_not_called()
        with patch.object(installer, "request_json") as request, self.assertRaises(installer.SetupError):
            installer.progress("https://other.example.com", "ready")
        request.assert_not_called()

    def test_invalid_status_credential_never_changes_existing_configuration(self):
        for changes in ({"installationTicketId": "bad", "reportToken": REPORT_TOKEN}, {"installationTicketId": TICKET, "reportToken": "short"}, {"installationTicketId": TICKET}, {"reportToken": REPORT_TOKEN}):
            before = installer.ENV.read_bytes()
            with self.subTest(changes=changes), patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json", return_value=self.result(**changes)), self.assertRaises(installer.SetupError):
                installer.configure(URL)
            self.assertEqual(before, installer.ENV.read_bytes())
            self.assertFalse(installer.INSTALLATION.exists())

    def test_invalid_enrollment_never_changes_existing_configuration(self):
        for changes in ({"url": "https://other.example.com"}, {"issuer": "https://other.example.com"}, {"clientId": ""}, {"clientSecret": "bad\nOIDC_ISSUER=x"}, {"clientSecret": "bad'quote"}, {"clientSecret": "bad\\escape"}, {"clientSecret": "x" * 4097}):
            before = installer.ENV.read_bytes()
            with self.subTest(changes=changes), patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json", return_value=self.result(**changes)) as request, self.assertRaises(installer.SetupError):
                installer.configure(URL)
            request.assert_called_once()
            self.assertEqual(installer.ENV.read_bytes(), before)
            self.assertFalse(installer.STATE.exists())

    def test_ambiguous_redeem_is_not_retried(self):
        before = installer.ENV.read_bytes()
        with patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json", side_effect=installer.SetupError("Enrollment failed.")) as request, self.assertRaises(installer.SetupError):
            installer.configure(URL)
        request.assert_called_once()
        self.assertEqual(installer.ENV.read_bytes(), before)

    def test_partial_wrong_origin_and_custom_project_fail_before_redeem(self):
        for changes in ({"OIDC_CLIENT_ID": "partial"}, {"OIDC_CLIENT_SECRET": "partial"}, {"COMPOSE_PROJECT_NAME": "other"}, {"OIDC_CLIENT_ID": "id", "OIDC_CLIENT_SECRET": "secret", "BETTER_AUTH_URL": "https://other.example.com"}):
            env = {**self.env, **changes}
            with self.subTest(changes=changes), patch.object(installer, "environment", return_value=env), patch.object(installer, "request_json") as request, self.assertRaises(installer.SetupError):
                installer.configure(URL)
            request.assert_not_called()

    def test_remote_provider_and_secret_values_are_preserved(self):
        self.env.update(SANDBOX_PROVIDER="remote-computers", SANDBOX_COMPUTER_EGRESS="operator-value")
        self.configured_env()
        self.write_env()
        with patch.object(installer, "environment", return_value=self.env):
            installer.configure(URL)
        self.assertIn("SANDBOX_PROVIDER=remote-computers", installer.ENV.read_text())
        self.assertIn("SANDBOX_COMPUTER_EGRESS=operator-value", installer.ENV.read_text())

    def test_symlink_hardlink_permissions_fail_closed(self):
        installer.ENV.chmod(0o644)
        with self.assertRaises(installer.SetupError):
            installer.regular(installer.ENV, private=True)
        installer.ENV.chmod(0o600)
        os.link(installer.ENV, "saved")
        with self.assertRaises(installer.SetupError):
            installer.regular(installer.ENV, private=True)
        Path("saved").unlink()
        installer.ENV.rename("saved")
        installer.ENV.symlink_to("saved")
        with self.assertRaises(installer.SetupError):
            installer.regular(installer.ENV, private=True)

    def test_preflight_refuses_other_compose_installation_and_orphan_volumes(self):
        with patch.object(installer, "docker", return_value="/another/installation\n"), self.assertRaises(installer.SetupError):
            installer.preflight(URL, False)
        installer.ENV.unlink()
        with patch.object(installer, "docker", side_effect=["", "orkbot_pgdata\n"]), self.assertRaises(installer.SetupError):
            installer.preflight(URL, False)
        self.write_env()
        with patch.object(installer, "docker", side_effect=["", "orkbot_pgdata\n"]), self.assertRaises(installer.SetupError):
            installer.preflight(URL, False)

    def test_occupied_ports_require_explicit_external_proxy(self):
        with patch.object(installer, "docker", return_value=""), patch.object(installer, "public_dns"), patch.object(installer, "occupied_ports", return_value=True):
            with self.assertRaises(installer.SetupError):
                installer.preflight(URL, False)
            installer.preflight(URL, True)

    def test_managed_resume_requires_same_url_and_proxy_mode(self):
        installer.atomic(installer.STATE, json.dumps({"url": URL, "externalProxy": False}))
        with patch.object(installer, "docker", return_value=""), patch.object(installer, "public_dns"), patch.object(installer, "occupied_ports", return_value=True):
            installer.preflight(URL, False)
            with self.assertRaises(installer.SetupError):
                installer.preflight(URL, True)
            with self.assertRaises(installer.SetupError):
                installer.preflight("https://other.example.com", False)

    def test_external_proxy_readiness_accepts_rpc_and_accounts_when_health_is_spa_html(self):
        class Response(io.BytesIO):
            status = 200

        class Opener:
            def __init__(self):
                self.paths = []

            def open(self, request, timeout):
                path = urllib.parse.urlsplit(request.full_url).path
                self.paths.append(path)
                if path == "/health":
                    return Response(b"<!doctype html><html><body>Ork</body></html>")
                if path == "/rpc/health":
                    self.rpc_method, self.rpc_body = request.get_method(), json.loads(request.data)
                    return Response(b'{"json":{"ok":true,"version":"test"}}')
                if path == "/api/auth/capabilities":
                    return Response(b'{"passwordAuth":false,"sso":{"name":"Accounts","availability":"available"}}')
                raise AssertionError("Unexpected readiness request")

        opener = Opener()
        with patch.object(installer, "public_dns"), patch.object(installer.urllib.request, "build_opener", return_value=opener), patch.object(installer.time, "monotonic", side_effect=[0, 181]):
            installer.ready(URL)
        self.assertEqual(opener.paths, ["/rpc/health", "/api/auth/capabilities"])
        self.assertEqual(opener.rpc_method, "POST")
        self.assertEqual(opener.rpc_body, {"json": {}})

    def test_readiness_checks_actual_rpc_and_accounts_contract(self):
        responses = [{"json": {"ok": True, "version": "test"}}, {"passwordAuth": False, "sso": {"name": "Accounts", "availability": "available"}}]
        with patch.object(installer, "public_dns"), patch.object(installer, "request_json", side_effect=responses) as request:
            installer.ready(URL)
        self.assertEqual([call.args for call in request.call_args_list], [(URL + "/rpc/health", {"json": {}}), (URL + "/api/auth/capabilities",)])
        native = [{"json": {"ok": True, "version": "test"}}, {"passwordAuth": False, "accountsLogin": True, "sso": None}, {"keys": [{"kty": "RSA"}]}]
        with patch.object(installer, "public_dns"), patch.object(installer, "request_json", side_effect=native):
            installer.ready(URL)
        with patch.object(installer, "public_dns"), patch.object(installer, "request_json", side_effect=native[:2] + [{"keys": []}]), patch.object(installer.time, "monotonic", side_effect=[0, 181]), self.assertRaises(installer.SetupError):
            installer.ready(URL)
        for field in ({"passwordAuth": True, "sso": {"name": "Accounts", "availability": "available"}}, {"passwordAuth": False, "sso": {"name": "Accounts", "availability": "checking"}}, {"passwordAuth": False, "sso": None}):
            with patch.object(installer, "public_dns"), patch.object(installer, "request_json", side_effect=responses[:1] + [field]), patch.object(installer.time, "monotonic", side_effect=[0, 181]), self.assertRaises(installer.SetupError):
                installer.ready(URL)

    def test_http_request_has_bounded_body_no_redirect_and_no_secret_errors(self):
        class Response(io.BytesIO):
            status = 200

        class Opener:
            response = b'{}'
            request = None
            def open(self, request, timeout):
                self.request, self.timeout = request, timeout
                return Response(self.response)

        opener = Opener()
        with patch.object(installer.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(installer.request_json(installer.ISSUER + "/api/installations/redeem", {"url": URL}, CODE), {})
            self.assertEqual(opener.timeout, 15)
            self.assertEqual(opener.request.headers["Authorization"], "Bearer " + CODE)
            self.assertEqual(json.loads(opener.request.data), {"url": URL})
            opener.response = b"x" * (installer.MAX_RESPONSE + 1)
            with self.assertRaises(installer.SetupError):
                installer.request_json(URL)
        self.assertIsNone(installer.NoRedirect().redirect_request(None, None, None, None, None, None))
        error = urllib.error.HTTPError(URL, 403, "secret-body", {}, None)
        with patch.object(installer.urllib.request, "build_opener") as factory:
            factory.return_value.open.side_effect = error
            with self.assertRaises(installer.SetupError) as raised:
                installer.request_json(URL, bearer=CODE)
            self.assertNotIn("secret-body", str(raised.exception))
            self.assertNotIn(CODE, str(raised.exception))
            self.assertEqual(factory.return_value.open.call_count, 1)

    def test_local_https_verifies_trust_and_hostname_without_following_redirects(self):
        key, certificate = Path("tls-key.pem"), Path("tls-cert.pem")
        # This temporary self-signed fixture is never an installer trust override.
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(key), "-out", str(certificate), "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost",
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        key.chmod(0o600)
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/must-not-follow")
                    body = b""
                else:
                    self.send_response(200)
                    body = b'{"ok":true}' if self.path == "/health" else b"<html>Proxy login</html>"
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(str(certificate), str(key))
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        endpoint = "https://localhost:" + str(server.server_port)
        trusted = ssl.create_default_context(cafile=str(certificate))
        untrusted = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        build_opener = installer.urllib.request.build_opener
        settings = {
            "http_proxy": "", "HTTP_PROXY": "", "https_proxy": "", "HTTPS_PROXY": "",
            "all_proxy": "", "ALL_PROXY": "", "no_proxy": "localhost,127.0.0.1", "NO_PROXY": "localhost,127.0.0.1",
        }
        try:
            with patch.dict(os.environ, settings), patch.object(
                installer.urllib.request, "build_opener",
                side_effect=lambda *handlers: build_opener(*handlers, installer.urllib.request.HTTPSHandler(context=trusted)),
            ):
                self.assertEqual(installer.request_json(endpoint + "/health"), {"ok": True})
                for path in ("/redirect", "/html"):
                    with self.subTest(path=path), self.assertRaises(installer.SetupError):
                        installer.request_json(endpoint + path)
                self.assertEqual(requests, ["/health", "/redirect", "/html"])
                # The trusted certificate still cannot authenticate another hostname.
                with self.assertRaises(installer.SetupError):
                    installer.request_json(endpoint.replace("localhost", "127.0.0.1") + "/health")
            with patch.dict(os.environ, settings), patch.object(
                installer.urllib.request, "build_opener",
                side_effect=lambda *handlers: build_opener(*handlers, installer.urllib.request.HTTPSHandler(context=untrusted)),
            ):
                with self.assertRaises(installer.SetupError):
                    installer.request_json(endpoint + "/health")
            self.assertEqual(requests, ["/health", "/redirect", "/html"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
