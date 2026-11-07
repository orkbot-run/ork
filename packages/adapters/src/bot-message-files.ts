// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited artifact/version and workspace primitives are preserved; delegated file delivery is an Ork addition.

import { createHash } from "node:crypto";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@orkbot/adapter-kit";
import type { ComputerMode, MessageBlock } from "@orkbot/contracts";
import {
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  MessageBlock as MessageBlockSchema,
} from "@orkbot/contracts";
import {
  inferAttachmentMimeType,
  messageBlockForArtifact,
  userTurnMessageForRun,
  withAbort,
} from "@orkbot/core";
import type { Artifact, Computer, Prisma } from "@orkbot/db";
import {
  assertRunCanWriteHistory,
  parseComputerMode,
  resolveArtifactVersionInTransaction,
} from "@orkbot/db";
import { archiveBotFiles } from "./bot-file-archive.js";
import {
  normalizeWorkspacePath,
  resolveBotWorkspacePath,
  toComputerRef,
} from "./computer-support.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

type Run = { id: string; spaceId: string; userId: string; botId: string; threadId: string };
export type BotFileSource = {
  computerId: string;
  mode: ComputerMode;
  computer: () => Promise<ComputerRef>;
  context: AdapterContext;
};
export type BotFileTarget = {
  botId: string;
  threadId: string;
  groupId?: string;
  computerId: string | null;
};
type Deps = Pick<ExecutorDeps, "prisma"> &
  Partial<Pick<ExecutorDeps, "sandbox" | "artifacts" | "maxUploadSizeBytes" | "runLease">>;
type FileBlock = Extract<MessageBlock, { kind: "file" | "image" }>;
type WorkspaceFiles = { computerId: string; version: string; paths: string[] };
type Pending = {
  name: string;
  mimeType: string;
  size: number;
  hash: string;
  storageKey: string;
  clientNonce: string;
};

export class BotFileTransferError extends Error {}

export function botFilePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENT_MAX_COUNT)
    throw new BotFileTransferError(`files must contain at most ${ATTACHMENT_MAX_COUNT} paths`);
  return value.map((item) => {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.includes("\0") ||
      Buffer.byteLength(item) > 4096
    )
      throw new BotFileTransferError("files must contain valid paths of at most 4096 bytes");
    try {
      normalizeWorkspacePath(item);
    } catch {
      throw new BotFileTransferError("File path escapes the computer workspace");
    }
    return item;
  });
}

export function botFileComputerVersion(
  computer: Pick<
    Computer,
    "id" | "scope" | "homeKey" | "kind" | "providerRef" | "screenGeneration"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        computer.id,
        computer.scope,
        computer.homeKey,
        computer.kind,
        computer.providerRef,
        computer.screenGeneration,
      ]),
    )
    .digest("hex");
}

/** A queued/resumed delegation must not lose its source when newer history fills the window. */
export async function loadDelegatedFileSource(
  prisma: ExecutorDeps["prisma"],
  run: Run & { trigger: string; sourceMessageId?: string | null },
) {
  if (!run.sourceMessageId || (run.trigger !== "bot_message" && run.trigger !== "follow_up"))
    return undefined;
  const source = await prisma.message.findFirst({
    where: {
      id: run.sourceMessageId,
      threadId: run.threadId,
      thread: { spaceId: run.spaceId, userId: run.userId },
    },
    select: { id: true, role: true, runId: true, blocks: true },
  });
  const blocks = MessageBlockSchema.array().safeParse(source?.blocks);
  if (!source || !blocks.success) return undefined;
  return userTurnMessageForRun(
    run.trigger,
    run.id,
    [{ ...source, blocks: blocks.data }],
    run.sourceMessageId,
    run.botId,
  );
}

