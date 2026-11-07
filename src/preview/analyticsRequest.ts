import { analyticsConfigured, analyticsReferrerAllowed, analyticsUrlAllowed, homeOnlyScopeSelected, homeOnlyUrlAllowed, homeOnlyReferrerAllowed, type AnalyticsConfig } from './analytics.js';

// Accepted 32-country policy, including EEA, UK and Switzerland.
export const ANALYTICS_DENIED_COUNTRIES = Object.freeze('AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE CH GB'.split(' '));
// Recognized ISO 3166-1 alpha-2 codes. Special CF values (XX/T1), missing,
// malformed and unrecognized values fail closed; headers never supply country.
const countries = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
export function analyticsCountryEligible(request: Request): boolean {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof country === 'string' && countries.has(country) && !ANALYTICS_DENIED_COUNTRIES.includes(country);
}

/** One request decision for HTML config and headers. No country is serialized. */
export function analyticsForRequest(request: Request, config: AnalyticsConfig): AnalyticsConfig {
  const allowed = (request.method === 'GET' || request.method === 'HEAD') &&
    analyticsUrlAllowed(request.url) && analyticsReferrerAllowed(request.headers.get('Referer') ?? '') &&
    analyticsCountryEligible(request);
  const scoped = allowed && (!homeOnlyScopeSelected(config) ||
    homeOnlyUrlAllowed(request.url) && homeOnlyReferrerAllowed(request.headers.get('Referer') ?? ''));
  return { ...config, regionEligible: scoped, documentPath: scoped ? new URL(request.url).pathname : '' };
}

export function analyticsHtmlHeaders(config: AnalyticsConfig): Record<string, string> {
  return {
    // Do not rely on Vary: CF-IPCountry; it is not a safe shared-cache key.
    'Cache-Control': 'private, no-store, no-transform',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Referrer-Policy': analyticsConfigured(config) ? 'origin' : 'no-referrer',
  };
}
