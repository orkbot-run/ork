// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotReplyMode } from "@orkbot/contracts";
import { DEFAULT_BOT_REPLY_MODE } from "@orkbot/contracts";
import { createQueuedSave } from "@orkbot/core";
import { NativeSelect, NativeSelectOption } from "@orkbot/ui-web";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { captureRpcContext } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** Mount only for a bot DTO whose server explicitly supports reply modes. */
export function BotReplyModeSetting({
  bot,
}: {
  bot: Pick<Bot, "id" | "spaceId" | "replyMode" | "updatedAt">;
}) {
  const { t } = useLingui();
  const id = useId();
  const live = useRef(false);
  const [saving, setSaving] = useState(false);
  const acceptedVersion = useRef(bot.updatedAt);
  const owner = useRef(bot);
  owner.current = bot;
  const [value, setValue] = useState<BotReplyMode>(bot.replyMode ?? DEFAULT_BOT_REPLY_MODE);
  const [error, setError] = useState<string | null>(null);
  const origin = useMemo(() => captureRpcContext(bot.spaceId), [bot.id, bot.spaceId]);
  const owned = () =>
    origin.isCurrent() && owner.current.id === bot.id && owner.current.spaceId === bot.spaceId;
  const current = () => live.current && owned();
  useLayoutEffect(() => {
    live.current = true;
    acceptedVersion.current = bot.updatedAt;
    setValue(bot.replyMode ?? DEFAULT_BOT_REPLY_MODE);
    setError(null);
    return () => {
      live.current = false;
    };
  }, [origin]);
  const queue = useMemo(
    () =>
      createQueuedSave<BotReplyMode>(bot.replyMode ?? DEFAULT_BOT_REPLY_MODE, {
        save: async (replyMode) => {
          if (!owned()) throw new DOMException("Session changed", "AbortError");
          const next = await origin.client.bots.update({ botId: bot.id, replyMode });
          if (!owned()) throw new DOMException("Session changed", "AbortError");
          if (next.replyMode !== replyMode) throw new Error(t`Could not save`);
          if (next.updatedAt > acceptedVersion.current) acceptedVersion.current = next.updatedAt;
        },
        onChange: (next) => {
          if (current()) {
            setValue(next);
            setError(null);
          }
        },
        onError: (failure) => {
          if (current()) setError(errorText(failure, t`Could not save`));
        },
        onSavingChange: (pending) => {
          if (current()) setSaving(pending);
        },
      }),
    [origin, bot.id],
  );
  useEffect(() => {
    if (!saving && current() && bot.updatedAt > acceptedVersion.current) {
      acceptedVersion.current = bot.updatedAt;
      queue.reset(bot.replyMode ?? DEFAULT_BOT_REPLY_MODE);
      setValue(bot.replyMode ?? DEFAULT_BOT_REPLY_MODE);
    }
  }, [bot.replyMode, bot.updatedAt, queue, saving]);
  return (
    <div>
      <label
        htmlFor={id}
        className="flex min-h-11 items-center justify-between gap-3 text-sm text-foreground"
      >
        <Trans>Reply mode</Trans>
        <NativeSelect
          id={id}
          disabled={!owned()}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            if (current() && (next === "chat" || next === "explicit")) queue.update(next);
          }}
        >
          <NativeSelectOption value="chat">
            <Trans>Chat</Trans>
          </NativeSelectOption>
          <NativeSelectOption value="explicit">
            <Trans>Updates and final reply</Trans>
          </NativeSelectOption>
        </NativeSelect>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
