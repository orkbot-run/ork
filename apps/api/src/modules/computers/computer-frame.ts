// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash } from "node:crypto";
import type { ComputerObservation } from "@orkbot/adapter-kit";
import { validComputerFrameImage } from "@orkbot/adapters";
import type { ComputerFrame } from "@orkbot/contracts";
import {
  COMPUTER_FRAME_MAX_BYTES,
  COMPUTER_FRAME_MAX_PIXELS,
  ComputerFrameSchema,
} from "@orkbot/contracts";
import { ORPCError } from "@orpc/server";

/** A bounded image crosses HTTP; provider pages, socket URLs and credentials never reach the client. */
export async function computerFrame(
  scope: string,
  observation: ComputerObservation,
  previous?: string,
): Promise<ComputerFrame | null> {
  if (
    !["image/png", "image/jpeg"].includes(observation.mimeType) ||
    !observation.image.byteLength ||
    observation.image.byteLength > COMPUTER_FRAME_MAX_BYTES ||
    !ComputerFrameSchema.shape.capturedAt.safeParse(observation.capturedAt).success ||
    observation.width * observation.height > COMPUTER_FRAME_MAX_PIXELS ||
    ![observation.width, observation.height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 16_384,
    )
  )
    throw new ORPCError("BAD_GATEWAY", { message: "Could not load the desktop." });
  if (!(await validComputerFrameImage(observation)))
    throw new ORPCError("BAD_GATEWAY", { message: "Could not load the desktop." });
  const id = createHash("sha256")
    .update(JSON.stringify([scope, observation.mimeType, observation.width, observation.height]))
    .update(observation.image)
    .digest("hex");
  if (id === previous) return null;
  return {
    id,
    capturedAt: observation.capturedAt,
    mimeType: observation.mimeType,
    data: Buffer.from(observation.image).toString("base64"),
    width: observation.width,
    height: observation.height,
  };
}
