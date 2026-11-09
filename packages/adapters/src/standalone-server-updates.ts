// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdateAdapter } from "@orkbot/adapter-kit";
import { ServerUpdatePhaseSchema } from "@orkbot/contracts";
import { cancelResponseBody, readBoundedJsonResponse } from "@orkbot/core";
import { createOfficialServerUpdateDiscovery } from "./easypanel-server-updates.js";

/** Request a pinned release from the private, independently running deployment service. */
export function createStandaloneServerUpdateAdapter(
  config: { channel: "stable" | "preview"; currentRevision: string | null; token: string },
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): ServerUpdateAdapter {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.token))
    throw new Error("Invalid update configuration.");
  const discover = (channel: "stable" | "preview") =>
    createOfficialServerUpdateDiscovery(
      { ...config, channel, previewRelease: true },
      dependencies,
    )();
  const fetch = dependencies.fetch ?? globalThis.fetch;
  return {
    channel: config.channel,
    channelSelectable: true,
    check: (channel = config.channel) => discover(channel),
    async operation() {
      try {
        const signal = AbortSignal.timeout(5000);
        const response = await fetch("http://updater:7092/state", {
          redirect: "error",
          signal,
          headers: { authorization: `Bearer ${config.token}` },
        });
        if (!response.ok) {
          cancelResponseBody(response);
          return null;
        }
        const body = await readBoundedJsonResponse<{ operation?: unknown }>(
          response,
          65536,
          signal,
        );
        const item = body.operation;
        if (!item || typeof item !== "object") return null;
        const value = item as Record<string, unknown>;
        if (
          typeof value.revision !== "string" ||
          !/^[a-f0-9]{40}$/.test(value.revision) ||
          typeof value.idempotencyKey !== "string" ||
          typeof value.state !== "string" ||
          !["accepted", "running", "succeeded", "failed", "unknown"].includes(value.state)
        )
          return null;
        const phase = ServerUpdatePhaseSchema.safeParse(value.phase);
        return {
          revision: value.revision,
          idempotencyKey: value.idempotencyKey,
          state: value.state as "accepted" | "running" | "succeeded" | "failed" | "unknown",
          ...(phase.success && (value.state === "accepted" || value.state === "running")
            ? { phase: phase.data }
            : {}),
        };
      } catch {
        return null;
      }
    },
    async submit(revision, beforeSubmit, idempotencyKey, channel = config.channel) {
      if (
        !/^[a-f0-9]{40}$/.test(revision) ||
        !idempotencyKey ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          idempotencyKey,
        )
      )
        throw new Error("Could not contact the deployment service.");
      const candidate = await discover(channel);
      if (candidate?.revision !== revision)
        throw new Error("Could not contact the deployment service.");
      await beforeSubmit();
      try {
        const response = await fetch("http://updater:7092/deploy", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ revision, idempotencyKey, channel }),
        });
        cancelResponseBody(response);
        if (response.status !== 202) throw new Error();
      } catch {
        throw new Error("Could not contact the deployment service.");
      }
    },
  };
}
