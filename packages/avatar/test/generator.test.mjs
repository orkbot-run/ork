// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  avatarFromString,
  CLASSIC_PARAMETERS,
  createAvatar,
  decodeAvatar,
  encodeAvatar,
  MAX_ENCODED_AVATAR_STRING_LENGTH,
  PARAMETER_RULES,
  renderAvatar,
  ValidationError,
} from "../src/generator.mjs";

const CLASSIC_STRING = "697495921471626208003591940531880713577";
const LEGACY_STRING = "ork1.ZeagAAAAAAJkAAEDAw1Pcmtv";
const normalizeIds = (avatar) => avatar.svg.replaceAll(avatar.id, "avatar");

test("the numeric string contains the full configuration and has a stable canonical encoding", () => {
  assert.equal(encodeAvatar(), CLASSIC_STRING);
  assert.deepEqual(decodeAvatar(CLASSIC_STRING), CLASSIC_PARAMETERS);
  assert.deepEqual(avatarFromString(CLASSIC_STRING), createAvatar(CLASSIC_PARAMETERS));
  assert.equal(renderAvatar(CLASSIC_STRING), createAvatar().svg);
  assert.equal(
    encodeAvatar({ color: "#aabbcc", shine: false }),
    encodeAvatar({ shine: false, color: "#AABBCC" }),
  );
});

test("a fresh process reproduces the avatar from only its string", () => {
  const avatar = createAvatar({
    name: "Żółw 🟢",
    color: "#ABCDEF",
    shape: "flower",
    animate: false,
  });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {avatarFromString} from ${JSON.stringify(new URL("../src/generator.mjs", import.meta.url).href)};
    process.stdout.write(JSON.stringify(avatarFromString(${JSON.stringify(avatar.avatarString)})));
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), avatar);
});

test("browser bundle works in a fresh offline context without Node APIs, fetch, or storage", async () => {
  const bundle = await readFile(new URL("../dist/ork-avatar.js", import.meta.url), "utf8");
  const context = vm.createContext({ TextEncoder, TextDecoder });
  vm.runInContext(bundle, context);
  const actual = vm.runInContext(`OrkAvatar.avatarFromString('${CLASSIC_STRING}')`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), avatarFromString(CLASSIC_STRING));
  assert.equal(
    vm.runInContext("typeof fetch + '/' + typeof process + '/' + typeof localStorage", context),
    "undefined/undefined/undefined",
  );
  assert.equal(
    vm.runInContext(`OrkAvatar.encodeAvatar(OrkAvatar.decodeAvatar('${CLASSIC_STRING}'))`, context),
    CLASSIC_STRING,
  );
  const seeded = vm.runInContext("OrkAvatar.avatarFromString('12312312312')", context);
  assert.deepEqual(JSON.parse(JSON.stringify(seeded)), avatarFromString("12312312312"));
});

test("every supported parameter round-trips and changes actual SVG content after ID normalization", () => {
  const base = createAvatar();
  for (const [key, rule] of Object.entries(PARAMETER_RULES)) {
    const values =
      rule.values ??
      (rule.type === "integer"
        ? [rule.min, rule.max]
        : rule.type === "boolean"
          ? [false, true]
          : key === "color"
            ? ["#000000", "#FFFFFF"]
            : ["", "Żółw 🟢"]);
    for (const value of values) {
      const result = createAvatar({ [key]: value });
      assert.equal(result.parameters[key], value);
      assert.deepEqual(decodeAvatar(result.avatarString), result.parameters);
      assert.equal(encodeAvatar(result.parameters), result.avatarString);
      if (value !== CLASSIC_PARAMETERS[key])
        assert.notEqual(normalizeIds(result), normalizeIds(base), `${key}=${value}`);
    }
  }
});

test("changing one parameter preserves every other parameter in the string", () => {
  const original = createAvatar({
    color: "#B8A0FA",
    shape: "jelly",
    accessory: "glasses",
  });
  const changed = createAvatar({
    ...decodeAvatar(original.avatarString),
    satellites: 0,
    shine: false,
    animate: false,
  });
  assert.deepEqual(changed.parameters, {
    ...original.parameters,
    satellites: 0,
    shine: false,
    animate: false,
  });
  assert.notEqual(changed.avatarString, original.avatarString);
});

