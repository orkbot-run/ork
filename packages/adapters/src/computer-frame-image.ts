// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerObservation } from "@orkbot/adapter-kit";
import { COMPUTER_FRAME_MAX_PIXELS } from "@orkbot/contracts";

/** Inspect encoded dimensions before a native client allocates decoded image memory. */
export async function validComputerFrameImage(observation: ComputerObservation): Promise<boolean> {
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(observation.image, {
      limitInputPixels: COMPUTER_FRAME_MAX_PIXELS,
      failOn: "error",
      animated: true,
    }).metadata();
    return (
      metadata.format === (observation.mimeType === "image/png" ? "png" : "jpeg") &&
      metadata.width === observation.width &&
      metadata.height === observation.height &&
      (metadata.pages ?? 1) === 1
    );
  } catch {
    return false;
  }
}
