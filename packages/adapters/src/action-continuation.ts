// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { automated } from "./automated-messages.js";

export const MAX_ACTION_CONTINUATIONS = 2;
export const ACTION_CONTINUATION_PROMPT = automated(
  "Your last reply promised an action that has not been performed. Continue the original task now using the available tools. Respect the latest user instructions, cancellations, approvals and limits. If you need input, ask; if blocked, state the concrete reason. Do not end with another promise to start.",
);

/** Recognize an explicit action announcement at the end of a reply. */
export function hasUnfinishedActionPromise(text: string): boolean {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/[“„][^”\n]*”|"[^"\n]*"/g, " ")
    .replace(/\bhttps?:\/\/[^\s<>]+/gi, " the link")
    .trim();
  if (!plain || isInteractionBoundary(plain)) return false;
  const sentences = plain.match(/[^.!?\n]+[.!?]?/g) ?? [];
  const last = sentences.at(-1)?.trim() ?? "";
  const tail =
    /^(?:give me a moment|one moment|momencik|chwileczkę|chwileczke|już za chwilę)[.!]?$/i.test(
      last,
    )
      ? sentences.slice(-2).join(" ")
      : last;
  const english =
    /\b(?:I(?:['’]ll| will| am going to|['’]m going to)|let me)\s+(?:(?:now|first|next|then|also|just)\s+)*(?:check|inspect|look|search|browse|open|read|run|execute|test|verify|build|install|deploy|update|edit|change|fix|create|write|save|send|continue|start|do|use|fetch|download|review|add|remove|try|proceed|investigate)\b/i;
  const polish =
    /(?:^|\s)(?:(?:teraz|zaraz|następnie|nastepnie|najpierw|jeszcze|od razu)\s+)*(?:sprawdzę|sprawdze|przejrzę|przejrze|poszukam|wyszukam|otworzę|otworze|odczytam|przeczytam|uruchomię|uruchomie|wykonam|przetestuję|przetestuje|zweryfikuję|zweryfikuje|zbuduję|zbuduje|zainstaluję|zainstaluje|wdrożę|wdroze|zaktualizuję|zaktualizuje|zmienię|zmienie|poprawię|poprawie|naprawię|naprawie|utworzę|utworze|zapiszę|zapisze|wyślę|wysle|zrobię|zrobie|użyję|uzyje|pobiorę|pobiore|dodam|usunę|usune|spróbuję|sprobuje|kontynuuję|kontynuuje|przechodzę|przechodze|zajmę|zajme)(?=$|[\s,.!:])/i;
  return english.test(tail) || polish.test(tail);
}

export function isInteractionBoundary(text: string): boolean {
  if (/\?[\s"”'’*)\]]*$/.test(text)) return true;
  // A question, permission boundary, explicit pause or refusal must keep control.
  if (
    /\b(?:if you|would you|could you|can you|do you|shall I|should I|let me know|please (?:confirm|pick|choose|select|provide|tell|specify|approve|enter)|need (?:your|permission|approval)|waiting for|awaiting|cannot|can't|unable to|won't|will not|paused|stop here)\b/i.test(
      text,
    )
  )
    return true;
  if (
    /(?:\b(?:jeśli|jezeli|jeżeli|potwierdź|potwierdz|potrzebuję|potrzebuje|czekam|poczekam|wstrzymuję|wstrzymuje|zatrzymuję|zatrzymuje|podaj|wybierz)\b|nie mogę|nie moge|nie będę|nie bede|(?:^|[.!\n])\s*czy\b)/i.test(
      text,
    )
  )
    return true;
  return false;
}
