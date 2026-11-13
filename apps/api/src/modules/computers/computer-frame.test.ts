// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerObservation } from "@orkbot/adapter-kit";
import { placeholderObservation } from "@orkbot/adapters";
import { COMPUTER_FRAME_MAX_BYTES, ComputerFrameSchema } from "@orkbot/contracts";
import { expect, it } from "vitest";
import { computerFrame } from "./computer-frame.js";

function observation(): ComputerObservation {
  return {
    frameId: "provider-private-id",
    capturedAt: "2026-11-13T10:00:00.000Z",
    mimeType: "image/png",
    image: placeholderObservation().image,
    width: 1,
    height: 1,
  };
}

it("returns only bounded image content and a scope-bound content identifier", async () => {
  const source = observation();
  const frame = (await computerFrame("workspace-a/bot-a/computer-a/revision-1", source))!;
  expect(ComputerFrameSchema.safeParse(frame).success).toBe(true);
  expect(Buffer.from(frame.data, "base64")).toEqual(Buffer.from(source.image));
  expect(JSON.stringify(frame)).not.toContain(source.frameId);
  expect(
    await computerFrame(
      "workspace-a/bot-a/computer-a/revision-1",
      { ...source, capturedAt: "2026-11-13T10:01:00.000Z" },
      frame.id,
    ),
  ).toBeNull();
  for (const scope of [
    "workspace-b/bot-a/computer-a/revision-1",
    "workspace-a/bot-b/computer-a/revision-1",
    "workspace-a/bot-a/computer-a/revision-2",
  ])
    expect((await computerFrame(scope, source, frame.id))?.id).not.toBe(frame.id);
  expect(
    (
      await computerFrame(
        "workspace-a/bot-a/computer-a/revision-1",
        { ...source, image: Uint8Array.from([...source.image, 0]) },
        frame.id,
      )
    )?.id,
  ).not.toBe(frame.id);
});

it("refuses oversized, invalid and decompression-heavy provider observations", async () => {
  for (const patch of [
    { image: new Uint8Array() },
    { image: Uint8Array.of(1, 2, 3) },
    { image: new Uint8Array(COMPUTER_FRAME_MAX_BYTES + 1) },
    { mimeType: "image/svg+xml" },
    { mimeType: "image/jpeg" },
    { width: 100, height: 80 },
    { width: 0 },
    { width: NaN },
    { height: 0.5 },
    { width: 16384, height: 16384 },
    { capturedAt: "invalid" },
    { capturedAt: "x".repeat(100) },
  ])
    await expect(
      computerFrame("scope", { ...observation(), ...patch } as ComputerObservation),
    ).rejects.toThrow("Could not load the desktop.");
});
