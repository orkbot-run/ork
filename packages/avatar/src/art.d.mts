// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { AvatarAccessory, AvatarEyes, AvatarMouth, AvatarShape } from "./generator.mjs";

export interface AvatarPart {
  readonly tag: "path" | "ellipse" | "rect" | "circle";
  readonly props: Readonly<{
    d?: string;
    cx?: number;
    cy?: number;
    r?: number;
    rx?: number;
    ry?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fill?: string;
    fillOpacity?: number;
    stroke?: string;
    strokeOpacity?: number;
    strokeWidth?: number;
    strokeLinecap?: "round";
    strokeLinejoin?: "round";
    opacity?: number;
    transform?: string;
  }>;
}

export const AVATAR_BODY_PATHS: Readonly<Record<AvatarShape, string>>;
export const AVATAR_SATELLITES: readonly (readonly [number, number, number])[];
export function eyeParts(
  type: AvatarEyes,
  size: number,
  index: 0 | 1,
  ink?: string,
): readonly AvatarPart[];
export function mouthParts(type: AvatarMouth, ink?: string): readonly AvatarPart[];
export function accessoryParts(
  type: AvatarAccessory,
  layer: "behind" | "front",
): readonly AvatarPart[];
export function cheekParts(): readonly AvatarPart[];
export function serializeParts(parts: readonly AvatarPart[]): string;
