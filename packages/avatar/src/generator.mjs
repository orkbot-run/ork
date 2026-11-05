// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { renderSoft3d } from "./renderer.mjs";

export const VERSION = "2";
export const MAX_ENCODED_AVATAR_STRING_LENGTH = 261;

const choices = (values) => Object.freeze({ type: "enum", values: Object.freeze(values) });
const integer = (min, max) => Object.freeze({ type: "integer", min, max });
const boolean = Object.freeze({ type: "boolean" });

export const PARAMETER_RULES = Object.freeze({
  name: Object.freeze({ type: "string", maxLength: 24 }),
  color: Object.freeze({ type: "color", pattern: "^#[a-fA-F0-9]{6}$" }),
  shape: choices(["ork", "round", "jelly", "drop", "cube", "ghost", "bean", "flower"]),
  eyes: choices(["pill", "dots", "sleepy", "wink", "spark", "heart", "robot"]),
  mouth: choices(["smile", "happy", "neutral", "surprise", "cheeky", "grin", "sleep"]),
  accessory: choices([
    "none",
    "headphones",
    "glasses",
    "antenna",
    "star",
    "crown",
    "bolt",
    "bow",
    "halo",
  ]),
  satellites: integer(0, 4),
  eyeSize: integer(80, 140),
  shine: boolean,
  cheeks: boolean,
  background: choices(["night", "light", "mint", "transparent"]),
  style: choices(["clay"]),
  motion: choices(["none", "float", "bounce", "wobble", "pulse", "dance", "spin"]),
  speed: integer(1, 5),
  intensity: integer(1, 5),
  blink: boolean,
  animate: boolean,
});

export const CLASSIC_PARAMETERS = Object.freeze({
  name: "Orko",
  color: "#65E6A0",
  shape: "ork",
  eyes: "pill",
  mouth: "smile",
  accessory: "none",
  satellites: 2,
  eyeSize: 100,
  shine: true,
  cheeks: false,
  background: "night",
  style: "clay",
  motion: "float",
  speed: 3,
  intensity: 3,
  blink: true,
  animate: true,
});

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export function requireObject(value, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new ValidationError(field, `${field} must be an object`);
  }
}

function isXmlCharacter(character) {
  const code = character.codePointAt(0);
  return (
    code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0xfffe && code !== 0xffff)
  );
}

