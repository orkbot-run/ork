// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved. Native device pairing tests are Ork additions.

// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

interface SessionState {
  isPending: boolean;
  data: { user: { id: string }; session?: { id: string } } | null;
  error: { status: number } | null;
}

const signedIn: SessionState = { isPending: false, data: { user: { id: "user-1" } }, error: null };
const capability = vi.hoisted(() => ({
  enabled: false,
  boardLoaded: vi.fn(),
  screen: vi.fn(async () => ({ ok: true })),
  session: null as SessionState | null,
  authMounts: 0,
  syncCallIdentity: vi.fn(),
  nativePairing: false,
  syncPairing: vi.fn(async () => undefined),
}));
vi.mock("./components/ProtocolRecovery", () => ({
  ProtocolRecovery: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./lib/desktop", () => ({
  desktopBridge: () =>
    capability.nativePairing ? { pairing: { sync: capability.syncPairing } } : undefined,
}));
vi.mock("./lib/bootstrap", () => ({
  getTicketBoardEnabled: () => capability.enabled,
  subscribeTicketBoardEnabled: () => () => {},
}));
vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({ ...(capability.session ?? signedIn), refetch: vi.fn() }),
  },
}));
vi.mock("./pages/Auth", async () => {
  const { useEffect } = await import("react");
  return {
    AuthPage: ({ mode }: { mode: string }) => {
      useEffect(() => {
        capability.authMounts += 1;
      }, []);
      return <div>Auth {mode}</div>;
    },
  };
});
vi.mock("./lib/call-session", () => ({ syncCallIdentity: capability.syncCallIdentity }));
vi.mock("./lib/remote-images-preference", () => ({
  getRemoteImagesEnabled: () => false,
  subscribeRemoteImages: () => () => {},
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./lib/rpc", () => ({ rpc: { analytics: { screen: capability.screen } } }));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({ ShellPage: () => <div>Shell</div> }));
vi.mock("./components/call/CallLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CallLayout: () => <Outlet /> };
});
vi.mock("./components/markdown-link-prompt", () => ({
  MarkdownLinkPrompt: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Board", () => {
  capability.boardLoaded();
  return { BoardPage: () => <div>Board page</div> };
});
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));

import { App } from "./App";

it.each([
  signedIn,
  { isPending: true, data: null, error: null },
  { isPending: false, data: null, error: null },
])(
  "closes the integration callback without loading the app or requiring a web session (%j)",
  async (session) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    window.history.replaceState(null, "", "/integrations/callback?status=success");
    capability.session = session;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <App />
          </MemoryRouter>,
        ),
      );
      expect(close).toHaveBeenCalledOnce();
      expect(container.textContent).toBe("You can close this window.");
      expect(container.querySelector("[data-orkbot-app-state]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      close.mockRestore();
      capability.session = null;
      window.history.replaceState(null, "", "/");
      vi.unstubAllGlobals();
    }
  },
);

it("loads the board chunk only after bootstrap enables the route", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => (
    <MemoryRouter initialEntries={["/app/board"]}>
      <App />
    </MemoryRouter>
  );
  try {
    await act(async () => root.render(render()));
    expect(container.textContent).toBe("Shell");
    expect(capability.screen).toHaveBeenCalledExactlyOnceWith({ screen: "board", surface: "web" });
    expect(capability.boardLoaded).not.toHaveBeenCalled();
    capability.enabled = true;
    await act(async () => {
      root.render(render());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capability.boardLoaded).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Board page");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the sign-in page mounted while a signed-out session refetches", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (session: SessionState) => {
    capability.session = session;
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/sign-in"]}>
          <App />
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    capability.authMounts = 0;
    await render({ isPending: false, data: null, error: null });
    expect(container.textContent).toBe("Auth in");
    // Better Auth refetches a null session when the tab regains focus.
    await render({ isPending: true, data: null, error: null });
    expect(container.textContent).toBe("Auth in");
    await render({ isPending: false, data: null, error: null });
    expect(container.textContent).toBe("Auth in");
    expect(capability.authMounts).toBe(1);
  } finally {
    capability.session = null;
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["throw", "reject"])(
  "keeps screen reporting failures out of the app error boundary (%s)",
  async (mode) => {
    if (mode === "throw")
      capability.screen.mockImplementationOnce(() => {
        throw new Error("analytics unavailable");
      });
    else capability.screen.mockRejectedValueOnce(new Error("analytics unavailable"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={["/app"]}>
            <App />
          </MemoryRouter>,
        ),
      );
      expect(container.textContent).toBe("Shell");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("tells the call session who is signed in, without counting an unreachable lookup", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (session: SessionState) => {
    capability.session = session;
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/app"]}>
          <App />
        </MemoryRouter>,
      ),
    );
  };
  try {
    capability.syncCallIdentity.mockClear();
    await render(signedIn);
    expect(capability.syncCallIdentity).toHaveBeenLastCalledWith("user-1");
    await render({ isPending: false, data: null, error: { status: 503 } });
    expect(capability.syncCallIdentity).not.toHaveBeenCalledWith(null);
    await render({ isPending: false, data: { user: { id: "user-2" } }, error: null });
    expect(capability.syncCallIdentity).toHaveBeenLastCalledWith("user-2");
    await render({ isPending: false, data: null, error: null });
    expect(capability.syncCallIdentity).toHaveBeenLastCalledWith(null);
  } finally {
    capability.session = null;
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("syncs native pairing only for settled sessions, including same-account session replacement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (session: SessionState) => {
    capability.session = session;
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/app"]}>
          <App />
        </MemoryRouter>,
      ),
    );
  };
  const session = (id: string): SessionState => ({
    isPending: false,
    data: { user: { id: "user-1" }, session: { id } },
    error: null,
  });
  try {
    capability.nativePairing = true;
    capability.syncPairing.mockClear();
    await render({ isPending: true, data: null, error: null });
    expect(capability.syncPairing).not.toHaveBeenCalled();
    await render({ isPending: false, data: null, error: { status: 503 } });
    expect(capability.syncPairing).not.toHaveBeenCalled();
    await render(session("session-1"));
    expect(capability.syncPairing).toHaveBeenCalledTimes(1);
    await render(session("session-1"));
    expect(capability.syncPairing).toHaveBeenCalledTimes(1);
    await render(session("session-2"));
    expect(capability.syncPairing).toHaveBeenCalledTimes(2);
    await render({ isPending: false, data: null, error: null });
    expect(capability.syncPairing).toHaveBeenCalledTimes(3);
    expect(capability.syncPairing.mock.calls.every((args) => args.length === 0)).toBe(true);
  } finally {
    capability.session = null;
    capability.nativePairing = false;
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["throw", "reject"])(
  "keeps native pairing failures out of the app error boundary (%s)",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      capability.nativePairing = true;
      if (mode === "throw")
        capability.syncPairing.mockImplementationOnce(() => {
          throw new Error("Unavailable");
        });
      else capability.syncPairing.mockRejectedValueOnce(new Error("Unavailable"));
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={["/app"]}>
            <App />
          </MemoryRouter>,
        ),
      );
      expect(container.textContent).toBe("Shell");
    } finally {
      capability.nativePairing = false;
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
