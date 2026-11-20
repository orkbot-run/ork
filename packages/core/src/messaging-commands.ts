/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type MessagingCommand = "approve" | "decline" | "leave" | "stop";

// Keep the localized button labels aligned with the web's Stop translations.
// Commands are exact tokens/phrases: Spanish "para" is intentionally excluded
// because it is also a very common preposition in ordinary messages.
const STOP_COMMANDS = new Set([
  "stop",
  "stop now",
  "stoppen",
  "stopp",
  "중지",
  "durdur",
  "dur",
  "रोकें",
  "parar",
  "停止",
  "detener",
  "detente",
  "остановить",
  "остановись",
  "стоп",
  "arrêter",
  "arrête",
  "עצירה",
  "zatrzymaj",
  "zatrzymaj się",
  "przerwij",
]);
const EDGE_PUNCTUATION = new Set(".!?…¡¿。！？,;:،؛");

/** Recognizes an entire Stop command, independently of the user's app locale. */
export function isStopCommand(text: string): boolean {
  const value = text.normalize("NFKC").trim().toLowerCase();
  // Only sentence punctuation at the edges; /stop remains a normal message.
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_PUNCTUATION.has(value[start]!)) start += 1;
  while (end > start && EDGE_PUNCTUATION.has(value[end - 1]!)) end -= 1;
  const normalized = value.slice(start, end).trim().replace(/\s+/g, " ");
  return STOP_COMMANDS.has(normalized);
}

export function parseMessagingCommand(text: string): MessagingCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  if (isStopCommand(text)) return "stop";
  return null;
}
