// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

export const personalDeviceSchema = z
  .object({
    id: z.uuid(),
    publicKey: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type PersonalDevice = z.infer<typeof personalDeviceSchema>;
export type ActivatedPersonalDevice = PersonalDevice & { registryVersion: number };
export interface PersonalDeviceTarget {
  serverId: string;
  bindingVersion: number;
  keyFingerprint: string;
  workspaceId: string;
  deviceId: string;
}
export function personalActivationMessage(
  target: PersonalDeviceTarget,
  challenge: string,
  grantHash: string,
): string {
  return JSON.stringify([
    "ork-personal-device-activation-v1",
    target.serverId,
    target.bindingVersion,
    target.keyFingerprint,
    target.workspaceId,
    target.deviceId,
    challenge,
    grantHash,
  ]);
}
export function personalOfflineMessage(target: PersonalDeviceTarget, challenge: string): string {
  return JSON.stringify([
    "ork-personal-device-login-v1",
    target.serverId,
    target.bindingVersion,
    target.keyFingerprint,
    target.workspaceId,
    target.deviceId,
    challenge,
  ]);
}
export function personalServerMessage(target: PersonalDeviceTarget, challenge: string): string {
  return JSON.stringify([
    "ork-personal-device-server-v1",
    target.serverId,
    target.bindingVersion,
    target.keyFingerprint,
    target.workspaceId,
    target.deviceId,
    challenge,
  ]);
}
