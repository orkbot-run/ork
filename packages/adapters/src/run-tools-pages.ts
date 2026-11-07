// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; shared-page approval fencing is an Ork addition.
// Ork changes consolidate database error matching through the shared database predicates.

import { createHash } from "node:crypto";
import type { MessageBlock } from "@orkbot/contracts";
import { PAGE_TITLE_MAX_LENGTH, PageTitleSchema } from "@orkbot/contracts";
import { containsSecret, instructionUpdateDiff, redactSecrets } from "@orkbot/core";
import { isUniqueViolation } from "@orkbot/db";
import { checkPageSource, PAGE_KIT_GUIDE } from "@orkbot/page-kit/validate";
import type { FleetCardSummary } from "./approval-ask.js";
import { MAX_APPROVAL_DETAIL_LENGTH } from "./approval-ask.js";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argumentGiven } from "./update-bot-patch.js";

const MAX_EDITS = 50;

type PageBaseline = {
  currentVersion: number;
  titleHash: string;
  visibility: string;
  shareTokenHash: string | null;
};

function pageBaseline(value: unknown): PageBaseline | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as PageBaseline;
  if (
    !Number.isSafeInteger(row.currentVersion) ||
    row.currentVersion < 1 ||
    typeof row.titleHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.titleHash) ||
    !["private", "link"].includes(row.visibility) ||
    !(row.shareTokenHash === null || typeof row.shareTokenHash === "string")
  )
    return undefined;
  return row;
}

function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex");
}

/** Keep changed lines and their immediate context; unchanged source stays pinned by version. */
function pageChangeDiff(before: string, after: string): string {
  const previous = before.split("\n");
  const next = after.split("\n");
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  if (start === previous.length && start === next.length) return "";
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd--;
    nextEnd--;
  }
  return [
    `@@ -${start + 1},${previousEnd - start} +${start + 1},${nextEnd - start} @@`,
    ...(start ? [`  ${previous[start - 1]}`] : []),
    ...previous.slice(start, previousEnd).map((line) => `- ${line}`),
    ...next.slice(start, nextEnd).map((line) => `+ ${line}`),
    ...(previousEnd < previous.length ? [`  ${previous[previousEnd]}`] : []),
  ].join("\n");
}

async function loadPage(ctx: RunContext, pageId: string) {
  return ctx.deps.prisma.page.findFirst({
    where: {
      id: pageId,
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      OR: ctx.thread.groupId
        ? [{ botId: ctx.bot.id }, { groupId: ctx.thread.groupId }]
        : [{ botId: ctx.bot.id }],
    },
    select: {
      id: true,
      title: true,
      currentVersion: true,
      visibility: true,
      shareTokenHash: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { source: true } },
    },
  });
}

