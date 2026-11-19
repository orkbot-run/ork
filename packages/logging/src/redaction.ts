// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; secret handling changes follow LICENSE.md.

const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "content",
  "text",
  "blocks",
  "parts",
  "input",
  "output",
  "stdout",
  "stderr",
  "arguments",
  "transcript",
  "completion",
  "html",
  "markdown",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "api_key",
]);
const SECRET_KEY = /passwd|password|secret|token|authorization|cookie|credential|apikey/;
const TOKEN_BUDGET_KEYS = new Set(["requestedmaxtokens", "effectivemaxtokens"]);

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: redactSensitiveText(
        typeof value.name === "string" && value.name ? value.name : "Error",
      ),
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key, nested) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

// Consume a failed local-part candidate once instead of retrying at every dot or hyphen.
const EMAIL_CANDIDATE = /\b[A-Z0-9._%+-]+(?:@[A-Z0-9.-]+\.[A-Z]{2,}\b)?/gi;
// The ordinary phrase “bearer of …” is prose, not an authentication credential.
const BEARER = /\bBearer\s+(?!of\b)[^\s"',;&]+/gi;
const BARE_SECRET =
  /sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|\b(?:ak_|ck_)[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9_-]{8,}/g;
// A failed JWT candidate is consumed once, including any embedded API key.
const BARE_SECRET_CANDIDATE = new RegExp(
  `${BARE_SECRET.source}|eyJ[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b)?`,
  "g",
);

function redactKnownCredentials(text: string): string {
  return text.replace(BARE_SECRET_CANDIDATE, (candidate) =>
    candidate.startsWith("eyJ") && !candidate.includes(".")
      ? candidate.replace(BARE_SECRET, REDACTED)
      : REDACTED,
  );
}

// Consume whole words even on a failed assignment: retrying a greedy key expression at each
// character makes long, ordinary words quadratic. Values and containers are also scanned once.
function redactAssignments(text: string): string {
  const fields = /\\?["']|(?:\\u[0-9a-f]{4}|[A-Za-z0-9_])(?:\\u[0-9a-f]{4}|[A-Za-z0-9_.-])*/gi;
  let quoteEnds: Uint32Array | undefined;
  const quotedEnd = (at: number) => {
    quoteEnds ??= indexQuoteEnds(text);
    return quoteEnds[at] || text.length;
  };
  let result = "";
  let offset = 0;
  for (let match = fields.exec(text); match; match = fields.exec(text)) {
    const quote = match[0].endsWith('"') || match[0].endsWith("'") ? match[0] : "";
    const keyStart = quote ? fields.lastIndex : match.index;
    let keyEnd = fields.lastIndex;
    let at = keyEnd;
    if (quote) {
      if (quote.length === 2 && quotedEnd(match.index) === text.length) {
        // An even run of backslashes may precede an ordinary quote.
        fields.lastIndex = match.index + 1;
      }
      at = quotedEnd(match.index);
      keyEnd = at - quote.length;
    }
    while (/\s/.test(text[at] ?? "") && at < text.length) at += 1;
    if (text[at] !== ":" && text[at] !== "=") continue;
    at += 1;
    while (/\s/.test(text[at] ?? "") && at < text.length) at += 1;
    const key = text.slice(keyStart, keyEnd);
    let decodedKey = key;
    if (quote) {
      try {
        decodedKey = JSON.parse(`"${key}"`) as string;
      } catch {
        /* A malformed quoted name still uses its literal spelling. */
      }
    }
    if (!shouldRedactSecretKey(decodedKey, undefined)) continue;
    const start = at;
    const valueQuote = text[at] === "\\" ? text[at + 1] : text[at];
    const quoted = valueQuote === '"' || valueQuote === "'";
    if (quoted) {
      at = quotedEnd(at);
    } else if (text[at] === "{" || text[at] === "[") {
      // Redaction markers are already safe and must stay stable on repeated passes.
      if (text.startsWith(REDACTED, at)) at += REDACTED.length;
      else if (text.startsWith("[redacted]", at)) at += "[redacted]".length;
      else at = containerEnd(text, at, quotedEnd);
    } else {
      while (at < text.length && !/[\s,;"'\]}]/.test(text[at]!)) at += 1;
      const normalized = normalizeSecretKey(decodedKey);
      if (normalized.includes("authorization")) {
        const scheme = text.slice(start, at);
        let credentials = at;
        while (/[ \t]/.test(text[credentials] ?? "")) credentials += 1;
        if (credentials > at && /^[a-z][a-z0-9_-]*$/i.test(scheme)) {
          if (/^(?:basic|bearer|digest|token)$/i.test(scheme)) {
            at = authorizationCredentialEnd(text, credentials, quotedEnd);
          } else {
            const boundary = quote ? /[\r\n}]/ : /[\r\n]/;
            while (at < text.length && !boundary.test(text[at]!)) at += 1;
          }
        }
      } else if (!quote && (normalized === "cookie" || normalized === "setcookie")) {
        while (at < text.length && !/[\r\n]/.test(text[at]!)) at += 1;
      }
    }
    if (at === start) continue;
    const value = text.slice(start, at);
    if (!shouldRedactSecretKey(decodedKey, /^\d+$/.test(value) ? Number(value) : undefined))
      continue;
    const replacement = quoted
      ? `${text[start] === "\\" ? "\\" : ""}${valueQuote}${REDACTED}${text[start] === "\\" ? "\\" : ""}${valueQuote}`
      : quote
        ? `${quote}${REDACTED}${quote}`
        : REDACTED;
    result += text.slice(offset, keyStart);
    result += quote ? `${key}${text.slice(keyEnd, start)}${replacement}` : `${key}=${replacement}`;
    offset = at;
    fields.lastIndex = at;
  }
  return result + text.slice(offset);
}

// Standard schemes have a token or comma-separated parameters. Preserve the surrounding log text.
function authorizationCredentialEnd(
  text: string,
  start: number,
  quotedEnd: (at: number) => number,
): number {
  let at = start;
  const parameter = /[A-Za-z0-9_-]+[ \t]*=/y;
  for (;;) {
    parameter.lastIndex = at;
    if (parameter.exec(text)) {
      at = parameter.lastIndex;
      while (/[ \t]/.test(text[at] ?? "")) at += 1;
    }
    while (at < text.length && !/[\s,;}]/.test(text[at]!)) {
      if (text[at] === '"' || text[at] === "'") at = quotedEnd(at);
      else at += 1;
    }
    let next = at;
    while (/[ \t,]/.test(text[next] ?? "")) next += 1;
    parameter.lastIndex = next;
    if (!parameter.exec(text)) return at;
    at = next;
  }
}

// Match closing delimiters once, including when diagnostic text embeds escaped JSON.
function indexQuoteEnds(text: string): Uint32Array {
  const ends = new Uint32Array(text.length);
  const last = [-1, -1, -1, -1];
  let slashes = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if ((char === '"' || char === "'") && (slashes === 1 || slashes % 2 === 0)) {
      const escaped = Number(slashes === 1);
      const kind = (char === '"' ? 0 : 2) + escaped;
      const previous = last[kind]!;
      if (previous >= 0) ends[previous] = at + 1;
      last[kind] = at - escaped;
    }
    slashes = 0;
  }
  return ends;
}

function containerEnd(text: string, start: number, quotedEnd: (at: number) => number): number {
  const closers: string[] = [];
  for (let at = start; at < text.length; at += 1) {
    if (text[at] === '"' || text[at] === "'" || (text[at] === "\\" && text[at + 1] === '"')) {
      at = quotedEnd(at) - 1;
    } else if (text[at] === "{" || text[at] === "[") closers.push(text[at] === "{" ? "}" : "]");
    else if (text[at] === "}" || text[at] === "]") {
      if (closers.pop() !== text[at]) return text.length;
      if (closers.length === 0) return at + 1;
    }
  }
  return text.length;
}

function redactUrlCredentials(text: string): string {
  // Colon is the fixed anchor; looking backwards for a scheme would repeatedly rescan long words.
  return text.replace(/(:\\?\/\\?\/)[^\s\\/?#"'<>]+/g, (authority, prefix: string) => {
    const separator = authority.lastIndexOf("@");
    return separator < 0 ? authority : `${prefix}${REDACTED}${authority.slice(separator)}`;
  });
}

const CARD_NUMBER =
  /^(?:4\d{12}(?:\d{3})?(?:\d{3})?|5[1-5]\d{14}|2[2-7]\d{14}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11}|6(?:011|5\d{2})\d{12})$/;

