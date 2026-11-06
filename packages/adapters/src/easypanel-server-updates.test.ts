// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it, vi } from "vitest";
import { createEasypanelServerUpdateAdapter } from "./easypanel-server-updates.js";

const trigger = "https://panel.example.test/api/deploy/fixture-deploy-token";
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const INDEX = "application/vnd.oci.image.index.v1+json";
function fixture(
  channel: "stable" | "preview" = "stable",
  overrides: Record<string, () => Response> = {},
) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const replacement = overrides[url];
    if (replacement) return replacement();
    if (url === trigger) return new Response(null, { status: 202 });
    if (url.endsWith("/releases/latest"))
      return Response.json({ tag_name: "v1.2.3", draft: false, prerelease: false });
    if (url.includes("/commits?")) return Response.json([{ sha: revision }]);
    if (url.includes("/compare/")) return Response.json({ status: "ahead" });
    if (url.startsWith("https://ghcr.io/token?")) {
      expect(init?.headers).toBeUndefined();
      return Response.json({ token: "fixture-public-pull-capability" });
    }
    if (url.includes("/manifests/")) {
      expect(init?.method).toBe("HEAD");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer fixture-public-pull-capability",
      });
      return new Response(null, {
        headers: { "content-type": INDEX, "docker-content-digest": digest },
      });
    }
    throw new Error("Unexpected endpoint.");
  });
  return {
    fetch,
    adapter: createEasypanelServerUpdateAdapter(
      { channel, deploymentTrigger: trigger, currentRevision: "9".repeat(40) },
      { fetch },
    ),
  };
}

describe("configured channel deployment adapter", () => {
  it("checks official stable release, full commit and matching published rolling/immutable manifests", async () => {
    const { adapter, fetch } = fixture();
    await expect(adapter.check()).resolves.toEqual({ revision, version: "v1.2.3" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/orkbot-run/ork/releases/latest",
      "https://api.github.com/repos/orkbot-run/ork/commits?sha=v1.2.3&per_page=1",
      `https://api.github.com/repos/orkbot-run/ork/compare/${"9".repeat(40)}...${revision}?per_page=1&page=2`,
      "https://ghcr.io/token?service=ghcr.io&scope=repository:orkbot-run/ork/app:pull",
      `https://ghcr.io/v2/orkbot-run/ork/app/manifests/sha-${revision}`,
      "https://ghcr.io/v2/orkbot-run/ork/app/manifests/latest",
    ]);
    expect(fetch.mock.calls.some(([url]) => url === trigger)).toBe(false);
  });

  it("preview checks official main and edge without offering unpublished commits", async () => {
    const { adapter } = fixture("preview");
    await expect(adapter.check()).resolves.toEqual({ revision, version: "edge" });
    const stale = fixture("preview", {
      "https://ghcr.io/v2/orkbot-run/ork/app/manifests/edge": () =>
        new Response(null, {
          headers: { "content-type": INDEX, "docker-content-digest": `sha256:${"c".repeat(64)}` },
        }),
    });
    await expect(stale.adapter.check()).resolves.toBeNull();
    const missing = fixture("preview", {
      [`https://ghcr.io/v2/orkbot-run/ork/app/manifests/sha-${revision}`]: () =>
        new Response(null, { status: 404 }),
    });
    await expect(missing.adapter.check()).resolves.toBeNull();
  });

  it("returns no candidate before the first stable release", async () => {
    const { adapter } = fixture("stable", {
      "https://api.github.com/repos/orkbot-run/ork/releases/latest": () =>
        new Response(null, { status: 404 }),
    });
    await expect(adapter.check()).resolves.toBeNull();
  });

  it.each(["v1.2.3-rc.1", "../main", "v01.2.3", "v1.2.3/other"])(
    "rejects invalid release %s before using it in a path",
    async (tag_name) => {
      const { adapter, fetch } = fixture("stable", {
        "https://api.github.com/repos/orkbot-run/ork/releases/latest": () =>
          Response.json({ tag_name, draft: false, prerelease: false }),
      });
      await expect(adapter.check()).rejects.toThrow("Could not contact the deployment service.");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    () => Response.json([{ sha: "abc123" }]),
    () => new Response("x".repeat(65_537)),
    () => new Response(null, { status: 302, headers: { location: trigger } }),
    () => new Response(null, { status: 429 }),
  ])("bounds and validates official metadata without reflecting responses", async (response) => {
    const { adapter } = fixture("preview", {
      "https://api.github.com/repos/orkbot-run/ork/commits?sha=main&per_page=1": response,
    });
    await expect(adapter.check()).rejects.toThrow("Could not contact the deployment service.");
  });

  it("submits exactly one credential-free request and treats acknowledgement only as requested", async () => {
    const { adapter, fetch } = fixture();
    await expect(adapter.submit()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each([302, 400, 500])(
    "does not retry or leak a failed trigger response %s",
    async (status) => {
      const { adapter, fetch } = fixture("stable", {
        [trigger]: () => new Response(trigger, { status }),
      });
      await expect(adapter.submit()).rejects.toThrow(
        /^Could not contact the deployment service\.$/,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes thrown network errors and never retries ambiguous submissions", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(trigger);
    });
    const adapter = createEasypanelServerUpdateAdapter(
      { channel: "stable", deploymentTrigger: trigger, currentRevision: revision },
      { fetch },
    );
    await expect(adapter.submit()).rejects.toThrow(/^Could not contact the deployment service\.$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["behind", "diverged", "identical"])(
    "refuses %s candidates before contacting the registry",
    async (status) => {
      const { adapter, fetch } = fixture("preview", {
        [`https://api.github.com/repos/orkbot-run/ork/compare/${"9".repeat(40)}...${revision}?per_page=1&page=2`]:
          () => Response.json({ status }),
      });
      await expect(adapter.check()).resolves.toBeNull();
      expect(fetch.mock.calls.some(([url]) => String(url).startsWith("https://ghcr.io"))).toBe(
        false,
      );
    },
  );

  it("does not offer automatic candidates when the running revision cannot be verified", async () => {
    const fetch = vi.fn();
    const adapter = createEasypanelServerUpdateAdapter(
      { channel: "stable", deploymentTrigger: trigger, currentRevision: null },
      { fetch },
    );
    await expect(adapter.check()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
