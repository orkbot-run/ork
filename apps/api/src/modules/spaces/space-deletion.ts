// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
  SecretStore,
} from "@orkbot/adapter-kit";
import {
  destroyBot,
  forgetPageShareSecrets,
  purgeAgentHome,
  removeAgentHome,
  toComputerRef,
} from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  claimSpaceDeletionForMember,
  deleteClaimedSpaceForMember,
  listClaimedSpaceBots,
  listClaimedSpaceComputers,
  recordComputerRunEnd,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  runAsSystem,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
  workspaceAdmissionBinding,
} from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import { rehomeItemsLeaving } from "./availability.js";
import type { ManagedSpaceClaim } from "./workspace-lifecycle-deletion.js";
import {
  claimManagedSpace,
  deleteClaimedManagedSpace,
  renewManagedSpace,
} from "./workspace-lifecycle-deletion.js";

/** Bound for one bot or sandbox teardown. Providers may ignore the abort signal,
 * so without a deadline a hung destroy would keep the deletion claim renewed
 * forever and block stale-claim recovery. */
const SPACE_TEARDOWN_TIMEOUT_MS = 120_000;

function spaceTeardownTimeoutMs(): number {
  const override = Number(process.env.SPACE_TEARDOWN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : SPACE_TEARDOWN_TIMEOUT_MS;
}

export type SpaceDeletionDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  artifacts: ArtifactStore;
  dataDir: string;
  messagingInstallations?: Parameters<typeof destroyBot>[0]["messagingInstallations"];
  /** Removes deleted page links' tokens from a remote secret store. */
  secrets?: Pick<SecretStore, "delete">;
};

/** The owner-only rules live in the db layer. A worker that dies mid-way leaves the Space
 * claimed; after the claim goes stale, deleting again resumes from what is left. */
