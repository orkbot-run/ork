// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerFrame, RpcInput } from "@orkbot/contracts";
import { mapTeachPointer, startComputerFrames } from "@orkbot/core";
import type { RefObject } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Image, PanResponder, Text, View } from "react-native";
import { captureApiRequestContext, nativeInstallationScope, rpc } from "../lib/api";
import type { ComputerKeyboardCommand } from "../lib/computer-keyboard";
import { computerKeyboardInputs } from "../lib/computer-keyboard";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

export interface NativeComputerScreenControls {
  keyboard(command: ComputerKeyboardCommand): void;
}

type Input = Pick<RpcInput<"computer/input">, "kind" | "payload">;
const scopeKey = nativeInstallationScope;

/** Native image rendering and scoped HTTP input share no provider page or WebSocket credentials. */
export function NativeComputerScreen({
  botId,
  interactive = false,
  foreground = true,
  controls,
  onReady,
}: {
  botId: string;
  interactive?: boolean;
  foreground?: boolean;
  controls?: RefObject<NativeComputerScreenControls | null>;
  onReady?: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const key = scopeKey();
  const gate = useMemo(
    () => ({
      key,
      send: undefined as ((inputs: Iterable<Input>) => void) | undefined,
      fail: undefined as ((error: unknown) => void) | undefined,
    }),
    [key, botId, interactive, foreground],
  );
  const currentGate = useRef(gate);
  currentGate.current = gate;
  const ready = useRef(onReady);
  ready.current = onReady;
  const [value, setValue] = useState<{ gate: typeof gate; frame: ComputerFrame } | null>(null);
  const [failure, setFailure] = useState<{ gate: typeof gate; error: unknown } | null>(null);
  const layout = useRef({ width: 1, height: 1 });
  const frame = value?.gate === gate && key === scopeKey() ? value.frame : null;
  const latestFrame = useRef(frame);
  latestFrame.current = frame;
  useImperativeHandle(
    controls,
    () => ({ keyboard: (command) => gate.send?.(computerKeyboardInputs(command)) }),
    [gate],
  );
  useEffect(() => {
    setValue(null);
    setFailure(null);
    if (!foreground || !key) return;
    let active = true;
    let stop = () => {};
    const current = () => active && currentGate.current === gate && gate.key === scopeKey();
    const fail = (error: unknown) => {
      if (!current()) return;
      gate.send = undefined;
      stop();
      active = false;
      setValue(null);
      setFailure({ gate, error });
    };
    gate.fail = fail;
    void captureApiRequestContext()
      .then((context) => {
        if (!current()) return;
        let inputQueue = Promise.resolve();
        gate.send = (inputs) => {
          if (!interactive || !current()) return;
          inputQueue = inputQueue
            .then(async () => {
              for (const input of inputs) {
                if (!current()) return;
                await rpc("computer/input", { botId, ...input }, { requestContext: context });
              }
            })
            .catch(fail);
        };
        stop = startComputerFrames({
          read: (previous, signal) =>
            rpc("computer/frame", { botId, previous }, { signal, requestContext: context }),
          isCurrent: current,
          onFrame: (next) => {
            setValue({ gate, frame: next });
          },
          onError: fail,
        });
        ready.current?.();
      })
      .catch(fail);
    return () => {
      active = false;
      gate.send = undefined;
      stop();
    };
  }, [botId, gate, interactive, foreground]);
  const gestures = useMemo(() => {
    let pending: Input | undefined;
    let scheduled = false;
    let scrolling = false;
    let lastDy = 0;
    const point = (x: number, y: number) =>
      mapTeachPointer(
        x,
        y,
        { left: 0, top: 0, ...layout.current },
        latestFrame.current ?? { width: 1, height: 1 },
      );
    const pointer = (type: string, x: number, y: number): Input => ({
      kind: "pointer",
      payload: { ...point(x, y), type, button: "left" },
    });
    function* latestMove() {
      try {
        if (pending) {
          const input = pending;
          pending = undefined;
          yield input;
        }
      } finally {
        scheduled = false;
      }
    }
    return PanResponder.create({
      onStartShouldSetPanResponder: () => interactive && Boolean(latestFrame.current && gate.send),
      onPanResponderGrant: (event) => {
        scrolling = false;
        lastDy = 0;
        gate.send?.([pointer("down", event.nativeEvent.locationX, event.nativeEvent.locationY)]);
      },
      onPanResponderMove: (event, gesture) => {
        const { locationX, locationY } = event.nativeEvent;
        if (gesture.numberActiveTouches > 1) {
          if (!scrolling) {
            gate.send?.([pointer("up", locationX, locationY)]);
            scrolling = true;
          }
          const delta = gesture.dy - lastDy;
          if (Math.abs(delta) > 12) {
            gate.send?.([
              {
                kind: "scroll",
                payload: {
                  ...point(locationX, locationY),
                  direction: delta < 0 ? "down" : "up",
                  amount: 3,
                },
              },
            ]);
            lastDy = gesture.dy;
          }
        } else if (!scrolling) {
          pending = pointer("move", locationX, locationY);
          if (!scheduled) {
            scheduled = true;
            gate.send?.(latestMove());
          }
        }
      },
      onPanResponderRelease: (event) => {
        pending = undefined;
        if (!scrolling)
          gate.send?.([
            pointer("move", event.nativeEvent.locationX, event.nativeEvent.locationY),
            pointer("up", event.nativeEvent.locationX, event.nativeEvent.locationY),
          ]);
      },
      onPanResponderTerminate: (event) => {
        pending = undefined;
        if (!scrolling)
          gate.send?.([pointer("up", event.nativeEvent.locationX, event.nativeEvent.locationY)]);
      },
    });
  }, [gate, interactive]);
  return (
    <View
      {...gestures.panHandlers}
      onLayout={(event) => {
        layout.current = event.nativeEvent.layout;
      }}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.card,
      }}
    >
      {frame ? (
        <View pointerEvents="none" style={{ width: "100%", height: "100%" }}>
          <Image
            testID="native-computer-frame"
            accessible
            accessibilityLabel={t("Computer")}
            onError={() => gate.fail?.(new Error(t("Could not connect to the computer screen")))}
            source={{ uri: `data:${frame.mimeType};base64,${frame.data}` }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="contain"
          />
        </View>
      ) : (
        <Text style={{ color: tokens.mutedForeground, textAlign: "center", padding: 16 }}>
          {failure?.gate === gate
            ? errorText(failure.error, t("Could not connect to the computer screen"))
            : t("Connecting…")}
        </Text>
      )}
    </View>
  );
}
