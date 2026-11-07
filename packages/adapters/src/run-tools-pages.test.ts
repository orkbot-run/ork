// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache tests are preserved; shared-page approval races are Ork additions.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { prepareToolRequest } from "./run-tool-request.js";

const publishMessage = vi.fn();
vi.mock("./run-messages.js", async (importActual) => ({
  ...(await importActual<typeof import("./run-messages.js")>()),
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));

const { pageTools, preparePageSaveRequest } = await import("./run-tools-pages.js");
const { redactBlocks } = await import("./run-messages.js");

const source = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Text>Hi</Text>\n  </Page>\n);\nexport default App;\n`;

function context(
  tx: Record<string, unknown>,
  existing?: {
    currentVersion: number;
    visibility?: string;
    shareTokenHash?: string | null;
    source?: string;
  },
  secrets: string[] = [],
) {
  const prisma = {
    page: {
      findFirst: vi.fn(async () =>
        existing
          ? {
              id: "page-1",
              title: "Plan",
              currentVersion: existing.currentVersion,
              visibility: existing.visibility ?? "private",
              shareTokenHash: existing.shareTokenHash ?? null,
              versions: [{ source: existing.source ?? source("Plan") }],
            }
          : null,
      ),
    },
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)),
  };
  return {
    deps: { prisma },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "bot-1" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    secrets,
    state: { tainted: false },
  } as never;
}

const call = (args: Record<string, unknown>) =>
  ({ args, finish: (result: unknown) => result }) as never;

describe("save_page", () => {
  beforeEach(() => publishMessage.mockReset());

  it("keeps a saved page when its chat card cannot be posted, and says how to link it", async () => {
    publishMessage.mockRejectedValueOnce(new Error("run was cancelled"));
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const result = (await pageTools.save_page!(
      context(tx),
      call({ title: "Plan", source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pageId: "page-1", version: 1, title: "Plan" });
    expect(result.error).toMatch(/saved, but its card could not be posted/);
    expect(result.error).toContain("[Plan](page:page-1)");
  });

  it("taints the run when it reads a page's stored source, but not when it saves one", async () => {
    const read = context({}, { currentVersion: 2 });
    const result = (await pageTools.save_page!(read, call({ pageId: "page-1" }))) as Record<
      string,
      unknown
    >;
    expect(result.source).toBe(source("Plan"));
    expect((read as { state: { tainted: boolean } }).state.tainted).toBe(true);

    const tx = { page: { create: vi.fn(async () => ({ id: "page-2", title: "New" })) } };
    const save = context(tx);
    await pageTools.save_page!(save, call({ title: "New", source: source("New") }));
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect((save as { state: { tainted: boolean } }).state.tainted).toBe(false);
  });

  it("treats an empty edits list as not sent, as it does a blank title or source", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const created = (await pageTools.save_page!(
      context(tx),
      call({ title: "Plan", source: source("Plan"), edits: [] }),
    )) as Record<string, unknown>;
    expect(created).toMatchObject({ pageId: "page-1", version: 1 });
    expect(tx.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versions: { create: expect.objectContaining({ code: expect.stringContaining("Plan") }) },
      }),
    });
    // Reading a page back with an empty list returns its source rather than an error.
    const read = (await pageTools.save_page!(
      context({}, { currentVersion: 3 }),
      call({ pageId: "page-1", edits: [], source: "" }),
    )) as Record<string, unknown>;
    expect(read).toEqual({ pageId: "page-1", version: 3, title: "Plan", source: source("Plan") });
  });

  it("never stores a run secret in a page's source, title or chat card", async () => {
    const secret = "FAKE_PAGE_SECRET_7246";
    const tx = {
      page: {
        create: vi.fn(async ({ data }: { data: { title: string } }) => ({
          id: "page-1",
          title: data.title,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      pageVersion: { create: vi.fn() },
    };
    const refused = [
      call({ title: "Plan", source: source(secret) }),
      call({ pageId: "page-1", source: source(secret) }),
      call({ pageId: "page-1", edits: [{ find: 'title="Plan"', replace: `title="${secret}"` }] }),
    ];
    for (const [index, args] of refused.entries()) {
      const existing = index === 0 ? undefined : { currentVersion: 1 };
      const result = (await pageTools.save_page!(context(tx, existing, [secret]), args)) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/secret/) });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(tx.page.create).not.toHaveBeenCalled();
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();

    const titled = (await pageTools.save_page!(
      context(tx, undefined, [secret]),
      call({ title: `Keys ${secret}`, source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(titled.title).toBe("Keys [redacted]");
    expect(JSON.stringify(tx.page.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
    // A page card in a run's reply is redacted like its text.
    expect(
      redactBlocks(
        [{ kind: "page", pageId: "page-1", version: 1, title: `A ${secret}` }],
        [secret],
      ),
    ).toEqual([{ kind: "page", pageId: "page-1", version: 1, title: "A [redacted]" }]);
    // Step labels can come from tool arguments, so they are redacted like notes.
    expect(
      redactBlocks([{ kind: "steps", steps: [{ label: `Run ${secret}`, count: 1 }] }], [secret]),
    ).toEqual([{ kind: "steps", steps: [{ label: "Run [redacted]", count: 1 }] }]);
  });

  it("redacts a kept title that holds a secret this run learned after it was saved", async () => {
    const secret = "FAKE_PAGE_SECRET_9132";
    const tx = {
      page: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ title: `Keys ${secret}` })),
        update: vi.fn(),
      },
      pageVersion: { create: vi.fn() },
    };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 1 }, [secret]),
      call({ pageId: "page-1", source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(result.title).toBe("Keys [redacted]");
    expect(tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { title: "Keys [redacted]" },
    });
    expect(JSON.stringify(tx.pageVersion.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
  });
});

describe("shared-page approval", () => {
  const existing = () => ({ currentVersion: 2, visibility: "link", shareTokenHash: "hash-1" });
  const write = () => ({ pageId: "page-1", source: source("Revised") });

  it("pins the approved content and sharing, with a redacted once-only card", async () => {
    const secret = "fake-page-title-secret";
    const ctx = context({}, existing(), [secret]);
    const request = { name: "save_page", args: { ...write(), title: `Plan ${secret}` } };
    expect(await prepareToolRequest(ctx, request as never)).toBeUndefined();
    expect(request).toMatchObject({ heldForApproval: true, mandatoryApproval: true });
    const prepared = request as unknown as {
      args: Record<string, unknown>;
      fleetSummary: never;
      effectRequest: unknown;
    };
    expect(prepared.effectRequest).toEqual(prepared.args);
    expect(prepared.args.pageSaveBaseline).toEqual({
      ...existing(),
      titleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const block = buildApprovalAskBlock("effect-1", "save_page", prepared.args, [secret], {
      summary: prepared.fleetSummary,
    });
    expect(JSON.stringify(prepared.args)).not.toContain(secret);
    expect(JSON.stringify(block)).not.toContain(secret);
    expect(block).toMatchObject({
      detail: expect.stringContaining('-   <Page title="Plan">'),
      actions: [{ id: "allow" }, { id: "deny" }],
    });
  });

  it("drops model-supplied approval metadata and refuses replay without a pinned baseline", async () => {
    const result = await preparePageSaveRequest(
      context({}, existing()),
      { ...write(), pageSaveBaseline: { currentVersion: 99 } },
      false,
    );
    expect(result).toMatchObject({ args: { pageSaveBaseline: { currentVersion: 2 } } });
    await expect(
      preparePageSaveRequest(context({}, existing()), write(), true),
    ).resolves.toHaveProperty("error");
  });

  it.each([
    { currentVersion: 3, visibility: "link", shareTokenHash: "hash-1" },
    { currentVersion: 2, visibility: "private", shareTokenHash: null },
    { currentVersion: 2, visibility: "link", shareTokenHash: "hash-2" },
  ])("rejects a stale approved write before changing state: %j", async (changed) => {
    const prepared = await preparePageSaveRequest(context({}, existing()), write(), false);
    if ("error" in prepared) throw Error(prepared.error);
    await expect(
      preparePageSaveRequest(context({}, changed), prepared.args, true),
    ).resolves.toHaveProperty("error");
    const tx = { page: { updateMany: vi.fn() } };
    expect(
      await pageTools.save_page!(context(tx, changed), {
        args: prepared.args,
        claimedEffect: true,
        bypassApproval: false,
        finish: (r: unknown) => r,
      } as never),
    ).toMatchObject({ unchanged: true });
    expect(tx.page.updateMany).not.toHaveBeenCalled();
  });

  it("requires a fresh approval when a private page becomes link-visible", async () => {
    const prepared = await preparePageSaveRequest(
      context({}, { currentVersion: 2 }),
      write(),
      false,
    );
    if ("error" in prepared) throw Error(prepared.error);
    const tx = { page: { updateMany: vi.fn() } };
    expect(
      await pageTools.save_page!(context(tx, existing()), {
        args: prepared.args,
        finish: (r: unknown) => r,
      } as never),
    ).toMatchObject({ unchanged: true });
    expect(tx.page.updateMany).not.toHaveBeenCalled();
  });

  it("refuses oversized review detail instead of approving a truncated change", async () => {
    await expect(
      preparePageSaveRequest(
        context({}, existing()),
        { pageId: "page-1", source: source("x".repeat(5000)) },
        false,
      ),
    ).resolves.toMatchObject({ error: expect.stringContaining("too large") });
  });

  it("keeps a small edit reviewable in a large page by omitting unchanged lines", async () => {
    const previous = `// ${"unchanged".repeat(1000)}\n// context\n${source("Plan")}`;
    const prepared = await preparePageSaveRequest(
      context({}, { ...existing(), source: previous }),
      { pageId: "page-1", edits: [{ find: 'title="Plan"', replace: 'title="Revised"' }] },
      false,
    );
    if ("error" in prepared) throw Error(prepared.error);
    expect(prepared.summary?.lines.join("\n")).not.toContain("unchanged".repeat(1000));
    expect(prepared.summary?.lines.join("\n")).toContain('+   <Page title="Revised">');
    expect(prepared.args.source).toBe(previous.replace('title="Plan"', 'title="Revised"'));
  });

  it("rejects a secret-bearing proposal before it can become a stored approval request", async () => {
    const secret = "fake-proposal-secret";
    const prepared = await preparePageSaveRequest(
      context({}, existing(), [secret]),
      {
        pageId: "page-1",
        source: source(secret),
      },
      false,
    );
    expect(prepared).toMatchObject({ error: expect.stringContaining("contains a secret") });
    expect(prepared).not.toHaveProperty("args");
  });

  it("compares sharing state atomically with the version when the approved save executes", async () => {
    const tx = {
      page: { updateMany: vi.fn(async () => ({ count: 0 })) },
      pageVersion: { create: vi.fn() },
    };
    const prepared = await preparePageSaveRequest(context({}, existing()), write(), false);
    if ("error" in prepared) throw Error(prepared.error);
    const result = await pageTools.save_page!(context(tx, existing()), {
      args: prepared.args,
      claimedEffect: true,
      bypassApproval: false,
      finish: (r: unknown) => r,
    } as never);
    expect(result).toMatchObject({ unchanged: true });
    expect(tx.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "page-1",
          currentVersion: 2,
          visibility: "link",
          shareTokenHash: "hash-1",
          title: "Plan",
        },
      }),
    );
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
  });
});
