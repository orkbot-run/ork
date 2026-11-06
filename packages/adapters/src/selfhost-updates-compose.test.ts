// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("leaves the existing six-service deployment under its panel manager and preserves image overrides", () => {
  const source = readFileSync(
    new URL("../../../infra/compose/docker-compose.selfhost.yml", import.meta.url),
    "utf8",
  );
  const compose = parse(source, { merge: true });
  expect(Object.keys(compose.services)).toEqual([
    "bootstrap",
    "ork-selfhost-database",
    "migrate",
    "api",
    "worker",
    "web",
  ]);
  for (const role of ["bootstrap", "migrate", "api", "worker", "web"]) {
    expect(compose.services[role].image).toBe(
      `\${ORKBOT_IMAGE:-ghcr.io/orkbot-run/ork/app}:\${ORKBOT_IMAGE_TAG:-edge}`,
    );
    expect(compose.services[role].pull_policy).toBe("always");
  }
  expect(source).not.toContain("docker.sock");
  expect(compose.services.api.volumes).toContain("api-configuration:/run/orkbot:ro");
});
