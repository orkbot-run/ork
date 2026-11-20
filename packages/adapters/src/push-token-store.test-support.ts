// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited test helpers are preserved; per-session registration is an Ork addition.

import { credentialDigest } from "./credential-digest.js";
import type { PushRecord, PushTokenStore } from "./push-token-store.js";

export class MemoryPushTokenStore implements PushTokenStore {
  private readonly rows = new Map<string, PushRecord & { userId: string }>();
  async list(userId: string): Promise<PushRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .map(({ userId: _userId, ...row }) => row)
      .reverse();
  }
  async load(userId: string) {
    return (await this.list(userId))[0];
  }
  async save(userId: string, token: string, sessionId = "", presentation?: "android_sender") {
    for (const [key, row] of this.rows)
      if (
        row.token === token ||
        (row.userId === userId && row.sessionId === (sessionId || undefined))
      )
        this.rows.delete(key);
    this.rows.set(JSON.stringify([userId, sessionId]), {
      userId,
      token,
      ...(sessionId ? { sessionId } : {}),
      ...(presentation ? { presentation } : {}),
    });
  }
  async importLegacy(userId: string, token: string, sessionId: string) {
    if (
      (await this.list(userId)).length ||
      [...this.rows.values()].some((row) => row.token === token)
    )
      return false;
    await this.save(userId, token, sessionId);
    return true;
  }
  async remove(userId: string, digest?: string) {
    for (const [key, row] of this.rows)
      if (row.userId === userId && (!digest || credentialDigest(row.token) === digest))
        this.rows.delete(key);
  }
  async endSession(userId: string, sessionId: string, nextSessionId?: string) {
    const key = JSON.stringify([userId, sessionId]);
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.delete(key);
    if (nextSessionId && !this.rows.has(JSON.stringify([userId, nextSessionId])))
      this.rows.set(JSON.stringify([userId, nextSessionId]), { ...row, sessionId: nextSessionId });
  }
}