export async function deleteSpaceWithContent(
  deps: SpaceDeletionDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  spaceId: string,
  signal?: AbortSignal,
  managed?: ManagedSpaceClaim,
): Promise<{ activeSpaceId: string }> {
  if (managed && managed.spaceId !== spaceId) throw new Error("Workspace deletion scope changed");
  let claimId: string | null = null;
  let claimActive = false;
  let claimHealthy = true;
  let claimReleasable = false;
  let claimRenewal: ReturnType<typeof setInterval> | null = null;
  const deleteInput = { currentSpaceId: actor.spaceId, userId: actor.userId, spaceId };
  const context = (botId?: string, userId = actor.userId): AdapterContext => ({
    operationId: `spaces.remove:${spaceId}`,
    traceId: `spaces.remove:${spaceId}`,
    spaceId,
    userId,
    ...(botId ? { botId } : {}),
    signal: signal ?? new AbortController().signal,
  });
  try {
    // Claim before teardown. Bot and group creation take the same lifecycle lock
    // and reject the Space until deletion finishes or this claim is released.
    const claim = managed
      ? await claimManagedSpace(deps.prisma, managed)
      : await claimSpaceDeletionForMember(deps.prisma, deleteInput);
    if ("missing" in claim && claim.missing) return { activeSpaceId: actor.spaceId };
    claimId = managed ? managed.claimId : (claim as { claimId: string }).claimId;
    claimActive = true;
    // A recovered worker can safely finish deletion, but cannot know whether the
    // previous worker still has teardown in flight. Keep the Space claimed on
    // failure so content cannot reuse it.
    claimReleasable = !managed && !claim.recovered;
    const claimedInput = { ...deleteInput, claimId };
    const assertClaim = async () => {
      if (!claimHealthy) throw new SpaceDeletionInProgressError();
      try {
        const renewed = managed
          ? await renewManagedSpace(deps.prisma, managed)
          : await renewSpaceDeletionClaim(deps.prisma, claimedInput);
        if (!renewed) {
          claimHealthy = false;
          claimReleasable = false;
          throw new SpaceDeletionInProgressError();
        }
      } catch (error) {
        claimHealthy = false;
        claimReleasable = false;
        throw error;
      }
    };
    claimRenewal = setInterval(() => {
      void assertClaim().catch((renewalError) => {
        if (claimActive) getLogger().error("space deletion claim renewal failed", renewalError);
      });
    }, SPACE_DELETION_CLAIM_TIMEOUT_MS / 5);
    // Teardown may reach a remote service even when it fails. From the first one,
    // only a finished deletion may unblock the Space; a stale recovery must finish it.
    const teardown = async (work: () => Promise<unknown>, timeoutMessage: string) => {
      signal?.throwIfAborted();
      await assertClaim();
      claimReleasable = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Stop renewal so the claim goes stale and a later worker can
              // recover; never release, since the hung work may still complete.
              claimHealthy = false;
              claimReleasable = false;
              reject(new Error(timeoutMessage));
            }, spaceTeardownTimeoutMs());
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      signal?.throwIfAborted();
      await assertClaim();
    };

    // Legacy personal Spaces can share integrations and credentials with other Spaces.
    // Centrally managed workspace admissions have no cross-workspace sharing.
    const managedWorkspace =
      managed ??
      (await runAsSystem("check the claimed workspace admission", () =>
        workspaceAdmissionBinding(deps.prisma, spaceId),
      ));
    const purgeSecrets = async () => {
      // These rows are scoped to this Space; account and organization credentials are untouched.
      const where = { spaceId, space: { deletionClaimId: claimId } };
      const [secrets, botSecrets, vault, modelSessions, mcpSessions, messaging] = await runAsSystem(
        "find every member's secrets in a claimed workspace",
        () =>
          Promise.all([
            deps.prisma.secret.findMany({
              where: {
                OR: [
                  where,
                  { pageShare: { is: { spaceId, space: { deletionClaimId: claimId } } } },
                ],
              },
              select: { id: true, ciphertext: true },
            }),
            deps.prisma.botSecret.findMany({ where, select: { id: true, ciphertext: true } }),
            deps.prisma.vaultCredential.findMany({ where, select: { id: true, ciphertext: true } }),
            deps.prisma.modelOAuthSession.findMany({
              where,
              select: { id: true, ciphertext: true },
            }),
            deps.prisma.mcpOAuthSession.findMany({
              where,
              select: { id: true, oauthCiphertext: true },
            }),
            deps.prisma.messagingInstallation.findMany({
              where,
              select: { id: true, ciphertext: true },
            }),
          ]),
      );
      const rows = [
        ...secrets,
        ...botSecrets,
        ...vault,
        ...modelSessions,
        ...mcpSessions.map(({ id, oauthCiphertext }) => ({ id, ciphertext: oauthCiphertext })),
        ...messaging,
      ];
      if (rows.length && !deps.secrets) throw new Error("Secret storage is unavailable");
      for (const row of rows) {
        await teardown(
          () =>
            deps.secrets!.delete(row.ciphertext, {
              recordId: row.id,
              signal: AbortSignal.timeout(10_000),
            }),
          "Space secret purge timed out",
        );
      }
    };
    // Remove remote references before bot cascades can erase the records needed for retries.
    if (managedWorkspace) await purgeSecrets();
    // Verify all known storage backends are reachable before bot teardown removes their rows.
    const artifacts = await deps.prisma.artifact.findMany({
      where: { spaceId, space: { deletionClaimId: claimId } },
      select: { storageKey: true },
    });
    for (const artifact of artifacts) {
      await teardown(
        () => deps.artifacts.remove(artifact.storageKey, context()),
        "Space artifact purge timed out",
      );
    }
    for (const bot of await listClaimedSpaceBots(deps.prisma, claimedInput)) {
      try {
        await teardown(
          () =>
            destroyBot({ ...deps, secretStore: deps.secrets }, bot, context(bot.id, bot.userId), {
              deleteMemories: true,
              strictTeardown: true,
              purgeHome: true,
            }),
          "Space bot teardown timed out",
        );
      } catch (error) {
        // A takeover worker may have finished this bot first.
        if (!claimHealthy) throw error;
        const remaining = await deps.prisma.bot.findUnique({
          where: { id: bot.id },
          select: { id: true },
        });
        if (remaining) throw error;
      }
    }
    for (const computer of await listClaimedSpaceComputers(deps.prisma, claimedInput)) {
      await teardown(
        () => deps.sandbox.destroy(toComputerRef(computer), context(computer.homeKey)),
        "Space sandbox teardown timed out",
      );
      // Never clear a provider handle after this worker loses its claim.
      await deps.prisma.computer.updateMany({
        where: {
          spaceId,
          homeKey: computer.homeKey,
          providerRef: computer.providerRef,
          space: { deletionClaimId: claimId },
        },
        data: { state: "stopped", providerRef: null },
      });
      await recordComputerRunEnd(deps.prisma, computer, "deleted");
    }
    // Other computers can still own stored revisions even after their provider stopped.
    // Purge while their database rows still identify the remote storage, and keep the
    // claim on failure so a retry can finish without making the Space usable again.
    const homes = await deps.prisma.computer.findMany({
      where: { spaceId, space: { deletionClaimId: claimId } },
      select: { homeKey: true },
    });
    for (const home of homes) {
      await teardown(() => purgeAgentHome(deps.home, home.homeKey), "Space home purge timed out");
    }
    // Catch remaining Space-owned secrets before their database rows cascade away.
    if (managedWorkspace) await purgeSecrets();
    // Sweep the whole storage namespace, including files without a surviving database row.
    if (!deps.artifacts.purgeSpace)
      throw new Error("This artifact storage provider cannot permanently delete a space");
    await teardown(() => deps.artifacts.purgeSpace!(context()), "Space artifact purge timed out");
    await assertClaim();
    claimActive = false;
    if (claimRenewal) {
      clearInterval(claimRenewal);
      claimRenewal = null;
    }
    if (!managed) await rehomeItemsLeaving(deps.prisma, spaceId);
    const deleted = managed
      ? await deleteClaimedManagedSpace(deps.prisma, managed)
      : await deleteClaimedSpaceForMember(deps.prisma, claimedInput);
    // Rows are gone; leftover stored files are unreachable, so cleanup failures only log.
    const cleanup = await Promise.allSettled([
      ...deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context())),
      ...deleted.homeKeys.map((homeKey) => removeAgentHome(deps.home, homeKey, deps.dataDir)),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
    if (deps.secrets) await forgetPageShareSecrets(deps.secrets, deleted.pageShareSecrets);
    return { activeSpaceId: deleted.id };
  } catch (error) {
    if (signal?.aborted) claimReleasable = false;
    if (claimId && claimReleasable) {
      await releaseSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId }).catch(
        (releaseError) => {
          getLogger().error("space deletion claim release failed", releaseError);
        },
      );
    }
    throw error;
  } finally {
    claimActive = false;
    if (claimRenewal) clearInterval(claimRenewal);
  }
}
