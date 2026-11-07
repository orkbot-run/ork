// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import { useExternalLinkOpener } from "@orkbot/chat-ui/web";
import { AI_DATA_DISCLOSURES } from "@orkbot/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@orkbot/ui-web";
import { useEffect, useSyncExternalStore } from "react";
import {
  answerAiConsent,
  cancelAiConsentPrompts,
  currentAiConsentPrompt,
  subscribeAiConsent,
} from "../lib/ai-consent";
import { authClient } from "../lib/auth";

/** The same per-recipient disclosure as mobile, shown only before an AI action needs it. */
export function AiConsentDialog() {
  const { t, i18n } = useLingui();
  const sessionId = authClient.useSession().data?.session.id;
  const { open, dialog } = useExternalLinkOpener();
  useEffect(() => {
    cancelAiConsentPrompts();
    return cancelAiConsentPrompts;
  }, [sessionId]);
  const prompt = useSyncExternalStore(subscribeAiConsent, currentAiConsentPrompt, () => null);
  if (!prompt) return null;
  const { recipient, privacyUrl } = prompt;
  const name = recipient.name;
  return (
    <>
      {dialog}
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) answerAiConsent(prompt, false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Share data with ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {recipient.detail && <span className="mb-2 block">{recipient.detail}</span>}
              <span className="block">{i18n._(AI_DATA_DISCLOSURES[recipient.use])}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <button
            type="button"
            onClick={() => open(privacyUrl)}
            className="w-fit text-sm underline"
          >
            <Trans>Privacy policy</Trans>
          </button>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => answerAiConsent(prompt, false)}>
              <Trans>Not now</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => answerAiConsent(prompt, true)}>
              <Trans>Allow</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