export function validateParameters(parameters) {
  requireObject(parameters, "parameters");
  for (const [key, value] of Object.entries(parameters)) {
    if (!Object.hasOwn(PARAMETER_RULES, key)) {
      throw new ValidationError(`parameters.${key}`, "Unknown parameter");
    }
    const rule = PARAMETER_RULES[key];
    let valid;
    if (rule.type === "enum") valid = rule.values.includes(value);
    if (rule.type === "integer")
      valid = Number.isInteger(value) && value >= rule.min && value <= rule.max;
    if (rule.type === "boolean") valid = typeof value === "boolean";
    if (rule.type === "color")
      valid = typeof value === "string" && new RegExp(rule.pattern).test(value);
    if (rule.type === "string")
      valid =
        typeof value === "string" &&
        value.isWellFormed() &&
        [...value].length <= rule.maxLength &&
        [...value].every(isXmlCharacter);
    if (!valid) throw new ValidationError(`parameters.${key}`, `Invalid value for ${key}`);
  }
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Decode only canonical v1 strings. No server, database, or random state is read. */
function decodeLegacyAvatar(avatarString) {
  if (
    typeof avatarString !== "string" ||
    avatarString.length > 152 ||
    !/^ork1\.[A-Za-z0-9_-]+$/.test(avatarString)
  ) {
    throw new ValidationError("avatarString", "Expected an ork1. avatar string");
  }
  const payload = avatarString.slice(5);
  let bytes;
  try {
    bytes = Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    throw new ValidationError("avatarString", "Invalid base64url encoding");
  }
  if (bytes.length < 14 || bytes.length > 110 || bytes[13] > 15 || toBase64Url(bytes) !== payload) {
    throw new ValidationError("avatarString", "Invalid avatar payload");
  }
  let name;
  try {
    name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.slice(14));
  } catch {
    throw new ValidationError("avatarString", "Invalid UTF-8 name");
  }
  const parameters = {
    name,
    color:
      "#" +
      [...bytes.slice(0, 3)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase(),
    shape: PARAMETER_RULES.shape.values[bytes[3]],
    eyes: PARAMETER_RULES.eyes.values[bytes[4]],
    mouth: PARAMETER_RULES.mouth.values[bytes[5]],
    accessory: PARAMETER_RULES.accessory.values[bytes[6]],
    satellites: bytes[7],
    eyeSize: bytes[8],
    shine: Boolean(bytes[13] & 1),
    cheeks: Boolean(bytes[13] & 2),
    background: PARAMETER_RULES.background.values[bytes[9]],
    style: "clay",
    motion: PARAMETER_RULES.motion.values[bytes[10]],
    speed: bytes[11],
    intensity: bytes[12],
    blink: Boolean(bytes[13] & 4),
    animate: Boolean(bytes[13] & 8),
  };
  try {
    validateParameters(parameters);
  } catch {
    throw new ValidationError("avatarString", "Avatar payload contains invalid parameters");
  }
  return parameters;
}

// Each field uses its own bits, so encoding never depends on object key order.
const PACKED_FIELDS = [
  ["color", 24],
  ["shape", 3],
  ["eyes", 3],
  ["mouth", 3],
  ["accessory", 4],
  ["satellites", 3],
  ["eyeSize", 6],
  ["shine", 1],
  ["cheeks", 1],
  ["background", 2],
  ["motion", 3],
  ["speed", 3],
  ["intensity", 3],
  ["blink", 1],
  ["animate", 1],
];
const MASK_64 = (1n << 64n) - 1n;
const SEED_COLORS = ["#65E6A0", "#82B5FF", "#B8A0FA", "#FFB565", "#F38CAF", "#F4D873", "#C9E7E2"];
const SEED_NAMES = [
  "Orko",
  "Noki",
  "Piko",
  "Lumi",
  "Zeno",
  "Moki",
  "Kiro",
  "Tiko",
  "Vero",
  "Nexo",
  "Bobo",
  "Riko",
  "Mimo",
  "Kodo",
  "Nunu",
  "Zizi",
  "Fino",
  "Yuki",
  "Naro",
  "Brix",
  "Ollo",
  "Zuki",
  "Pufi",
  "Kora",
];

function resolveParameters(parameters) {
  validateParameters(parameters);
  const resolved = Object.fromEntries(
    Object.keys(PARAMETER_RULES).map((key) => [
      key,
      Object.hasOwn(parameters, key) ? parameters[key] : CLASSIC_PARAMETERS[key],
    ]),
  );
  resolved.color = resolved.color.toUpperCase();
  return resolved;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode all parameters into a decimal string with a version and checksum. */
export function encodeAvatar(parameters = {}) {
  const resolved = resolveParameters(parameters);
  let visual = 0n;
  for (const [key, width] of PACKED_FIELDS) {
    const rule = PARAMETER_RULES[key];
    const ordinal =
      key === "color"
        ? Number.parseInt(resolved.color.slice(1), 16)
        : rule.type === "enum"
          ? rule.values.indexOf(resolved[key])
          : rule.type === "integer"
            ? resolved[key] - rule.min
            : Number(resolved[key]);
    visual = (visual << BigInt(width)) | BigInt(ordinal);
  }
  const name = new TextEncoder().encode(resolved.name);
  const bytes = new Uint8Array(13 + name.length);
  bytes[0] = 2;
  for (let index = 8; index >= 1; index--) {
    bytes[index] = Number(visual & 255n);
    visual >>= 8n;
  }
  bytes.set(name, 9);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, crc32(bytes.subarray(0, -4)), false);
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  return number.toString(10);
}

function normalizeInput(input) {
  if (typeof input === "bigint") {
    if (input < 0n) throw new ValidationError("avatarString", "Use a nonnegative integer");
    return input.toString(10);
  }
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0) {
      throw new ValidationError(
        "avatarString",
        "Pass long numbers as strings or BigInt to preserve every digit",
      );
    }
    return String(input);
  }
  if (typeof input !== "string")
    throw new ValidationError("avatarString", "Use digits, a safe integer, or BigInt");
  const trimmed = input.trim();
  if (trimmed.startsWith("ork1.")) return trimmed;
  if (!/^[0-9]+$/.test(trimmed))
    throw new ValidationError("avatarString", "Use a nonnegative integer written as digits");
  return trimmed.replace(/^0+(?=\d)/, "");
}

