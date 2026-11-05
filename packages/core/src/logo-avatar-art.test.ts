// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify the replacement Ork geometry and face contrast.
// Inherited test setup remains Apache-2.0. New changes follow LICENSE.md.

import { darkTokens, lightTokens } from "@orkbot/ui-tokens";
import { expect, it } from "vitest";
import { BOT_COLOR_LIST, contrastRatio } from "./bot-avatar-colors.js";
import {
  LOGO_AVATAR_BODY_Y,
  LOGO_AVATAR_EYES,
  LOGO_BODY_PATH,
  logoAvatarEyeInk,
  logoAvatarPaint,
  logoAvatarSmilePath,
} from "./logo-avatar-art.js";

type Point = [number, number];

/** Sample the actual quadratic/cubic contour rather than its off-curve control points. */
function contour(): Point[] {
  let start: Point = [0, 0];
  const samples: Point[] = [];
  for (const [, command, coordinates] of LOGO_BODY_PATH.matchAll(/([MQLCZ])([^MQLCZ]*)/g)) {
    const values = [...coordinates!.matchAll(/-?\d+(?:\.\d+)?/g)].map(([n]) => Number(n));
    const points: Point[] = [];
    for (let index = 0; index < values.length; index += 2) {
      points.push([values[index]!, values[index + 1]!]);
    }
    if (command === "M") {
      start = points[0]!;
      continue;
    }
    if (command === "Z") continue;
    for (let step = 0; step <= 100; step++) {
      const t = step / 100;
      let curve = [start, ...points];
      while (curve.length > 1) {
        curve = curve
          .slice(1)
          .map((point, index) => [
            curve[index]![0] * (1 - t) + point[0] * t,
            curve[index]![1] * (1 - t) + point[1] * t,
          ]);
      }
      samples.push(curve[0]!);
    }
    start = points.at(-1)!;
  }
  return samples;
}

it("keeps the complete rounded Ork body inside the animation plate", () => {
  const samples = contour();
  expect(LOGO_BODY_PATH.endsWith("Z")).toBe(true);
  expect(samples.length).toBeGreaterThan(100);
  for (const [x, y] of samples) {
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThan(10);
    expect(x).toBeLessThan(90);
    expect(y + LOGO_AVATAR_BODY_Y).toBeGreaterThan(8);
    expect(y + LOGO_AVATAR_BODY_Y).toBeLessThan(94);
  }
  expect(
    Math.max(...samples.map(([x]) => x)) - Math.min(...samples.map(([x]) => x)),
  ).toBeGreaterThan(75);
  const bottom = samples.filter(([, y]) => y > 80);
  expect(bottom.length).toBeGreaterThan(0);
  expect(Math.min(...bottom.map(([x]) => x))).toBeGreaterThan(30);
  expect(Math.max(...bottom.map(([x]) => x))).toBeLessThan(70);
});

it("has two integrated ears above the lower crown between them", () => {
  const samples = contour();
  const top = (left: number, right: number) =>
    Math.min(...samples.filter(([x]) => x >= left && x <= right).map(([, y]) => y));
  expect(top(30, 42)).toBeLessThan(2);
  expect(top(58, 70)).toBeLessThan(2);
  expect(top(45, 55)).toBeGreaterThan(10);
  expect(LOGO_AVATAR_EYES.leftCx).toBeLessThan(50);
  expect(LOGO_AVATAR_EYES.rightCx).toBeGreaterThan(50);
  expect(LOGO_AVATAR_EYES.height).toBeGreaterThan(LOGO_AVATAR_EYES.width);
});

it.each([...BOT_COLOR_LIST, { hex: "#101014" }, { hex: "#777777" }])(
  "retains $hex as the base and keeps both face features legible",
  ({ hex }) => {
    const paint = logoAvatarPaint(hex);
    expect(paint.base).toBe(hex.toLowerCase());
    for (const page of [lightTokens, darkTokens]) {
      const ink = logoAvatarEyeInk(hex, page);
      expect(contrastRatio(paint.base, ink)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(paint.shadow, ink)).toBeGreaterThanOrEqual(3);
    }
  },
);

it("translates the smile by the same gaze displacement on native", () => {
  const numbers = (path: string) => [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(([n]) => Number(n));
  const still = numbers(logoAvatarSmilePath());
  const moved = numbers(logoAvatarSmilePath(-10, 6));
  expect(moved).toHaveLength(still.length);
  for (const [index, value] of still.entries()) {
    expect(moved[index]).toBeCloseTo(value + (index % 2 === 0 ? -10 : 6));
  }
});
