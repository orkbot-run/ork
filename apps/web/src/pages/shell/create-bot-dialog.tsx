// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 code remains separately licensed. Generator-only avatar editing is an Ork addition.

import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet } from "@orkbot/contracts";
import { BOT_NAME_MAX_LENGTH } from "@orkbot/contracts";
import { newClientId } from "@orkbot/core";
import {
  BOT_AVATAR_COLORS,
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@orkbot/ui-web";
import { useRef, useState } from "react";
import { errorText } from "../../lib/user-error";
import { BotLookPicker } from "./avatar-studio-popover";

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

export interface CreateBotDialogInput {
  name: string;
  color: string;
  /** Reserve the logo preview's persistent seed through creation and retries. */
  id?: string;
}

/** Mounted only while open; the parent unmounts it from `onCancel` or after `onCreate`. */
export function CreateBotDialog({
  avatarSet,
  onCancel,
  onCreate,
}: {
  /** The account's set: the server gives it to the new bot, so the preview draws it too. */
  avatarSet: BotAvatarSet;
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [previewIdentities] = useState(() =>
    Array.from({ length: 8 }, () => `c${newClientId().replaceAll("-", "").slice(0, 24)}`),
  );
  const [look, setLook] = useState(() => ({
    value: pick(BOT_AVATAR_COLORS),
    identity: pick(previewIdentities),
  }));
  const submittedAppearance = useRef<{ value: string; identity: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function create() {
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    if (!submittedAppearance.current) submittedAppearance.current = look;
    const appearance = submittedAppearance.current;
    try {
      await onCreate({
        name: trimmed,
        color: appearance.value,
        id: appearance.identity,
      });
    } catch (err) {
      setError(errorText(err, t`Could not create bot`));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={nameRef}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="create-bot-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-center">
              <Trans>New bot</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-2">
            <BotAvatar
              color={look.value}
              identity={look.identity}
              size={96}
              avatarSet={avatarSet}
            />
          </div>
          <Input
            ref={nameRef}
            aria-label={t`Name`}
            placeholder={t`Name your Bot`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="text-center"
          />
          {error ? (
            <p role="alert" data-testid="create-bot-error" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <fieldset
            className="contents"
            disabled={submitting || submittedAppearance.current !== null}
          >
            <BotLookPicker
              value={look.value}
              identity={look.identity}
              previewIdentities={previewIdentities}
              onChange={(value, identity) => {
                setLook((current) => ({ value, identity: identity ?? current.identity }));
              }}
            />
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!trimmed || submitting}>
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