/** Prepare bounded objects outside the delivery transaction; publish metadata only with delivery. */
export async function prepareBotFiles(
  deps: Deps,
  run: Run,
  target: BotFileTarget,
  requested: string[],
  deliveryKey: string | undefined,
  source: BotFileSource | undefined,
) {
  if (!requested.length) return undefined;
  if (
    !source ||
    !deliveryKey ||
    !deps.sandbox ||
    source.context.spaceId !== run.spaceId ||
    source.context.userId !== run.userId ||
    source.context.botId !== run.botId ||
    source.context.runId !== run.id
  )
    throw new BotFileTransferError("File transfer is unavailable for this delivery");
  const sandbox = deps.sandbox;
  const context = {
    ...source.context,
    signal: AbortSignal.any([source.context.signal, AbortSignal.timeout(30_000)]),
  };
  const maxBytes = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  const nonces = requested.map((_, index) => `bot-files:${deliveryKey}:${index}`);
  const owner = { spaceId: run.spaceId, userId: run.userId };
  const validateTarget = async (tx: Pick<Prisma.TransactionClient, "bot">) => {
    const [sender, recipient] = await Promise.all([
      tx.bot.findFirst({
        where: {
          id: run.botId,
          ...owner,
          archivedAt: null,
          computerId: source.computerId,
          computerSwitching: false,
        },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: {
          id: target.botId,
          ...owner,
          archivedAt: null,
          computerId: target.computerId,
          computerSwitching: false,
        },
        select: { id: true },
      }),
    ]);
    if (!sender || !recipient)
      throw new BotFileTransferError("File source or recipient is no longer available");
  };
  await validateTarget(deps.prisma);
  if (
    !(await deps.prisma.run.findFirst({
      where: { id: run.id, ...owner, botId: run.botId, threadId: run.threadId, status: "running" },
      select: { id: true },
    }))
  )
    throw new BotFileTransferError("File source run is no longer active");
  // Never reread changed files after an earlier successful delivery; its first snapshot wins.
  const replayed = await deps.prisma.artifact.findMany({
    where: { ...owner, clientNonce: { in: nonces } },
  });
  for (const row of replayed) {
    if (
      row.runId !== run.id ||
      row.botId !== target.botId ||
      row.groupId !== (target.groupId ?? null)
    )
      throw new BotFileTransferError("File delivery belongs to a different recipient");
  }
  const existing = new Map(replayed.map((row) => [row.clientNonce, row]));
  const pending: Pending[] = [];
  let snapshot: Computer | undefined;
  let workspaceFiles: WorkspaceFiles | undefined;
  let paths: string[] = [];
  let metadataStarted = false;
  const cleanup = async (knownSettled = false) => {
    if (metadataStarted && !knownSettled) return;
    if (!deps.artifacts) return;
    const cleanupContext = { ...context, signal: AbortSignal.timeout(2_000) };
    for (const item of pending) {
      try {
        // A lost commit response is not proof of rollback. Never delete a referenced object.
        const kept = await withAbort(
          deps.prisma.artifact.findFirst({
            where: { ...owner, storageKey: item.storageKey },
            select: { id: true },
          }),
          cleanupContext.signal,
        );
        if (!kept)
          await withAbort(
            deps.artifacts.remove(item.storageKey, cleanupContext),
            cleanupContext.signal,
          );
      } catch {
        /* Uncertain ownership keeps the object for recovery. */
      }
    }
  };
  try {
    if (existing.size !== requested.length) {
      const computer = await withAbort(source.computer(), context.signal);
      snapshot =
        (await deps.prisma.computer.findFirst({ where: { id: source.computerId, ...owner } })) ??
        undefined;
      if (
        !snapshot ||
        snapshot.kind !== computer.kind ||
        snapshot.providerRef !== computer.providerRef ||
        parseComputerMode(snapshot.scope) !== source.mode
      )
        throw new BotFileTransferError("File source computer changed during delivery");
      paths = requested.map((item) =>
        normalizeWorkspacePath(resolveBotWorkspacePath(source.mode, run.botId, item)),
      );
      if (new Set(paths).size !== paths.length)
        throw new BotFileTransferError("files must not contain duplicate paths");
      const shared =
        target.computerId === snapshot.id &&
        source.mode === "team" &&
        (await withAbort(
          Promise.resolve(sandbox.sharesWorkspace?.(computer) ?? false),
          context.signal,
        ));
      if (shared)
        workspaceFiles = {
          computerId: snapshot.id,
          version: botFileComputerVersion(snapshot),
          paths,
        };
      if (!sandbox.readTransferFile)
        throw new BotFileTransferError("File transfer is unsupported on this computer");
      if (!shared && !deps.artifacts)
        throw new BotFileTransferError("Attachment storage is unavailable");
      const limits = { maxBytes, maxFiles: 256, maxDepth: 16, maxMetadataBytes: 256 * 1024 };
      for (let index = 0; index < paths.length; index++) {
        if (existing.has(nonces[index]!)) continue;
        context.signal.throwIfAborted();
        const sourcePath = paths[index]!;
        let bytes: Uint8Array;
        let name = path.posix.basename(sourcePath.replace(/\/+$/, "")) || "files";
        let mimeType = inferAttachmentMimeType(name);
        try {
          bytes = await withAbort(
            sandbox.readTransferFile(computer, sourcePath, context, maxBytes),
            context.signal,
          );
        } catch {
          context.signal.throwIfAborted();
          if (!sandbox.exportDirectory)
            throw new BotFileTransferError(
              "File is unreadable or directory transfer is unsupported on this computer",
            );
          try {
            bytes = await archiveBotFiles(
              sandbox.exportDirectory(computer, sourcePath, context, limits),
              limits,
              context.signal,
            );
          } catch {
            context.signal.throwIfAborted();
            throw new BotFileTransferError(
              "Directory is unreadable, unsupported, or exceeds transfer limits",
            );
          }
          name += ".zip";
          mimeType = "application/zip";
        }
        if (bytes.byteLength > maxBytes)
          throw new BotFileTransferError("File exceeds the attachment limit");
        if (shared) continue;
        if (!mimeType) {
          const content = bytes;
          bytes = await archiveBotFiles(
            (async function* () {
              yield { path: name, content };
            })(),
            limits,
            context.signal,
          );
          name += ".zip";
          mimeType = "application/zip";
        }
        name = name.replace(/\p{Cc}/gu, " ").slice(0, ARTIFACT_NAME_MAX_LENGTH);
        const metadata = {
          name,
          mimeType,
          size: bytes.byteLength,
          hash: createHash("sha256").update(bytes).digest("hex"),
          clientNonce: nonces[index]!,
        };
        await withAbort(
          deps.artifacts!.put({ name, mimeType, bytes }, context).then((stored) => {
            pending.push({ ...metadata, storageKey: stored.id });
            if (context.signal.aborted) void cleanup();
          }),
          context.signal,
        );
      }
    }
    return {
      workspaceFiles,
      async commit(tx: Prisma.TransactionClient): Promise<FileBlock[]> {
        context.signal.throwIfAborted();
        const lease = runLeaseFor(deps, run.id);
        if (!lease) throw new BotFileTransferError("File source run is no longer owned");
        const status = await assertRunCanWriteHistory(tx, run.id, { lease });
        if (status?.status !== "running")
          throw new BotFileTransferError("File source run is no longer active");
        await validateTarget(tx);
        if (snapshot) {
          const current = await tx.computer.findFirst({ where: { id: snapshot.id, ...owner } });
          if (!current || botFileComputerVersion(current) !== botFileComputerVersion(snapshot))
            throw new BotFileTransferError("File source computer changed during delivery");
        }
        const blocks: FileBlock[] = [];
        // Stable name order matches the artifact version advisory-lock order across deliveries.
        const rows = new Map<string, Artifact>();
        for (const item of [...pending].sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        )) {
          const params = {
            ...owner,
            botId: target.botId,
            groupId: target.groupId,
            name: item.name,
          };
          const version = await resolveArtifactVersionInTransaction(tx, params);
          const raced = await tx.artifact.findFirst({
            where: { ...owner, clientNonce: item.clientNonce },
          });
          if (raced) {
            if (
              raced.botId !== target.botId ||
              raced.groupId !== (target.groupId ?? null) ||
              raced.runId !== run.id
            )
              throw new BotFileTransferError("File delivery belongs to a different recipient");
            rows.set(item.clientNonce, raced);
          } else {
            context.signal.throwIfAborted();
            metadataStarted = true;
            rows.set(
              item.clientNonce,
              await tx.artifact.create({ data: { ...params, ...item, ...version, runId: run.id } }),
            );
          }
        }
        for (const nonce of nonces) {
          const row = rows.get(nonce) ?? existing.get(nonce);
          if (row) blocks.push(messageBlockForArtifact(row));
        }
        return blocks;
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (source.context.signal.aborted) throw source.context.signal.reason;
    if (error instanceof BotFileTransferError) throw error;
    throw new BotFileTransferError("File transfer failed; no message was delivered");
  }
}

/** Only the current server-owned delegation source may expose a shared workspace reference. */
export async function delegatedFilesInstruction(
  deps: Pick<ExecutorDeps, "prisma" | "sandbox">,
  run: Run,
  computer: Computer,
  blocks: MessageBlock[] | undefined,
): Promise<string> {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  if (!parsed.success) return "";
  const block = parsed.data.find(
    (item) =>
      item.kind === "bot_message_received" ||
      (item.kind === "handoff" && item.toBotId === run.botId),
  );
  if (!block || !("workspaceFiles" in block) || !block.workspaceFiles) return "";
  const files = block.workspaceFiles;
  const source = await deps.prisma.bot.findFirst({
    where: {
      id: block.fromBotId,
      spaceId: run.spaceId,
      userId: run.userId,
      archivedAt: null,
      computerId: files.computerId,
      computerSwitching: false,
    },
    select: { id: true },
  });
  let shared = false;
  if (
    source &&
    computer.providerRef &&
    computer.id === files.computerId &&
    computer.scope === "team" &&
    botFileComputerVersion(computer) === files.version
  ) {
    try {
      shared = (await deps.sandbox.sharesWorkspace?.(toComputerRef(computer))) ?? false;
    } catch {
      /* A changed/unavailable provider cannot authorize a reference. */
    }
  }
  if (!shared)
    return "The delegated shared files are no longer available on this computer. Ask the sender to attach them again.";
  let paths: string[];
  try {
    paths = botFilePaths(files.paths);
    if (paths.some((item) => normalizeWorkspacePath(item) !== item))
      return "The delegated file references are invalid.";
  } catch {
    return "The delegated file references are invalid.";
  }
  return `Files shared on this computer (use these workspace-root paths):\n${paths.map((item) => `- ${JSON.stringify(`/${item}`)}`).join("\n")}`;
}
