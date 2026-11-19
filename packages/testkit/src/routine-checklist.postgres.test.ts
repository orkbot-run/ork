// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent } from "@orkbot/adapter-kit";
import type { Actor, RoutineChecklist } from "@orkbot/contracts";
import {
  LEGACY_ROUTINE_CHECKLIST_EVENT_TYPE,
  ROUTINE_CHECKLIST_EVENT_TYPE,
  ROUTINE_CHECKLIST_META_KIND,
  routineChecklistFromEvent,
} from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  declareRunReaderVersion,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRoutineRuns } from "../../../apps/api/src/modules/routines/routine-runs.js";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import {
  createRoutineChecklist,
  redactRoutineChecklist,
} from "../../adapters/src/routine-checklist.js";
import type { TurnCheckpoint } from "../../adapters/src/turn-checkpoint.js";
import { startModelEmulator } from "./model-emulator.js";

const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;
const prompt = "1. Inspect the report\n2. Save the summary";
type Identity = { userId: string; spaceId: string; botId: string; threadId: string };

postgres("routine checklist persistence (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const identities: Identity[] = [];
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    for (let index = 0; index < 2; index++) {
      const provisioned = await runAsSystem("routine checklist fixture", () =>
        provisionMessagingIdentity(
          db.prisma,
          { provider: "email", address: `checklist-${randomUUID()}@orkbot.test` },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      const { userId, spaceId, botId, threadId } = provisioned;
      identities.push({ userId, spaceId, botId, threadId });
    }
  });
  afterAll(async () => {
    for (const identity of identities) {
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  const actor = (identity: Identity): Actor => ({
    ...identity,
    email: "fixture@orkbot.test",
    isDeploymentOwner: false,
  });
  const scoped = <T>(identity: Identity, work: () => Promise<T>) => runAsTenant(identity, work);
  async function fixture(identity = identities[0]!) {
    const routine = await system.routine.create({
      data: { ...identity, name: "Checklist", prompt, crons: [], active: false },
    });
    const task = await system.task.create({ data: { ...identity, prompt, status: "running" } });
    const run = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        routineId: routine.id,
        trigger: "routine",
        status: "running",
        leaseOwner: "checklist-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { identity, routine, run };
  }
  async function latest(identity: Identity, runId: string) {
    const event = await scoped(identity, () =>
      db.prisma.event.findFirst({
        where: {
          spaceId: identity.spaceId,
          threadId: identity.threadId,
          runId,
          type: ROUTINE_CHECKLIST_EVENT_TYPE,
        },
        orderBy: { seq: "desc" },
        select: { payload: true },
      }),
    );
    return routineChecklistFromEvent(event?.payload);
  }

  it("writes fenced snapshots, resumes from durable outcomes, and projects the occurrence's latest checklist", async () => {
    const { identity, routine, run } = await fixture();
    const events = createThreadEvents(db.prisma);
    let fence = 1;
    let checkpoint = "";
    const model = await startModelEmulator({
      steps: [
        { expect() {}, response: { type: "text", text: "Starting the routine." } },
        {
          expect(wire) {
            expect(JSON.stringify(wire.messages.at(-1))).toContain("unaccounted steps");
          },
          response: {
            type: "tool",
            id: "step-one",
            name: "update_routine_step",
            arguments: { step: 1, status: "done" },
          },
        },
        {
          expect() {},
          response: {
            type: "tool",
            id: "pause",
            name: "ask_user",
            arguments: {
              question: "Where should the summary be saved?",
              options: ["Configured destination", "Skip saving"],
            },
          },
        },
        {
          expect(wire) {
            expect(
              wire.messages.filter((message) =>
                String(message.content).includes("unaccounted steps"),
              ),
            ).toHaveLength(1);
          },
          response: {
            type: "tool",
            id: "step-two",
            name: "update_routine_step",
            arguments: {
              step: 2,
              status: "blocked",
              reason: "Destination [fixture-secret] is unavailable",
            },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            text: "Inspection complete. Saving is blocked by the unavailable destination.",
          },
        },
      ],
    });
    const base: AgentRunRequest = {
      ...identity,
      runId: run.id,
      routineId: routine.id,
      prompt,
      instructions: "Complete every routine step.",
      history: [],
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      model: model.model,
      onRoutineChecklist: async (snapshot) => {
        await scoped(identity, () =>
          events.append({
            ...identity,
            runId: run.id,
            type: ROUTINE_CHECKLIST_EVENT_TYPE,
            lease: { owner: "checklist-worker", fence },
            payload: {
              kind: ROUTINE_CHECKLIST_META_KIND,
              checklist: redactRoutineChecklist(snapshot, ["[fixture-secret]"]),
            },
          }),
        );
      },
      onCheckpoint: async (capture) => {
        const blob = capture();
        if ((JSON.parse(blob) as TurnCheckpoint).pendingToolCallId === "pause") checkpoint = blob;
      },
    };
    try {
      const first: AgentRuntimeEvent[] = [];
      for await (const event of new PiAgentRuntime().run(base)) first.push(event);
      expect(first.some((event) => event.type === "ask")).toBe(true);
      expect(checkpoint).not.toBe("");
      const saved = await latest(identity, run.id);
      expect(saved).toMatchObject({
        continuationRequested: true,
        steps: [{ status: "done" }, { status: "pending" }],
      });
      // A parallel pause can have captured its snapshot before a sibling recorded Done.
      const staleCheckpoint = JSON.parse(checkpoint) as TurnCheckpoint;
      staleCheckpoint.routineChecklist = createRoutineChecklist({
        ...base,
        routineChecklist: undefined,
      })!.snapshot();
      await system.run.update({
        where: { id: run.id },
        data: {
          checkpoint: JSON.stringify(staleCheckpoint),
          status: "waiting_input",
          leaseOwner: null,
        },
      });
      fence = 2;
      await system.$transaction(async (tx) => {
        await declareRunReaderVersion(tx);
        await tx.run.update({
          where: { id: run.id },
          data: { status: "running", leaseOwner: "checklist-worker", leaseFence: fence },
        });
      });
      const restored = await system.run.findUniqueOrThrow({
        where: { id: run.id },
        select: { checkpoint: true },
      });
      for await (const _event of new PiAgentRuntime().run({
        ...base,
        prompt: "Use the configured destination.",
        turnCheckpoint: restored.checkpoint!,
        routineChecklist: saved,
        resumeToolResult: { content: [{ type: "text", text: "Use the configured destination." }] },
      })) {
        /* consume the real runtime */
      }
      model.assertComplete();
      const final = await latest(identity, run.id);
      expect(final).toMatchObject({
        continuationRequested: true,
        steps: [{ status: "done", reason: null }, { status: "blocked" }],
      });
      expect(JSON.stringify(final)).not.toContain("[fixture-secret]");
      expect(final?.steps[1]?.reason).toContain("is unavailable");
      await expect(
        scoped(identity, () =>
          events.append({
            ...identity,
            runId: run.id,
            type: ROUTINE_CHECKLIST_EVENT_TYPE,
            lease: { owner: "checklist-worker", fence: 1 },
            payload: { kind: ROUTINE_CHECKLIST_META_KIND, checklist: saved! },
          }),
        ),
      ).rejects.toThrow();
      await system.run.update({
        where: { id: run.id },
        data: { status: "completed", completedAt: new Date(), leaseOwner: null },
      });
      const history = await scoped(identity, () =>
        listRoutineRuns(db.prisma, actor(identity), routine.id),
      );
      expect(history.runs).toHaveLength(1);
      expect(history.runs[0]?.checklist).toEqual(final);
      expect(history.runs[0]?.messageId).toBeNull();
      await system.routine.update({
        where: { id: routine.id },
        data: { prompt: "- A replacement step\n- Another replacement step" },
      });
      expect(
        (await scoped(identity, () => listRoutineRuns(db.prisma, actor(identity), routine.id)))
          .runs[0]?.checklist,
      ).toEqual(final);
    } finally {
      await model.close();
    }
  });

  it("does not expose another tenant's routine, checklist events, or history", async () => {
    const own = await fixture();
    const foreign = await fixture(identities[1]!);
    const snapshot: RoutineChecklist = {
      continuationRequested: false,
      steps: [
        { id: 1, text: "Foreign private step", status: "done", reason: null },
        { id: 2, text: "Second private step", status: "skipped", reason: "Private reason" },
      ],
    };
    await scoped(foreign.identity, () =>
      createThreadEvents(db.prisma).append({
        ...foreign.identity,
        runId: foreign.run.id,
        type: ROUTINE_CHECKLIST_EVENT_TYPE,
        lease: { owner: "checklist-worker", fence: 1 },
        payload: { kind: ROUTINE_CHECKLIST_META_KIND, checklist: snapshot },
      }),
    );
    await expect(
      scoped(own.identity, () =>
        listRoutineRuns(db.prisma, actor(own.identity), foreign.routine.id),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await scoped(own.identity, () =>
        db.prisma.event.findMany({
          where: { runId: foreign.run.id, type: ROUTINE_CHECKLIST_EVENT_TYPE },
        }),
      ),
    ).toEqual([]);
    expect(
      (
        await scoped(own.identity, () =>
          listRoutineRuns(db.prisma, actor(own.identity), own.routine.id),
        )
      ).runs[0]?.checklist,
    ).toBeUndefined();
    await expect(
      scoped(own.identity, () =>
        createThreadEvents(db.prisma).append({
          ...foreign.identity,
          runId: foreign.run.id,
          type: ROUTINE_CHECKLIST_EVENT_TYPE,
          lease: { owner: "checklist-worker", fence: 1 },
          payload: { kind: ROUTINE_CHECKLIST_META_KIND, checklist: snapshot },
        }),
      ),
    ).rejects.toThrow();
  });

  it("reads existing snapshots, then skips both snapshot formats in the chat stream", async () => {
    const { identity, run, routine } = await fixture();
    const events = createThreadEvents(db.prisma);
    const checklist: RoutineChecklist = {
      continuationRequested: false,
      steps: [
        { id: 1, text: "Inspect", status: "done", reason: null },
        { id: 2, text: "Save", status: "pending", reason: null },
      ],
    };
    const common = { ...identity, runId: run.id, lease: { owner: "checklist-worker", fence: 1 } };
    const historic = await scoped(identity, () =>
      events.append({
        ...common,
        type: ROUTINE_CHECKLIST_EVENT_TYPE,
        payload: { kind: ROUTINE_CHECKLIST_META_KIND, checklist },
      }),
    );
    await system.event.update({
      where: { id: historic.id },
      data: { type: LEGACY_ROUTINE_CHECKLIST_EVENT_TYPE, payload: checklist },
    });
    const read = () =>
      scoped(identity, () => listRoutineRuns(db.prisma, actor(identity), routine.id));
    expect((await read()).runs[0]?.checklist).toEqual(checklist);
    const updated = { ...checklist, continuationRequested: true };
    await scoped(identity, () =>
      events.append({
        ...common,
        type: ROUTINE_CHECKLIST_EVENT_TYPE,
        payload: { kind: ROUTINE_CHECKLIST_META_KIND, checklist: updated },
      }),
    );
    const visible = await scoped(identity, () =>
      events.append({
        ...common,
        type: "thread.meta",
        payload: { fixture: "unrelated" },
      }),
    );
    expect((await read()).runs[0]?.checklist).toEqual(updated);
    const stream = events.follow(identity.threadId, historic.seq - 1, AbortSignal.timeout(2_000));
    try {
      expect((await scoped(identity, () => stream.next())).value).toMatchObject({ id: visible.id });
    } finally {
      await stream.return(undefined);
    }
  });
});
