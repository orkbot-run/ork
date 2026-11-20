import { AppLocaleSchema } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import { isStopCommand, parseMessagingCommand } from "./messaging-commands.js";

describe("isStopCommand", () => {
  const localizedLabels = {
    en: "Stop",
    de: "Stoppen",
    ko: "중지",
    tr: "Durdur",
    hi: "रोकें",
    "pt-BR": "Parar",
    "zh-CN": "停止",
    "zh-TW": "停止",
    es: "Detener",
    ru: "Остановить",
    fr: "Arrêter",
    he: "עצירה",
    nl: "Stoppen",
    ja: "停止",
    pl: "Zatrzymaj",
  } satisfies Record<(typeof AppLocaleSchema.options)[number], string>;

  it.each(AppLocaleSchema.options)("recognizes the Stop label for %s", (locale) => {
    const text = localizedLabels[locale];
    expect(isStopCommand(text)).toBe(true);
    expect(isStopCommand(`  ¡${text.toUpperCase()}!  `)).toBe(true);
    expect(parseMessagingCommand(text)).toBe("stop");
  });

  it("normalizes edge punctuation, case, Unicode and whitespace", () => {
    for (const text of [
      "¿DeTeNeR?",
      "¡DETENTE!",
      "停止。",
      "중지！",
      "  ZaTrZyMaJ   SiĘ… ",
      "Arre\u0302ter!",
      "ＳＴＯＰ！",
      " STOP\nNOW?! ",
      "przerwij",
      "СтОп",
      "arrête",
      "dur",
    ]) {
      expect(isStopCommand(text), text).toBe(true);
      expect(parseMessagingCommand(text), text).toBe("stop");
    }
  });

  it("does not interpret ordinary prose, substrings or ambiguous para as commands", () => {
    for (const text of [
      "",
      "?!",
      "para",
      "¡PARA!",
      "para mañana",
      "stopper",
      "stop it",
      "don't stop",
      "stop, now",
      "/stop",
      "zatrzymaj się proszę",
      "nie zatrzymaj",
      "Detener el proceso",
      "停止してください",
      "остановить задачу",
    ]) {
      expect(isStopCommand(text), text).toBe(false);
      expect(parseMessagingCommand(text), text).toBeNull();
    }
  });
});

describe("parseMessagingCommand", () => {
  it("parses the minimal command set case-insensitively", () => {
    expect(parseMessagingCommand("YES")).toBe("approve");
    expect(parseMessagingCommand("yes")).toBe("approve");
    expect(parseMessagingCommand(" yes ")).toBe("approve");
    expect(parseMessagingCommand("NO")).toBe("decline");
    expect(parseMessagingCommand("no")).toBe("decline");
    expect(parseMessagingCommand("LEAVE")).toBe("leave");
    expect(parseMessagingCommand("leave")).toBe("leave");
  });

  it("reads a bare stop or stop now, ignoring case, spacing and closing punctuation", () => {
    for (const text of ["stop", "Stop now.", "STOP!", "  stop   now ", "stop…"])
      expect(parseMessagingCommand(text)).toBe("stop");
    for (const text of ["stop it", "stopper", "don't stop", "/stop", "stop, now"])
      expect(parseMessagingCommand(text)).toBeNull();
  });

  it("treats everything else as a normal message", () => {
    expect(parseMessagingCommand("yes please")).toBeNull();
    expect(parseMessagingCommand("YES!")).toBeNull();
    expect(parseMessagingCommand("")).toBeNull();
    expect(parseMessagingCommand("hello")).toBeNull();
    expect(parseMessagingCommand("leave the group")).toBeNull();
  });
});
