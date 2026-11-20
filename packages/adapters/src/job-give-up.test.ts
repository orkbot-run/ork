// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createLogger, createTestSink, installLogger, wrapJobPayload } from "@orkbot/logging";
import { afterEach, expect, it } from "vitest";
import { reportJobGiveUp } from "./job-give-up.js";

afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

it("reports final attempts with public type and correlation, excluding payload and error metadata", () => {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  const job = {
    id: "123",
    task_identifier: "run.interactive",
    key: "run:123",
    payload: wrapJobPayload(
      { secret: "payload-must-stay-private" },
      { jobId: "job-123", traceId: "a".repeat(32) },
    ),
    attempts: 2,
    max_attempts: 3,
    created_at: new Date(Date.now() - 1_000),
  };
  const error = Object.assign(new Error("handler stopped"), { payload: job.payload });
  reportJobGiveUp(job, error);
  expect(sink.events).toHaveLength(0);
  reportJobGiveUp({ ...job, attempts: 3 }, error);
  expect(sink.events).toHaveLength(1);
  expect(sink.events[0]).toMatchObject({
    message: "job.gave_up",
    "job.type": "run.continue",
    "job.queue_id": "123",
    "job.id": "job-123",
    "trace.id": "a".repeat(32),
    "job.attempts": 3,
    "job.max_attempts": 3,
    error: { message: "handler stopped" },
    "error.fingerprint": ["job.gave_up", "run.continue"],
  });
  expect(JSON.stringify(sink.events)).not.toContain("payload-must-stay-private");
});
