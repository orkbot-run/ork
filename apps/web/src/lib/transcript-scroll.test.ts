import { describe, expect, it } from "vitest";
import {
  longReplyScrollTop,
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "./transcript-scroll.js";

describe("longReplyScrollTop", () => {
  const viewport = { top: 20, height: 500, scrollTop: 400 };

  it("positions the first line below the header even after the reply grows below it", () => {
    expect(longReplyScrollTop(viewport, { top: -25, height: 700 }, 64)).toBe(291);
    expect(longReplyScrollTop(viewport, { top: -25, height: 1_200 }, 64)).toBe(291);
  });

  it("keeps the normal tail-follow behavior for replies that fit", () => {
    expect(longReplyScrollTop(viewport, { top: 40, height: 436 }, 64)).toBeUndefined();
    expect(
      longReplyScrollTop({ ...viewport, height: 0 }, { top: 40, height: 700 }, 64),
    ).toBeUndefined();
  });
});

describe("transcriptIsNearEnd", () => {
  it("follows only while the viewport is within 80px of the latest message", () => {
    expect(transcriptIsNearEnd({ scrollHeight: 1_000, scrollTop: 421, clientHeight: 500 })).toBe(
      true,
    );
    expect(transcriptIsNearEnd({ scrollHeight: 1_000, scrollTop: 420, clientHeight: 500 })).toBe(
      false,
    );
  });
});

describe("transcriptCanSnapAfterFrame", () => {
  it("does not snap after the reader moves while the frame is queued", () => {
    const transcript = { scrollTop: 950 };
    expect(transcriptCanSnapAfterFrame(transcript, transcript, 950)).toBe(true);
    transcript.scrollTop = 920;
    expect(transcriptCanSnapAfterFrame(transcript, transcript, 950)).toBe(false);
  });

  it("does not snap a replacement transcript", () => {
    const queuedTranscript = { scrollTop: 950 };
    const replacementTranscript = { scrollTop: 950 };
    expect(transcriptCanSnapAfterFrame(replacementTranscript, queuedTranscript, 950)).toBe(false);
  });
});

describe("transcriptMovedDown", () => {
  it("does not treat an uninitialized baseline as downward movement", () => {
    expect(transcriptMovedDown(null, 920)).toBe(false);
    expect(transcriptMovedDown(950, 920)).toBe(false);
    expect(transcriptMovedDown(920, 950)).toBe(true);
  });
});
