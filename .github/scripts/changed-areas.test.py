# SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
# SPDX-FileCopyrightText: 2026 Ork contributors
# Modified by Ork contributors to cover the Tauri desktop paths. See LICENSE.md.

"""Classify pull-request merge commits in disposable repositories, without network access."""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("changed-areas.sh").resolve()
WORKFLOW = SCRIPT.parents[1] / "workflows" / "ci.yml"
BASE_FILES = ("apps/web/src/logo.svg", "apps/mobile/app/index.tsx", "README.md")


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL, text=True)


def changes_job():
    return WORKFLOW.read_text().split("  changes:\n", 1)[1].split("\n  build:\n", 1)[0]


def workflow_areas(root, event):
    """Execute the active workflow's routing shell, with no Actions service or network."""
    local_script = root / ".github" / "scripts" / "changed-areas.sh"
    local_script.parent.mkdir(parents=True, exist_ok=True)
    local_script.write_text(SCRIPT.read_text())
    step = changes_job().split("      - id: areas\n", 1)[1]
    body = step.split("        run: ", 1)[1]
    script = (
        "\n".join(line[10:] for line in body[2:].splitlines() if line.strip())
        if body.startswith("|\n")
        else body.splitlines()[0]
    )
    destination = root / "outputs"
    subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        cwd=root,
        env={**os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_OUTPUT": str(destination)},
        check=True,
        capture_output=True,
        text=True,
    )
    return dict(line.split("=", 1) for line in destination.read_text().splitlines())


def areas(change, event=None):
    """Commit `change(root)` on a branch, merge it into the base, and classify the merge commit."""
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        git(root, "init", "-q", "-b", "main")
        git(root, "config", "user.name", "Test")
        git(root, "config", "user.email", "test@example.invalid")
        git(root, "config", "commit.gpgsign", "false")
        git(root, "config", "core.hooksPath", "/dev/null")
        for name in BASE_FILES:
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(f"{name}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        git(root, "switch", "-qc", "pr")
        change(root)
        git(root, "add", "-A")
        git(root, "commit", "-qm", "change")
        git(root, "switch", "-q", "main")
        (root / "base-moved.txt").write_text("main moved on\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "unrelated main commit")
        git(root, "merge", "-q", "--no-ff", "-m", "merge", "pr")
        if event:
            return workflow_areas(root, event)
        output = subprocess.check_output(["bash", str(SCRIPT)], cwd=root, text=True)
        return dict(line.split("=", 1) for line in output.split())


def write(path, text="changed\n"):
    def change(root):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)

    return change


AREAS = ("web", "e2e", "server", "native", "compose", "all_packages")


def expect(*on):
    return {area: str(area in on).lower() for area in AREAS}


EVERY_BROWSER_AREA = ("web", "e2e", "server")


class ChangedAreasTests(unittest.TestCase):
    def test_workflow_changes_job_runs_for_every_trigger(self):
        self.assertNotRegex(changes_job(), r"(?m)^    if:")

    def test_pull_request_workflow_retains_the_real_merge_diff_filter(self):
        for path, expected in [
            ("apps/mobile/app/screen.tsx", expect()),
            ("docs/getting-started.md", expect("web")),
            ("apps/desktop/src-tauri/src/lib.rs", expect("web", "e2e", "native")),
        ]:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path), "pull_request"), expected)

    def test_main_and_manual_workflows_run_every_dependent_area_without_a_pr_diff(self):
        for event in ["push", "workflow_dispatch"]:
            with self.subTest(event=event), tempfile.TemporaryDirectory() as directory:
                # No git repository or merge parent exists in these event fixtures.
                self.assertEqual(
                    workflow_areas(pathlib.Path(directory), event),
                    {area: "true" for area in ("web", "server", "native", "compose")},
                )

    def test_classifies_what_the_pull_request_changed(self):
        cases = [
            ("apps/mobile/app/screen.tsx", expect()),
            ("apps/mobile/modules/orkbot-identity/ios/PersonalDeviceStore.swift", expect("native")),
            ("apps/mobile/modules/orkbot-transport/android/build.gradle", expect("native")),
            ("apps/mobile/plugins/with-installation-transport.js", expect("native")),
            (".agents/skills/x/SKILL.md", expect()),
            ("CHANGELOG.md", expect()),
            ("docs/getting-started.md", expect("web")),
            ("apps/www/src/page.astro", expect("web")),
            ("apps/worker/src/index.ts", expect("web", "server")),
            ("packages/adapters/src/slack.ts", expect("web", "e2e", "server")),
            ("packages/adapters/src/scripted-runtime.ts", expect("web", "e2e", "server")),
            ("packages/adapters/src/host-computer-runner.ts", expect("web", "e2e", "server", "native")),
            ("packages/adapters/src/computer-workspace.ts", expect("web", "e2e", "server", "native")),
            ("packages/core/src/node/desktop-runtime.ts", expect(*EVERY_BROWSER_AREA, "native")),
            (
                "infra/compose/docker-compose.prod.yml",
                expect(*EVERY_BROWSER_AREA, "compose", "all_packages"),
            ),
            ("infra/sandboxes/computer/start.sh", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("infra/sandboxes/computer/Dockerfile", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("infra/sandboxes/supervisor/Dockerfile", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("infra/updater/Dockerfile", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("infra/updater/src/compose-env.ts", expect(*EVERY_BROWSER_AREA)),
            ("apps/mobile/package.json", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("tsconfig.base.json", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("scripts/build-server.mjs", expect(*EVERY_BROWSER_AREA, "all_packages")),
            (".agents/skills/pr-watch/pr-digest", expect("all_packages")),
            ("packages/core/README.md", expect(*EVERY_BROWSER_AREA)),
            ("packages/core/src/run-error.ts", expect(*EVERY_BROWSER_AREA)),
            ("pnpm-lock.yaml", expect(*AREAS)),
            (".github/workflows/ci.yml", expect(*AREAS)),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), expected)

    def test_a_rename_out_of_the_web_app_counts_its_old_path(self):
        def move(root):
            (root / "apps/mobile/assets").mkdir()
            git(root, "mv", "apps/web/src/logo.svg", "apps/mobile/assets/logo.svg")

        self.assertEqual(areas(move), expect("web", "e2e"))

    def test_browser_clients_skip_the_postgres_journeys(self):
        cases = [
            ("apps/web/src/app.ts", expect("web", "e2e")),
            ("packages/ui-web/src/button.tsx", expect("web", "e2e")),
            ("packages/chat-ui/src/thread.tsx", expect("web", "e2e")),
            ("apps/desktop/src-tauri/src/lib.rs", expect("web", "e2e", "native")),
            ("packages/client-transport/native/src/lib.rs", expect(*EVERY_BROWSER_AREA, "native")),
            ("apps/web/package.json", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("packages/ui-tokens/src/tokens.ts", expect(*EVERY_BROWSER_AREA)),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), expected)


if __name__ == "__main__":
    unittest.main()
