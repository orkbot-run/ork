// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "vitest";

it("checks both GitHub CLI download paths and rejects corrupt archives", () => {
  const directory = path.resolve(import.meta.dirname, "../../../infra/sandboxes/computer");
  execFileSync("bash", [
    path.join(directory, "install-github-cli.test.sh"),
    path.join(directory, "install-github-cli.sh"),
  ]);
});
