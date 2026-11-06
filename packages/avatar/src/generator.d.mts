// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

export type AvatarShape = "ork" | "round" | "jelly" | "drop" | "cube" | "ghost" | "bean" | "flower";
export type AvatarEyes = "pill" | "dots" | "sleepy" | "wink" | "spark" | "heart" | "robot";
export type AvatarMouth = "smile" | "happy" | "neutral" | "surprise" | "cheeky" | "grin" | "sleep";
export type AvatarAccessory =
  | "none"
  | "headphones"
  | "glasses"
  | "antenna"
  | "star"
  | "crown"
  | "bolt"
  | "bow"
  | "halo";
export type AvatarMotion = "none" | "float" | "bounce" | "wobble" | "pulse" | "dance" | "spin";

export interface AvatarParameters {
  name: string;
  color: string;
  shape: AvatarShape;
  eyes: AvatarEyes;
  mouth: AvatarMouth;
  accessory: AvatarAccessory;
  satellites: number;
  eyeSize: number;
  shine: boolean;
  cheeks: boolean;
  background: "night" | "light" | "mint" | "transparent";
  style: "clay";
  motion: AvatarMotion;
  speed: number;
  intensity: number;
  blink: boolean;
  animate: boolean;
}

export type AvatarInput = string | number | bigint;
export type ParameterRule =
  | Readonly<{ type: "enum"; values: readonly string[] }>
  | Readonly<{ type: "integer"; min: number; max: number }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{ type: "color"; pattern: string }>
  | Readonly<{ type: "string"; maxLength: number }>;
export interface GeneratedAvatar {
  version: "2";
  avatarString: string;
  id: string;
  parameters: AvatarParameters;
  svg: string;
}

export const VERSION: "2";
export const MAX_ENCODED_AVATAR_STRING_LENGTH: 261;
export const PARAMETER_RULES: Readonly<Record<keyof AvatarParameters, ParameterRule>>;
export const CLASSIC_PARAMETERS: Readonly<AvatarParameters>;
export class ValidationError extends Error {
  field: string;
  constructor(field: string, message: string);
}
export function requireObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown>;
export function validateParameters(
  parameters: unknown,
): asserts parameters is Partial<AvatarParameters>;
export function encodeAvatar(parameters?: Partial<AvatarParameters>): string;
export function decodeAvatar(input: AvatarInput): AvatarParameters;
export function renderAvatar(input: AvatarInput): string;
export function avatarFromString(input: AvatarInput): GeneratedAvatar;
export function createAvatar(parameters?: Partial<AvatarParameters>): GeneratedAvatar;
