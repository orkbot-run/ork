// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { redactSensitiveText } from "@orkbot/logging/redaction";
import { redactSecrets } from "./events.js";

const REDACTION_MARKER = /^(?:\[redacted\])$/i;

function redactKnown(text: string, credentials: readonly string[]): string {
  if (credentials.length === 0) return text;
  const withMarker = credentials.filter(
    (value) => /\[redacted\]/i.test(value) && !REDACTION_MARKER.test(value),
  );
  return redactSecrets(text, withMarker)
    .split(/(\[redacted\])/i)
    .map((part) => (REDACTION_MARKER.test(part) ? part : redactSecrets(part, credentials)))
    .join("");
}

function decodeEscapes(text: string): string {
  return text
    .replace(/%[0-9a-f]{2}(?:%[89ab][0-9a-f]){0,3}/gi, (sequence) => {
      // Decode each UTF-8 character independently so a malformed neighbor cannot hide it.
      for (let end = sequence.length; end > 0; end -= 3) {
        try {
          return decodeURIComponent(sequence.slice(0, end)) + sequence.slice(end);
        } catch {
          // Leave invalid bytes in their original spelling.
        }
      }
      return sequence;
    })
    .replace(
      /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g,
      (sequence) => JSON.parse(`"${sequence}"`) as string,
    );
}

/** Mask known request/stored credentials before recognizing generic credential shapes. */
export function sanitizeModelConnectionError(
  raw: string,
  credentials: readonly string[] = [],
): string {
  const variants = credentials
    .flatMap((credential) => [credential, credential.trim()])
    .flatMap((credential) => {
      if (!credential) return [];
      const escaped = JSON.stringify(credential).slice(1, -1);
      let encoded: string;
      try {
        encoded = encodeURIComponent(credential);
      } catch {
        return [credential, escaped];
      }
      return [
        credential,
        encoded,
        encoded.replaceAll("%20", "+"),
        encoded.replace(/%[0-9A-F]{2}/g, (sequence) => sequence.toLowerCase()),
        escaped,
      ];
    });
  const knownRedacted = redactKnown(raw.trim(), variants);
  // Alternate encodings are relevant only when they reveal a credential we know.
  if (variants.length === 0) return redactSensitiveText(knownRedacted);
  const decoded = decodeEscapes(knownRedacted);
  const decodedRedacted = redactKnown(decoded, variants);
  return redactSensitiveText(decodedRedacted === decoded ? knownRedacted : decodedRedacted);
}
