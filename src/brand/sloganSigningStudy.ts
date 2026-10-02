import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { FAVICON_LINK } from "./favicon.js";
import { SLOGAN_MBTI_HERO_CSS, SLOGAN_MBTI_HERO_SCRIPT_URL } from "./sloganMbtiHero.js";
import { SIGNING_SLOGAN_CANDIDATES } from "./sloganSigningFrames.js";
import { pathInkBounds, unionInkBounds, type InkBounds } from "./sloganStudyBounds.js";

export const SIGNING_SLOGAN_STUDY_PATH = "/design/slogan-wording";
export const SIGNING_SLOGAN_STUDY_CSS_PATH = "/assets/signing-slogan-study.css";
type Candidate = typeof SIGNING_SLOGAN_CANDIDATES[number];
type Layout = "fit" | "native";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const number = (value: number) => Number(value.toFixed(6));
const inkBounds = (capture: { frames: readonly { d: string }[] }) => unionInkBounds(capture.frames.map(frame => pathInkBounds(frame.d)));

function arrange(candidate: Candidate): { bounds: InkBounds; offsets: number[] } {
  if (candidate.mode === "phrase") return { bounds: inkBounds(candidate), offsets: [] };
  const bounds = candidate.words.map(inkBounds);
  let cursor = 0;
  const offsets = bounds.map(word => {
    const offset = cursor - word.minX;
    cursor += word.maxX - word.minX + 40;
    return offset;
  });
  return { bounds: { minX: 0, maxX: cursor - 40,
    minY: Math.min(...bounds.map(word => word.minY)), maxY: Math.max(...bounds.map(word => word.maxY)) }, offsets };
}

// One fixed union over all eight frames prevents scale and spacing from jumping.
// Independent words share the canonical baseline, native weight and 40-unit ink gaps.
const arrangements = SIGNING_SLOGAN_CANDIDATES.map(arrange);
const maxInkWidth = Math.max(...arrangements.map(item => item.bounds.maxX - item.bounds.minX));
const allInk = unionInkBounds(arrangements.map(item => item.bounds));
const y = allInk.minY - 16, height = allInk.maxY - allInk.minY + 32;

function href(shape: string | undefined, layout: Layout): string {
  const search = new URLSearchParams();
  if (shape) search.set("shape", shape);
  if (layout === "native") search.set("layout", layout);
  return SIGNING_SLOGAN_STUDY_PATH + (search.size ? `?${search}` : "");
}

