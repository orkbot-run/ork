// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdateAdapter } from "@orkbot/adapter-kit";
import { cancelResponseBody, readBoundedJsonResponse } from "@orkbot/core";
import { validateDeploymentTrigger } from "./server-updates-config.js";

const OFFICIAL_API = "https://api.github.com/repos/orkbot-run/ork";
const REGISTRY = "https://ghcr.io";
const REPOSITORY = "orkbot-run/ork/app";
const MAX_BYTES = 65_536;
const TIMEOUT_MS = 10_000;
const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const failure = () => new Error("Could not contact the deployment service.");

export function createEasypanelServerUpdateAdapter(
  config: {
    channel: "stable" | "preview";
    deploymentTrigger: string;
    currentRevision: string | null;
  },
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): ServerUpdateAdapter {
  const trigger = validateDeploymentTrigger(config.deploymentTrigger);
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
    if (response.status === 404 && path === "/releases/latest") {
      cancelResponseBody(response);
      return null;
    }
    if (!response.ok) {
      cancelResponseBody(response);
      throw failure();
    }
    return readBoundedJsonResponse(response, MAX_BYTES, signal);
  }
  async function published(revision: string, signal: AbortSignal): Promise<boolean> {
    // Anonymous pull capability is fixed to the official public repository, never an operator token.
    const response = await fetch(
      `${REGISTRY}/token?service=ghcr.io&scope=repository:${REPOSITORY}:pull`,
      {
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) {
      cancelResponseBody(response);
      throw failure();
    }
    const auth = await readBoundedJsonResponse<{ token?: unknown }>(response, 16_384, signal);
    if (typeof auth.token !== "string" || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(auth.token))
      throw failure();
    async function digest(tag: string): Promise<string | null> {
      const manifest = await fetch(`${REGISTRY}/v2/${REPOSITORY}/manifests/${tag}`, {
        method: "HEAD",
        redirect: "error",
        signal,
        headers: { accept: INDEX_TYPES.join(", "), authorization: `Bearer ${auth.token}` },
      });
      cancelResponseBody(manifest);
      if (manifest.status === 404) return null;
      if (
        !manifest.ok ||
        !INDEX_TYPES.includes(
          (manifest.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "",
        )
      )
        throw failure();
      const value = manifest.headers.get("docker-content-digest");
      if (!value || !/^sha256:[a-f0-9]{64}$/.test(value)) throw failure();
      return value;
    }
    const [immutable, rolling] = await Promise.all([
      digest(`sha-${revision}`),
      digest(channel === "stable" ? "latest" : "edge"),
    ]);
    return immutable !== null && immutable === rolling;
  }
  return {
    channel,
    async check() {
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
        if (!(await published(commit.sha, signal))) return null;
        return { revision: commit.sha, version };
      } catch {
        throw failure();
      }
    },
    async submit() {
      try {
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
