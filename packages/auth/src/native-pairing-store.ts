// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";

const PREFIX = "native-pairing:";
const LEASE_SECONDS = 120;
export interface PairingReceipt {
  id: string;
  receipt: string;
  expiresAt: number;
}
export interface PairingLease {
  key: string;
  value: string;
  ticket: PairingReceipt;
}
export type PairingClaim =
  | { state: "pending" | "paired" | "failed" }
  | { state: "claimed"; lease: PairingLease };
export interface NativePairingStore {
  create(ticket: PairingReceipt): Promise<string>;
  acquire(handle: string): Promise<PairingClaim>;
  current(lease: PairingLease): Promise<boolean>;
  finish(lease: PairingLease, state: "pending" | "paired" | "failed"): Promise<boolean>;
}
type Stored = PairingReceipt & {
  state: "pending" | "working" | "paired" | "failed";
  leaseUntil?: number;
  leaseId?: string;
};
const keyOf = (handle: string) => PREFIX + createHash("sha256").update(handle).digest("hex");

/** A value CAS fences each ticket without holding a database connection across broker calls. */
export function nativePairingStore(prisma: PrismaClient): NativePairingStore {
  return {
    async create(ticket) {
      const handle = randomBytes(32).toString("base64url");
      await prisma.verification.deleteMany({
        where: { identifier: { startsWith: PREFIX }, expiresAt: { lt: new Date() } },
      });
      await prisma.verification.create({
        data: {
          id: keyOf(handle),
          identifier: keyOf(handle),
          value: JSON.stringify({ ...ticket, state: "pending" }),
          expiresAt: new Date(ticket.expiresAt * 1000),
        },
      });
      return handle;
    },
    async acquire(handle) {
      const key = keyOf(handle);
      const row = await prisma.verification.findUnique({ where: { id: key } });
      if (!row || row.expiresAt <= new Date()) return { state: "failed" };
      const saved = JSON.parse(row.value) as Stored;
      if (saved.state === "paired" || saved.state === "failed") return { state: saved.state };
      if (saved.state === "working") {
        if (saved.leaseUntil! > Date.now()) return { state: "pending" };
        // An interrupted exchange may already have consumed its one-use grant. Never retry it.
        await prisma.verification.updateMany({
          where: { id: key, value: row.value },
          data: { value: JSON.stringify({ ...saved, state: "failed" }) },
        });
        return { state: "failed" };
      }
      const value = JSON.stringify({
        ...saved,
        state: "working",
        leaseId: randomBytes(16).toString("hex"),
        leaseUntil: Date.now() + LEASE_SECONDS * 1000,
      });
      const claimed = await prisma.verification.updateMany({
        where: { id: key, value: row.value, expiresAt: { gt: new Date() } },
        data: { value },
      });
      return claimed.count === 1
        ? {
            state: "claimed",
            lease: {
              key,
              value,
              ticket: { id: saved.id, receipt: saved.receipt, expiresAt: saved.expiresAt },
            },
          }
        : { state: "pending" };
    },
    async current(lease) {
      const row = await prisma.verification.findUnique({ where: { id: lease.key } });
      return Boolean(
        row &&
          row.value === lease.value &&
          row.expiresAt > new Date() &&
          (JSON.parse(row.value) as Stored).leaseUntil! > Date.now(),
      );
    },
    async finish(lease, state) {
      const result = await prisma.verification.updateMany({
        where: { id: lease.key, value: lease.value },
        data: { value: JSON.stringify({ ...lease.ticket, state }) },
      });
      return result.count === 1;
    },
  };
}