test("animation, blinking, satellites, and transparent backgrounds honor false and zero", () => {
  const still = createAvatar({
    animate: false,
    satellites: 0,
    background: "transparent",
  }).svg;
  assert.doesNotMatch(still, /<style>|<g class="ork-sat|<rect width="600"/);
  const noBlink = createAvatar({ animate: true, blink: false, motion: "none" });
  assert.match(noBlink.svg, /\.ork-eyes\{\}/);
  assert.match(noBlink.svg, /\.ork-body\{\}/);
  assert.match(noBlink.svg, /ork-sat-1\{animation:/);
  const moving = createAvatar({
    animate: true,
    blink: true,
    motion: "float",
    speed: 5,
    intensity: 5,
  }).svg;
  assert.match(moving, /1\.85s ease-in-out infinite/);
  assert.match(moving, /translateY\(-32px\)/);
  assert.match(moving, /prefers-reduced-motion:reduce/);
});

test("names, Unicode, byte boundaries, and XML escaping survive portable serialization", () => {
  for (const name of ["<>&\"' Żółw 🟢", "\uFEFFHello", "", "🟢".repeat(24), "Łódź", "line\nname"]) {
    const avatar = createAvatar({ name });
    assert.equal(decodeAvatar(avatar.avatarString).name, name);
    assert.equal(encodeAvatar(decodeAvatar(avatar.avatarString)), avatar.avatarString);
    assert.ok(avatar.avatarString.length <= MAX_ENCODED_AVATAR_STRING_LENGTH);
  }
  assert.equal(encodeAvatar({ name: "🟢".repeat(24) }).length, MAX_ENCODED_AVATAR_STRING_LENGTH);
  assert.match(createAvatar({ name: "<>&\"'" }).svg, /&lt;&gt;&amp;&quot;&#39;/);
  assert.throws(() => createAvatar({ name: "🟢".repeat(25) }), ValidationError);
  assert.throws(() => createAvatar({ name: "bad\u0001" }), ValidationError);
  assert.throws(() => createAvatar({ name: "\uD800" }), ValidationError);
});

test("invalid types, ranges, styles, and unknown parameters fail explicitly", () => {
  for (const parameters of [
    null,
    [],
    "x",
    new Date(),
    { unknown: 1 },
    { style: "flat" },
    { animate: "false" },
    { satellites: -1 },
    { satellites: 5 },
    { satellites: 1.2 },
    { speed: Infinity },
    { intensity: NaN },
    { eyeSize: 79 },
    { eyeSize: 141 },
    { color: "#fff" },
    { color: 'red" onload="x' },
    { shape: "__proto__" },
    JSON.parse('{"__proto__": {"polluted":true}}'),
    { name: null },
    { blink: undefined },
  ]) {
    assert.throws(() => createAvatar(parameters), ValidationError);
  }
  assert.equal({}.polluted, undefined);
});

test("every nonempty numeric prefix and extension generates a reproducible avatar", () => {
  for (let length = 1; length <= CLASSIC_STRING.length; length++) {
    const prefix = CLASSIC_STRING.slice(0, length);
    const result = avatarFromString(prefix);
    assert.deepEqual(avatarFromString(prefix), result);
    assert.doesNotThrow(() => encodeAvatar(result.parameters));
    assert.equal(result.avatarString, prefix);
  }
  for (const seed of [
    "0",
    "1",
    "12312312312",
    `${CLASSIC_STRING}1234567890`,
    "1234567890".repeat(10_000),
  ]) {
    const result = avatarFromString(seed);
    assert.deepEqual(avatarFromString(seed), result);
    assert.deepEqual(decodeAvatar(encodeAvatar(result.parameters)), result.parameters);
    assert.equal(result.svg, renderAvatar(encodeAvatar(result.parameters)));
    assert.ok(result.id.length <= MAX_ENCODED_AVATAR_STRING_LENGTH + 4);
    assert.ok(result.svg.length < 40_000);
  }
});

test("number 1 and longer numbers choose different stable characters", () => {
  const one = avatarFromString("1");
  assert.equal(one.id, "ork-711241459094222639009686628416388960932");
  assert.equal(avatarFromString("12312312312").id, "ork-702282813103326884588861634067405737690");
  assert.notEqual(one.id, avatarFromString("12312312312").id);
  const prefix = "1234567890".repeat(1000);
  assert.notEqual(avatarFromString(`${prefix}1`).id, avatarFromString(`${prefix}2`).id);
  assert.notEqual(avatarFromString(prefix).id, avatarFromString(`${prefix}0`).id);
  assert.equal(
    new Set(Array.from({ length: 1000 }, (_, i) => avatarFromString(String(i)).id)).size,
    1000,
  );
});

test("numeric types and leading zeros normalize without precision loss", () => {
  for (const input of [1, 1n, "1", "0001", "  0001\n"])
    assert.deepEqual(avatarFromString(input), avatarFromString("1"));
  for (const input of [0, -0, 0n, "0", "000"])
    assert.deepEqual(avatarFromString(input), avatarFromString("0"));
  const large = 123123123123123123123123123123123123123123123123123123123123n;
  assert.deepEqual(avatarFromString(large), avatarFromString(large.toString()));
  assert.deepEqual(
    avatarFromString(Number.MAX_SAFE_INTEGER),
    avatarFromString(String(Number.MAX_SAFE_INTEGER)),
  );
  for (const input of [
    null,
    undefined,
    {},
    [],
    true,
    -1,
    -1n,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    " ",
    "-1",
    "+1",
    "1.2",
    "1e3",
    "1 2",
    "12a",
    "１２３",
  ]) {
    assert.throws(() => decodeAvatar(input), ValidationError);
  }
});

test("altered numeric parameter codes remain valid deterministic seeds", () => {
  const changedDigit = CLASSIC_STRING.slice(0, -1) + (CLASSIC_STRING.at(-1) === "0" ? "1" : "0");
  const result = avatarFromString(changedDigit);
  assert.notDeepEqual(result.parameters, CLASSIC_PARAMETERS);
  assert.deepEqual(avatarFromString(changedDigit), result);
  assert.doesNotThrow(() => renderAvatar(changedDigit));
  const bytes = Buffer.from(BigInt(CLASSIC_STRING).toString(16).padStart(34, "0"), "hex");
  bytes[0] = 3;
  const futureVersion = BigInt(`0x${bytes.toString("hex")}`).toString(10);
  assert.doesNotThrow(() => renderAvatar(futureVersion));
});

test("malformed UTF-8 with a valid checksum falls back in a separate runtime", async () => {
  // Header and visual fields are valid, the name is 0xff, CRC32 is 64e0890c.
  const input = "41573996631600034714714900564236";
  const bundle = await readFile(new URL("../dist/ork-avatar.js", import.meta.url), "utf8");
  const context = vm.createContext({ TextEncoder, TextDecoder });
  vm.runInContext(bundle, context);
  const result = vm.runInContext(`OrkAvatar.avatarFromString('${input}')`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), avatarFromString(input));
  assert.equal(result.avatarString, input);
});

test("legacy strings retain their parameters and migrate to the numeric format", () => {
  assert.deepEqual(decodeAvatar(LEGACY_STRING), CLASSIC_PARAMETERS);
  assert.deepEqual(avatarFromString(LEGACY_STRING), createAvatar());
  const pack = (bytes) => `ork1.${Buffer.from(bytes).toString("base64url")}`;
  const bytes = Buffer.from(LEGACY_STRING.slice(5), "base64url");
  for (const string of [
    `ork2.${LEGACY_STRING.slice(5)}`,
    `${LEGACY_STRING}=`,
    "ork1.a",
    `ork1.${"a".repeat(148)}`,
    pack([1, 2, 3]),
  ]) {
    assert.throws(() => decodeAvatar(string), ValidationError);
  }
  for (const [index, value] of [
    [3, 8],
    [4, 7],
    [5, 7],
    [6, 9],
    [7, 5],
    [8, 79],
    [9, 4],
    [10, 7],
    [11, 0],
    [12, 6],
    [13, 16],
    [14, 255],
  ]) {
    const corrupt = bytes.slice();
    corrupt[index] = value;
    assert.throws(() => decodeAvatar(pack(corrupt)), ValidationError);
  }
});
