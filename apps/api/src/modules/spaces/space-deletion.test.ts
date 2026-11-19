// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
  SecretStore,
} from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  claim: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
  bots: vi.fn(),
  computers: vi.fn(),
  remove: vi.fn(),
  admission: vi.fn(),
}));
vi.mock("@orkbot/db", async (original) => ({
  ...(await original<typeof import("@orkbot/db")>()),
  claimSpaceDeletionForMember: lifecycle.claim,
  renewSpaceDeletionClaim: lifecycle.renew,
  releaseSpaceDeletionClaim: lifecycle.release,
  listClaimedSpaceBots: lifecycle.bots,
  listClaimedSpaceComputers: lifecycle.computers,
  deleteClaimedSpaceForMember: lifecycle.remove,
  workspaceAdmissionBinding: lifecycle.admission,
}));
vi.mock("./availability.js", () => ({ rehomeItemsLeaving: vi.fn().mockResolvedValue(undefined) }));

import { deleteSpaceWithContent } from "./space-deletion.js";

const actor = { spaceId: "active-space", userId: "owner" };
function fixture(options: {
  homeFailure?: boolean;
  artifactFailure?: boolean;
  secretFailure?: boolean;
}) {
  const home = {
    purge: vi.fn().mockImplementation(async () => {
      if (options.homeFailure) throw new Error("home storage unavailable");
    }),
  } as unknown as AgentHomeStore;
  const artifacts = {
    remove: vi.fn().mockResolvedValue(undefined),
    purgeSpace: vi.fn().mockImplementation(async () => {
      if (options.artifactFailure) throw new Error("artifact storage unavailable");
    }),
  } as unknown as ArtifactStore;
  const prisma = {
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
    secret: { findMany: vi.fn().mockResolvedValue([]) },
    botSecret: { findMany: vi.fn().mockResolvedValue([]) },
    modelOAuthSession: { findMany: vi.fn().mockResolvedValue([]) },
    mcpOAuthSession: { findMany: vi.fn().mockResolvedValue([]) },
    messagingInstallation: { findMany: vi.fn().mockResolvedValue([]) },
    vaultCredential: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.secretFailure ? [{ id: "workspace-secret", ciphertext: "sealed-ref" }] : [],
        ),
    },
    computer: {
      findMany: vi.fn().mockResolvedValue(options.homeFailure ? [{ homeKey: "saved-home" }] : []),
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    home,
    artifacts,
    secrets: {
      delete: vi.fn().mockImplementation(async () => {
        if (options.secretFailure) throw new Error("secret storage unavailable");
      }),
    } as unknown as SecretStore,
    sandbox: {} as SandboxProvider,
    jobs: {} as JobPublisher,
    dataDir: "/tmp",
  };
}

describe("workspace deletion storage cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.claim.mockResolvedValue({ claimId: "claim", recovered: false });
    lifecycle.renew.mockResolvedValue(true);
    lifecycle.bots.mockResolvedValue([]);
    lifecycle.computers.mockResolvedValue([]);
    lifecycle.admission.mockResolvedValue({ id: "central-workspace" });
    lifecycle.remove.mockResolvedValue({
      id: "active-space",
      artifactKeys: [],
      homeKeys: [],
      pageShareSecrets: [],
    });
  });

  it("keeps the workspace when a member's stored secret cannot be removed", async () => {
    const deps = fixture({ secretFailure: true });
    await expect(deleteSpaceWithContent(deps, actor, "workspace")).rejects.toThrow(
      "secret storage unavailable",
    );
    expect(deps.prisma.vaultCredential.findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace", space: { deletionClaimId: "claim" } },
      select: { id: true, ciphertext: true },
    });
    expect(lifecycle.remove).not.toHaveBeenCalled();
    expect(lifecycle.release).not.toHaveBeenCalled();
  });

  it("does not purge potentially shared personal Space secrets", async () => {
    lifecycle.admission.mockResolvedValue(null);
    const deps = fixture({ secretFailure: true, artifactFailure: true });
    await expect(deleteSpaceWithContent(deps, actor, "workspace")).resolves.toEqual({
      activeSpaceId: "active-space",
    });
    expect(deps.secrets.delete).not.toHaveBeenCalled();
    expect(deps.artifacts.purgeSpace).not.toHaveBeenCalled();
  });

  it("purges pending sign-ins and messaging credentials before removing their rows", async () => {
    const deps = fixture({ artifactFailure: true });
    vi.mocked(deps.prisma.modelOAuthSession.findMany).mockResolvedValueOnce([
      { id: "model-sign-in", ciphertext: "model-ref" },
    ] as never);
    vi.mocked(deps.prisma.mcpOAuthSession.findMany).mockResolvedValueOnce([
      { id: "mcp-sign-in", oauthCiphertext: "mcp-ref" },
    ] as never);
    vi.mocked(deps.prisma.messagingInstallation.findMany).mockResolvedValueOnce([
      { id: "messaging", ciphertext: "messaging-ref" },
    ] as never);
    await expect(deleteSpaceWithContent(deps, actor, "workspace")).rejects.toThrow(
      "artifact storage unavailable",
    );
    for (const [ref, id] of [
      ["model-ref", "model-sign-in"],
      ["mcp-ref", "mcp-sign-in"],
      ["messaging-ref", "messaging"],
    ])
      expect(deps.secrets.delete).toHaveBeenCalledWith(
        ref,
        expect.objectContaining({ recordId: id }),
      );
    expect(lifecycle.remove).not.toHaveBeenCalled();
  });

  it("keeps the claimed workspace when its stored home cannot be removed", async () => {
    const deps = fixture({ homeFailure: true });
    await expect(deleteSpaceWithContent(deps, actor, "workspace")).rejects.toThrow(
      "home storage unavailable",
    );
    expect(lifecycle.remove).not.toHaveBeenCalled();
    expect(lifecycle.release).not.toHaveBeenCalled();
  });

  it("keeps the claimed workspace when its artifact namespace cannot be removed", async () => {
    const deps = fixture({ artifactFailure: true });
    await expect(deleteSpaceWithContent(deps, actor, "workspace")).rejects.toThrow(
      "artifact storage unavailable",
    );
    expect(lifecycle.remove).not.toHaveBeenCalled();
    expect(lifecycle.release).not.toHaveBeenCalled();
  });
});
