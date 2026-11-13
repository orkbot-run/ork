// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useLingui } from "@lingui/react/macro";
import type { ComputerFrame, RpcInput } from "@orkbot/contracts";
import { startComputerFrames } from "@orkbot/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import { captureRpcContext, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { TeachCaptureOverlay } from "./teach/TeachCaptureOverlay";

/** Render only image bytes from the authenticated native HTTP channel. */
export function NativeComputerScreen({
  botId,
  interactive = false,
}: {
  botId: string;
  interactive?: boolean;
}) {
  const { t } = useLingui();
  const session = authClient.useSession();
  const spaceId = selectedSpaceId();
  const scope = useMemo(() => {
    const { client, isCurrent } = captureRpcContext(spaceId);
    return {
      isCurrent,
      read: (previous: string | undefined, signal: AbortSignal) =>
        client.computer.frame({ botId, previous }, { signal }),
      input: (input: RpcInput<"computer/input">) => client.computer.input(input),
    };
  }, [spaceId, session.data?.session.id, botId]);
  const reading = useRef<{ scope: typeof scope; stop(): void } | null>(null);
  const [value, setValue] = useState<{ scope: typeof scope; frame: ComputerFrame } | null>(null);
  const [failure, setFailure] = useState<{ scope: typeof scope; error: unknown } | null>(null);
  const onError = useCallback(
    (error: unknown) => {
      if (!scope.isCurrent()) return;
      if (reading.current?.scope !== scope) return;
      reading.current.stop();
      setValue(null);
      setFailure({ scope, error });
    },
    [scope],
  );
  useEffect(() => {
    setValue(null);
    setFailure(null);
    const stop = startComputerFrames({
      read: scope.read,
      isCurrent: scope.isCurrent,
      onFrame: (frame) => setValue({ scope, frame }),
      onError,
    });
    reading.current = { scope, stop };
    return () => {
      stop();
      if (reading.current?.scope === scope) reading.current = null;
    };
  }, [botId, scope, onError]);
  const frame = value?.scope === scope && scope.isCurrent() ? value.frame : null;
  const error = failure?.scope === scope ? failure.error : null;
  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden bg-background">
      {frame ? (
        <>
          <img
            alt={t`Bot screen`}
            className="h-full w-full object-contain"
            draggable={false}
            onError={() => onError(new Error(t`Could not load the desktop.`))}
            src={`data:${frame.mimeType};base64,${frame.data}`}
          />
          <TeachCaptureOverlay
            botId={botId}
            skill={null}
            live
            enabled={interactive}
            screenWidth={frame.width}
            screenHeight={frame.height}
            send={scope.input}
            onInputError={onError}
          />
        </>
      ) : (
        <span className="px-6 text-center text-sm text-muted-foreground">
          {error ? errorText(error, t`Could not load the desktop.`) : t`Connecting…`}
        </span>
      )}
    </div>
  );
}
