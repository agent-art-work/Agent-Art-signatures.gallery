import { createHash } from "node:crypto";
import { DARK_COLOR, LIGHT_COLOR } from "../algorithmV2/index.js";
import { SIGNATURE_ICON_SHAPE_LOCKS } from "./faviconShapeLock.js";
import { pathInkBounds } from "./sloganStudyBounds.js";

export type SignatureIconLetter = keyof typeof SIGNATURE_ICON_SHAPE_LOCKS;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The same square framing for every icon, retaining the original path coordinates. */
export function signatureIconViewBox(d: string) {
  const bounds = pathInkBounds(d);
  const side = Math.ceil(Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / .78 * 1e6) / 1e6;
  const round = (value: number): number => Number(value.toFixed(6));
  return Object.freeze([
    round((bounds.minX + bounds.maxX - side) / 2),
    round((bounds.minY + bounds.maxY - side) / 2),
    side, side,
  ] as const);
}

/** Frame the exact captured outline; no redrawing, case conversion, stretching,
 * added strokes or runtime artwork generation. The source handle label is omitted. */
export function signatureIcon(letter: SignatureIconLetter) {
  if (letter !== "S" && letter !== "s") throw new RangeError("Icon letter must be S or s.");
  const shape = SIGNATURE_ICON_SHAPE_LOCKS[letter];
  const path = `<path d="${shape.d}" fill="${DARK_COLOR}" stroke="none"/>`;
  if (sha256(shape.d) !== shape.pathSha256 || sha256(path) !== shape.sourcePathElementSha256) {
    throw new Error("Signature icon shape lock mismatch.");
  }
  const viewBox = signatureIconViewBox(shape.d);
  const [x, y, width, height] = viewBox;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${viewBox.join(" ")}"><title>Signatures Gallery · ${letter}</title><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${LIGHT_COLOR}"/>${path}</svg>`;
  const manifest = Object.freeze({
    rendererInput: shape.rendererInput,
    rendererVersion: shape.rendererVersion,
    mbti: shape.mbti,
    purpose: "branding-only",
    sourceSvgSha256: shape.sourceSvgSha256,
    sourcePathElementSha256: shape.sourcePathElementSha256,
    pathSha256: shape.pathSha256,
    canonicalViewBox: Object.freeze([0, 0, 420, 420] as const),
    viewBox,
    background: LIGHT_COLOR,
    ink: DARK_COLOR,
  });
  return Object.freeze({ svg, manifest });
}
