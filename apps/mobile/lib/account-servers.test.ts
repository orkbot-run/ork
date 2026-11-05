// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountServers, addAccountServer } from "./account-servers";
import { accountsAuthorization } from "./accounts";

vi.mock("./accounts", () => ({ accountsAuthorization: vi.fn(), accountsVersion: () => 0 }));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
const remote = {
  id: "00000000-0000-4000-8000-000000000001",
  url: "https://server.example.test",
  kind: "selfhosted",
  deviceId: null,
};
beforeEach(() => {
  vi.mocked(accountsAuthorization).mockResolvedValue({
    issuer: "https://api.orkbot.run",
    subject: "subject-a",
    accessToken: "central-bearer",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("sends the central bearer only to the fixed directory without a device ID", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ servers: [remote] }));
  vi.stubGlobal("fetch", fetcher);
  expect(await accountServers()).toEqual([remote]);
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.orkbot.run/api/servers",
    expect.objectContaining({
      headers: { authorization: "Bearer central-bearer" },
      credentials: "omit",
      redirect: "error",
    }),
  );
});
it("never returns another device's local server", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        servers: [
          {
            id: "desktop",
            url: "http://127.0.0.1:45173",
            kind: "local",
            deviceId: "desktop-device",
          },
          remote,
        ],
      }),
    ),
  );
  expect(await accountServers()).toEqual([remote]);
});
it("does not contact any endpoint without an Accounts session", async () => {
  vi.mocked(accountsAuthorization).mockResolvedValue(null);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(accountServers()).rejects.toThrow("Sign in to Accounts");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not send a different issuer's credential to the central directory", async () => {
  vi.mocked(accountsAuthorization).mockResolvedValue({
    issuer: "https://other.example.test",
    subject: "subject-a",
    accessToken: "private-other-token",
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(accountServers()).rejects.toThrow("Sign in to Accounts");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not perform a stale account's directory mutation with the new account's token", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    addAccountServer(remote.url, JSON.stringify(["https://api.orkbot.run", "old-subject"])),
  ).rejects.toThrow("Sign in to Accounts");
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects a saved entry that substitutes a different product origin", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ server: { ...remote, url: "https://other.example.test" } }),
      ),
  );
  await expect(addAccountServer(remote.url)).rejects.toThrow("different server");
});

it.each(["http://127.0.0.1:45173", "http://localhost:45173", "http://[::1]:45173"])(
  "does not synchronize this device's loopback URL %s",
  async (url) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(addAccountServer(url)).rejects.toThrow("self-hosted server address");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("stores a normalized bookmark without contacting the proposed product server", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ server: remote }));
  vi.stubGlobal("fetch", fetcher);
  expect(await addAccountServer("server.example.test/path?token=discarded")).toEqual(remote);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.orkbot.run/api/servers",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ url: remote.url, kind: "selfhosted" }),
    }),
  );
});
it.each([
  { servers: [{ ...remote, url: "https://user:secret@server.example.test/path" }] },
  { servers: "invalid" },
])("rejects malformed directory response %j", async (response) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
  await expect(accountServers()).rejects.toThrow("Could not load your servers");
});
