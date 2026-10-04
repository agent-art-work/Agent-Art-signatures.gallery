import { createHash } from "node:crypto";
import { DARK_COLOR, LIGHT_COLOR, MBTI_TYPES, RENDERER_VERSION, renderSignatureSvg, type MBTI } from "../algorithmV2/index.js";
import { signatureIconViewBox } from "./signatureIcon.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Design study only. These fixed inputs are neither assessments nor minted works.
 * Unlike the captured production favicon, the study generates at local startup. */
export function siteIconMbtiStudyIcon(mbti: MBTI) {
  if (!MBTI_TYPES.includes(mbti)) throw new RangeError("Use one of the 16 uppercase MBTI types.");
  const source = renderSignatureSvg("S", mbti);
  const paths = source.match(/<path\b[^>]*\/>/g);
  if (paths?.length !== 1) throw new Error("Expected one renderer outline.");
  const path = paths[0]!;
  const d = path.match(/^<path d="([^"]+)" fill="#[0-9a-f]{6}" stroke="none"\/>$/)?.[1];
  if (!d) throw new Error("Unexpected renderer path markup.");
  const background = mbti[0] === "I" ? DARK_COLOR : LIGHT_COLOR;
  const ink = mbti[0] === "I" ? LIGHT_COLOR : DARK_COLOR;
  if (path !== `<path d="${d}" fill="${ink}" stroke="none"/>` || !source.includes(`<rect x="0" y="0" width="420" height="420" fill="${background}"/>`)) {
    throw new Error("Unexpected renderer palette.");
  }
  const viewBox = signatureIconViewBox(d);
  const [x, y, width, height] = viewBox;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${viewBox.join(" ")}"><title>Signatures Gallery · S × ${mbti}</title><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${background}"/>${path}</svg>`;
  const manifest = Object.freeze({
    rendererInput: "S",
    rendererVersion: RENDERER_VERSION,
    mbti,
    purpose: "branding-only",
    sourceSvgSha256: sha256(source),
    sourcePathElementSha256: sha256(path),
    pathSha256: sha256(d),
    canonicalViewBox: Object.freeze([0, 0, 420, 420] as const),
    viewBox,
    background,
    ink,
  });
  return Object.freeze({ mbti, svg, manifest });
}

export const SITE_ICON_MBTI_CASES = Object.freeze(MBTI_TYPES.map(siteIconMbtiStudyIcon));