/** Resolve edits before approval and bind the write to the exact content and sharing state. */
export async function preparePageSaveRequest(
  ctx: RunContext,
  given: Record<string, unknown>,
  approved: boolean,
): Promise<{ args: Record<string, unknown>; summary?: FleetCardSummary } | { error: string }> {
  const { pageSaveBaseline: supplied, ...args } = given;
  if (args.help === true || !argumentGiven(args.pageId)) return { args };
  const page = await loadPage(ctx, String(args.pageId));
  if (!page)
    return approved ? { error: "No page with that pageId belongs to this bot or chat." } : { args };
  const hasEdits = Array.isArray(args.edits) ? args.edits.length > 0 : argumentGiven(args.edits);
  if (!argumentGiven(args.source) && !hasEdits && !argumentGiven(args.title)) return { args };
  const baseline = approved
    ? pageBaseline(supplied)
    : {
        currentVersion: page.currentVersion,
        titleHash: titleHash(page.title),
        visibility: page.visibility,
        shareTokenHash: page.shareTokenHash,
      };
  if (
    !baseline ||
    baseline.currentVersion !== page.currentVersion ||
    (baseline.visibility === "link" && baseline.titleHash !== titleHash(page.title)) ||
    baseline.visibility !== page.visibility ||
    baseline.shareTokenHash !== page.shareTokenHash
  )
    return { error: "The page or its sharing changed; read it again and request a new approval." };
  // Private saves keep their existing validation and rename behavior. The sharing/version
  // fence still rejects one that becomes public before the handler commits it.
  if (page.visibility !== "link") return { args: { ...args, pageSaveBaseline: baseline } };
  if (argumentGiven(args.source) && hasEdits)
    return { error: "Send either source or edits, not both." };
  let source = argumentGiven(args.source) ? String(args.source) : (page.versions[0]?.source ?? "");
  if (hasEdits) {
    const edits = parseEdits(args.edits);
    if (typeof edits === "string") return { error: edits };
    const applied = applyPageEdits(source, edits);
    if (!applied.ok) return { error: applied.error };
    source = applied.source;
  }
  const parsed = PageTitleSchema.safeParse(argumentGiven(args.title) ? args.title : page.title);
  if (!parsed.success) return { error: "title must be 1 to 200 characters." };
  const title = redactSecrets(parsed.data, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
  const check = checkPageSource(source);
  if (!check.ok) return { error: "The page has problems; nothing was saved." };
  if (containsSecret([source, check.code], ctx.secrets))
    return {
      error: "The page contains a secret value; nothing was saved. Remove it and save again.",
    };
  const canonical = { pageId: page.id, source, title, pageSaveBaseline: baseline };
  const detail = redactSecrets(
    [
      "This page is visible to anyone with its link.",
      `Version: ${page.currentVersion}`,
      ...(title !== page.title ? [instructionUpdateDiff(page.title, title)] : []),
      pageChangeDiff(page.versions[0]?.source ?? "", source),
    ].join("\n"),
    ctx.secrets,
  );
  if (detail.length > MAX_APPROVAL_DETAIL_LENGTH)
    return { error: "The shared-page change is too large to review; nothing was saved." };
  return {
    args: canonical,
    summary: {
      title: `Update shared page “${redactSecrets(page.title, ctx.secrets)}”?`,
      lines: [detail],
      onceOnly: true,
    },
  };
}

type PageEdit = { find: string; replace: string };

/** All edits or none: each `find` must occur exactly once in the result of the edits before it. */
function applyPageEdits(
  source: string,
  edits: readonly PageEdit[],
): { ok: true; source: string } | { ok: false; error: string } {
  let next = source;
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    if (!edit.find) return { ok: false, error: `${label}: find is empty.` };
    const at = next.indexOf(edit.find);
    if (at === -1) return { ok: false, error: `${label}: find text was not found in the page.` };
    if (next.indexOf(edit.find, at + 1) !== -1) {
      return {
        ok: false,
        error: `${label}: find text occurs more than once; include more surrounding text.`,
      };
    }
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  }
  return { ok: true, source: next };
}

function parseEdits(value: unknown): PageEdit[] | string {
  if (!Array.isArray(value) || value.length === 0) return "edits must be a non-empty list.";
  if (value.length > MAX_EDITS) return `Send at most ${MAX_EDITS} edits at once.`;
  const edits: PageEdit[] = [];
  for (const [index, item] of value.entries()) {
    const edit = item as Partial<PageEdit> | null;
    if (typeof edit?.find !== "string" || typeof edit.replace !== "string") {
      return `Edit ${index + 1}: needs find and replace strings.`;
    }
    edits.push({ find: edit.find, replace: edit.replace });
  }
  return edits;
}

