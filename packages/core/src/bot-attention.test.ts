// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to use generated Ork avatars and retire legacy icon rendering.
// Inherited Apache-2.0 material is preserved. New changes follow LICENSE.md.

import { describe, expect, it } from "vitest";
import {
  botAvatarActivity,
  initialLogoAvatarSignals,
  logoAvatarActivity,
  logoAvatarNeedsAttention,
  usesLogoAvatar,
} from "./logo-avatar-activity.js";
import { createLogoAvatarActivityStore } from "./logo-avatar-activity-store.js";

const bot = { avatarSet: "orkbot", color: "orange" };
const needsAttention = (activity: ReturnType<typeof logoAvatarActivity>) =>
  logoAvatarNeedsAttention(botAvatarActivity(bot, activity));

describe("avatar attention", () => {
  it.each(["waiting_input", "waiting_takeover"])("shows a foreground %s wait", (status) => {
    expect(needsAttention(logoAvatarActivity({ ...initialLogoAvatarSignals("bot"), status }))).toBe(
      true,
    );
  });

  it.each(["idle", "running", "queued", "completed", "failed", "cancelled"])(
    "does not treat %s as attention",
    (status) => {
      expect(
        needsAttention(logoAvatarActivity({ ...initialLogoAvatarSignals("bot"), status })),
      ).toBe(false);
    },
  );

  it("suppresses background waits", () => {
    expect(
      needsAttention(
        logoAvatarActivity({
          ...initialLogoAvatarSignals("bot"),
          status: "waiting_input",
          background: true,
        }),
      ),
    ).toBe(false);
  });

  it.each([
    { ...bot, color: "data:image/png;base64,fixture" },
    { ...bot, archivedAt: "2026-01-01T00:00:00.000Z" },
  ])("excludes avatars without a visible waiting state: %j", (avatar) => {
    expect(logoAvatarNeedsAttention(botAvatarActivity(avatar, "waiting"))).toBe(false);
  });

  it("uses live activity when a waiting list snapshot disagrees", () => {
    const store = createLogoAvatarActivityStore();
    store.hydrate("chat", {
      threadId: "thread",
      botId: "bot",
      cursor: 1,
      run: { id: "run", botId: "bot", status: "running", trigger: "user" },
    });
    expect(needsAttention(store.getActivity("bot", "waiting_input"))).toBe(false);
    store.apply("chat", {
      threadId: "thread",
      botId: "bot",
      runId: "run",
      seq: 2,
      type: "run.waiting_input",
      payload: {},
    });
    expect(needsAttention(store.getActivity("bot", "idle"))).toBe(true);
  });

  it("uses the same avatar selection as rendering", () => {
    expect(usesLogoAvatar(bot)).toBe(true);
    expect(botAvatarActivity(bot, "waiting")).toBe("waiting");
  });

  it.each([
    { ...bot, avatarSet: "organic" },
    { color: "orange" },
    { ...bot, color: "orange::shape_3" },
  ])("keeps live attention after replacing a legacy icon: %j", (avatar) => {
    expect(usesLogoAvatar(avatar)).toBe(true);
    expect(logoAvatarNeedsAttention(botAvatarActivity(avatar, "waiting"))).toBe(true);
  });

  it("keeps activity on the saved logo avatar set from before the rename", () => {
    const saved = { ...bot, avatarSet: "rakazo" };
    expect(usesLogoAvatar(saved)).toBe(true);
    expect(botAvatarActivity(saved, "waiting")).toBe("waiting");
  });
});
