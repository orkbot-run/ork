// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { AppLocaleSchema, MessageBlock } from "@orkbot/contracts";
import { redactSensitiveText } from "@orkbot/logging/redaction";
import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "./thread-message-updates.js";
import { matchUiLocale } from "./ui-locale.js";

const HINTS: Record<(typeof AppLocaleSchema.options)[number], readonly [string, string]> = {
  en: ["(Reply in the app.)", "(Take over the screen in the app.)"],
  de: ["(Antworte in der App.)", "(Übernimm den Bildschirm in der App.)"],
  ko: ["(앱에서 답변하세요.)", "(앱에서 화면 제어를 넘겨받으세요.)"],
  tr: ["(Uygulamada yanıtlayın.)", "(Uygulamada ekranın kontrolünü devralın.)"],
  hi: ["(ऐप में जवाब दें।)", "(ऐप में स्क्रीन का नियंत्रण लें।)"],
  "pt-BR": ["(Responda no aplicativo.)", "(Assuma o controle da tela no aplicativo.)"],
  "zh-CN": ["（请在应用中回复。）", "（请在应用中接管屏幕。）"],
  "zh-TW": ["（請在應用程式中回覆。）", "（請在應用程式中接管螢幕。）"],
  es: ["(Responde en la aplicación.)", "(Toma el control de la pantalla en la aplicación.)"],
  ru: ["(Ответьте в приложении.)", "(Возьмите управление экраном в приложении.)"],
  fr: ["(Répondez dans l’application.)", "(Prenez le contrôle de l’écran dans l’application.)"],
  he: ["(יש להשיב באפליקציה.)", "(יש להשתלט על המסך באפליקציה.)"],
  nl: ["(Antwoord in de app.)", "(Neem de schermbediening over in de app.)"],
  ja: ["（アプリで回答してください。）", "（アプリで画面の操作を引き継いでください。）"],
  pl: ["(Odpowiedz w aplikacji.)", "(Przejmij ekran w aplikacji.)"],
};

/** Text preview for the owner; answering and approvals remain in the application. */
export function formatMessagingOwnerPrompt(
  block: unknown,
  waitStatus: string,
  locale?: string | null,
): string | undefined {
  if (waitStatus !== "waiting_input" && waitStatus !== "waiting_takeover") return undefined;
  const parsed = MessageBlock.safeParse(block);
  if (!parsed.success) return undefined;
  const card = parsed.data;
  if (!("text" in card) || !card.text.trim()) return undefined;
  const hints = HINTS[matchUiLocale(locale, AppLocaleSchema.options)];

  if (waitStatus === "waiting_takeover") {
    if (card.kind !== "computer" || card.state !== TAKEOVER_COMPUTER_PENDING_STATE)
      return undefined;
    return `${card.text.trim()}\n\n${hints[1]}`;
  }

  if (card.kind !== "ask" || card.status === "answered" || card.dismissed || card.answer) {
    return undefined;
  }
  const protectedAsk = isApprovalAskBlock(card) || isSecretAskBlock(card);
  // A malformed approval must never fall through to a normal question's details.
  if (card.approvalEffectId && !protectedAsk) return undefined;
  const parts = [protectedAsk ? redactSensitiveText(card.text.trim()) : card.text.trim()];
  if (!protectedAsk) {
    if (card.detail?.trim()) parts.push(card.detail.trim());
    if (card.actions?.length) {
      if (card.actions.some((action) => !action.label.trim())) return undefined;
      parts.push(
        card.actions.map((action, index) => `${index + 1}. ${action.label.trim()}`).join("\n"),
      );
    }
  }
  parts.push(hints[0]);
  return parts.join("\n\n");
}