async function savePage(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread } = ctx;
  const { args } = call;
  if (args.help === true) return { guide: PAGE_KIT_GUIDE };
  const pageId = argumentGiven(args.pageId) ? String(args.pageId) : undefined;
  const hasSource = argumentGiven(args.source);
  // Serializers send unused optional fields blank, an empty list included.
  const hasEdits = Array.isArray(args.edits) ? args.edits.length > 0 : argumentGiven(args.edits);
  if (hasSource && hasEdits) return { error: "Send either source or edits, not both." };
  let title: string | undefined;
  if (argumentGiven(args.title)) {
    const parsed = PageTitleSchema.safeParse(args.title);
    if (!parsed.success) return { error: "title must be 1 to 200 characters." };
    title = redactSecrets(parsed.data, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
  }

  // A bot reaches its own pages and its group's pages, from any of its chats or routines; another
  // bot's page answers as if it did not exist, since its source may hold that chat's text.
  const page = pageId ? await loadPage(ctx, pageId) : null;
  if (pageId && !page) return { error: "No page with that pageId belongs to this bot or chat." };
  const current = page?.versions[0]?.source ?? "";

  if (page && !hasSource && !hasEdits && !title) {
    // The stored source may hold outside text an earlier run put in the page, so reading it
    // taints this run like any other outside content; saves only confirm this run's own write.
    ctx.state.tainted = true;
    return { pageId: page.id, version: page.currentVersion, title: page.title, source: current };
  }
  if (!page && hasEdits) return { error: "edits need the pageId of the page to change." };
  if (!page && !hasSource) return { error: "A new page needs source." };
  if (!page && !title) return { error: "A new page needs a title." };

  const baseline = pageBaseline(args.pageSaveBaseline);
  if (
    page &&
    ((page.visibility === "link" && (!baseline || !call.claimedEffect || call.bypassApproval)) ||
      (baseline &&
        (baseline.currentVersion !== page.currentVersion ||
          (baseline.visibility === "link" && baseline.titleHash !== titleHash(page.title)) ||
          baseline.visibility !== page.visibility ||
          baseline.shareTokenHash !== page.shareTokenHash)))
  )
    return {
      error: "The page or its sharing changed; read it again and request a new approval.",
      unchanged: true,
    };

  let source = hasSource ? String(args.source) : current;
  if (hasEdits) {
    const edits = parseEdits(args.edits);
    if (typeof edits === "string") return { error: edits, unchanged: true };
    const applied = applyPageEdits(current, edits);
    if (!applied.ok) return { error: applied.error, unchanged: true };
    source = applied.source;
  }
  const check = checkPageSource(source);
  if (!check.ok) {
    return { error: "The page has problems; nothing was saved.", problems: check.errors };
  }
  // A page can be shared by link, so it never stores a value this run keeps secret.
  if (containsSecret([source, check.code], ctx.secrets)) {
    return {
      error: "The page contains a secret value; nothing was saved. Remove it and save again.",
      unchanged: true,
    };
  }

  let saved: { pageId: string; version: number; title: string };
  try {
    saved = await deps.prisma.$transaction(async (tx) => {
      if (!page) {
        const created = await tx.page.create({
          data: {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: bot.id,
            groupId: thread.groupId,
            title: title!,
            versions: { create: { version: 1, title: title!, source, code: check.code } },
          },
        });
        return { pageId: created.id, version: 1, title: created.title };
      }
      const version = page.currentVersion + 1;
      // Compare the version and sharing state used by the proposal, including concurrent renames.
      const moved = await tx.page.updateMany({
        where: {
          id: page.id,
          currentVersion: page.currentVersion,
          visibility: page.visibility,
          shareTokenHash: page.shareTokenHash,
          ...(baseline?.visibility === "link" ? { title: page.title } : {}),
        },
        data: { currentVersion: version, title, updatedAt: new Date() },
      });
      if (moved.count === 0) throw new PageChangedError();
      let nextTitle =
        title ??
        (await tx.page.findUniqueOrThrow({ where: { id: page.id }, select: { title: true } }))
          .title;
      // A title saved before this run learned a secret is redacted before it is shown again.
      const kept = redactSecrets(nextTitle, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
      if (kept !== nextTitle) {
        nextTitle = kept;
        await tx.page.update({ where: { id: page.id }, data: { title: kept } });
      }
      await tx.pageVersion.create({
        data: { pageId: page.id, version, title: nextTitle, source, code: check.code },
      });
      return { pageId: page.id, version, title: nextTitle };
    });
  } catch (error) {
    if (error instanceof PageChangedError || isUniqueViolation(error)) {
      return { error: "The page changed while saving; read it again and retry.", unchanged: true };
    }
    throw error;
  }
  const block: MessageBlock = { kind: "page", ...saved };
  const linkText = saved.title.replace(/[\\[\]]/g, "\\$&");
  try {
    // A routine speaks only through its final reply, which may be silence, so refreshing a
    // page it already showed posts no card; its first save still does.
    if (!page || run.trigger !== "routine") await publishMessage(deps, run, "bot", [block]);
  } catch (error) {
    // The page is saved; only its card in the chat is missing, so the bot can still link it.
    return {
      ...saved,
      error: `The page was saved, but its card could not be posted in the chat (${
        error instanceof Error ? error.message : "unknown error"
      }). Link it in your reply as [${linkText}](page:${saved.pageId}).`,
    };
  }
  const result = {
    ...saved,
    mention: `Mention it in your reply as [${linkText}](page:${saved.pageId})`,
  };
  return check.warnings?.length ? { ...result, warnings: check.warnings } : result;
}

class PageChangedError extends Error {}

export const pageTools: ToolHandlers = {
  async save_page(ctx, call) {
    return call.finish(await savePage(ctx, call));
  },
};
