import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SITE_ACTION_SELECTOR, SITE_FIELD_SELECTOR } from "../v1/controlsCss.js";

/** Local comparison assets only. The product's typography stays unchanged. */
export const FONT_STUDY_FAMILIES = [
  { id: "space-grotesk", name: "Space Grotesk" },
  { id: "balsamiq-sans", name: "Balsamiq Sans" },
  { id: "comic-neue", name: "Comic Neue" },
  { id: "playpen-sans", name: "Playpen Sans" },
] as const;
export type FontStudyFamily = typeof FONT_STUDY_FAMILIES[number]["id"];
export const FONT_STUDY_VARIANTS = [
  { id: "lighter", name: "Lighter" },
  { id: "regular", name: "Regular" },
  { id: "bold", name: "Bold" },
] as const;
export type FontStudyVariant = typeof FONT_STUDY_VARIANTS[number]["id"];
export type FontStudyView = "home" | "mint";
export const FONT_STUDY_SCRIPT_PATH = "/assets/font-study.js";

const require = createRequire(import.meta.url);
const assets = new Map<string, { bytes: Buffer; contentType: string }>();
const preloads = new Map<string, string>();
function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function fontStudyFamily(value: string | null): FontStudyFamily {
  return FONT_STUDY_FAMILIES.find(font => font.id === value)?.id ?? "space-grotesk";
}
export function fontStudyVariant(value: string | null): FontStudyVariant {
  return FONT_STUDY_VARIANTS.find(variant => variant.id === value)?.id ?? "regular";
}
export function fontStudyWeight(font: FontStudyFamily, variant: FontStudyVariant): number {
  return variant === "bold" ? 700 : variant === "lighter" && font !== "balsamiq-sans" ? 300 : 400;
}
export function fontStudyHref(view: FontStudyView, font: FontStudyFamily, handle = "AnAgentArtist", variant: FontStudyVariant = "regular"): string {
  const search = new URLSearchParams({ font, variant });
  if (/^@?[A-Za-z0-9_]{0,15}$/.test(handle)) search.set("handle", handle);
  return `${view === "home" ? "/" : "/mint"}?${search}`;
}

/** Larger, identical specimens for every family; never applied to the live site or SVG art. */
export const FONT_STUDY_TYPE_SCALE_CSS = `
html[data-font-study]{--ui-font-size:18px;--control-padding:14px 28px}
html[data-font-study] ${SITE_ACTION_SELECTOR}{font-size:20px;min-height:56px}
html[data-font-study] ${SITE_FIELD_SELECTOR}{font-size:20px;min-height:56px;height:56px}
html[data-font-study] body.open-mint .mint-entry-sheet :is(.mint-section-title,.open-wallet-address,.open-mint-cost,.open-feedback,.open-mint-explanation,[data-pulse-sale-status],[data-pulse-feedback],.mint-entry-ceiling,.mint-entry-modes label){font-size:18px}
html[data-font-study] body.open-mint .mint-entry-handle .open-handle-input{font-size:56px;height:104px;line-height:1.35}
html[data-font-study] body.open-mint .mint-entry-handle .open-handle-input::placeholder{font-size:inherit}
html[data-font-study] body.open-mint .home-grid .home-guidance{font-size:18px;white-space:normal;text-wrap:pretty}
html[data-font-study] body.open-mint .home-grid .home-mint-cta,html[data-font-study] body.open-mint .home-grid .home-mint-cta>span{font-size:20px}
@media(max-width:480px){html[data-font-study] body.open-mint .mint-entry-wallet [data-wallet-controls]{grid-template-columns:minmax(0,1fr)}}
`;

/** Real weight choices only. Balsamiq's lighter specimen is softer ink, not a fabricated light font. */
export const FONT_STUDY_VARIANT_CSS = `
html[data-font-study]{--font-study-weight:400;--font-study-original-ink:#101319}
@media(prefers-color-scheme:dark){html[data-font-study]{--font-study-original-ink:#f4f0e6}}
html[data-font-study]:not([data-font-study="balsamiq-sans"])[data-font-study-variant="lighter"]{--font-study-weight:300}
html[data-font-study][data-font-study-variant="bold"]{--font-study-weight:700}
html[data-font-study] body,html[data-font-study] body :not(svg,svg *){font-weight:var(--font-study-weight)!important;font-synthesis:none}
html[data-font-study] body :is(strong,b){font-weight:700!important}
html[data-font-study="balsamiq-sans"][data-font-study-variant="lighter"]{--ink:color-mix(in srgb,var(--font-study-original-ink) 80%,var(--paper))}
html[data-font-study="balsamiq-sans"][data-font-study-variant="lighter"] svg{--ink:var(--font-study-original-ink);color:var(--ink)}
html[data-font-study] .font-study-tools,html[data-font-study] .font-study-tools *{font-weight:400!important}
`;

