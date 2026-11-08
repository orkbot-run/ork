// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { RunRoutineNameSchema } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import { projectRunRoutineName, routineWorkContext } from "./routine-work.js";

const run = {
  id: "run",
  routineId: "routine",
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  threadId: "thread",
  routineName: "Morning report",
  status: "running",
};
const routine = {
  id: "routine",
  name: "Morning report",
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  threadId: "thread",
};
const thread = { id: "thread", botId: "bot", groupId: null };
describe("routine run name projection", () => {
  it("projects the owned direct and group routine without persisting a second state", () => {
    expect(projectRunRoutineName(run, routine, thread)).toBe("Morning report");
    expect(projectRunRoutineName(run, routine, { ...thread, botId: null, groupId: "group" })).toBe(
      "Morning report",
    );
    expect(projectRunRoutineName(run, { ...routine, name: "Renamed" }, thread)).toBe("Renamed");
    expect(projectRunRoutineName(run, null, thread)).toBeNull();
    expect(projectRunRoutineName(run, undefined, thread)).toBeNull();
  });
  it.each(["id", "userId", "spaceId", "botId", "threadId"] as const)(
    "rejects a mismatched routine %s",
    (key) => {
      expect(projectRunRoutineName(run, { ...routine, [key]: "foreign" }, thread)).toBeNull();
    },
  );
  it("accepts a legacy null thread only in the run bot's actual DM", () => {
    const legacy = { ...routine, threadId: null };
    expect(projectRunRoutineName(run, legacy, thread)).toBe("Morning report");
    expect(
      projectRunRoutineName(run, legacy, { ...thread, botId: null, groupId: "group" }),
    ).toBeNull();
    expect(projectRunRoutineName(run, legacy, { ...thread, botId: "peer" })).toBeNull();
    expect(projectRunRoutineName(run, routine, { ...thread, id: "other-thread" })).toBeNull();
  });
  it("allows only an owned manual test intent to display a group routine in the actual bot DM", () => {
    const grouped = { ...routine, threadId: "group-thread" };
    const manual = { ...run, trigger: "routine", clientNonce: "routine-run:owner:client-key" };
    expect(projectRunRoutineName(manual, grouped, thread)).toBe("Morning report");
    for (const clientNonce of [
      undefined,
      null,
      "routine-test:old",
      "routine-run:foreign:key",
      "routine-run:owner:",
      "send:routine-run:owner:key",
    ])
      expect(projectRunRoutineName({ ...manual, clientNonce }, grouped, thread)).toBeNull();
    expect(
      projectRunRoutineName(manual, grouped, { ...thread, botId: null, groupId: "group-a" }),
    ).toBeNull();
    expect(projectRunRoutineName({ ...manual, trigger: "user" }, grouped, thread)).toBeNull();
    expect(projectRunRoutineName(manual, { ...grouped, userId: "foreign" }, thread)).toBeNull();
  });
  it("bounds a legacy long name without failing the enclosing snapshot or splitting Unicode", () => {
    const result = projectRunRoutineName(
      run,
      { ...routine, name: `${"A".repeat(199)}🌿tail` },
      thread,
    );
    expect(result).toBe("A".repeat(199));
    expect(RunRoutineNameSchema.safeParse(result).success).toBe(true);
  });
});
describe("existing active run context", () => {
  it.each(["queued", "leased", "running", "waiting_input", "waiting_takeover"])(
    "identifies a single %s routine",
    (status) => {
      expect(routineWorkContext([{ ...run, status }])).toEqual({
        names: ["Morning report"],
        stopName: "Morning report",
        stopAll: false,
      });
    },
  );
  it("keeps all known group names and global Stop semantics", () => {
    expect(
      routineWorkContext([
        run,
        { ...run, id: "peer", routineId: "other", routineName: "Evening report" },
      ]),
    ).toEqual({ names: ["Morning report", "Evening report"], stopName: null, stopAll: true });
    expect(
      routineWorkContext([run, { ...run, id: "ordinary", routineId: null, routineName: null }]),
    ).toEqual({ names: ["Morning report"], stopName: null, stopAll: true });
  });
  it("drops terminal, legacy unnamed and missing-routine labels", () => {
    expect(
      routineWorkContext([
        { ...run, status: "completed" },
        { ...run, id: "failed", status: "failed" },
        { ...run, id: "canceled", status: "cancelled" },
      ]),
    ).toEqual({ names: [], stopName: null, stopAll: false });
    expect(routineWorkContext([{ ...run, routineName: undefined }])).toEqual({
      names: [],
      stopName: null,
      stopAll: false,
    });
    expect(routineWorkContext([{ ...run, routineId: null }])).toEqual({
      names: [],
      stopName: null,
      stopAll: false,
    });
  });
});
