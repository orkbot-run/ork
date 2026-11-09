// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdateAdapter } from "@orkbot/adapter-kit";
import {
  cancelResponseBody,
  equalRegistryManifests,
  parseReleaseTag,
  readBoundedJsonResponse,
  selectLatestReleaseTag,
} from "@orkbot/core";
import { validateDeploymentTrigger } from "./server-updates-config.js";

const OFFICIAL_API = "https://api.github.com/repos/orkbot-run/ork";
const REGISTRY = "https://ghcr.io";
const REPOSITORY = "orkbot-run/ork/app";
const MAX_BYTES = 65_536;
const TIMEOUT_MS = 10_000;
const failure = () => new Error("Could not contact the deployment service.");

export function createOfficialServerUpdateDiscovery(
  config: {
    channel: "stable" | "preview";
    currentRevision: string | null;
    previewRelease?: boolean;
  },
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): ServerUpdateAdapter["check"] {
  const channel = config.channel;
  const currentRevision = config.currentRevision;
  if (channel !== "stable" && channel !== "preview") throw failure();
  const fetch = dependencies.fetch ?? globalThis.fetch;
  async function request(path: string, signal: AbortSignal): Promise<unknown | null> {
    const response = await fetch(`${OFFICIAL_API}${path}`, {
      redirect: "error",
      signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "Ork-server-updates" },
    });
    if (
      response.status === 404 &&
      (path === "/releases/latest" || path.startsWith("/actions/workflows/ci.yml/runs?"))
    ) {
      cancelResponseBody(response);
      return null;
    }
    if (!response.ok) {
      cancelResponseBody(response);
      throw failure();
    }
    return readBoundedJsonResponse(response, MAX_BYTES, signal);
  }
  async function published(
    revision: string,
    signal: AbortSignal,
    version: string,
  ): Promise<boolean> {
    return equalRegistryManifests({
      tokenUrl: `${REGISTRY}/token?service=ghcr.io&scope=repository:${REPOSITORY}:pull`,
      manifestBase: `${REGISTRY}/v2/${REPOSITORY}/manifests`,
      tags: [
        `sha-${revision}`,
        channel === "stable" ? "latest" : config.previewRelease ? version : "edge",
      ],
      signal,
      fetch,
    });
  }
  async function check(): ReturnType<ServerUpdateAdapter["check"]> {
    if (!currentRevision || !/^[0-9a-f]{40}$/.test(currentRevision)) return null;
    const signal = AbortSignal.timeout(6_000);
    try {
      let version = "edge";
      let ref = "main";
      if (channel === "stable") {
        const release = (await request("/releases/latest", signal)) as {
          tag_name?: unknown;
          draft?: unknown;
          prerelease?: unknown;
        } | null;
        if (release === null) return null;
        if (
          release.draft !== false ||
          release.prerelease !== false ||
          typeof release.tag_name !== "string" ||
          !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name)
        )
          throw failure();
        version = release.tag_name;
        ref = version;
      } else if (config.previewRelease) {
        const releases = await request("/releases?per_page=100", signal);
        if (!Array.isArray(releases)) throw failure();
        const tags = releases.flatMap((item: unknown) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (entry.draft !== false || typeof entry.tag_name !== "string") return [];
          const parsed = parseReleaseTag(entry.tag_name);
          if (!parsed || entry.prerelease !== (parsed.prerelease !== null)) return [];
          return [entry.tag_name];
        });
        const newest = selectLatestReleaseTag(tags, true);
        if (!newest) return null;
        version = newest;
        ref = version;
      }
      const commits = await request(`/commits?sha=${ref}&per_page=1`, signal);
      const commit =
        Array.isArray(commits) && commits.length === 1 ? (commits[0] as { sha?: unknown }) : null;
      if (!commit || typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha))
        throw failure();
      if (currentRevision !== commit.sha) {
        const comparison = (await request(
          `/compare/${currentRevision}...${commit.sha}?per_page=1&page=2`,
          signal,
        )) as { status?: unknown } | null;
        if (
          !comparison ||
          !["ahead", "behind", "diverged", "identical"].includes(String(comparison.status))
        )
          throw failure();
        if (comparison.status !== "ahead") return null;
      }
      const runs = (await request(
        `/actions/workflows/ci.yml/runs?head_sha=${commit.sha}&event=push&per_page=1`,
        signal,
      )) as { workflow_runs?: unknown } | null;
      if (runs === null) return null;
      if (!Array.isArray(runs.workflow_runs)) throw failure();
      const run =
        runs.workflow_runs.length === 1
          ? (runs.workflow_runs[0] as Record<string, unknown> | null)
          : null;
      if (
        !run ||
        run.head_sha !== commit.sha ||
        run.head_branch !== "main" ||
        run.event !== "push" ||
        run.status !== "completed" ||
        run.conclusion !== "success"
      )
        return null;
      if (!(await published(commit.sha, signal, version))) return null;
      return { revision: commit.sha, version };
    } catch {
      throw failure();
    }
  }
  return check;
}

export function createEasypanelServerUpdateAdapter(
  config: {
    channel: "stable" | "preview";
    currentRevision: string | null;
    deploymentTrigger: string;
  },
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): ServerUpdateAdapter {
  const trigger = validateDeploymentTrigger(config.deploymentTrigger);
  const channel = config.channel;
  const check = createOfficialServerUpdateDiscovery(config, dependencies);
  const fetch = dependencies.fetch ?? globalThis.fetch;
  return {
    channel,
    check,
    async submit(expectedRevision, beforeSubmit) {
      try {
        if (!/^[0-9a-f]{40}$/.test(expectedRevision)) throw failure();
        const candidate = await check();
        if (candidate?.revision !== expectedRevision) throw failure();
        await beforeSubmit();
        const response = await fetch(trigger, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        cancelResponseBody(response);
        if (!response.ok) throw failure();
      } catch {
        throw failure();
      }
    },
  };
}
