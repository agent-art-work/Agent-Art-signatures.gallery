import { ANALYTICS_ORIGIN, type AnalyticsConfig } from './analytics.js';
export type GalleryAnalyticsOptions = AnalyticsConfig;
// Owner-controlled source only. No activation from URL, preferences or env flags.
export function galleryAnalytics(publicOrigin: string): GalleryAnalyticsOptions {
  return { enabled: false, production: publicOrigin === ANALYTICS_ORIGIN, beaconToken: '',
    manualRegionalModeQualified: false, documentBoundaryQualified: false, withdrawalQualified: false,
    regionEligible: false, documentPath: '' };
}
export const ANALYTICS_OPEN_BUTTON = '<a class="measurement-privacy-link" href="#measurement-privacy">Privacy</a>';
export function analyticsMarkup(config: GalleryAnalyticsOptions): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script type="application/json" id="analytics-config">${json}</script>`
    + '<details id="measurement-privacy"><summary>Privacy and measurement</summary>'
    + (config.enabled
      ? '<p>Statistical measurement is enabled only for qualified public pages and regions. This page may remain unmeasured because of its route, region, browser settings or referrer. Previews and functional browser storage work independently.</p>'
      : '<p>Browser audience measurement is off in this version. No analytics permission prompt is shown. Previews and functional browser storage work independently.</p>')
    + '<p>When qualified and enabled, Cloudflare statistical measurement covers selected public pages, not handle previews, saved collections, wallet or mint flows. It receives network and browser information; reports are estimates, not unique people. Restricted or unknown regions are unmeasured. Hosting security and service counters are separate.</p>'
    + '<p>Your existing browser exclusion is preserved. Removing it does not grant consent or enable collection. Old Google Analytics choices and historical reports are not reused as permission. Clearing browser storage also clears the exclusion.</p>'
    + '<p id="analytics-status" role="status" aria-live="polite">Browser measurement is off.</p>'
    + '<div class="measurement-actions"><button type="button" data-analytics-action="exclude" hidden>Exclude this browser</button><button type="button" data-analytics-action="include" hidden>Remove browser exclusion</button></div>'
    + '<p>If measurement was active in an older open tab, save your work and reload that tab after excluding it. A final in-flight measurement may still complete; previously sent data cannot be recalled.</p></details>';
}
export const ANALYTICS_CSS = `
#measurement-privacy{max-width:54rem;margin:2rem auto;padding:0 1rem;color:var(--muted)}
#measurement-privacy summary{cursor:pointer}#measurement-privacy p{margin:1rem 0}
.measurement-actions{display:flex;flex-wrap:wrap;gap:1rem}
.measurement-privacy-link{text-underline-offset:.2em}
[data-analytics-action][hidden]{display:none}
`;
