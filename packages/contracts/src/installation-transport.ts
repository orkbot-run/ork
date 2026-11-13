// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

export const INSTALLATION_TRANSPORT_PATH = "/api/installation-transport/v1";
export const installationTransportIdentitySchema = z
  .object({
    protocol: z.literal("ork-installation-tls-v1"),
    serverId: z.uuid(),
    bindingVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    certificate: z
      .string()
      .min(4)
      .max(22 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();

export type InstallationTransportIdentity = z.infer<typeof installationTransportIdentitySchema>;