function decodePackedNumber(numberString) {
  // Only small, correctly marked envelopes enter BigInt parsing. Longer seeds
  // are folded digit by digit below, with no fixed input length requirement.
  if (numberString.length > MAX_ENCODED_AVATAR_STRING_LENGTH) return null;
  const hex = BigInt(numberString).toString(16).padStart(2, "0");
  const padded = hex.length % 2 ? `0${hex}` : hex;
  if (padded.length < 26 || padded.length > 218 || !padded.startsWith("02")) return null;
  const bytes = Uint8Array.from(padded.match(/../g), (pair) => Number.parseInt(pair, 16));
  if (
    new DataView(bytes.buffer).getUint32(bytes.length - 4, false) !== crc32(bytes.subarray(0, -4))
  )
    return null;
  let visual = 0n;
  for (const byte of bytes.subarray(1, 9)) visual = (visual << 8n) | BigInt(byte);
  const parameters = {};
  for (const [key, width] of [...PACKED_FIELDS].reverse()) {
    const ordinal = Number(visual & ((1n << BigInt(width)) - 1n));
    visual >>= BigInt(width);
    const rule = PARAMETER_RULES[key];
    parameters[key] =
      key === "color"
        ? `#${ordinal.toString(16).padStart(6, "0").toUpperCase()}`
        : rule.type === "enum"
          ? rule.values[ordinal]
          : rule.type === "integer"
            ? ordinal + rule.min
            : Boolean(ordinal);
  }
  if (visual !== 0n) return null;
  try {
    parameters.name = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(9, -4));
  } catch {
    return null;
  }
  try {
    parameters.style = "clay";
    const resolved = resolveParameters(parameters);
    return encodeAvatar(resolved) === numberString ? resolved : null;
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

function parametersFromSeed(digits) {
  // FNV-1a folds all decimal digits; SplitMix64 spreads them across the traits.
  let state = 0xcbf29ce484222325n;
  for (let index = 0; index < digits.length; index++) {
    state = ((state ^ BigInt(digits.charCodeAt(index))) * 0x100000001b3n) & MASK_64;
  }
  const next = (count) => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let value = state;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return Number((value ^ (value >> 31n)) % BigInt(count));
  };
  const pick = (values) => values[next(values.length)];
  return {
    ...CLASSIC_PARAMETERS,
    name: pick(SEED_NAMES),
    color: pick(SEED_COLORS),
    shape: pick(PARAMETER_RULES.shape.values),
    eyes: pick(PARAMETER_RULES.eyes.values),
    mouth: pick(PARAMETER_RULES.mouth.values),
    accessory: pick(PARAMETER_RULES.accessory.values),
    satellites: next(5),
    eyeSize: 80 + next(61),
    shine: next(100) >= 18,
    cheeks: next(100) >= 72,
    motion: pick(PARAMETER_RULES.motion.values.slice(1)),
    speed: 1 + next(5),
    intensity: 1 + next(5),
  };
}

/** Any decimal integer is a deterministic seed; encoded parameter numbers restore exactly. */
export function decodeAvatar(avatarString) {
  const normalized = normalizeInput(avatarString);
  return normalized.startsWith("ork1.")
    ? decodeLegacyAvatar(normalized)
    : (decodePackedNumber(normalized) ?? parametersFromSeed(normalized));
}

/** Return SVG directly from a number or a portable parameter string. */
export function renderAvatar(avatarString) {
  return avatarFromString(avatarString).svg;
}

export function avatarFromString(avatarString) {
  const normalized = normalizeInput(avatarString);
  const parameters = decodeAvatar(normalized);
  const canonical = normalized.startsWith("ork1.") ? encodeAvatar(parameters) : normalized;
  // SVG IDs use the compact full configuration, even when the seed is very long.
  const id = `ork-${encodeAvatar(parameters)}`;
  return {
    version: VERSION,
    avatarString: canonical,
    id,
    parameters,
    svg: renderSoft3d(parameters, id),
  };
}

export function createAvatar(parameters = {}) {
  return avatarFromString(encodeAvatar(parameters));
}
