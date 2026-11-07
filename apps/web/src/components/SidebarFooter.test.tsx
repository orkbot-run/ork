// @vitest-environment jsdom
// Modified by Ork contributors: canonical domain links now use ork.run.
import type { DesktopUpdateState } from "@orkbot/contracts";
import { Toaster } from "@orkbot/ui-web";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdateSection, DesktopUpdatesProvider } from "./DesktopUpdates";
import { SidebarFooter, sidebarMarkCount } from "./SidebarFooter";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.orkbotDesktop;
  vi.restoreAllMocks();
});
async function render(
  name = "Demo User",
  image?: string,
  onIntegrations = vi.fn(),
  onBoard?: () => void,
  logos?: Array<{ name: string; logo?: string }>,
  mini = false,
) {
  const email = "account@orkbot.test";
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <SidebarFooter
          mini={mini}
          logos={logos}
          name={name}
          initials={name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
          image={image}
          email={email}
          open
          onOpenChange={() => {}}
          onIntegrations={onIntegrations}
          onSkills={vi.fn()}
          onBoard={onBoard}
          onArtifacts={() => {}}
          onSettings={() => {}}
          onLogOut={() => {}}
          signingOut={false}
          logOutError={null}
        />
        <Toaster />
      </DesktopUpdatesProvider>,
    ),
  );
}
function bridge(phase: DesktopUpdateState["phase"]) {
  const state: DesktopUpdateState = {
    phase,
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    percent: null,
    message: null,
    checkedAt: null,
  };
  const install = vi.fn(async () => state);
  window.orkbotDesktop = {
    platform: "darwin",
    window: {
      close: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    oauth: { onCallback: () => () => {} },
    update: {
      state: async () => state,
      install,
      download: async () => state,
      check: async () => state,
    },
  };
  return install;
}
it("hides update controls without a desktop bridge", async () => {
  await render();
  expect(document.querySelector('[aria-label="Install update"]')).toBeNull();
  expect(document.body.textContent).not.toContain("New update available");
});
it.each(["unsupported", "idle", "available", "downloading", "checking", "error"] as const)(
  "hides install controls in phase %s",
  async (phase) => {
    bridge(phase);
    await render();
    expect(document.querySelector('[aria-label="Install update"]')).toBeNull();
    expect(document.body.textContent).not.toContain("New update available");
  },
);
it("installs the ready update only through the footer button", async () => {
  const install = bridge("ready");
  await render("Ada Lovelace");
  const icon = document.querySelector<HTMLButtonElement>('[aria-label="Install update"]')!;
  expect(icon).not.toBeNull();
  expect(icon.textContent).toContain("Install update");
  expect(document.body.textContent).not.toContain("New update available");
  await act(async () => icon.click());
  expect(install).toHaveBeenCalledTimes(1);
  expect(
    [...document.querySelectorAll("button")].some((button) => button.textContent === "Install"),
  ).toBe(false);
});
it("shows the account image and falls back to the initial after a load error", async () => {
  await render("Ada Lovelace", "https://example.test/avatar.png");
  const trigger = host.querySelector('[data-testid="user-menu-trigger"]')!;
  const image = trigger.querySelector("img")!;
  expect(image.src).toBe("https://example.test/avatar.png");
  await act(async () => image.dispatchEvent(new Event("error")));
  expect(trigger.querySelector("img")).toBeNull();
  expect(trigger.textContent).toBe("AL");
});

it("opens integrations and keeps the existing account actions and links", async () => {
  const onIntegrations = vi.fn();
  await render("Demo User", undefined, onIntegrations, vi.fn());
  const connect = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Connect apps"),
  )!;
  await act(async () => connect.click());
  expect(onIntegrations).toHaveBeenCalledOnce();
  const menu = document.querySelector('[data-slot="popover-content"]')!;
  expect([...menu.querySelectorAll("button, a")].map((row) => row.textContent)).toEqual([
    "Settings",
    "Skills",
    "Artifacts",
    "Board",
    "Get the mobile app",
    "Docs",
    "Log out",
  ]);
  expect(host.querySelector('[data-testid="user-menu-trigger"]')?.getAttribute("aria-label")).toBe(
    "Account menu for Demo User",
  );
});
it("omits Board when unavailable", async () => {
  await render();
  expect(document.querySelector('[data-slot="popover-content"]')?.textContent).not.toContain(
    "Board",
  );
});

it("offers the Ork download page on Android", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  await render();
  const mobile = [...document.querySelectorAll("a")].find(
    (link) => link.textContent === "Get the mobile app",
  )!;
  expect(mobile.href).toBe("https://ork.run/download/");
});

it("falls back when app artwork fails and accepts replacement artwork", async () => {
  await render("Demo User", undefined, undefined, undefined, [
    { name: "Slack", logo: "https://example.test/slack.svg" },
  ]);
  const pill = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Connect apps"),
  )!;
  await act(async () => pill.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(pill.querySelector("img")).toBeNull();
  expect(pill.textContent).toContain("S");
  await render("Demo User", undefined, undefined, undefined, [
    { name: "Slack", logo: "https://example.test/new-slack.svg" },
  ]);
  expect(pill.querySelector("img")?.src).toBe("https://example.test/new-slack.svg");
});
it.each(["throw", "state"] as const)(
  "reveals a %s install failure after Later",
  async (failure) => {
    const install = bridge("ready");
    if (failure === "throw") install.mockRejectedValueOnce(new Error("offline"));
    else
      install.mockResolvedValueOnce({
        ...(await window.orkbotDesktop!.update.state()),
        phase: "error",
        message: "Update could not be installed",
      });
    await render();
    // The notice is a toast, which mounts and leaves on the toaster's own timers.
    const notice = () => document.querySelector('[aria-label="Desktop update"]');
    const later = () =>
      [...notice()!.querySelectorAll("button")].find((button) => button.textContent === "Later")!;
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    await act(async () => later().click());
    await vi.waitFor(() => expect(notice()).toBeNull());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Install update"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(notice()?.querySelector('[role="status"]')?.textContent).toBe(
        failure === "throw"
          ? "Could not complete the update. Try again."
          : "Update could not be installed",
      ),
    );
    await act(async () => later().click());
    await vi.waitFor(() => expect(notice()).toBeNull());
  },
);

