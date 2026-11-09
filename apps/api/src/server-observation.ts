// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFile, statfs } from "node:fs/promises";

/** Measures the API container and the filesystem containing its data, not the whole host. */
export function createServerObserver(dataDir: string) {
  let previous: { usage: number; time: number } | undefined;
  const read = (path: string) => readFile(`/sys/fs/cgroup/${path}`, "utf8").catch(() => "");
  const positive = (value: string) => {
    if (!/^\d+$/.test(value.trim())) return null;
    const result = Number(value.trim());
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
  };
  const label = (value: string | undefined) =>
    value && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(value) ? value : null;
  return async () => {
    const [cpu, quota, memory, limit, disk] = await Promise.all([
      read("cpu.stat"),
      read("cpu.max"),
      read("memory.current"),
      read("memory.max"),
      statfs(dataDir, { bigint: true }).catch(() => null),
    ]);
    const usage = positive(cpu.match(/^usage_usec\s+(\d+)$/m)?.[1] ?? "");
    const time = performance.now();
    const cpuUsedCores =
      usage !== null && previous && usage >= previous.usage && time > previous.time
        ? Math.min(4096, (usage - previous.usage) / ((time - previous.time) * 1000))
        : null;
    if (usage !== null) previous = { usage, time };
    const [q, period] = quota.trim().split(/\s+/).map(positive);
    const cpuLimitCores =
      q !== null && q !== undefined && period ? Math.min(4096, q / period) : null;
    const bytes = (value: bigint) =>
      value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      cpuUsedCores,
      cpuLimitCores,
      memoryUsedBytes: positive(memory),
      memoryLimitBytes: positive(limit),
      dataUsedBytes: disk ? bytes((disk.blocks - disk.bfree) * disk.bsize) : null,
      dataTotalBytes: disk ? bytes(disk.blocks * disk.bsize) : null,
      dataAvailableBytes: disk ? bytes(disk.bavail * disk.bsize) : null,
      version: label(process.env.ORKBOT_SERVER_VERSION),
      revision: label(process.env.ORKBOT_GIT_SHA),
    };
  };
}
