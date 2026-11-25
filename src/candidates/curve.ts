import { centerPointsForCenterline, pureBezierPath, type GeometryPoint } from "../algorithm/geometry.js";
import { DEFAULT_SETTINGS } from "../algorithm/settings.js";
import { pointsForSettings } from "../algorithm/svg.js";

export class CandidateError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export function checkedHandle(value: unknown): string {
  if (typeof value !== "string" || !/^@?[A-Za-z0-9_]{1,15}(?![\s\S])/.test(value)) {
    throw new CandidateError("invalid_handle");
  }
  return value.replace(/^@/, "");
}

export const WORK_DEFINITION = "signatures.gallery/curve-edit-study/1";
export const EDIT_POLICY = Object.freeze({
  version: "single-coordinate-study/1",
  maxX: 8,
  maxY: 16,
});

export type Edit = { point: number; part: "anchor" | "incoming" | "outgoing"; dx: number; dy: number };
export type Proposal = { edit: Edit; intention: string };

const FRAME = 420;
const encoder = new TextEncoder();

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function isShape(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
}

export function basePoints(handle: string): GeometryPoint[] {
  return centerPointsForCenterline(pointsForSettings(handle, DEFAULT_SETTINGS), FRAME / 2);
}

export function curveSvg(handle: string, points: GeometryPoint[]): string {
  const path = pureBezierPath(points);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420" width="420" height="420" role="img"><title>Signature for @${handle}</title><rect width="420" height="420" fill="#f2ead6"/><path d="${path}" fill="none" stroke="#11110f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function readProposal(value: unknown): Proposal {
  if (!isShape(value, ["edit", "intention"]) || !isShape(value.edit, ["point", "part", "dx", "dy"])) {
    throw new CandidateError("invalid_proposal");
  }
  const { point, part, dx, dy } = value.edit;
  if (typeof point !== "number" || !Number.isSafeInteger(point) || point < 0
      || (part !== "anchor" && part !== "incoming" && part !== "outgoing")
      || typeof dx !== "number" || !Number.isInteger(dx) || Math.abs(dx) > EDIT_POLICY.maxX
      || typeof dy !== "number" || !Number.isInteger(dy) || Math.abs(dy) > EDIT_POLICY.maxY || (!dx && !dy)) {
    throw new CandidateError("invalid_edit");
  }
  if (typeof value.intention !== "string" || !value.intention.trim()
      || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.intention)
      || encoder.encode(value.intention).byteLength > 1024) {
    throw new CandidateError("invalid_intention");
  }
  return { edit: { point, part, dx: dx || 0, dy: dy || 0 }, intention: value.intention };
}

export function applyEdit(original: GeometryPoint[], edit: Edit): GeometryPoint[] {
  const { point, part, dx, dy } = edit;
  if (point >= original.length || (part === "incoming" && !point)
      || (part === "outgoing" && point === original.length - 1)) {
    throw new CandidateError("unused_coordinate");
  }
  const old = original[point];
  const changed = { ...old };
  const parts = part === "anchor" ? ["anchor", "incoming", "outgoing"] as const : [part];
  for (const key of parts) {
    const coordinates: [number, number] = [old[key][0] + dx, old[key][1] + dy];
    if (!coordinates.every(value => Number.isFinite(value) && value >= 0 && value <= FRAME)) {
      throw new CandidateError("coordinate_outside_canvas");
    }
    changed[key] = coordinates;
  }
  if (part === "anchor" && ((point > 0 && changed.anchor[0] <= original[point - 1].anchor[0])
      || (point + 1 < original.length && changed.anchor[0] >= original[point + 1].anchor[0]))) {
    throw new CandidateError("anchor_order_changed");
  }
  return original.map((entry, index) => index === point ? changed : entry);
}
