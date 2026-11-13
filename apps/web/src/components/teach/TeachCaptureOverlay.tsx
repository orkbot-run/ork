// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited teaching gestures are retained. Native HTTP input scoping follows LICENSE.md.

import { t } from "@lingui/core/macro";
import type { RpcInput, RpcOutput, TaughtSkill } from "@orkbot/contracts";
import {
  computerInputForDomKey,
  DEFAULT_COMPUTER_SCREEN,
  mapTeachPointer,
  teachCaptureKey,
} from "@orkbot/core";
import { useEffect, useRef } from "react";
import { rpc } from "../../lib/rpc";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

export function TeachCaptureOverlay({
  botId,
  skill,
  enabled,
  screenWidth,
  screenHeight,
  live = false,
  send = rpc.computer.input,
  onInputError,
}: {
  botId: string;
  skill: TaughtSkill | null;
  enabled: boolean;
  screenWidth?: number;
  screenHeight?: number;
  live?: boolean;
  send?: (input: RpcInput<"computer/input">) => Promise<RpcOutput<"computer/input">>;
  onInputError?: (error: unknown) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const width = screenWidth ?? DEFAULT_COMPUTER_SCREEN.width;
  const height = screenHeight ?? DEFAULT_COMPUTER_SCREEN.height;

  useEffect(() => {
    if (!enabled || (!live && !skill) || (skill && skill.status !== "recording")) return;
    const overlay = rootRef.current;
    if (!overlay) return;
    const target: HTMLDivElement = overlay;
    let active = true;
    if (live) target.focus({ preventScroll: true });

    function enqueueInput(task: () => Promise<void>) {
      void enqueueTeachComputerInput(botId, async () => {
        if (active) await task();
      }).catch((error) => {
        if (active) onInputError?.(error);
      });
    }

    function pointerAt(event: MouseEvent) {
      return mapTeachPointer(event.clientX, event.clientY, target.getBoundingClientRect(), {
        width,
        height,
      });
    }

    async function sendPointer(
      type: "move" | "down" | "up" | "click",
      x: number,
      y: number,
      button: "left" | "right" = "left",
    ) {
      await send({
        botId,
        kind: "pointer",
        payload: { x, y, button, type },
      });
    }

    async function sendKey(key: string) {
      await send({ botId, kind: "key", payload: { key } });
    }

    async function sendScroll(
      direction: "up" | "down" | "left" | "right",
      amount: number,
      x: number,
      y: number,
    ) {
      await send({
        botId,
        kind: "scroll",
        payload: { direction, amount, x, y },
      });
    }

    function buttonFor(event: PointerEvent): "left" | "right" {
      return event.button === 2 ? "right" : "left";
    }

    function onPointerDown(event: PointerEvent) {
      if (live) target.focus({ preventScroll: true });
      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendPointer("down", x, y, buttonFor(event)));
    }

    // Each input is one request, one recording write and one sandbox action, so a raw pointer
    // stream would queue faster than it drains. Keep only the newest position and send it once
    // the previous one has landed.
    let pendingMove: { x: number; y: number; button: "left" | "right" } | null = null;
    let moveInFlight = false;

    function pumpMove() {
      if (!active || moveInFlight || !pendingMove) return;
      const move = pendingMove;
      pendingMove = null;
      moveInFlight = true;
      enqueueInput(async () => {
        try {
          await sendPointer("move", move.x, move.y, move.button);
        } finally {
          moveInFlight = false;
          pumpMove();
        }
      });
    }

    function onPointerMove(event: PointerEvent) {
      if (!event.buttons) return;
      event.preventDefault();
      const { x, y } = pointerAt(event);
      pendingMove = { x, y, button: event.buttons === 2 ? "right" : "left" };
      pumpMove();
    }

    function onPointerUp(event: PointerEvent) {
      event.preventDefault();
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      const { x, y } = pointerAt(event);
      const button = buttonFor(event);
      const dragged = pendingMove !== null;
      pendingMove = null;
      // The final position has to reach the sandbox before the release; dropped intermediate
      // moves are fine, a release at a stale position is not.
      if (dragged) enqueueInput(() => sendPointer("move", x, y, button));
      enqueueInput(() => sendPointer("up", x, y, button));
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      // A mostly sideways wheel or trackpad swipe scrolls left or right.
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = sideways ? event.deltaX : event.deltaY;
      const direction = sideways ? (delta < 0 ? "left" : "right") : delta < 0 ? "up" : "down";
      const amount = Math.min(20, Math.max(1, Math.round(Math.abs(delta) / 80) || 1));
      // The computer scrolls what is under the same point on its screen.
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendScroll(direction, amount, x, y));
    }

    function onKeyDown(event: KeyboardEvent) {
      if (live && event.key === "Escape" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        target.blur();
        return;
      }
      // Keys aimed at page controls (the Stop teaching button, dialogs) must keep working;
      // only keystrokes with no other target belong to the demo.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("button, input, textarea, select, a, [contenteditable]")
      ) {
        return;
      }
      let key = teachCaptureKey(event.key, event);
      if (live && !event.metaKey && !event.isComposing) {
        const plain = teachCaptureKey(event.key);
        if (plain) {
          const mapped = computerInputForDomKey(plain);
          const modified =
            event.ctrlKey || event.altKey || (event.shiftKey && mapped.kind === "key");
          if (modified)
            key = [
              event.ctrlKey ? "ctrl" : "",
              event.altKey ? "alt" : "",
              event.shiftKey ? "shift" : "",
              mapped.kind === "key" ? mapped.key : plain.toLowerCase(),
            ]
              .filter(Boolean)
              .join("+");
        }
      }
      if (!key) return;
      event.preventDefault();
      if (live) event.stopPropagation();
      enqueueInput(() => sendKey(key));
    }

    function onContextMenu(event: Event) {
      event.preventDefault();
    }

    target.addEventListener("pointerdown", onPointerDown);
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("pointercancel", onPointerUp);
    target.addEventListener("wheel", onWheel, { passive: false });
    target.addEventListener("contextmenu", onContextMenu);
    const keyboardTarget = live ? target : window;
    keyboardTarget.addEventListener("keydown", onKeyDown as EventListener);
    return () => {
      active = false;
      pendingMove = null;
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("contextmenu", onContextMenu);
      keyboardTarget.removeEventListener("keydown", onKeyDown as EventListener);
    };
  }, [botId, enabled, height, skill, width, live, send, onInputError]);

  if (!enabled || (!live && !skill) || (skill && skill.status !== "recording")) return null;

  return live ? (
    <div
      ref={rootRef}
      data-testid="teach-capture-overlay"
      role="application"
      tabIndex={-1}
      aria-label={t`Computer controls`}
      aria-description={t`Press Shift+Escape to leave computer controls.`}
      className="absolute inset-0 z-10 cursor-crosshair bg-transparent"
    />
  ) : (
    <div
      ref={rootRef}
      data-testid="teach-capture-overlay"
      role="presentation"
      className="absolute inset-0 z-10 cursor-crosshair bg-transparent"
    />
  );
}
