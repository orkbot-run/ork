// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { SecretStore } from "@orkbot/adapter-kit";
import type { BotSecretDestination } from "@orkbot/contracts";
import {
  BotSecretAuth,
  commandVariableName,
  decodeCardSecret,
  decodeLoginSecret,
} from "@orkbot/contracts";
import type { Prisma, PrismaClient } from "@orkbot/db";
import { runAsSystem, workspaceAdmissionBinding } from "@orkbot/db";
import {
  itemPreview,
  normalizeSecretDestination,
  sameSecretDestination,
  validateBotSecretValue,
} from "./bot-secrets.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import type { AIActor } from "./server-ai-catalog.js";

const forbidden = (): never => {
  throw new Error("Organization vault access denied");
};

/** Operations run only on the customer's installation; Accounts never receives secret values. */
export class OrganizationVault {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
  ) {}

  private async administrator(tx: Prisma.TransactionClient, actor: AIActor) {
    await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
    const binding = await workspaceAdmissionBinding(tx, actor.spaceId);
    if (!binding) return forbidden();
    await tx.$queryRaw`SELECT id FROM central_workspace_bindings WHERE id = ${binding.id} FOR UPDATE`;
    const current = await tx.centralWorkspaceBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
    const access = await tx.centralWorkspaceAccess.findUnique({
      where: { workspaceId_userId: { workspaceId: current.id, userId: actor.userId } },
    });
    const administrator =
      access &&
      Array.isArray(current.members) &&
      current.members.some(
        (member) =>
          member &&
          typeof member === "object" &&
          !Array.isArray(member) &&
          member.userId === access.centralSubject &&
          member.accessVersion === access.membershipVersion &&
          member.organizationRole === "admin",
      );
    if (
      current.organizationType !== "shared" ||
      current.state !== "ready" ||
      current.validUntil.getTime() <= Date.now() ||
      !access?.active ||
      !actor.membershipVersion ||
      actor.membershipVersion !== access.membershipVersion ||
      !administrator ||
      !identity ||
      identity.state !== "ready" ||
      identity.serverId !== current.serverId ||
      identity.centralOrganizationId !== current.centralOrganizationId ||
      identity.localOrganizationId !== current.localOrganizationId ||
      identity.bindingVersion !== current.bindingVersion
    )
      return forbidden();
    if (
      current.spaceId !== actor.spaceId &&
      !(await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      }))
    )
      return forbidden();
    return {
      organizationId: current.localOrganizationId,
      bindingVersion: current.bindingVersion,
      serverId: current.serverId,
    };
  }

  async workspaces(actor: AIActor) {
    return runAsSystem("list organization vault workspace access", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        const spaces = await tx.space.findMany({
          where: { organizationId: admin.organizationId, deletingAt: null },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        });
        const result = [];
        for (const space of spaces) {
          const binding = await workspaceAdmissionBinding(tx, space.id);
          if (
            !binding ||
            binding.serverId !== admin.serverId ||
            binding.bindingVersion !== admin.bindingVersion
          )
            continue;
          const grant = await tx.organizationVaultGrant.findUnique({
            where: { spaceId: space.id },
          });
          result.push({
            id: space.id,
            name: space.name,
            state: binding.state,
            granted:
              grant?.organizationId === admin.organizationId &&
              grant.bindingVersion === admin.bindingVersion,
          });
        }
        return result;
      }),
    );
  }

  async setWorkspaceAccess(actor: AIActor, spaceId: string, allowed: boolean) {
    await runAsSystem("change organization vault workspace access", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        const space = await tx.space.findUnique({ where: { id: spaceId } });
        const binding = space && (await workspaceAdmissionBinding(tx, spaceId));
        if (
          !space ||
          space.organizationId !== admin.organizationId ||
          space.deletingAt ||
          !binding ||
          binding.serverId !== admin.serverId ||
          binding.bindingVersion !== admin.bindingVersion ||
          !["ready", "archived"].includes(binding.state)
        )
          return forbidden();
        if (allowed)
          await tx.organizationVaultGrant.upsert({
            where: { spaceId },
            create: {
              spaceId,
              organizationId: admin.organizationId,
              bindingVersion: admin.bindingVersion,
            },
            update: { organizationId: admin.organizationId, bindingVersion: admin.bindingVersion },
          });
        else
          await tx.organizationVaultGrant.deleteMany({
            where: { spaceId, organizationId: admin.organizationId },
          });
      }),
    );
  }

  async list(actor: AIActor) {
    const rows = await runAsSystem("list organization vault metadata", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        return tx.organizationVaultCredential.findMany({
          where: { organizationId: admin.organizationId },
          select: {
            name: true,
            title: true,
            note: true,
            origin: true,
            auth: true,
            createdAt: true,
            updatedAt: true,
            id: true,
            ciphertext: true,
          },
          orderBy: { name: "asc" },
        });
      }),
    );
    return Promise.all(
      rows.map(async ({ id, ciphertext, ...row }) => ({
        ...row,
        preview: await itemPreview(this.secrets, { id, ciphertext, auth: row.auth }),
      })),
    );
  }

  async reveal(actor: AIActor, name: string) {
    const row = await runAsSystem("read an organization vault secret after confirmation", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        return tx.organizationVaultCredential.findUnique({
          where: { organizationId_name: { organizationId: admin.organizationId, name } },
        });
      }),
    );
    if (!row) return null;
    const plaintext = await this.secrets.load(row.ciphertext, row.id);
    await runAsSystem("recheck organization vault authorization before revealing", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        const current = await tx.organizationVaultCredential.findUnique({
          where: { organizationId_name: { organizationId: admin.organizationId, name } },
          select: { id: true, ciphertext: true },
        });
        if (current?.id !== row.id || current.ciphertext !== row.ciphertext) return forbidden();
      }),
    );
    const type = BotSecretAuth.safeParse(row.auth).data?.type;
    if (type === "login") return decodeLoginSecret(plaintext);
    if (type === "card") return { card: decodeCardSecret(plaintext) };
    return { value: plaintext };
  }

  async put(
    actor: AIActor,
    input: {
      destination: BotSecretDestination;
      plaintext: string;
      title?: string;
      note?: string;
      createOnly?: boolean;
    },
  ) {
    const destination = normalizeSecretDestination(input.destination);
    const plaintext = validateBotSecretValue(destination, input.plaintext);
    const previous = await runAsSystem("prepare organization vault credential", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        return tx.organizationVaultCredential.findUnique({
          where: {
            organizationId_name: { organizationId: admin.organizationId, name: destination.name },
          },
        });
      }),
    );
    const id = previous?.id ?? randomUUID();
    const stored = await this.secrets.put(
      plaintext,
      {
        userId: actor.userId,
        spaceId: actor.spaceId,
        operationId: id,
        traceId: id,
        signal: new AbortController().signal,
      },
      { recordId: id },
    );
    await persistPreparedSecret(
      this.prisma,
      this.secrets,
      { id, ciphertext: stored.ciphertext },
      () =>
        runAsSystem("save organization vault credential", () =>
          this.prisma.$transaction(async (tx) => {
            const admin = await this.administrator(tx, actor);
            await tx.$queryRaw`SELECT id FROM organization WHERE id = ${admin.organizationId} FOR UPDATE`;
            const rows = await tx.organizationVaultCredential.findMany({
              where: { organizationId: admin.organizationId },
            });
            const current = rows.find((row) => row.name === destination.name);
            if (current?.id !== previous?.id)
              throw new Error("Credential changed while saving; retry");
            if (current && input.createOnly)
              throw new Error("A credential with this name already exists");
            if (!current && rows.length >= 100) throw new Error("Credential limit reached");
            if (current && !sameSecretDestination(normalizeSecretDestination(current), destination))
              throw new Error("Remove the existing credential before changing its destination");
            if (
              destination.auth.type === "command" &&
              rows.some(
                (row) =>
                  row.name !== destination.name &&
                  BotSecretAuth.safeParse(row.auth).data?.type === "command" &&
                  commandVariableName(row.name) === commandVariableName(destination.name),
              )
            )
              throw new Error("A command variable with this name already exists");
            if (current)
              await tx.organizationVaultCredential.update({
                where: { id },
                data: {
                  ciphertext: stored.ciphertext,
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.note !== undefined ? { note: input.note } : {}),
                },
              });
            else
              await tx.organizationVaultCredential.create({
                data: {
                  id,
                  organizationId: admin.organizationId,
                  ...destination,
                  ciphertext: stored.ciphertext,
                  title: input.title ?? "",
                  note: input.note ?? "",
                },
              });
          }),
        ),
    );
  }

  async remove(actor: AIActor, name: string) {
    await runAsSystem("delete organization vault credential", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        await tx.organizationVaultCredential.deleteMany({
          where: { organizationId: admin.organizationId, name },
        });
      }),
    );
  }

  async relabel(
    actor: AIActor,
    input: { destination: BotSecretDestination; title?: string; note?: string },
  ) {
    const destination = normalizeSecretDestination(input.destination);
    await runAsSystem("update organization vault labels", () =>
      this.prisma.$transaction(async (tx) => {
        const admin = await this.administrator(tx, actor);
        const row = await tx.organizationVaultCredential.findUnique({
          where: {
            organizationId_name: { organizationId: admin.organizationId, name: destination.name },
          },
        });
        if (!row || !sameSecretDestination(normalizeSecretDestination(row), destination))
          throw new Error("Credential not found or destination changed");
        await tx.organizationVaultCredential.update({
          where: { id: row.id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        });
      }),
    );
  }
}
