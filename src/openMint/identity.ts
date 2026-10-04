import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { MBTI_TYPES, type MBTI } from "../algorithmV2/index.js";
export { RENDERER_VERSION, MBTI_TYPES, type MBTI } from "../algorithmV2/index.js";
export { RENDERER_VERSION as LEGACY_RENDERER_VERSION } from "../v1/rendererVersion.js";

export const HANDLE_DOMAIN = "signatures.gallery/open-handle/v1";
export const LEGACY_MAPPING_VERSION = "mbti-seed-v1";
export const POLICY_VERSION = "grok-x-search-v1";

/** Protocol order: never reorder or change these seeds without a new mapping version. */
export const LEGACY_MBTI_TYPES = [
  "INTJ", "INTP", "ENTJ", "ENTP", "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ", "ISTP", "ISFP", "ESTP", "ESFP",
] as const;
export const MBTI_SEEDS: Readonly<Record<MBTI, number>> = Object.freeze({
  INTJ: 1, INTP: 7, ENTJ: 14, ENTP: 20, INFJ: 27, INFP: 34, ENFJ: 40, ENFP: 47,
  ISTJ: 53, ISFJ: 60, ESTJ: 67, ESFJ: 73, ISTP: 80, ISFP: 86, ESTP: 93, ESFP: 100,
});

/** Validate spelling without changing case: preview input or a verified mint snapshot. */
export function preservedHandle(value: unknown): string {
  if (typeof value !== "string" || !/^@?[A-Za-z0-9_]{1,15}$/.test(value)) {
    throw new Error("Handle must contain 1–15 ASCII letters, numbers, or underscores, with an optional @.");
  }
  return value.replace(/^@/, "");
}

/** Case-insensitive literal handle identity, not X account ID; separate from artwork spelling. */
export function canonicalHandle(value: unknown): string { return preservedHandle(value).toLowerCase(); }

/** Identity depends only on the canonical handle, never the artwork's MBTI attribute. */
export function handleDigest(value: unknown): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [HANDLE_DOMAIN, canonicalHandle(value)]));
}

export function isMbti(value: unknown): value is MBTI {
  return typeof value === "string" && (MBTI_TYPES as readonly string[]).includes(value);
}

export function seedForMbti(value: MBTI): number {
  if (!isMbti(value)) throw new Error("Invalid MBTI artwork attribute.");
  return MBTI_SEEDS[value];
}
