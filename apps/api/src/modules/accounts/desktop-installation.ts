// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { InstallationClient, WorkspaceAuthority } from "@orkbot/auth";
import { desktopInstallationInputSchema as inputSchema } from "@orkbot/contracts";
import type { Hono } from "hono";
import { validLocalSettingsToken } from "#modules/computers/local-settings";
import { readBoundedBody } from "#modules/platform/http-body";

/** The private native capability operates this Docker installation, never an Accounts bearer. */
export function mountDesktopInstallation(
  app: Hono,
  deps: {
    token?: string;
    accountKey?: string;
    installation?: Pick<InstallationClient, "resumeEnrollment" | "configuration" | "publishRoutes">;
    authority?: Pick<WorkspaceAuthority, "synchronize" | "provisionWorkspace">;
    delegate(accountKey: string, fingerprint: string, bindingVersion: number): Promise<void>;
  },
) {
  app.post("/api/desktop-settings/installation", async (c) => {
    c.header("cache-control", "no-store");
    if (
      !deps.accountKey ||
      !/^[a-f0-9]{64}$/.test(deps.accountKey) ||
      !validLocalSettingsToken(deps.token, c.req.header("x-orkbot-desktop-stack-token"))
    )
      return c.json({ error: "Unavailable" }, 401);
    if (!deps.installation || !deps.authority) return c.json({ error: "Unavailable" }, 503);
    const body = await readBoundedBody(c.req.raw, 16 * 1024);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    let parsed: ReturnType<typeof inputSchema.safeParse>;
    try {
      parsed = inputSchema.safeParse(JSON.parse(body));
    } catch {
      return c.json({ error: "Invalid setup request" }, 400);
    }
    if (!parsed.success) return c.json({ error: "Invalid setup request" }, 400);
    const input = parsed.data;
    try {
      if (input.action === "enroll")
        return c.json(
          await deps.installation.resumeEnrollment("This computer", input.organizationId),
        );
      const configuration = await deps.installation.configuration();
      if (
        !configuration ||
        configuration.organizationId !== input.organizationId ||
        configuration.serverId !== input.serverId ||
        configuration.bindingVersion !== input.bindingVersion ||
        configuration.keyFingerprint !== input.keyFingerprint
      )
        return c.json({ error: "Installation binding changed" }, 409);
      const projection = await deps.authority.synchronize();
      if (!projection.workspaces.some((row) => row.id === input.workspaceId))
        return c.json({ error: "Workspace unavailable" }, 403);
      await deps.authority.provisionWorkspace(input.workspaceId);
      const confirmed = await deps.authority.synchronize();
      if (
        confirmed.serverId !== input.serverId ||
        confirmed.organizationId !== input.organizationId ||
        confirmed.bindingVersion !== input.bindingVersion ||
        confirmed.keyFingerprint !== input.keyFingerprint
      )
        return c.json({ error: "Installation binding changed" }, 409);
      if (
        !confirmed.workspaces.some((row) => row.id === input.workspaceId && row.state === "ready")
      )
        return c.json({ error: "Workspace is not ready" }, 409);
      await deps.installation.publishRoutes(input.routes, configuration);
      if (input.delegateAI)
        await deps.delegate(
          deps.accountKey,
          configuration.keyFingerprint,
          configuration.bindingVersion,
        );
      return c.json({ state: "ready", ...configuration, workspaceId: input.workspaceId });
    } catch {
      return c.json({ error: "Could not complete local installation. Retry to continue." }, 503);
    }
  });
}
