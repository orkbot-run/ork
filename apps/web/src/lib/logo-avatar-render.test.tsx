// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to use generated Ork avatars and retire legacy icon rendering.
// Inherited Apache-2.0 material is preserved. New changes follow LICENSE.md.

// @vitest-environment jsdom
import type { ProductEvent } from "@orkbot/contracts";
import { logoAvatarTraits } from "@orkbot/core";
import { BotAvatar, BotAvatarActivityProvider } from "@orkbot/ui-web";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLogoAvatarActivity } from "./logo-avatar-activity";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  webLogoAvatarActivity.clear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  webLogoAvatarActivity.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const snapshot = {
  threadId: "thread-a",
  cursor: 0,
  botId: "bot-a",
  run: { id: "run-a", botId: "bot-a", status: "running" as const, trigger: "user" as const },
};
const event = (
  seq: number,
  type: ProductEvent["type"],
  payload: ProductEvent["payload"] = {},
  runId = "run-a",
): ProductEvent => ({
  id: `event-${seq}`,
  spaceId: "space-a",
  threadId: "thread-a",
  seq,
  botId: "bot-a",
  runId,
  type,
  payload,
  createdAt: "2026-10-01T00:00:00Z",
});
async function mount(status?: string, avatarSeed?: string) {
  await act(async () =>
    root.render(
      <BotAvatarActivityProvider source={webLogoAvatarActivity}>
        <div data-testid="live">
          <BotAvatar
            identity="bot-a"
            avatarSeed={avatarSeed}
            color="#10B981"
            avatarSet="orkbot"
            status={status}
          />
        </div>
        <BotAvatar identity="old-bot" color="#8B5CF6" />
        <BotAvatar identity="photo" color="data:image/png;base64,YQ==" avatarSet="orkbot" />
        <BotAvatar identity="shape" color="#8B5CF6::shape_2" avatarSet="orkbot" />
        <BotAvatar identity="explicit" color="#F97316" avatarSet="orkbot" activity="reading" />
      </BotAvatarActivityProvider>,
    ),
  );
}
const live = () => container.querySelector<SVGSVGElement>('[data-testid="live"] svg')!;
it("subscribes generated avatars to production feed events while keeping photos and explicit poses static", async () => {
  const subscribe = vi.spyOn(webLogoAvatarActivity, "subscribe");
  await mount();
  expect(subscribe).toHaveBeenCalledTimes(3);
  expect(live().dataset.activity).toBe("idle");
  await act(async () => webLogoAvatarActivity.hydrate("chat", snapshot));
  const steps = [
    [event(1, "thread.meta", { activity: { thinking: true } }), "thinking"],
    [event(2, "agent.tool.called", { name: "read_file", executionId: "read" }), "reading"],
    [event(3, "agent.tool.called", { name: "computer_act", executionId: "screen" }), "computer"],
    [event(4, "agent.tool.completed", { executionId: "screen" }), "reading"],
    [event(5, "agent.tool.completed", { executionId: "read" }), "working"],
    [event(6, "thread.meta", { activity: { thinking: true } }), "thinking"],
    [event(7, "thread.progress", { streaming: true, delta: "A reply" }), "writing"],
    [event(8, "thread.message.created", { role: "bot" }), "working"],
    [event(9, "thread.meta", { activity: { thinking: true } }), "thinking"],
    [event(10, "thread.meta", { activity: { thinking: false } }), "working"],
    [event(11, "run.waiting_input"), "waiting"],
    [event(12, "run.failed"), "error"],
    [event(13, "run.started", { trigger: "user" }, "run-b"), "working"],
    [event(14, "thread.meta", { activity: { thinking: true } }, "run-b"), "thinking"],
    [event(15, "run.completed", {}, "run-b"), "idle"],
    [event(16, "thread.meta", { activity: { thinking: true } }, "run-b"), "idle"],
    [event(17, "run.started", { trigger: "user" }, "run-c"), "working"],
    [event(18, "thread.meta", { activity: { thinking: true } }, "run-c"), "thinking"],
    [event(19, "run.cancelled", {}, "run-c"), "idle"],
  ] as const;
  for (const [message, expected] of steps) {
    await act(async () => webLogoAvatarActivity.apply("chat", message));
    expect(live().dataset.activity).toBe(expected);
    expect(live().dataset.working).toBe(String(expected !== "idle" && expected !== "error"));
  }
  expect(subscribe).toHaveBeenCalledTimes(3);
});
it("retains the live pose through overlapping feed hydration, hidden updates and reconnect", async () => {
  await mount();
  await act(async () => {
    webLogoAvatarActivity.hydrate("chat", snapshot);
    webLogoAvatarActivity.apply(
      "chat",
      event(1, "agent.tool.called", { name: "read_file", executionId: "read" }),
    );
  });
  await act(async () => webLogoAvatarActivity.hydrate("call", { ...snapshot, cursor: 1 }));
  expect(live().dataset.activity).toBe("reading");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(live().dataset.paused).toBe("true");
  await act(async () =>
    webLogoAvatarActivity.apply(
      "chat",
      event(2, "thread.progress", { streaming: true, delta: "Reply" }),
    ),
  );
  // A still-open tool remains the most specific activity while the tab is hidden.
  expect(live().dataset.activity).toBe("reading");
  hidden.mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(live().dataset.paused).toBe("false");
  await act(async () => {
    webLogoAvatarActivity.resetSource("chat");
    webLogoAvatarActivity.resetSource("call");
    webLogoAvatarActivity.hydrate("reconnect", { ...snapshot, cursor: 2 });
    webLogoAvatarActivity.apply(
      "reconnect",
      event(1, "agent.tool.called", { name: "read_file", executionId: "read" }),
    );
  });
  expect(live().dataset.activity).toBe("working");
});

