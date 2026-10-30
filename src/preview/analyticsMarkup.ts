// Consent-first analytics markup and styles shared by the page layout and the
// Cloudflare build. Text mirrors AgentArt.work's notice, adapted to Gallery.
export const GALLERY_MEASUREMENT_ID = "G-QBCNPY7QK1";
export const GALLERY_ANALYTICS_ORIGIN = "https://signatures.gallery";

export interface GalleryAnalyticsOptions { enabled: true; production: boolean; measurementId: string }

/** Production only. Staging shows the same choices but never loads Google. */
export function galleryAnalytics(publicOrigin: string): GalleryAnalyticsOptions {
  return { enabled: true, production: publicOrigin === GALLERY_ANALYTICS_ORIGIN, measurementId: GALLERY_MEASUREMENT_ID };
}

export const ANALYTICS_OPEN_BUTTON = '<button class="analytics-open" type="button" data-analytics-action="open" aria-haspopup="dialog" aria-controls="analytics-settings" hidden>Analytics choices</button>';

const actions = '<div class="analytics-actions"><button type="button" data-analytics-action="allow">Allow analytics</button><button type="button" data-analytics-action="reject">Reject analytics</button></div>';

/** JSON data block (not executed under script-src 'self'), notice and dialog. */
export function analyticsMarkup(config: GalleryAnalyticsOptions): string {
  const json = JSON.stringify({ enabled: config.enabled, production: config.production, measurementId: config.measurementId }).replace(/</g, "\\u003c");
  return `<script type="application/json" id="analytics-config">${json}</script>`
    + `<aside id="analytics-notice" aria-label="Optional analytics" hidden><p>Allow Google Analytics to measure page categories, approximate country, visits and engagement? It uses cookies. Your choice is optional; previews work either way.</p>${actions}<button class="analytics-open" type="button" data-analytics-action="open">Details and choices</button></aside>`
    + `<dialog id="analytics-settings" aria-labelledby="analytics-title"><h2 id="analytics-title" tabindex="-1">Analytics choices</h2><p id="analytics-status" role="status" aria-live="polite">Analytics is off until this page verifies your permission.</p>`
    + `<p>If allowed, Google Analytics measures broad page categories (Home, About, Explore, MBTI galleries or Previews), approximate country, browser visits and engagement time. Google receives network and browser information, including your IP address. No X handle, MBTI choice, wallet or mint data is included. Advertising and personalization are off.</p>`
    + `${actions}<details><summary>Cookies and limits</summary><p>Your choice is saved in this browser for 90 days. If allowed, analytics cookies distinguish browsers and sessions. The client cookie is configured for up to 90 days from creation; session cookies may renew for up to 90 days after activity or a later visit. Clearing site storage removes the saved choice and browser exclusion.</p><p>Reject analytics to withdraw permission. This stops further measurement on this page and removes this site’s analytics cookies; it cannot recall information already sent. Excluding this browser also prevents future measurement here until you remove the exclusion. Removing exclusion does not grant permission.</p><p>Reports cover consenting browsers, not all visitors or unique people. Country can reflect a VPN or network location; engagement time is not proof of attention. See <a href="https://policies.google.com/privacy" rel="noreferrer">Google’s privacy policy</a>.</p></details>`
    + `<div class="analytics-secondary"><button type="button" data-analytics-action="exclude">Exclude this browser</button><button type="button" data-analytics-action="include" hidden>Remove browser exclusion</button><button type="button" data-analytics-action="close">Close</button></div></dialog>`;
}

export const ANALYTICS_CSS = `
/* A quiet text link like About the work; outranks the site-wide pill button rule. */
body footer .analytics-open,body #analytics-notice .analytics-open{display:inline-flex;align-items:center;min-width:0;min-height:44px;padding:0;border:0;border-radius:0;background:transparent;color:inherit;font-size:inherit;line-height:inherit;text-decoration:underline;text-underline-offset:.2em;white-space:nowrap}body footer .analytics-open:hover,body #analytics-notice .analytics-open:hover{text-decoration:none}
#analytics-settings,#analytics-notice{color:var(--ink);background:var(--paper);border:1px solid var(--line);font:var(--ui-font-weight) var(--ui-font-size)/1.6 var(--font-family);padding:20px}
#analytics-settings{width:min(560px,calc(100% - 32px));max-height:85vh;overflow:auto;margin:auto}#analytics-settings::backdrop{background:rgb(0 0 0 / .35)}
#analytics-settings h2{margin:0 0 16px;font-size:18px}#analytics-settings p,#analytics-notice p{margin:0 0 16px}#analytics-settings summary{cursor:pointer;margin-bottom:12px}#analytics-status{min-height:3.2em}
.analytics-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-block:16px}
.analytics-actions button,.analytics-secondary button{padding:7px 10px;border:1px solid var(--line);border-radius:0;color:var(--ink);background:var(--paper);font:inherit;cursor:pointer}
.analytics-actions button:disabled{opacity:.6;cursor:default}.analytics-secondary{display:flex;flex-wrap:wrap;gap:12px}
#analytics-notice{position:fixed;z-index:30;right:16px;bottom:16px;width:min(460px,calc(100% - 32px));max-height:80vh;overflow:auto}
#analytics-notice[hidden],[data-analytics-action][hidden]{display:none}
@media print{#analytics-settings,#analytics-notice,.analytics-open{display:none}}
`;