export function signingSloganStudyPage(cssUrl: string, shape?: string, layout: Layout = "fit"): string {
  const selected = SIGNING_SLOGAN_CANDIDATES[0].frames.find(frame => frame.mbti === shape);
  const mode: Layout = layout === "native" ? "native" : "fit";
  const shapes = `<a href="${escape(href(undefined, mode))}"${selected ? "" : ' aria-current="page"'}>Animate</a>` +
    SIGNING_SLOGAN_CANDIDATES[0].frames.map(frame => `<a href="${escape(href(frame.mbti, mode))}"${selected?.mbti === frame.mbti ? ' aria-current="page"' : ""}>${frame.mbti} / ${frame.pairedMbti}</a>`).join("");
  const modes = ([['fit', 'Fit to equal width'], ['native', 'Same stroke scale']] as const).map(([value, label]) =>
    `<a href="${escape(href(selected?.mbti, value))}"${mode === value ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const rows = SIGNING_SLOGAN_CANDIDATES.map((candidate, index) => {
    const arrangement = arrangements[index];
    const inkWidth = arrangement.bounds.maxX - arrangement.bounds.minX;
    const span = mode === "native" ? maxInkWidth : inkWidth;
    const padding = span * .035;
    const viewBox = `${number(arrangement.bounds.minX - (span - inkWidth) / 2 - padding)} ${number(y)} ${number(span + padding * 2)} ${number(height)}`;
    const frames = candidate.frames.map((frame, i) => {
      const paths = candidate.mode === "words" ? candidate.words.map((word, w) =>
        `<g data-signing-word="${escape(word.source.displayText)}" transform="translate(${number(arrangement.offsets[w])} 0)"><path d="${word.frames[i].d}" fill="currentColor"/></g>`).join("") : `<path d="${frame.d}" fill="currentColor"/>`;
      return `<g class="slogan-mbti-frame slogan-mbti-frame-${i}" data-slogan-frame="${frame.mbti}" data-mbti-pair="${frame.mbti}/${frame.pairedMbti}" data-active="${selected?.mbti === frame.mbti}">${paths}</g>`;
    }).join("");
    return `<figure data-signing-candidate="${candidate.id}" data-render-mode="${candidate.mode}" data-ink-width="${number(inkWidth)}"><figcaption><span class="signing-number">0${index + 1}</span><strong>${escape(candidate.literal)}</strong><span class="signing-kind">${index === 0 ? "Current · " : ""}${candidate.mode === "words" ? "Four independent signatures" : "One continuous signature"}</span></figcaption><svg xmlns="http://www.w3.org/2000/svg" data-signing-art="${candidate.id}" viewBox="${viewBox}" role="img" aria-label="${escape(candidate.literal)} — ${candidate.mode === "words" ? "four independent word signatures" : "one continuous signature"}">${frames}</svg></figure>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Anyone can sign anyone · Slogan comparison</title>${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${escape(cssUrl)}"><link rel="stylesheet" href="${SIGNING_SLOGAN_STUDY_CSS_PATH}"><script defer src="${SLOGAN_MBTI_HERO_SCRIPT_URL}"></script></head><body class="signing-study" data-animation="${selected ? "off" : "on"}" data-layout="${mode}"><main><nav class="signing-nav"><a href="http://127.0.0.1:3004/">← Live home</a><span>Demo only · homepage unchanged</span></nav><header><h1>Anyone, in four forms.</h1><p>Exact capitalization. No punctuation. The spaced versions draw each word independently.</p></header><nav class="signing-layout" aria-label="Comparison scale">${modes}</nav><nav class="signing-shapes" aria-label="MBTI shape">${shapes}</nav><p class="signing-note">${mode === "fit" ? "Each complete arrangement fits the same width. Four independent words become smaller and thinner together; no individual word is stretched." : "All four rows share the same native stroke scale and baseline. Different arrangements keep their natural widths."} ${selected ? `Holding ${selected.mbti} / ${selected.pairedMbti}.` : "1000ms fade + 1000ms hold. Hover or focus on the drawings to pause all four."}</p><section class="slogan-loop" tabindex="0" aria-label="Four slogan comparisons">${rows}</section><p class="signing-footnote">Pinned renderer 2.0.1. Shared MBTI shapes, stable spacing, and theme-aware ink. This read-only study makes no wallet, mint, Grok, or RPC requests.</p></main></body></html>`;
}

export const SIGNING_SLOGAN_STUDY_CSS = `${SLOGAN_MBTI_HERO_CSS}
.signing-study{padding:28px 24px 56px}
.signing-study main{max-width:1024px;margin-inline:auto;min-height:0}
.signing-nav{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:32px;color:var(--muted)}
.signing-study header h1{font-size:24px;line-height:1.5}
.signing-study p{line-height:1.65;color:var(--muted)}
.signing-layout,.signing-shapes{display:flex;flex-wrap:wrap;gap:0 20px;line-height:1.5}
.signing-layout{margin-top:24px}.signing-shapes{margin-top:4px}
.signing-layout a,.signing-shapes a,.signing-nav a{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;text-underline-offset:5px}
.signing-layout a[aria-current],.signing-shapes a[aria-current],.signing-study a:hover{text-decoration:underline}
.signing-study a:focus-visible,.signing-study .slogan-loop:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
.signing-study figure{margin:0;padding:24px 0 28px;border-top:1px dashed var(--line)}
.signing-study figcaption{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 16px;line-height:1.6}
.signing-study figcaption strong{font-size:16px}
.signing-number,.signing-kind{color:var(--muted)}.signing-kind{margin-inline-start:auto}
.signing-study svg[data-signing-art]{display:block;width:100%;height:auto;margin-top:20px;overflow:visible;color:var(--ink)}
.signing-note{margin:12px 0 24px}.signing-footnote{margin-top:20px}
.signing-study[data-animation="off"] .slogan-loop .slogan-mbti-frame{animation:none;opacity:0}
.signing-study[data-animation="off"] .slogan-loop .slogan-mbti-frame[data-active="true"]{opacity:1}
@media(max-width:600px){.signing-study{padding:20px 20px 40px}.signing-kind{flex-basis:100%;margin-inline-start:32px}.signing-layout,.signing-shapes{gap:0 16px}}
`;
