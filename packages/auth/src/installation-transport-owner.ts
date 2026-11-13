// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import type { InstallationConfiguration } from "./installation-client.js";

export const INSTALLATION_OWNER_SECONDS = 60;
interface OwnerRow extends InstallationConfiguration {
  transportLeaseUntil: Date;
}

/** One API process maintains transport presence for replicas sharing this installation database. */
export class InstallationTransportOwner {
  readonly id = randomUUID();
  constructor(private readonly prisma: PrismaClient) {}

  async acquire(): Promise<{ configuration: InstallationConfiguration; deadline: number } | null> {
    const startedAt = performance.now();
    const rows = await runAsSystem(
      "elect the installation transport process",
      () => this.prisma.$queryRaw<OwnerRow[]>`
      UPDATE installation_identity
      SET "transportOwnerId" = ${this.id},
          "transportLeaseUntil" = clock_timestamp() + ${INSTALLATION_OWNER_SECONDS} * interval '1 second'
      WHERE id = 'local' AND state = 'ready' AND "serverId" IS NOT NULL
        AND "centralOrganizationId" IS NOT NULL
        AND ("transportOwnerId" IS NULL OR "transportOwnerId" = ${this.id}
          OR "transportLeaseUntil" <= clock_timestamp())
      RETURNING "serverId", "centralOrganizationId" AS "organizationId", "bindingVersion",
        "keyFingerprint", "transportLeaseUntil"
    `,
    );
    const row = rows[0];
    if (!row) return null;
    const deadline = Math.min(
      startedAt + INSTALLATION_OWNER_SECONDS * 1000,
      performance.now() + row.transportLeaseUntil.getTime() - Date.now(),
    );
    if (deadline <= performance.now()) return null;
    const { transportLeaseUntil: _, ...configuration } = row;
    return { configuration, deadline };
  }

  async active(configuration: InstallationConfiguration): Promise<boolean> {
    const rows = await runAsSystem(
      "check installation transport ownership before opening a channel",
      () => this.prisma.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM installation_identity WHERE id = 'local' AND state = 'ready'
        AND "transportOwnerId" = ${this.id} AND "transportLeaseUntil" > clock_timestamp()
        AND "serverId" = ${configuration.serverId} AND "centralOrganizationId" = ${configuration.organizationId}
        AND "bindingVersion" = ${configuration.bindingVersion} AND "keyFingerprint" = ${configuration.keyFingerprint}) AS allowed
    `,
    );
    return rows[0]?.allowed === true;
  }

  async release(): Promise<void> {
    await runAsSystem("release only this process's installation transport ownership", () =>
      this.prisma.installationIdentity.updateMany({
        where: { id: "local", transportOwnerId: this.id },
        data: { transportOwnerId: null, transportLeaseUntil: null },
      }),
    );
  }
}
