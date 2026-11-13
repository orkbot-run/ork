// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

export const COMPUTER_FRAME_MAX_BYTES = 6 * 1024 * 1024;
export const COMPUTER_FRAME_MAX_PIXELS = 64 * 1024 * 1024;
export const COMPUTER_FRAME_INTERVAL_MS = 500;
export const ComputerFrameIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ComputerFrameSchema = z.object({
  id: ComputerFrameIdSchema,
  capturedAt: z.string().datetime().max(64),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  data: z.string().max(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
});
export type ComputerFrame = z.infer<typeof ComputerFrameSchema>;
