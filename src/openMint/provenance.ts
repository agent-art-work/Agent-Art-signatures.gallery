import { isMbti } from "./identity.js";
import { handleLink } from "./handleLink.js";
import type { AssessmentPageModel } from "./pages.js";

const e = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
const LETTERS: Readonly<Record<string, string>> = Object.freeze({
  I: "Introversion", E: "Extraversion", S: "Sensing", N: "Intuition",
  T: "Thinking", F: "Feeling", J: "Judging", P: "Perceiving",
});

/** Presentation only. Never normalize or rewrite the frozen assessment. */
function sourceLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    return url.href;
  } catch { return undefined; }
}

type Fact = readonly [label: string, html: string | undefined];
function facts(rows: readonly Fact[]): string {
  return `<dl class="signature-facts">${rows.filter(([, value]) => value !== undefined && value !== "").map(([label, html]) => `<div><dt>${e(label)}</dt><dd>${html}</dd></div>`).join("")}</dl>`;
}
const text = (value: string | undefined): string | undefined => value === undefined ? undefined : e(value);

/** Called by verified inclusion/finalized pages; no transport, storage or runtime-mode attribution. */
export function provenanceBody(model: AssessmentPageModel, handle: string): string {
  const grok = model.assessmentProvenance === "grok";
  const fixture = model.assessmentProvenance === "development-fixture";
  const assessor = grok ? "Grok" : fixture ? "Development fixture" : "Not recorded";
  const explanation = grok
    ? "Grok selected this MBTI from public X research. The first accepted assessment is fixed for this handle. This is the site’s assessment record, not a cryptographic signature from Grok."
    : fixture ? "Sample MBTI input; Grok was not called."
    : "The assessor was not recorded for this work. No Grok attribution is inferred.";
  const meaning = isMbti(model.mbti) ? `<span class="provenance-mbti-meaning">${[...model.mbti].map(letter => `<span>${letter} — ${LETTERS[letter]}</span>`).join(" · ")}</span>` : "";
  const verifiedAt = grok ? model.identityVerifiedAt : undefined;
  const account = verifiedAt && /^[1-9][0-9]{0,19}$/.test(model.verifiedXUserId ?? "")
    ? `<a href="https://x.com/i/user/${e(model.verifiedXUserId)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${e(model.verifiedXUserId)} ↗</a>` : undefined;
  const sources = grok && Array.isArray(model.assessmentSourceUrls)
    ? [...new Set(model.assessmentSourceUrls.slice(0, 128).map(sourceLink).filter((url): url is string => !!url))] : [];
  const sourceHtml = grok ? `<div class="provenance-sources"><h3>Research sources</h3>${sources.length
    ? `<p>Links saved with the assessment. Their contents may change or become unavailable.</p><ul data-assessment-sources>${sources.map(url => `<li><a href="${e(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${e(url)} ↗</a></li>`).join("")}</ul>`
    : "<p>No source links available in this record.</p>"}</div>` : "";
  return `<div class="provenance-caveats"><p><strong class="open-preview-notice-label">Caveat</strong> MBTI is an artistic input, not a psychological diagnosis. Owning this token does not imply ownership or control of the X account.</p></div>
<section class="signature-provenance-section"><h2>Assessment</h2><p>${explanation}</p>${facts([
    ["Assessor", assessor],
    ["Model", text(model.assessmentModel)],
    [fixture ? "Created" : "Assessed", text(model.assessedAt)],
    ["MBTI", model.mbti ? `${e(model.mbti)}${meaning}` : undefined],
    ["Spelling verified at preparation", text(verifiedAt)],
    ["Verified X account", account],
  ])}${verifiedAt ? "<p>This is the spelling verified during preparation, not a live X profile lookup. The token identifies the handle, not the X account ID.</p>" : ""}${sourceHtml}</section>
<section class="signature-provenance-section"><h2>Artwork</h2>${facts([
    ["Handle", handleLink(handle)], ["Renderer", text(model.rendererVersion)],
    ["SVG SHA-256", text(model.svgSha256)], ["PNG SHA-256", text(model.pngSha256)],
    ["Input commitment", text(model.inputDigest)], ["Renderer identity", text(model.rendererIdentity)],
    ["Assessment commitment", text(model.assessmentDigest)],
  ])}</section>
<section class="signature-provenance-section"><h2>Mint</h2>${facts([
    ["Token", text(model.mint?.tokenId ?? model.tokenId)], ["Transaction", text(model.mint?.transactionHash)],
  ])}</section>`;
}