const toolbarCss = `
.font-study-tools{position:fixed;z-index:100;inset-block-end:max(12px,env(safe-area-inset-bottom));inset-inline-start:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 24px);padding:10px 18px;border:1px solid var(--line);border-radius:16px;background:var(--paper);color:var(--ink);box-shadow:0 4px 24px #0002}
.font-study-families,.font-study-variants,.font-study-pages{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 18px}
.font-study-tools a{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 2px;text-decoration:none;white-space:nowrap}
.font-study-tools a:hover,.font-study-tools a[aria-current]{text-decoration:underline;text-underline-offset:4px}
.font-study-tools a:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.font-study-variants,.font-study-pages{border-top:1px dashed var(--line)}
.font-study-pages{color:var(--muted)}
.font-study-weight-note{max-width:24rem;margin:4px 0;text-align:center;color:var(--muted);line-height:1.4;font-size:14px}
.font-study-notice{margin:0;text-align:center;color:var(--muted)}
body:has(.font-study-tools){padding-bottom:224px}
@media(max-width:480px){.font-study-families{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.font-study-tools{padding:8px 14px}.font-study-variants{gap:4px 14px}body:has(.font-study-tools){padding-bottom:288px}}
`;
const staticWeights: Partial<Record<FontStudyFamily, number[]>> = {
  "balsamiq-sans": [400, 700],
  "comic-neue": [300, 400, 700],
};
for (const font of FONT_STUDY_FAMILIES) {
  const weights = staticWeights[font.id];
  const isStatic = Boolean(weights);
  const packageName = `${isStatic ? "@fontsource" : "@fontsource-variable"}/${font.id}`;
  const { version } = JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), "utf8")) as { version: string };
  const basePath = `/assets/font-study/${font.id}-${version}`;
  // Preserve real weight coverage: Balsamiq regular/bold, Comic light/regular/bold, others variable.
  const css = (weights?.map(weight => `${weight}.css`) ?? ["wght.css"])
    .map(file => readFileSync(require.resolve(`${packageName}/${file}`), "utf8")).join("\n")
    .replaceAll(`${font.name} Variable`, font.name).replaceAll("./files/", `${basePath}/`)
    .replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, "");
  for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
    const path = match[1];
    const filename = path.slice(basePath.length + 1);
    assets.set(path, { bytes: readFileSync(require.resolve(`${packageName}/files/${filename}`)), contentType: "font/woff2" });
  }
  assets.set(`${basePath}/LICENSE.txt`, { bytes: readFileSync(require.resolve(`${packageName}/LICENSE`)), contentType: "text/plain; charset=utf-8" });
  assets.set(`/assets/font-study/${font.id}.css`, { bytes: Buffer.from(css + `\nhtml[data-font-study="${font.id}"]{--font-family:"${font.name}",sans-serif}\n` + FONT_STUDY_TYPE_SCALE_CSS + FONT_STUDY_VARIANT_CSS + toolbarCss), contentType: "text/css; charset=utf-8" });
  for (const variant of FONT_STUDY_VARIANTS) {
    preloads.set(`${font.id}/${variant.id}`, `<link rel="preload" href="${basePath}/${font.id}-latin-${isStatic ? fontStudyWeight(font.id, variant.id) : "wght"}-normal.woff2" as="font" type="font/woff2" crossorigin>`);
  }
}
export function fontStudyAsset(pathname: string) { return assets.get(pathname); }