it("keeps static SVG artwork mounted through rapid live activity changes", async () => {
  await act(async () =>
    root.render(
      <BotAvatarActivityProvider source={webLogoAvatarActivity}>
        <BotAvatar identity="bot-a" color="#10B981" avatarSet="orkbot" size={22} status="running" />
      </BotAvatarActivityProvider>,
    ),
  );
  await act(async () => webLogoAvatarActivity.hydrate("chat", snapshot));
  const body = container.querySelector(".logo-avatar-art");
  const definition = body!.querySelector("defs");
  for (let seq = 1; seq <= 40; seq++) {
    await act(async () =>
      webLogoAvatarActivity.apply(
        "chat",
        event(seq, "thread.meta", { activity: { thinking: seq % 2 === 0 } }),
      ),
    );
    expect(container.querySelector(".orkbot-logo-avatar")!.getAttribute("data-activity")).toBe(
      seq % 2 === 0 ? "thinking" : "working",
    );
    expect(container.querySelector(".logo-avatar-art")).toBe(body);
    expect(body!.querySelector("defs")).toBe(definition);
    expect(container.querySelectorAll("[data-logo-layer]")).toHaveLength(1);
  }
});

it("renders generic work elsewhere when the open chat is idle, preserving live detail", async () => {
  await mount("running");
  await act(async () =>
    webLogoAvatarActivity.hydrate("dm", { threadId: "dm", cursor: 0, botId: "bot-a", run: null }),
  );
  expect(live().dataset.activity).toBe("working");
  expect(live().dataset.working).toBe("true");
  await act(async () => {
    webLogoAvatarActivity.hydrate("group", snapshot);
    webLogoAvatarActivity.apply(
      "group",
      event(1, "agent.tool.called", { name: "read_file", executionId: "read" }),
    );
  });
  expect(live().dataset.activity).toBe("reading");
  await act(async () => webLogoAvatarActivity.resetSource("group"));
  expect(live().dataset.activity).toBe("working");
  await mount("idle");
  expect(live().dataset.activity).toBe("idle");
  expect(live().dataset.working).toBe("false");
});

it("keeps activity bound to the local agent while drawing the saved account Ork", async () => {
  const seed = "64cf5621-3144-4810-97f5-148acdc29c35";
  await mount(undefined, seed);
  expect(live().dataset.shape).toBe(logoAvatarTraits(seed, "#10B981").appearance.shape);
  await act(async () => webLogoAvatarActivity.hydrate("chat", snapshot));
  await act(async () =>
    webLogoAvatarActivity.apply("chat", event(1, "thread.meta", { activity: { thinking: true } })),
  );
  expect(live().dataset.activity).toBe("thinking");
});
