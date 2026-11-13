// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PersonalDevice, WorkspaceTarget } from "@orkbot/contracts";
import { personalDeviceSchema, WorkspaceTargetSchema } from "@orkbot/contracts";
import forge from "node-forge";

interface PersonalNative {
  stagePersonalKey(scope: string, target: string): Promise<PersonalDevice>;
  signPersonalProof(scope: string, id: string, message: string): Promise<string>;
  activatePersonalKey(scope: string, id: string, descriptor: string): Promise<void>;
  personalCredentials(account: string): Promise<string[]>;
  forgetPersonalKey(scope: string, id: string): Promise<void>;
  forgetAllPersonalKeys(): Promise<void>;
  verifyPersonalServer(
    key: string,
    fingerprint: string,
    message: string,
    signature: string,
  ): Promise<boolean>;
}
export interface PersonalCredential {
  version: 1;
  account: string;
  origin: string;
  scope: string;
  deviceId: string;
  target: WorkspaceTarget;
}
export interface StagedPersonalDevice {
  device: PersonalDevice;
  credential: PersonalCredential;
  epoch: number;
}
const SIGNED_OUT = "orkbot.personal.signed-out-v1";
let epoch = 0;
let denied = false;
let writes: Promise<unknown> = Promise.resolve();
const unavailable = () => new Error("Could not continue");
export const personalCredentialEpoch = () => epoch;
export const personalDigest = (value: string) =>
  forge.md.sha256.create().update(value, "utf8").digest().toHex();
const accountHash = (account: string) => personalDigest(`ork-personal-account-v1:${account}`);
export function personalScope(account: string, target: WorkspaceTarget): string {
  return `${accountHash(account)}.${personalDigest(
    JSON.stringify([
      "ork-personal-target-v1",
      target.organizationId,
      target.serverId,
      target.workspaceId,
      target.bindingVersion,
      target.keyFingerprint,
    ]),
  )}`;
}
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation, operation);
  writes = next.catch(() => undefined);
  return next;
}
async function native(): Promise<PersonalNative | null> {
  // Older binaries cannot create an offline credential. No private key enters JavaScript.
  const core = await import("expo-modules-core");
  return core.requireOptionalNativeModule<PersonalNative>("OrkIdentity");
}
export function parsePersonalCredential(raw: string): PersonalCredential {
  if (raw.length > 8192) throw unavailable();
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "account,deviceId,origin,scope,target,version" ||
    value.version !== 1 ||
    typeof value.account !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.deviceId !== "string"
  )
    throw unavailable();
  const owner = JSON.parse(value.account);
  if (
    !Array.isArray(owner) ||
    owner.length !== 2 ||
    owner.some((item) => typeof item !== "string" || !item)
  )
    throw unavailable();
  const issuer = new URL(owner[0]);
  const origin = new URL(value.origin);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    origin.protocol !== "https:" ||
    origin.origin !== value.origin ||
    origin.username ||
    origin.password ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.deviceId)
  )
    throw unavailable();
  const target = WorkspaceTargetSchema.parse(value.target);
  if (
    !Number.isSafeInteger(target.bindingVersion) ||
    value.scope !== personalScope(value.account, target)
  )
    throw unavailable();
  return { ...value, target };
}
export async function stagePersonalDevice(
  account: string,
  origin: string,
  target: WorkspaceTarget,
): Promise<StagedPersonalDevice | null> {
  const expected = epoch;
  const module = await native();
  if (!module) return null;
  return serialize(async () => {
    if (epoch !== expected) throw unavailable();
    const scope = personalScope(account, target);
    const device = personalDeviceSchema.parse(
      await module.stagePersonalKey(scope, JSON.stringify(target)),
    );
    if (epoch !== expected) {
      await module.forgetPersonalKey(scope, device.id);
      throw unavailable();
    }
    const credential = parsePersonalCredential(
      JSON.stringify({
        version: 1,
        account,
        origin,
        scope,
        deviceId: device.id,
        target,
      }),
    );
    return { device, credential, epoch: expected };
  });
}
export async function signPersonalDevice(
  credential: PersonalCredential,
  message: string,
  expected: number,
): Promise<string> {
  if (epoch !== expected) throw unavailable();
  const module = await native();
  if (!module || epoch !== expected) throw unavailable();
  const proof = await module.signPersonalProof(credential.scope, credential.deviceId, message);
  if (epoch !== expected || !/^[A-Za-z0-9_-]{1,110}$/.test(proof)) throw unavailable();
  return proof;
}
export async function activatePersonalDevice(
  staged: StagedPersonalDevice,
  current: () => boolean,
): Promise<void> {
  return serialize(async () => {
    if (epoch !== staged.epoch || !current()) throw unavailable();
    const module = await native();
    if (!module || epoch !== staged.epoch || !current()) throw unavailable();
    const { credential } = staged;
    await module.activatePersonalKey(
      credential.scope,
      credential.deviceId,
      JSON.stringify(credential),
    );
    if (epoch !== staged.epoch || !current()) {
      await module.forgetPersonalKey(credential.scope, credential.deviceId);
      throw unavailable();
    }
    const storage = await import("expo-secure-store");
    if (epoch !== staged.epoch || !current()) throw unavailable();
    await storage.deleteItemAsync(SIGNED_OUT);
    if (epoch !== staged.epoch || !current()) throw unavailable();
    denied = false;
  });
}
export async function forgetPersonalDevice(credential: PersonalCredential): Promise<void> {
  return serialize(async () => {
    await (await native())?.forgetPersonalKey(credential.scope, credential.deviceId);
  });
}
/** Invalidate synchronously before account listeners or a pending network response can run. */
export function signOutPersonalDevices(): Promise<void> {
  ++epoch;
  denied = true;
  return serialize(async () => {
    // Attempt both operations even if either storage fails. The marker survives process restart.
    const results = await Promise.allSettled([
      import("expo-secure-store").then((storage) =>
        storage.setItemAsync(SIGNED_OUT, "1", {
          keychainAccessible: storage.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      ),
      native().then((module) => module?.forgetAllPersonalKeys()),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
}
export async function personalCredential(
  account: string,
  origin: string,
  target: WorkspaceTarget,
): Promise<PersonalCredential | null> {
  const expected = epoch;
  await writes;
  const module = await native();
  if (!module || denied || epoch !== expected) return null;
  const storage = await import("expo-secure-store");
  if (await storage.getItemAsync(SIGNED_OUT)) return null;
  const values = await module.personalCredentials(accountHash(account));
  if (denied || epoch !== expected) return null;
  const scope = personalScope(account, target);
  const matches = values
    .map(parsePersonalCredential)
    .filter((row) => row.account === account && row.origin === origin && row.scope === scope);
  return matches.length === 1 ? matches[0]! : null;
}
export async function verifyPersonalServer(
  credential: PersonalCredential,
  key: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const module = await native();
  return module
    ? module.verifyPersonalServer(key, credential.target.keyFingerprint, message, signature)
    : false;
}
