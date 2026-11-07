// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SecretStore } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { savedCatalogSelections } from "./pi-live-catalog.js";

type CatalogSecret = { id: string; ciphertext: string };

/** Reads shared only by the catalog and serving checks of one member's list request. */
export interface ModelCatalogReads {
  secretStore: Pick<SecretStore, "load">;
  secrets(userId: string, ids: readonly string[]): Promise<CatalogSecret[]>;
  selections(userId: string): Promise<Set<string>>;
}

export function createModelCatalogReads(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
): ModelCatalogReads {
  const rows = new Map<string, Promise<CatalogSecret | undefined>>();
  const plaintexts = new Map<string, Map<string, Promise<string>>>();
  let selections: Promise<Set<string>> | undefined;
  const assertOwner = (requestedUserId: string) => {
    if (requestedUserId !== userId) throw new Error("Model catalog read scope changed");
  };
  return {
    secretStore: {
      load(ciphertext, id) {
        if (typeof id !== "string") return secretStore.load(ciphertext, id);
        let versions = plaintexts.get(id);
        if (!versions) {
          versions = new Map();
          plaintexts.set(id, versions);
        }
        let loaded = versions.get(ciphertext);
        if (!loaded) {
          loaded = Promise.resolve().then(() => secretStore.load(ciphertext, id));
          versions.set(ciphertext, loaded);
        }
        return loaded;
      },
    },
    async secrets(requestedUserId, ids) {
      assertOwner(requestedUserId);
      const uniqueIds = [...new Set(ids)];
      const missing = uniqueIds.filter((id) => !rows.has(id));
      if (missing.length) {
        const batch = prisma.secret.findMany({
          where: { id: { in: missing }, userId, spaceId: null },
          select: { id: true, ciphertext: true },
        });
        for (const id of missing)
          rows.set(
            id,
            batch.then((secrets) => secrets.find((secret) => secret.id === id)),
          );
      }
      const found = await Promise.all(uniqueIds.map((id) => rows.get(id)!));
      return found.filter((secret): secret is CatalogSecret => secret !== undefined);
    },
    selections(requestedUserId) {
      assertOwner(requestedUserId);
      selections ??= savedCatalogSelections(prisma, userId);
      return selections;
    },
  };
}
