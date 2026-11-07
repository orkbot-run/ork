// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

const helper = new URL("./migration-signals.ts", import.meta.url).href;

async function run(signal: "SIGINT" | "SIGTERM", mode: "drain" | "hung" | "retained-handle") {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `
import { migrationSignals } from ${JSON.stringify(helper)};
const alive = setInterval(() => {}, 1_000);
const shutdown = migrationSignals(${mode === "drain" ? "undefined" : "100"});
shutdown.signal.addEventListener("abort", async () => {
  console.log("interrupted");
  if (${JSON.stringify(mode)} === "hung") return;
  if (${JSON.stringify(mode)} === "drain") await new Promise(resolve => process.once("message", resolve));
  console.log("cleanup done");
  process.exitCode = 1;
  shutdown.finish();
  if (${JSON.stringify(mode)} === "drain") clearInterval(alive);
  process.disconnect();
});
// Simulate a dependency that cleans up and re-raises the received signal.
process.once(${JSON.stringify(signal)}, () => process.kill(process.pid, ${JSON.stringify(signal)}));
console.log("ready");
`,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk.toString();
  });
  const closed = once(child, "close").then(([code, receivedSignal]) => ({
    code,
    signal: receivedSignal,
  }));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const waitFor = async (text: string) => {
    while (!output.includes(text)) {
      await Promise.race([
        once(child.stdout!, "data"),
        closed.then(() => {
          throw new Error(`CLI exited before ${text}: ${output}`);
        }),
      ]);
    }
  };
  try {
    await waitFor("ready");
    child.kill(signal);
    await waitFor("interrupted");
    if (mode === "drain") child.send("release cleanup");
    const result = await closed;
    return { ...result, output };
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
  }
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  it(`drains cleanup after repeated ${signal} and preserves the interruption code`, async () => {
    const result = await run(signal, "drain");
    expect(result.code).toBe(code);
    expect(result.signal).toBeNull();
    expect(result.output.match(/interrupted/g)).toHaveLength(1);
    expect(result.output).toContain("cleanup done");
  });

  it(`bounds an uncooperative operation after ${signal}`, async () => {
    const result = await run(signal, "hung");
    expect(result.code).toBe(code);
    expect(result.signal).toBeNull();
    expect(result.output).not.toContain("cleanup done");
  });

  it(`retains the exit deadline if a dependency leaves a handle after ${signal} cleanup`, async () => {
    const result = await run(signal, "retained-handle");
    expect(result.code).toBe(code);
    expect(result.signal).toBeNull();
    expect(result.output).toContain("cleanup done");
  });
}

it("removes only its listeners and preserves ordinary failure status when not interrupted", async () => {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `
import { migrationSignals } from ${JSON.stringify(helper)};
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const shutdown = migrationSignals();
process.exitCode = 1;
shutdown.finish();
console.log(JSON.stringify([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]));
console.log(JSON.stringify(counts));
`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk.toString();
  });
  const [code, signal] = await once(child, "close");
  expect({ code, signal }).toEqual({ code: 1, signal: null });
  const lines = output.trim().split("\n");
  expect(lines[0]).toBe(lines[1]);
});
