// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";
import { isPrivateNetworkHost } from "./network-host.js";

export const INSTALLATION_TRANSPORT_PATH = "/api/installation-transport/v1";
export const INSTALLATION_TRANSPORT_LEASE_PURPOSE = "ork-installation-transport-lease-v1";
export const INSTALLATION_TRANSPORT_LEASE_SECONDS = 45;
export const RELAY_SERVER_PURPOSE = "ork-relay-server-v1";
export const RELAY_CHANNEL_PURPOSE = "ork-relay-channel-v1";
export const RELAY_SERVER_PATH = "/api/relay/v1/installations";
export const RELAY_CHANNEL_PATH = "/api/relay/v1/channels";
export const RELAY_ATTACHMENT_PATH = "/api/relay/v1/attachments";

export const installationRelayRouteSchema = z
  .object({ origin: z.string().url().max(2048) })
  .strict()
  .refine(({ origin }) => {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password;
  });
export type InstallationRelayRoute = z.infer<typeof installationRelayRouteSchema>;
export const installationDirectRouteSchema = z
  .object({ origin: z.string().url().max(2048) })
  .strict()
  .refine(({ origin }) => {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isPrivateNetworkHost(url.hostname)))
    );
  });
export type InstallationDirectRoute = z.infer<typeof installationDirectRouteSchema>;
export type InstallationConnectionRoutes = {
  direct?: InstallationDirectRoute;
  relay?: InstallationRelayRoute;
};
export const installationVirtualOrigin = (serverId: string) =>
  `https://${z.uuid().parse(serverId)}.installation.ork.invalid`;

const relayAdmissionBase = {
  version: z.literal(1),
  relayOrigin: z.string().url().max(2048),
  serverId: z.uuid(),
  bindingVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  validForSeconds: z.number().int().positive().max(60),
};
export const relayAdmissionSchema = z.discriminatedUnion("kind", [
  z.object({ ...relayAdmissionBase, kind: z.literal("server"), leaseId: z.uuid() }).strict(),
  z.object({ ...relayAdmissionBase, kind: z.literal("channel"), workspaceId: z.uuid() }).strict(),
]);
export type RelayAdmission = z.infer<typeof relayAdmissionSchema>;

export const relayOpenSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("open"),
    channelId: z.uuid(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export const relayRenewSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("renew"),
    ticket: z
      .string()
      .min(1)
      .max(16 * 1024),
  })
  .strict();

export const relayReadySchema = z
  .object({
    version: z.literal(1),
    type: z.literal("ready"),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
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
    origin: z.string().url().max(2048).optional(),
  })
  .strict();

export type InstallationTransportIdentity = z.infer<typeof installationTransportIdentitySchema>;
