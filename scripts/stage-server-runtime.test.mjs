// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stageServerRuntime } from "./stage-server-runtime.mjs";

test("stages the server and proxy without native clients or product renderer sources", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "ork-server-runtime-"));
  const source = path.join(temporary, "source");
  const destination = path.join(temporary, "runtime");
  const write = (relative, value = "fixture") => {
    mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    writeFileSync(path.join(source, relative), value);
  };
  try {
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "LICENSE",
      "LICENSE-POLYFORM",
      "LICENSE.md",
      "NOTICE",
    ])
      write(file);
    for (const directory of ["api", "worker"]) write(`apps/${directory}/dist/index.js`);
    for (const directory of [
      "adapter-kit",
      "adapters",
      "auth",
      "avatar",
      "chat-ui",
      "contracts",
      "core",
      "db",
      "logging",
      "memory",
      "page-kit",
      "ui-tokens",
      "ui-web",
    ])
      write(`packages/${directory}/package.json`);
    for (const directory of ["compose", "railway", "sandboxes/supervisor"])
      write(`infra/${directory}/package.json`);
    const computerHelpers = ["orkbot-page-browser", "install-agent-browser.sh", "page_secrets.py"];
    for (const file of computerHelpers) write(`infra/sandboxes/computer/${file}`, file);
    write("scripts/pnpm.mjs");
    write("apps/web/package.json");
    write("apps/web/vite.config.ts");
    write("apps/web/lingui.config.ts");
    write("apps/web/server/index.js");
    write("package.json.license", "root license notice");
    write("apps/web/package.json.license", "web license notice");
    write("apps/web/dist/index.html");
    for (const file of [
      "api-proxy",
      "asset-archive",
      "forwarded-for",
      "missing-asset",
      "novnc-html",
      "screen-proxy",
    ])
      write(`apps/web/src/${file}.ts`);
    write("apps/web/src/pwa/retire-build.ts");
    write("apps/web/src/pwa/retire.ts");
    write("node_modules/.pnpm/example/index.js");
    mkdirSync(path.join(source, "apps/web/node_modules"), { recursive: true });
    symlinkSync(
      "../../../node_modules/.pnpm/example",
      path.join(source, "apps/web/node_modules/example"),
    );
    for (const directory of ["desktop", "mobile", "www", "accounts-web"])
      write(`apps/${directory}/src/index.ts`);
    write("apps/web/src/native-app.tsx");
    write("apps/web/src/pages/shell/index.tsx");

    stageServerRuntime(source, destination);

    for (const file of computerHelpers)
      assert.equal(
        readFileSync(path.join(destination, "infra/sandboxes/computer", file), "utf8"),
        file,
      );

    assert.equal(
      readFileSync(path.join(destination, "apps/web/dist/index.html"), "utf8"),
      "fixture",
    );
    assert.equal(
      readFileSync(path.join(destination, "package.json.license"), "utf8"),
      "root license notice",
    );
    assert.equal(
      readFileSync(path.join(destination, "apps/web/package.json.license"), "utf8"),
      "web license notice",
    );
    assert.equal(existsSync(path.join(destination, "apps/web/vite.config.ts")), false);
    assert.equal(existsSync(path.join(destination, "apps/web/lingui.config.ts")), false);
    assert.equal(
      readFileSync(path.join(destination, "apps/web/server/index.js"), "utf8"),
      "fixture",
    );
    assert.equal(
      readFileSync(path.join(destination, "apps/web/node_modules/example/index.js"), "utf8"),
      "fixture",
    );
    assert.equal(
      readlinkSync(path.join(destination, "apps/web/node_modules/example")),
      "../../../node_modules/.pnpm/example",
    );
    assert.ok(existsSync(path.join(destination, "infra/sandboxes/supervisor/package.json")));
    assert.equal(existsSync(path.join(destination, "apps/web/src")), false);
    for (const directory of ["desktop", "mobile", "www", "accounts-web"])
      assert.equal(existsSync(path.join(destination, `apps/${directory}`)), false);
    assert.equal(existsSync(path.join(destination, "apps/web/src/native-app.tsx")), false);
    assert.equal(existsSync(path.join(destination, "apps/web/src/pages")), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
