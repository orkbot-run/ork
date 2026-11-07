// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Call speaker ownership changes follow LICENSE.md.

import { MAX_VOICE_AUDIO_BYTES, VOICE_RESPONSE_TIMEOUT_MS } from "@orkbot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Speaker } from "./tts.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubSelectedSpace(id: string) {
  const store = new Map<string, string>([["orkbot:space-id", id]]);
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  return (next: string) => store.set("orkbot:space-id", next);
}

describe("Speaker", () => {
  it("rolls back speaker admission when stopping previous audio throws", () => {
    const speaker = new Speaker();
    const stop = vi.spyOn(speaker, "stop").mockImplementationOnce(() => {
      throw new Error("audio teardown failed");
    });
    expect(() => speaker.claim()).toThrow("audio teardown failed");
    expect(speaker.canSpeak()).toBe(true);
    stop.mockRestore();
    const next = speaker.claim();
    expect(next?.isCurrent()).toBe(true);
    next?.release();
  });

  it("blocks read-aloud without preparation while a ringing or listening call owns the speaker", async () => {
    const speaker = new Speaker();
    const prepare = vi
      .spyOn(speaker as unknown as { prepare: () => Promise<string[]> }, "prepare")
      .mockResolvedValue([]);
    const owner = speaker.claim()!;
    expect(speaker.canSpeak()).toBe(false);
    await speaker.speak("Other chat", { botId: "same-bot" });
    expect(prepare).not.toHaveBeenCalled();
    await speaker.speak("Current call", { owner, botId: "same-bot" });
    expect(prepare).toHaveBeenCalledOnce();
    speaker.stop();
    expect(speaker.canSpeak()).toBe(false);
    owner.release();
    await speaker.speak("After call");
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects retired call speech even after a replacement call releases its claim", async () => {
    const speaker = new Speaker();
    const prepare = vi
      .spyOn(speaker as unknown as { prepare: () => Promise<string[]> }, "prepare")
      .mockResolvedValue([]);
    const first = speaker.claim()!;
    first.release();
    const second = speaker.claim()!;
    first.release();
    expect(speaker.canSpeak()).toBe(false);
    second.release();
    await speaker.speak("Late old call", { owner: first });
    expect(prepare).not.toHaveBeenCalled();
    expect(speaker.canSpeak()).toBe(true);
  });

  it("takes over existing preparation once and does not let blocked starts or stale Stop interrupt call speech", async () => {
    const speaker = new Speaker();
    const prepare = vi
      .spyOn(speaker as unknown as { prepare: () => Promise<string[]> }, "prepare")
      .mockImplementation(() => new Promise(() => undefined));
    const previous = speaker.speak("Earlier read-aloud");
    const owner = speaker.claim()!;
    await expect(previous).resolves.toBeUndefined();
    const current = speaker.speak("Call reply", { owner, messageId: "call-reply" });
    await speaker.speak("Blocked chat");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(speaker.state).toMatchObject({ status: "preparing", messageId: "call-reply" });
    expect(speaker.claim()).toBeUndefined();
    speaker.stop();
    await expect(current).resolves.toBeUndefined();
    expect(owner.isCurrent()).toBe(true);
    owner.release();
  });

  it("interrupting before audio arrives leaves the speaker idle", async () => {
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockImplementation(() => new Promise(() => undefined));
    const pending = speaker.speak("Hello there.", { messageId: "m1" });
    speaker.stop();
    await expect(pending).resolves.toBeUndefined();
    expect(speaker.state.status).toBe("idle");
  });

  it("does not report a failure for a request a newer one replaced", async () => {
    const speaker = new Speaker();
    let fail: (error: Error) => void = () => undefined;
    vi.spyOn(speaker as unknown as { prepare: () => Promise<string[]> }, "prepare")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValueOnce([]);
    const first = speaker.speak("First.", { messageId: "m1" });
    await speaker.speak("Second.", { messageId: "m2" });
    fail(new Error("Your voice provider is out of credit."));
    await expect(first).resolves.toBeUndefined();
    expect(speaker.state.error).toBeUndefined();
  });

  it("resolves with an error snapshot instead of rejecting", async () => {
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockRejectedValue(new Error("ElevenLabs rejected that key."));
    await expect(speaker.speak("Hi there.")).resolves.toBe("ElevenLabs rejected that key.");
    expect(speaker.state.error).toBe("ElevenLabs rejected that key.");
  });

  it.each([
    { spaceId: undefined, expectedSpaceId: "space-support" },
    { spaceId: "space-edited", expectedSpaceId: "space-edited" },
  ])("keeps both speech requests in $expectedSpaceId", async ({ spaceId, expectedSpaceId }) => {
    const changeSelectedSpace = stubSelectedSpace("space-support");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      blob: async () => new Blob(["audio"]),
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "Audio",
      class {
        src = "";
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play() {
          queueMicrotask(() => this.onended?.());
          return Promise.resolve();
        }
        pause() {}
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const speaker = new Speaker();
    const prepare = vi
      .spyOn(
        speaker as unknown as {
          prepare: (
            text: string,
            opts: unknown,
            signal: AbortSignal,
            spaceId: string | null,
          ) => Promise<string[]>;
        },
        "prepare",
      )
      .mockImplementation(async () => {
        changeSelectedSpace("space-other");
        return ["Hello."];
      });
    await speaker.speak("Hello.", { messageId: "m1", spaceId });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/speak",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-orkbot-space-id")).toBe(expectedSpaceId);
    expect(headers.get("content-type")).toBe("application/json");
    expect(prepare.mock.calls[0]?.[3]).toBe(expectedSpaceId);
  });

  it("rejects oversized audio without waiting for response cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_VOICE_AUDIO_BYTES + 1) },
          }),
      ),
    );
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Hello."]);

    await expect(speaker.speak("Hello.")).resolves.toBe("Voice response is too large.");

    expect(speaker.state.error).toBe("Voice response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["VOICE_OUT_OF_CREDIT", 402, "Your voice provider is out of credit."],
    ["VOICE_KEY_REJECTED", 403, "Your voice provider key was rejected."],
  ])("shows its own copy for %s", async (code, status, copy) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Insufficient API credit at fish.audio", code }), {
            status,
          }),
      ),
    );
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Hello."]);

    await expect(speaker.speak("Hello.")).resolves.toBe(copy);

    expect(speaker.state.error).toBe(copy);
  });

  it("times out while a voice response body is stalled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => undefined),
            }),
          ),
      ),
    );
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Hello."]);

    const pending = speaker.speak("Hello.");
    await vi.advanceTimersByTimeAsync(VOICE_RESPONSE_TIMEOUT_MS);
    await pending;

    expect(speaker.state.error).toBe("Voice request timed out.");
  });
});
