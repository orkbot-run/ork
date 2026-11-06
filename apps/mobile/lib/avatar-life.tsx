// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 viewport and tap handling remain. Unused legacy avatar clocks were removed.

import type { AvatarPoke } from "@orkbot/core";
import { AVATAR_POKE_SECONDS, AVATAR_POKES } from "@orkbot/core";
import type { ReactNode } from "react";
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { SharedValue } from "react-native-reanimated";
import { Easing, withTiming } from "react-native-reanimated";
import { useAppForeground } from "./app-foreground";

const ScreenFocused = createContext(true);

/** Screens behind the visible one stop their avatars; avatars outside a screen count as shown. */
export function AvatarScreenFocus({
  navigation,
  children,
}: {
  navigation: {
    isFocused(): boolean;
    addListener(event: "focus" | "blur", listener: () => void): () => void;
  };
  children: ReactNode;
}) {
  const focused = useSyncExternalStore(
    (listener) => {
      const offFocus = navigation.addListener("focus", listener);
      const offBlur = navigation.addListener("blur", listener);
      return () => {
        offFocus();
        offBlur();
      };
    },
    () => navigation.isFocused(),
  );
  return <ScreenFocused value={focused}>{children}</ScreenFocused>;
}

/** Which list rows are on screen, fed by the list's viewability callback. */
export function createAvatarViewport() {
  let visible = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    update(keys: Iterable<string>) {
      visible = new Set(keys);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    has: (key: string) => visible.has(key),
  };
}
export type AvatarViewport = ReturnType<typeof createAvatarViewport>;

const Viewport = createContext<AvatarViewport | null>(null);
const RowKey = createContext<string | null>(null);

/** Lets the rows of one list know whether they are on screen. */
export function AvatarViewportScope({
  viewport,
  children,
}: {
  viewport: AvatarViewport;
  children: ReactNode;
}) {
  return <Viewport value={viewport}>{children}</Viewport>;
}

/** Marks the avatars inside as belonging to the list row `id`. */
export function AvatarRow({ id, children }: { id: string; children: ReactNode }) {
  return <RowKey value={id}>{children}</RowKey>;
}

const noViewport = () => () => undefined;

/**
 * Whether an avatar is on the visible screen of a foreground app and, inside a list,
 * in a row that is scrolled into view. Rows scrolled away freeze until they return.
 */
export function useAvatarOnScreen(): boolean {
  const foreground = useAppForeground();
  const focused = useContext(ScreenFocused);
  const viewport = useContext(Viewport);
  const row = useContext(RowKey);
  const rowVisible = useSyncExternalStore(viewport?.subscribe ?? noViewport, () =>
    viewport && row !== null ? viewport.has(row) : true,
  );
  return focused && foreground && rowVisible;
}

/** Plays the next tap reaction on a moving avatar. */
export function usePoke(
  life: { poke: SharedValue<AvatarPoke | null>; pokeProgress: SharedValue<number> },
  enabled: boolean,
) {
  const next = useRef(0);
  return () => {
    if (!enabled) return;
    const kind = AVATAR_POKES[next.current % AVATAR_POKES.length]!;
    next.current += 1;
    // The reaction runs on its own 0–1 clock on the UI thread. Reading the clip clock here
    // could lag behind the frames, and the reaction would look already over.
    life.poke.value = kind;
    life.pokeProgress.value = 0;
    life.pokeProgress.value = withTiming(1, {
      duration: AVATAR_POKE_SECONDS[kind] * 1000,
      easing: Easing.linear,
    });
  };
}