it.each([
  [-20, 0],
  [0, 0],
  [25, 0],
  [26, 1],
  [47, 1],
  [48, 2],
  [69, 2],
  [70, 3],
  [200, 3],
])("fits marks into %ipx without consuming label or padding space", (width, count) => {
  expect(sidebarMarkCount(width)).toBe(count);
});

it("keeps at most three marks with the same tile and a missing-logo fallback", async () => {
  await render("Demo User", undefined, undefined, undefined, [
    { name: "Gmail", logo: "https://example.test/gmail.svg" },
    { name: "Notion" },
    { name: "GitHub", logo: "https://example.test/github.svg" },
    { name: "Slack" },
  ]);
  const tiles = [...host.querySelectorAll('span[aria-hidden="true"] > span')];
  expect(tiles).toHaveLength(3);
  expect(new Set(tiles.map((tile) => tile.className)).size).toBe(1);
  expect(tiles[1]!.textContent).toBe("N");
});

const personal = {
  id: "org-personal",
  name: "Personal",
  defaultSpaceId: "s1",
  spaceIds: ["s1"],
  canManage: true,
};
const work = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "s2",
  spaceIds: ["s2"],
  canManage: true,
};

async function renderOrganizations(
  organizations: (typeof personal)[],
  onSwitchOrganization = vi.fn(),
) {
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <SidebarFooter
          name="Demo User"
          initials="DU"
          email="account@orkbot.test"
          open
          onOpenChange={() => {}}
          onIntegrations={() => {}}
          onSkills={() => {}}
          onArtifacts={() => {}}
          onSettings={() => {}}
          onLogOut={() => {}}
          signingOut={false}
          logOutError={null}
          organizations={organizations}
          activeOrganizationId="org-personal"
          onSwitchOrganization={onSwitchOrganization}
        />
      </DesktopUpdatesProvider>,
    ),
  );
  return [...document.querySelector('[data-slot="popover-content"]')!.querySelectorAll("button")];
}

it("shows no organization rows with one organization", async () => {
  const rows = await renderOrganizations([personal]);
  expect(rows[0]!.textContent).toBe("Settings");
});

it("lists two organizations with the active one checked", async () => {
  const onSwitch = vi.fn();
  const rows = await renderOrganizations([personal, work], onSwitch);
  expect(rows.map((row) => row.textContent).slice(0, 3)).toEqual(["Personal", "Work", "Settings"]);
  expect(rows[0]!.getAttribute("aria-current")).toBe("true");
  expect(rows[0]!.querySelector("svg")).not.toBeNull();
  expect(rows[1]!.hasAttribute("aria-current")).toBe(false);
  expect(rows[1]!.querySelector("svg")).toBeNull();
  await act(async () => rows[1]!.click());
  expect(onSwitch).toHaveBeenCalledWith(work);
});

it("keeps integrations in the account menu while the update action is visible", async () => {
  bridge("ready");
  const onIntegrations = vi.fn();
  await render("Demo User", undefined, onIntegrations);
  const footer = host.querySelector('[data-testid="sidebar-footer"]')!;
  expect(footer.querySelector('[aria-label="Install update"]')?.textContent).toContain(
    "Install update",
  );
  const connect = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
  ].find((button) => button.textContent === "Connect apps")!;
  expect(connect).toBeDefined();
  await act(async () => connect.click());
  expect(onIntegrations).toHaveBeenCalledOnce();
});

it("keeps the collapsed update action accessible", async () => {
  const install = bridge("ready");
  await render("Demo User", undefined, vi.fn(), undefined, undefined, true);
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Install update"]')!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(install).toHaveBeenCalledOnce();
});

async function renderUpdateSettings() {
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <DesktopUpdateSection />
      </DesktopUpdatesProvider>,
    ),
  );
}

it("shows the result of a manual check when native rate limiting returns a cached successful check", async () => {
  bridge("idle");
  const state = {
    ...(await window.orkbotDesktop!.update.state()),
    checkedAt: "2026-01-01T00:00:00Z",
  };
  window.orkbotDesktop!.update.state = vi.fn(async () => state);
  const check = vi.fn(async () => state);
  window.orkbotDesktop!.update.check = check;
  await renderUpdateSettings();
  expect(host.textContent).not.toContain("Up to date");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(check).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Up to date");
});

it.each(["idle", "error"] as const)(
  "waits for a manual check's polled %s result",
  async (phase) => {
    vi.useFakeTimers();
    try {
      bridge("idle");
      let state = await window.orkbotDesktop!.update.state();
      window.orkbotDesktop!.update.state = vi.fn(async () => state);
      window.orkbotDesktop!.update.check = vi.fn(async () => {
        state = { ...state, phase: "checking" };
        return state;
      });
      await renderUpdateSettings();
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      expect(host.textContent).not.toContain("Up to date");
      state = {
        ...state,
        phase,
        checkedAt: "2026-01-01T00:01:00Z",
        message: phase === "error" ? "Could not reach the update server." : null,
      };
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        phase === "idle" ? "Up to date" : "Could not reach the update server.",
      );
    } finally {
      vi.useRealTimers();
    }
  },
);
