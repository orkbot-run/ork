// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createLogger, createTestSink, getLogger, installLogger } from "@orkbot/logging";
import { expect, it, vi } from "vitest";
import { createSpeechSummarizer } from "./speech-summary.js";

it("redacts the model key if the provider includes it in an error", async () => {
  const sink = createTestSink();
  const previous = getLogger();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  try {
    const summarize = createSpeechSummarizer({
      prisma: {} as never,
      runtime: {
        describe: () => ({ capabilities: { compaction: true } }),
        run: vi.fn(() => {
          throw new Error("provider echoed private-key-fixture");
        }),
      } as never,
      resolveModel: async () => ({
        provider: "example",
        id: "model",
        apiKey: "private-key-fixture",
      }),
    });
    expect(await summarize({ userId: "u", spaceId: "s" } as never, "bot", "Hello")).toBeNull();
    expect(JSON.stringify(sink.events)).not.toContain("private-key-fixture");
    expect(JSON.stringify(sink.events)).toContain("[redacted]");
  } finally {
    installLogger(previous);
  }
});