function hasCardChecksum(digits: string): boolean {
  let sum = 0;
  for (let at = digits.length - 1; at >= 0; at -= 1) {
    let digit = Number(digits[at]);
    if ((digits.length - 1 - at) % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function redactPaymentCards(text: string): string {
  const starts = /(?<!\d)[2-6]/g;
  let result = "";
  let offset = 0;
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    let end = match.index;
    let digits = "";
    let cardEnd = end;
    // A candidate starts at a digit-group boundary and examines at most 19 digits.
    while (digits.length < 19 && /\d/.test(text[end] ?? "")) {
      digits += text[end++];
      if (!/\d/.test(text[end] ?? "") && CARD_NUMBER.test(digits) && hasCardChecksum(digits))
        cardEnd = end;
      if (text[end] === " " || text[end] === "-") end += 1;
    }
    if (cardEnd === match.index) continue;
    result += text.slice(offset, match.index) + REDACTED;
    offset = cardEnd;
    starts.lastIndex = cardEnd;
  }
  return result + text.slice(offset);
}
// Profile paths leak the account name; leave later drive prefixes available for independent redaction.
const WINDOWS_PROFILE = /[A-Z]:[\\/]Users[\\/](?:(?![A-Z]:[\\/])[^\\/\r\n])+/gi;
const POSIX_PROFILE = /(?:\/Users\/|\/home\/)[^/\s]+/g;

// A shared page's link is its only credential, in the API path and in the web page path, alone
// or anywhere in text after an origin or a separator. The lookbehind runs only after a link path
// matched and stops at the previous slash, so the scan stays linear.
const PAGE_SHARE_LINK =
  /(\/(?:api\/v1\/pages\/shared|p)\/)(?<=(?:^|[\s"'`(<=,;[{]|:\/\/[^/\s]*)\/(?:api\/v1\/pages\/shared|p)\/)[^/?#\s"'`<>()[\]{},;:]+/gi;
// An unfinished quoted value consumes the rest of the text as well.
const INVALID_HEADER_VALUE =
  /Headers\.append: (\\?")[\s\S]*?(?:\1 is an invalid header value\.|$)/g;

export function redactSensitiveText(text: string): string {
  const assignments = redactAssignments(redactUrlCredentials(text));
  return redactPaymentCards(
    redactKnownCredentials(
      assignments
        .replace(PAGE_SHARE_LINK, `$1${REDACTED}`)
        .replace(
          INVALID_HEADER_VALUE,
          `Headers.append: $1${REDACTED}$1 is an invalid header value.`,
        )
        .replace(EMAIL_CANDIDATE, (candidate) => (candidate.includes("@") ? REDACTED : candidate))
        .replace(BEARER, `Bearer ${REDACTED}`)
        .replace(/(?:%[0-9a-f]{2}|[A-Za-z0-9_.~-])+/gi, (candidate) => {
          if (!candidate.includes("%")) return candidate;
          // Decode ASCII bytes independently: malformed UTF-8 next to a key must not hide it.
          const decoded = candidate.replace(/%([0-9a-f]{2})/gi, (sequence, hex: string) => {
            const byte = Number.parseInt(hex, 16);
            return byte < 128 ? String.fromCharCode(byte) : sequence;
          });
          const redacted = redactKnownCredentials(redactAssignments(redactUrlCredentials(decoded)));
          return redacted === decoded ? candidate : REDACTED;
        })
        .replace(WINDOWS_PROFILE, "[user]")
        .replace(POSIX_PROFILE, "/[user]"),
    ),
  );
}

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactSecretKey(key: string, value: unknown): boolean {
  const normalized = normalizeSecretKey(key);
  // Only known numeric counters bypass token redaction; strings and containers may be secrets.
  if (
    TOKEN_BUDGET_KEYS.has(normalized) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return false;
  }
  return normalized === "email" || SECRET_KEY.test(normalized);
}

function shouldRedactKey(key: string, value: unknown): boolean {
  return (
    REDACT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9_]/g, "")) ||
    shouldRedactSecretKey(key, value)
  );
}
