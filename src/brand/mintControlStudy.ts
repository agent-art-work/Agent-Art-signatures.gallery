import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { SITE_CSS_URL } from "../v1/siteCss.js";
import { HOME_LINK } from "../v1/navigation.js";
import { FAVICON_LINK } from "./favicon.js";
import { siteFooter } from "./footer.js";
import { bindHandleValidation } from "../openMint/fieldValidation.js";

export const MINT_CONTROL_STUDY_PATH = "/design/mint-controls";
export const MINT_CONTROL_STUDY_CSS_PATH = "/assets/mint-control-study.css";
export const MINT_CONTROL_STUDY_SCRIPT_PATH = "/assets/mint-control-study.js";

export const MINT_CONTROL_STUDIES = [
  { id: "hairline", name: "Hairline", note: "Outlined field / outlined button" },
  { id: "ink", name: "Ink", note: "Underlined field / solid button" },
  { id: "frame", name: "Open frame", note: "Bracketed field / bracketed button" },
  { id: "continuous", name: "Continuous", note: "One frame / joined action" },
  { id: "x-pill", name: "X-inspired pill", note: "Quiet underlined field / solid pill button" },
] as const;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** An isolated, local interaction study. No mint client, forms or wallet hooks. */
export function mintControlStudyPage(stylesheetUrl = SITE_CSS_URL): string {
  const pairs = MINT_CONTROL_STUDIES.map((style, index) => {
    const number = String(index + 1).padStart(2, "0");
    const field = `<div class="mcs-field"><input id="mcs-input-${style.id}" name="handle" type="text" placeholder="@handle" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" required aria-describedby="mcs-validation-${style.id} mcs-status-${style.id}"></div>`;
    const button = `<button class="mcs-button" type="button"><span>Mint &amp; reveal</span>${style.id === "continuous" ? '<span class="mcs-arrow" aria-hidden="true">↗</span>' : ""}</button>`;
    return `<article class="mcs-candidate" data-control-style="${style.id}" data-style-number="${number}" aria-labelledby="mcs-title-${style.id}"><header class="mcs-heading"><h2 id="mcs-title-${style.id}"><span class="mcs-number">${number}</span>${style.name}</h2><p>${style.note}</p></header><div class="mcs-specimen"><label class="mcs-label" for="mcs-input-${style.id}">X handle</label><div class="mcs-controls">${field}${button}</div><p id="mcs-validation-${style.id}" class="open-preview-notice open-preview-warning" data-handle-validation role="status" aria-live="polite" hidden></p><p class="mcs-status" id="mcs-status-${style.id}" data-control-feedback role="status" aria-live="polite"></p></div></article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Input &amp; button pairs · Signatures Gallery</title>${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${escape(stylesheetUrl)}"><link rel="stylesheet" href="${MINT_CONTROL_STUDY_CSS_PATH}"><script src="${MINT_CONTROL_STUDY_SCRIPT_PATH}" defer></script></head><body class="book-page mcs-page"><main>${HOME_LINK}<a class="collection-shortcut" href="/me" aria-label="My Collection" title="My Collection"><span class="collection-shortcut-dot" aria-hidden="true"></span></a><section class="mcs-study"><header class="mcs-intro"><h1>Input &amp; button pairs</h1><p>Same words, ${MINT_CONTROL_STUDIES.length} treatments. Type, hover, or use Tab to compare.</p><p class="mcs-note">The buttons only test the styling. They do not mint.</p></header><div class="mcs-grid">${pairs}</div><a class="mcs-back" href="/mint">Back to mint ↗</a></section></main>${siteFooter()}</body></html>`;
}

// Scoped to the comparison page; production mint controls are untouched.
export const MINT_CONTROL_STUDY_CSS = `
.mcs-study{padding:100px var(--page-gutter) 56px;line-height:1.5}
.mcs-intro{margin-bottom:52px}.mcs-intro h1{font-size:24px;line-height:1.3;letter-spacing:-.02em}.mcs-intro p{margin:12px 0 0;color:var(--muted)}.mcs-intro .mcs-note{margin-top:4px}
.mcs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:52px 56px}
.mcs-candidate{min-width:0}.mcs-heading h2{display:flex;align-items:baseline;gap:12px;margin:0;line-height:1.5}.mcs-number{color:var(--muted);font-variant-numeric:tabular-nums}.mcs-heading p{margin:6px 0 28px;color:var(--muted)}
.mcs-label{display:block;margin-bottom:10px;color:var(--muted)}.mcs-controls{display:grid;justify-items:start;gap:18px}.mcs-field{position:relative;width:100%;min-width:0}
.mcs-field input{appearance:none;display:block;width:100%;min-width:0;height:48px;margin:0;padding:12px 16px;border:0;border-radius:0;background:transparent;color:var(--ink);font-family:var(--font-family);font-size:16px;line-height:1.35;box-shadow:none;transition:border-color 120ms}
.mcs-field input::placeholder{color:var(--muted);opacity:1}
.mcs-button{appearance:none;position:relative;display:inline-flex;align-items:center;justify-content:center;gap:12px;min-width:44px;min-height:48px;margin:0;padding:12px 20px;border:1px solid transparent;border-radius:0;background:transparent;color:var(--ink);font-family:var(--font-family);font-size:16px;line-height:1.35;cursor:pointer;transition:background-color 120ms,color 120ms}
.mcs-button>span{font-size:inherit;line-height:inherit}.mcs-button:active{transform:translateY(1px)}
.mcs-field input:focus-visible,.mcs-button:focus-visible,.mcs-back:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
[data-control-style=x-pill] input:is(:focus,:focus-visible){outline:none;box-shadow:none}
.mcs-status{min-height:21px;margin:12px 0 0;color:var(--muted);overflow-wrap:anywhere}.mcs-back{display:inline-flex;align-items:center;min-height:44px;margin-top:36px;text-decoration:none}.mcs-back:hover{text-decoration:underline;text-underline-offset:4px}
.mcs-page .open-preview-warning{--preview-warning:#806014;margin:.65rem 0 0;border-inline-start:1px solid var(--preview-warning);background:transparent;padding:.15rem 0 .15rem .65rem;color:var(--ink);font-size:14px;line-height:1.6;overflow-wrap:anywhere}.mcs-page .open-preview-notice-label{display:inline;font-weight:500;color:var(--preview-warning)}.mcs-page .open-preview-notice-label::after{content:":"}.mcs-page [data-handle-validation][hidden]{display:none}@media(prefers-color-scheme:dark){.mcs-page .open-preview-warning{--preview-warning:#c6a65a}}
[data-control-style=hairline] input{border:1px solid var(--line)}[data-control-style=hairline] input:hover,[data-control-style=hairline] input:focus{border-color:var(--ink)}[data-control-style=hairline] .mcs-button{border-color:var(--ink)}[data-control-style=hairline] .mcs-button:hover{background:var(--ink);color:var(--paper)}
[data-control-style=ink] input{padding-inline:0;border-bottom:1px solid var(--line)}[data-control-style=ink] input:hover,[data-control-style=ink] input:focus{border-bottom-color:var(--ink)}[data-control-style=ink] .mcs-button{border-color:var(--ink);background:var(--ink);color:var(--paper)}[data-control-style=ink] .mcs-button:hover{background:var(--paper);color:var(--ink)}
[data-control-style=frame] .mcs-field::before,[data-control-style=frame] .mcs-field::after,[data-control-style=frame] .mcs-button::before,[data-control-style=frame] .mcs-button::after{content:"";position:absolute;inset-block:0;width:8px;border-block:1px solid var(--ink);pointer-events:none}
[data-control-style=frame] .mcs-field::before,[data-control-style=frame] .mcs-button::before{left:0;border-left:1px solid var(--ink)}[data-control-style=frame] .mcs-field::after,[data-control-style=frame] .mcs-button::after{right:0;border-right:1px solid var(--ink)}[data-control-style=frame] .mcs-button{border:0}[data-control-style=frame] .mcs-button:hover{background:var(--paper-2)}
[data-control-style=continuous] .mcs-controls{display:flex;align-items:stretch;width:100%;gap:0;border:1px solid var(--line)}[data-control-style=continuous] .mcs-controls:focus-within{border-color:var(--ink)}[data-control-style=continuous] .mcs-field{flex:1;min-width:0}[data-control-style=continuous] input{height:48px}[data-control-style=continuous] .mcs-button{flex:none;min-height:48px;padding:12px 16px;border:0;border-left:1px solid var(--line)}[data-control-style=continuous] .mcs-button:hover{background:var(--ink);color:var(--paper)}[data-control-style=continuous] .mcs-arrow{display:inline-block}
[data-control-style=x-pill] input{padding-inline:0;border-bottom:1px solid var(--line)}[data-control-style=x-pill] input:hover,[data-control-style=x-pill] input:focus{border-bottom-color:var(--ink)}[data-control-style=x-pill] .mcs-button{padding-inline:24px;border:0;border-radius:999px;background:var(--ink);color:var(--paper);font-weight:500}[data-control-style=x-pill] .mcs-button>span{font-weight:inherit}[data-control-style=x-pill] .mcs-button:hover{background:var(--paper);color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
@media(max-width:700px){.mcs-study{padding-top:88px}.mcs-grid{grid-template-columns:minmax(0,1fr);gap:40px}.mcs-intro{margin-bottom:40px}.mcs-heading p{margin-bottom:22px}.mcs-back{margin-top:24px}}
@media(prefers-reduced-motion:reduce){.mcs-field input,.mcs-button{transition:none}.mcs-button:active{transform:none}}
`;

export const MINT_CONTROL_STUDY_SCRIPT = `(() => {
  const bindHandleValidation = ${bindHandleValidation.toString()};
  for (const card of document.querySelectorAll("[data-control-style]")) {
    bindHandleValidation(card);
    const input = card.querySelector("input");
    const status = card.querySelector("[data-control-feedback]");
    input.addEventListener("input", () => { status.textContent = ""; });
    card.querySelector("button").addEventListener("click", () => {
      if (!input.reportValidity()) return;
      status.textContent = "Style " + card.dataset.styleNumber + " · " + input.value + " — demo only.";
    });
  }
})();`;
