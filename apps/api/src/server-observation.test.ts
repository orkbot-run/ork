// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createServerObserver } from "./server-observation.js";

it("reports filesystem capacity and a nonnegative CPU sample without exposing paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ork-observer-"));
  try {
    const observe = createServerObserver(directory);
    const first = await observe();
    const next = await observe();
    expect(first.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(first.dataTotalBytes).toBeGreaterThan(0);
    expect(first.dataAvailableBytes).toBeLessThanOrEqual(first.dataTotalBytes!);
    expect(next.cpuUsedCores === null || next.cpuUsedCores >= 0).toBe(true);
    expect(JSON.stringify(next)).not.toContain(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
