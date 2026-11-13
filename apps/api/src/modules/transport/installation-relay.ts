// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { InstallationTransport } from "@orkbot/adapters/installation-transport";
import type { InstallationClient, WorkspaceAuthority } from "@orkbot/auth";
import type { InstallationTransportLease } from "@orkbot/auth/installation-client";
import { InstallationRequestError } from "@orkbot/auth/installation-client";
import { InstallationTransportOwner } from "@orkbot/auth/installation-transport-owner";
import {
  RELAY_ATTACHMENT_PATH,
  RELAY_SERVER_PATH,
  relayOpenSchema,
  relayReadySchema,
} from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { WebSocket } from "ws";

interface Attachment {
  socket?: WebSocket;
}
interface Acknowledgement {
  expiresAt: number;
  resolve(): void;
  reject(error: Error): void;
}

const unavailable = () => new Error("Installation relay unavailable");
function address(origin: string, path: string): string {
  const url = new URL(path, origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw unavailable();
  url.protocol = "wss:";
  return url.href;
}

function connect(url: string, credential: string, maxPayload = 32 * 1024): WebSocket {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${credential}` },
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload,
    handshakeTimeout: 8_000,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  });
  socket.on("error", () => undefined);
  return socket;
}

/** One elected process maintains metadata control; each data request starts its own channel. */
export function startInstallationRelay(options: {
  prisma: PrismaClient;
  installation: InstallationClient;
  authority: WorkspaceAuthority;
  transport: InstallationTransport;
  onError(error: Error): void;
}): () => Promise<void> {
  const owner = new InstallationTransportOwner(options.prisma);
  let stopped = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let lease: InstallationTransportLease | undefined;
  let control: WebSocket | undefined;
  let controlOrigin: string | undefined;
  let acknowledgement: Acknowledgement | undefined;
  const attachments = new Map<string, Attachment>();
  const closeNetwork = () => {
    const previous = control;
    control = undefined;
    controlOrigin = undefined;
    acknowledgement?.reject(unavailable());
    acknowledgement = undefined;
    for (const attachment of attachments.values()) attachment.socket?.terminate();
    attachments.clear();
    previous?.terminate();
  };
  const current = (socket: WebSocket, expected: InstallationTransportLease) =>
    !stopped && control === socket && lease === expected && expected.deadline > performance.now();

  const attach = async (socket: WebSocket, input: ReturnType<typeof relayOpenSchema.parse>) => {
    const expected = lease;
    if (
      !expected?.relay ||
      !current(socket, expected) ||
      attachments.has(input.channelId) ||
      attachments.size >= 256
    )
      throw unavailable();
    const attachment: Attachment = {};
    attachments.set(input.channelId, attachment);
    try {
      if (!(await owner.active(expected.configuration)) || !current(socket, expected))
        throw unavailable();
      const data = connect(
        address(expected.relay.origin, `${RELAY_ATTACHMENT_PATH}/${input.channelId}`),
        input.secret,
        256 * 1024,
      );
      // Data records have a separate bounded frame limit from control metadata.
      attachment.socket = data;
      data.once("close", () => {
        if (attachments.get(input.channelId) === attachment) attachments.delete(input.channelId);
      });
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(unavailable());
        };
        const cleanup = () => {
          data.off("open", ready);
          data.off("error", failed);
          data.off("close", failed);
        };
        data.once("open", ready);
        data.once("error", failed);
        data.once("close", failed);
      });
      if (
        !current(socket, expected) ||
        attachments.get(input.channelId) !== attachment ||
        !(await owner.active(expected.configuration)) ||
        !current(socket, expected)
      )
        throw unavailable();
      await options.transport.attach(data);
    } catch (error) {
      attachment.socket?.terminate();
      if (attachments.get(input.channelId) === attachment) attachments.delete(input.channelId);
      throw error;
    }
  };

  const renew = async (expected: InstallationTransportLease) => {
    if (!expected.relay) {
      closeNetwork();
      return;
    }
    if (
      !control ||
      control.readyState !== WebSocket.OPEN ||
      controlOrigin !== expected.relay.origin
    ) {
      closeNetwork();
      const socket = connect(
        address(expected.relay.origin, RELAY_SERVER_PATH),
        expected.relay.ticket,
      );
      control = socket;
      controlOrigin = expected.relay.origin;
      socket.once("close", () => {
        if (control === socket) closeNetwork();
      });
      socket.on("message", (bytes, binary) => {
        if (control !== socket) return;
        if (binary || !Buffer.isBuffer(bytes) || bytes.length > 32 * 1024) return closeNetwork();
        try {
          const value: unknown = JSON.parse(bytes.toString());
          const ready = relayReadySchema.safeParse(value);
          if (ready.success) {
            if (acknowledgement?.expiresAt !== ready.data.expiresAt) throw unavailable();
            acknowledgement.resolve();
            return;
          }
          const opened = relayOpenSchema.parse(value);
          void attach(socket, opened).catch(() => {
            if (!stopped) options.onError(unavailable());
          });
        } catch {
          closeNetwork();
        }
      });
    }
    const socket = control;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          cleanup();
          closeNetwork();
          reject(unavailable());
        },
        Math.max(0, Math.min(8_000, expected.deadline - performance.now())),
      );
      timeout.unref();
      const failed = () => {
        cleanup();
        reject(unavailable());
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("error", failed);
        socket.off("close", failed);
        if (acknowledgement === pending) acknowledgement = undefined;
      };
      const pending: Acknowledgement = {
        expiresAt: expected.expiresAt,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: () => {
          cleanup();
          reject(unavailable());
        },
      };
      acknowledgement = pending;
      socket.once("error", failed);
      socket.once("close", failed);
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ version: 1, type: "renew", ticket: expected.relay!.ticket }),
          (error) => {
            if (error) failed();
          },
        );
    });
  };

  const tick = async () => {
    let owned: Awaited<ReturnType<InstallationTransportOwner["acquire"]>> = null;
    try {
      owned = await owner.acquire();
      if (stopped) return;
      if (!owned) {
        closeNetwork();
        lease = undefined;
        clearTimeout(leaseTimer);
        return;
      }
      const next = await options.installation.transportLease(owner.id, owned.configuration);
      if (
        stopped ||
        performance.now() >= owned.deadline ||
        !(await owner.active(owned.configuration))
      )
        return;
      lease = next;
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () => {
          closeNetwork();
          lease = undefined;
        },
        Math.max(0, next.deadline - performance.now()),
      );
      leaseTimer.unref();
      await renew(next);
    } catch (error) {
      closeNetwork();
      if (!stopped) {
        if (
          error instanceof InstallationRequestError &&
          [400, 401, 403, 409, 410, 426].includes(error.status)
        ) {
          await options.authority
            .refuseInstallation(owned?.configuration.serverId)
            .catch(() => options.onError(unavailable()));
        } else if (lease?.relay) {
          // A relay refusal alone is not central revocation authority.
          await options.authority.synchronize().catch(() => undefined);
        }
        options.onError(unavailable());
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          active = tick();
        }, 10_000);
        timer.unref();
      }
    }
  };
  active = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(leaseTimer);
    closeNetwork();
    await active;
    if (lease) {
      try {
        await options.installation.releaseTransport(owner.id, lease.configuration);
        await owner.release();
      } catch {
        // Retain the longer local lease if Accounts could not confirm release.
      }
    }
  };
}