/** Decorate the real anonymous home/mint HTML, but never run its wallet clients. */
export function fontStudyPage(html: string, view: FontStudyView, font: FontStudyFamily, sourceOrigin: string, handle = "AnAgentArtist", variant: FontStudyVariant = "regular"): string {
  const origin = new URL(sourceOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password) throw Error("Local font study only");
  const family = FONT_STUDY_FAMILIES.find(candidate => candidate.id === font)!;
  const variantName = FONT_STUDY_VARIANTS.find(candidate => candidate.id === variant)!.name;
  const softInk = font === "balsamiq-sans" && variant === "lighter";
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*rel="preload"[^>]*>/gi, "")
    .replace(/<p data-pulse-sale-status role="status">Checking mint availability…<\/p>/g, '<p data-pulse-sale-status role="status" hidden></p>')
    .replace(/<html\b/, `<html data-font-study="${font}" data-font-study-variant="${variant}"`)
    .replace(/(<title>)[\s\S]*?(<\/title>)/, `$1${family.name} · ${variantName}${softInk ? " (softer ink)" : ""} · ${view === "home" ? "Home" : "Mint"} typography$2`)
    .replace(/href="(\/[^"<>]*)"/g, (_match, href: string) => {
      const url = new URL(href, origin);
      // Styles/font/image links stay on this read-only preview server.
      if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/test-art/")) return `href="${escape(href)}"`;
      if (url.pathname === "/" || url.pathname === "/mint") return `href="${escape(fontStudyHref(url.pathname === "/" ? "home" : "mint", font, handle, variant))}"`;
      return `href="${escape(url.href)}"`;
    })
    .replace(/(<input\b[^>]*id="open-handle"[^>]*value=")[^"]*(")/, (_match, before: string, after: string) => before + escape(handle) + after);
  const fonts = FONT_STUDY_FAMILIES.map(candidate => `<a data-font-study-link href="${escape(fontStudyHref(view, candidate.id, handle, variant))}"${candidate.id === font ? ' aria-current="true"' : ""}>${candidate.name}</a>`).join("");
  const variants = FONT_STUDY_VARIANTS.map(candidate => `<a data-font-study-link href="${escape(fontStudyHref(view, font, handle, candidate.id))}"${candidate.id === variant ? ' aria-current="true"' : ""}>${candidate.name}${font === "balsamiq-sans" && candidate.id === "lighter" ? " · softer ink" : ""}</a>`).join("");
  const weightNote = softInk ? '<p class="font-study-weight-note">Regular 400, softer ink. Balsamiq Sans has no light weight.</p>' : "";
  const pages = (["home", "mint"] as const).map(page => `<a data-font-study-link href="${escape(fontStudyHref(page, font, handle, variant))}"${view === page ? ' aria-current="page"' : ""}>${page === "home" ? "Home" : "Mint"}</a>`).join("");
  const toolbar = `<nav class="font-study-tools" aria-label="Typography comparison"><div class="font-study-families" role="group" aria-label="Font family">${fonts}</div><div class="font-study-variants" role="group" aria-label="Font variant">${variants}</div>${weightNote}<div class="font-study-pages">${pages}<a href="${escape(new URL(view === "home" ? "/" : "/mint", origin).href)}">Live site ↗</a></div><p class="font-study-notice" data-font-study-notice role="status" hidden>Typography preview only. Use the live site to mint.</p></nav>`;
  return clean.replace("</head>", `${preloads.get(`${font}/${variant}`)}<link rel="stylesheet" href="/assets/font-study/${font}.css"><script src="${FONT_STUDY_SCRIPT_PATH}" defer></script></head>`)
    .replace("</body>", `${toolbar}</body>`);
}

export const FONT_STUDY_SCRIPT = `(() => {
  document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => event.preventDefault()));
  document.querySelectorAll('button').forEach(button => button.addEventListener('click', event => {
    event.preventDefault(); document.querySelector('[data-font-study-notice]').hidden = false;
  }));
  // Compare the same typed handle when switching font or switching Home/Mint.
  document.querySelectorAll('[data-font-study-link],a.home-mint-cta,a.home-return').forEach(link => link.addEventListener('click', () => {
    const field = document.querySelector('#open-handle');
    const handle = field ? field.value : new URLSearchParams(location.search).get('handle');
    if (handle !== null && /^@?[A-Za-z0-9_]{0,15}$/.test(handle)) {
      const url = new URL(link.href); url.searchParams.set('handle', handle); link.href = url.href;
    }
  }));
})();`;
