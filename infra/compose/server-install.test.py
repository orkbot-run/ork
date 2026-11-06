#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Offline server installer tests. No host packages, Docker daemon or credentials."""

import importlib.util
import io
import json
import os
from pathlib import Path
import socket
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
            installer.pin_images("https://mirror.example.com/ork/" + commit + "/infra/compose")
        self.assertIn("ORKBOT_IMAGE_TAG='custom-release'", installer.ENV.read_text())
        before = installer.ENV.read_bytes()
        installer.pin_images("https://mirror.example.com/ork/main/infra/compose")
        self.assertEqual(before, installer.ENV.read_bytes())

    def test_exact_public_origin_only(self):
        self.assertEqual(installer.origin(URL), "server.example.com")
        for value in ("http://server.example.com", URL + "/", URL + "/a", URL + "?a=b", URL + "#x", URL + ":443", "https://user@server.example.com", "https://localhost", "https://127.0.0.1", "https://SERVER.example.com", "https://-bad.example.com", "https://server..com", "https://$(id).example.com"):
            with self.subTest(value=value), self.assertRaises(installer.SetupError):
                installer.origin(value)

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

    def test_new_client_redeems_once_and_saves_literal_values(self):
        with patch.dict(os.environ, {"ORKBOT_INSTALL_CODE": CODE}), patch.object(installer, "environment", return_value=self.env), patch.object(installer, "request_json", return_value=self.result(clientSecret='dollar$double"quote')) as request:
            installer.configure(URL)
        request.assert_called_once_with(installer.ISSUER + "/api/installations/redeem", {"url": URL}, CODE)
        text = installer.ENV.read_text()
        self.assertIn("OIDC_CLIENT_SECRET='dollar$double\"quote'", text)
        self.assertNotIn(CODE, text)
        self.assertNotIn(CODE, installer.STATE.read_text())
        self.assertEqual(json.loads(installer.STATE.read_text()), {"url": URL, "externalProxy": False})

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


if __name__ == "__main__":
    unittest.main()
