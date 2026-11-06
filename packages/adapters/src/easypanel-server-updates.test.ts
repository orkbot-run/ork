// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it, vi } from "vitest";
import { createEasypanelServerUpdateAdapter } from "./easypanel-server-updates.js";

const trigger = "https://panel.example.test/api/compose/deploy/fixture-deploy-token";
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const INDEX = "application/vnd.oci.image.index.v1+json";
const ciUrl = `https://api.github.com/repos/orkbot-run/ork/actions/workflows/ci.yml/runs?head_sha=${revision}&event=push&per_page=1`;
const successfulRun = {
  head_sha: revision,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};
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
    if (url.includes("/actions/workflows/ci.yml/runs?"))
      return Response.json({
        workflow_runs: [{ ...successfulRun, head_sha: new URL(url).searchParams.get("head_sha") }],
      });
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
      ciUrl,
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
    await expect(adapter.check()).resolves.toMatchObject({ revision });
    await expect(adapter.submit(revision)).resolves.toBeUndefined();
    const requests = fetch.mock.calls.filter(([url]) => url === trigger);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(requests[0]?.[1]?.headers).toBeUndefined();
    expect(requests[0]?.[1]?.body).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => url === ciUrl)).toHaveLength(2);
  });

  it.each([302, 400, 500])(
    "does not retry or leak a failed trigger response %s",
    async (status) => {
      const { adapter, fetch } = fixture("stable", {
        [trigger]: () => new Response(trigger, { status }),
      });
      await expect(adapter.submit(revision)).rejects.toThrow(
        /^Could not contact the deployment service\.$/,
      );
      expect(fetch.mock.calls.filter(([url]) => url === trigger)).toHaveLength(1);
    },
  );

  it("sanitizes thrown network errors and never retries ambiguous submissions", async () => {
    const { adapter, fetch } = fixture("stable", {
      [trigger]: () => {
        throw new Error(trigger);
      },
    });
    await expect(adapter.submit(revision)).rejects.toThrow(
      /^Could not contact the deployment service\.$/,
    );
    expect(fetch.mock.calls.filter(([url]) => url === trigger)).toHaveLength(1);
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

  it.each([
    ["queued", { status: "queued", conclusion: null }],
    ["running", { status: "in_progress", conclusion: null }],
    ["failed", { conclusion: "failure" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["timed out", { conclusion: "timed_out" }],
    ["neutral", { conclusion: "neutral" }],
    ["wrong revision", { head_sha: "c".repeat(40) }],
    ["wrong branch", { head_branch: "other" }],
    ["wrong event", { event: "pull_request" }],
  ])("withholds a candidate for %s official CI", async (_name, overrides) => {
    const { adapter, fetch } = fixture("preview", {
      [ciUrl]: () =>
        Response.json({ workflow_runs: [{ ...successfulRun, ...(overrides as object) }] }),
    });
    await expect(adapter.check()).resolves.toBeNull();
    await expect(adapter.submit(revision)).rejects.toThrow(
      /^Could not contact the deployment service\.$/,
    );
    expect(
      fetch.mock.calls.some(
        ([url]) => String(url).startsWith("https://ghcr.io") || url === trigger,
      ),
    ).toBe(false);
  });

  it.each([() => Response.json({ workflow_runs: [] }), () => new Response(null, { status: 404 })])(
    "withholds missing official CI and refuses submission",
    async (response) => {
      const { adapter, fetch } = fixture("preview", { [ciUrl]: response });
      await expect(adapter.check()).resolves.toBeNull();
      await expect(adapter.submit(revision)).rejects.toThrow();
      expect(fetch.mock.calls.some(([url]) => url === trigger)).toBe(false);
    },
  );

  it("rechecks CI after discovery and refuses a now-cancelled run before posting", async () => {
    let cancelled = false;
    const { adapter, fetch } = fixture("preview", {
      [ciUrl]: () =>
        Response.json({
          workflow_runs: [{ ...successfulRun, conclusion: cancelled ? "cancelled" : "success" }],
        }),
    });
    await expect(adapter.check()).resolves.toMatchObject({ revision });
    cancelled = true;
    await expect(adapter.submit(revision)).rejects.toThrow();
    expect(fetch.mock.calls.some(([url]) => url === trigger)).toBe(false);
  });

  it("refuses a changed published candidate even when its CI also succeeds", async () => {
    let moved = false;
    const { adapter, fetch } = fixture("preview", {
      "https://api.github.com/repos/orkbot-run/ork/commits?sha=main&per_page=1": () =>
        Response.json([{ sha: moved ? "c".repeat(40) : revision }]),
    });
    await expect(adapter.check()).resolves.toMatchObject({ revision });
    moved = true;
    await expect(adapter.submit(revision)).rejects.toThrow();
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes(`manifests/sha-${"c".repeat(40)}`)),
    ).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url === trigger)).toBe(false);
  });

  it("rechecks the rolling manifest before posting", async () => {
    let moved = false;
    const { adapter, fetch } = fixture("preview", {
      "https://ghcr.io/v2/orkbot-run/ork/app/manifests/edge": () =>
        new Response(null, {
          headers: {
            "content-type": INDEX,
            "docker-content-digest": moved ? `sha256:${"c".repeat(64)}` : digest,
          },
        }),
    });
    await expect(adapter.check()).resolves.toMatchObject({ revision });
    moved = true;
    await expect(adapter.submit(revision)).rejects.toThrow();
    expect(fetch.mock.calls.some(([url]) => url === trigger)).toBe(false);
  });

  it("rejects malformed expected revisions before any request", async () => {
    const { adapter, fetch } = fixture();
    await expect(adapter.submit("main")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
