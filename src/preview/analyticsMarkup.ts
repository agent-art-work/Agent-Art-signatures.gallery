import { HOME_PILOT_BINDING, HOME_PILOT_MODE, HOME_MEASUREMENT_MODE } from './homePilotBinding.js';
import { ANALYTICS_ORIGIN, type AnalyticsConfig } from './analytics.js';
export type GalleryAnalyticsOptions = AnalyticsConfig;
declare const __GALLERY_HOME_PILOT__: boolean;
declare const __GALLERY_HOME_MEASUREMENT__: boolean;
const homePilot = typeof __GALLERY_HOME_PILOT__ !== 'undefined' && __GALLERY_HOME_PILOT__ === true;
const homeMeasurement = typeof __GALLERY_HOME_MEASUREMENT__ !== 'undefined' && __GALLERY_HOME_MEASUREMENT__ === true;
// Owner-controlled source only. No activation from URL, preferences or env flags.
export function galleryAnalytics(publicOrigin: string): GalleryAnalyticsOptions {
  const pilot = homePilot && !homeMeasurement, ongoing = homeMeasurement && !homePilot;
  return { enabled: false, production: publicOrigin === ANALYTICS_ORIGIN, beaconToken: pilot || ongoing ? HOME_PILOT_BINDING.publicBeaconToken : '',
    manualRegionalModeQualified: false, documentBoundaryQualified: false, withdrawalQualified: false,
    regionEligible: false, documentPath: '', ...(pilot ? { homePilot: HOME_PILOT_MODE } : {}),
    ...(ongoing ? { homeMeasurement: HOME_MEASUREMENT_MODE } : {}) };
}
export const ANALYTICS_OPEN_BUTTON = '<a class="measurement-privacy-link" href="#measurement-privacy">Privacy</a>';
export function analyticsMarkup(config: GalleryAnalyticsOptions): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const ongoing = config.homeMeasurement === HOME_MEASUREMENT_MODE && config.homePilot === undefined;
  return `<script type="application/json" id="analytics-config">${json}</script>`
    + '<details id="measurement-privacy"><summary>Privacy and measurement</summary>'
    + (ongoing
      ? '<p>We use Cloudflare Web Analytics to estimate usage and performance of the public Home page. Previews, collections, wallets and minting are not measured. Reports are estimates, not counts of unique people.</p>'
      : config.homePilot === HOME_PILOT_MODE
      ? '<p>Home-only measurement pilot. Routine audience measurement is not yet qualified. Exclude this browser and reload to prevent the next SDK load; a final public Home beacon may complete before reload.</p>'
      : config.enabled
      ? '<p>Statistical measurement is enabled only for qualified public pages and regions. This page may remain unmeasured because of its route, region, browser settings or referrer. Previews and functional browser storage work independently.</p>'
      : '<p>Browser audience measurement is off in this version. No analytics permission prompt is shown. Previews and functional browser storage work independently.</p>')
    + (ongoing
      ? '<p>Only the exact public Home page is measured, in eligible regions and browsers that are not excluded. Cloudflare receives network, browser and page-performance information. Other pages, restricted or unknown regions and unsafe referrers are unmeasured. Hosting security and service counters are separate.</p>'
      : '<p>When qualified and enabled, Cloudflare statistical measurement covers selected public pages, not handle previews, saved collections, wallet or mint flows. It receives network and browser information; reports are estimates, not unique people. Restricted or unknown regions are unmeasured. Hosting security and service counters are separate.</p>')
    + '<p>Your existing browser exclusion is preserved. Removing it does not start measurement in this document; after a reload or later visit, this browser can be measured when Home measurement is enabled. Old Google Analytics choices and historical reports are not reused as permission. Clearing browser storage also clears the exclusion.</p>'
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
