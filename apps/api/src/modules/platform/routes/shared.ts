// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; Ork changes consolidate database error matching.
// Inherited Apache-2.0 behavior is preserved. Personal Ork changes follow LICENSE.md.

import {
  deploymentModelRole,
  findConnectedModelCredential,
  findWorkspaceModelPolicy,
  hasHostedModelCredits,
  hostCredentialSource,
  mcpStdioAvailable,
  resolveMemberMainModel,
  selectConfiguredModel,
} from "@orkbot/adapters";
import type { Actor, Me } from "@orkbot/contracts";
import {
  attachmentMaxBytes,
  attachmentMaxCount,
  canonicalPiProviderId,
  resolveBotAvatarSet,
} from "@orkbot/contracts";
import { computerHomeKey } from "@orkbot/db";
import { isAdmin } from "#modules/accounts/admins";
import { syncPrimaryOrk } from "#modules/accounts/first-ork";
import { computerCapabilities } from "#modules/computers/computer-capabilities";
import {
  effectiveSandboxProvider,
  getAccountComputerSettings,
} from "#modules/computers/computer-provider-config";
import type { RouterDeps } from "../router.js";

export { createAdapterContext as computerContext } from "@orkbot/adapter-kit";

function hostCredentials(active: boolean, provider: string) {
  return active
    ? { hostCredentialProvider: provider, hostCredentialSource: hostCredentialSource(provider) }
    : { hostCredentialProvider: null, hostCredentialSource: null };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup, admin] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: {
        email: true,
        name: true,
        orkAvatar: true,
        timezone: true,
        locale: true,
        botAvatarSet: true,
      },
    }),
    modelSetup(deps, actor),
    isAdmin(deps, actor.userId),
  ]);
  await syncPrimaryOrk(deps.prisma, actor, user.orkAvatar);
  // Where the deployment runs computers once an admin's choice in Settings applies.
  const sandboxProvider = effectiveSandboxProvider(setup.settings, deps.env.sandboxProvider);
  const [capabilities, accountSettings] = await Promise.all([
    computerCapabilities(deps.sandbox, {
      homeKey: computerHomeKey({ mode: "team", spaceId: actor.spaceId, userId: actor.userId }),
      ownerUserId: actor.userId,
    }),
    getAccountComputerSettings(deps, actor).catch(() => null),
  ]);
  return {
    serverOrigin: new URL(deps.env.webOrigin).origin,
    ticketBoardEnabled: deps.env.ticketBoardEnabled === true,
    phoneCallsEnabled: deps.env.phoneCallsEnabled === true,
    navLinks: deps.env.navLinks ?? [],
    maxUploadSizeBytes: attachmentMaxBytes(deps.env),
    maxAttachmentsPerMessage: attachmentMaxCount(deps.env),
    userId: actor.userId,
    email: user.email,
    name: user.name,
    orkAvatar: user.orkAvatar ?? null,
    spaceId: actor.spaceId,
    isDeploymentOwner: false,
    isAdmin: admin,
    needsModel: setup.needsModel,
    defaultProvider: canonicalPiProviderId(setup.model?.provider ?? deps.env.defaultProvider),
    defaultModel: setup.model?.modelId ?? deps.env.defaultModel,
    // Set only while the active default is the deployment's own, running on host credentials.
    ...hostCredentials(
      !setup.main &&
        !setup.workspaceModel &&
        !setup.settings?.defaultModelProvider &&
        Boolean(deps.env.deploymentModelHostCredentials),
      deps.env.defaultProvider,
    ),
    computerHost: computerHostFor(setup.settings?.computerHost, sandboxProvider),
    canChooseHostComputer:
      Boolean(deps.env.desktopHostChoiceEnabled) && sandboxProvider === "docker",
    // The deployment's provider: an account's own choice covers only its Team Computers.
    sandboxProvider,
    computerCapabilities: capabilities,
    canConfigureAccountComputers: Boolean(accountSettings?.providers.length),
    mcpStdioEnabled:
      admin &&
      mcpStdioAvailable({
        stdioEnabled: deps.env.mcpStdioEnabled,
        allowedCommands: deps.env.mcpStdioAllowedCommands,
      }),
    avatarStyle: "organic",
    botAvatarSet: resolveBotAvatarSet(user.botAvatarSet),
    timezone: user.timezone ?? null,
    locale: user.locale ?? null,
    billingEnabled: Boolean(deps.billing),
    // Keep the field for older clients without requiring a survey.
    needsSignupSurvey: false,
    paymentWalletProvider: deps.paymentWallet
      ? { id: deps.paymentWallet.describe().id, name: deps.paymentWallet.displayName }
      : null,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

/** The main model chat runs: the member's while it can run, else the deployment's. */
export async function modelSetup(deps: RouterDeps, actor: Actor) {
  const managed = await deps.serverAIModels?.actor(actor);
  if (managed && deps.serverAI) {
    const choices = await deps.serverAI.choices(managed);
    const primary = choices[0];
    const account =
      primary && (await deps.serverAI.list(managed)).find((row) => row.id === primary.connectionId);
    const model =
      account && primary
        ? { provider: account.provider, modelId: primary.modelId }
        : { provider: "", modelId: "" };
    return {
      main: null,
      workspaceModel: model,
      model,
      settings: await deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      funding: null,
      creditsAvailable: false,
      hasDeployment: false,
      needsModel: deps.env.agentRuntime !== "scripted" && !account,
    };
  }
  const workspaceModel = await findWorkspaceModelPolicy(deps.prisma, actor.spaceId);
  const [member, settings] = await Promise.all([
    workspaceModel
      ? null
      : resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const main =
    member &&
    (member.credential ||
      (deps.billing?.modelCreditsEnabled &&
        (await hasHostedModelCredits(deps.prisma, actor, member.provider))))
      ? member
      : null;
  const funding = deps.billing ? await deps.billing.status(actor) : null;
  // A balance keeps paying for the deployment model after switching to an own key.
  const creditsAvailable = funding?.funding === "credits" || (funding?.balanceUsd ?? 0) > 0;
  const hasDeployment =
    Boolean(deps.env.deploymentModelConfigured) &&
    (!funding?.creditPurchasesEnabled || creditsAvailable);
  return {
    main,
    workspaceModel,
    model:
      (workspaceModel
        ? { provider: workspaceModel.provider, modelId: workspaceModel.modelId }
        : null) ??
      main ??
      deploymentModelRole("main", {
        settings,
        deployment: { provider: deps.env.defaultProvider, model: deps.env.defaultModel },
      }).primary,
    settings,
    funding,
    creditsAvailable,
    hasDeployment,
    needsModel: deps.env.agentRuntime !== "scripted" && !workspaceModel && !main && !hasDeployment,
  };
}

/** Whether every bot runs its own model on one of the member's connections, as a run selects it. */
export async function botsRunOwnModels(deps: RouterDeps, actor: Actor, botIds: string[]) {
  const bots = await deps.prisma.bot.findMany({
    where: { id: { in: botIds }, userId: actor.userId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  const credentials = await Promise.all(
    bots.map(async (bot) => {
      const overrideCredential = bot.modelProvider
        ? await findConnectedModelCredential(
            deps.prisma,
            deps.secrets,
            actor,
            bot.modelProvider,
            bot.modelId,
          )
        : null;
      return selectConfiguredModel({ override: bot, overrideCredential, main: null, defaults: {} })
        .credential;
    }),
  );
  return credentials.every(Boolean);
}

export const THREAD_MESSAGE_PAGE_SIZE = 100;

/** Silence longer than this on a thread stream is indistinguishable from a dead socket. */
export const HEARTBEAT_MS = 20_000;

/** A thread stream re-checks its session at least this often while it delivers. */
export const SESSION_RECHECK_MS = 10_000;
