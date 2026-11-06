import { HOME_PILOT_BINDING, HOME_PILOT_MODE } from './homePilotBinding.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_PATHS, analyticsConfigured, type AnalyticsConfig } from './analytics.js';
import { analyticsCountryEligible, analyticsForRequest, analyticsHtmlHeaders, ANALYTICS_DENIED_COUNTRIES } from './analyticsRequest.js';
import * as markup from './analyticsMarkup.js';
import { handlePreviewRequest, previewContentSecurityPolicy } from './worker.js';

const origin = 'https://signatures.gallery';
// Inert, distinct synthetic fixtures. No native SDK/download/ingestion.
const qualified: AnalyticsConfig = { ...markup.galleryAnalytics(origin), enabled: true,
  beaconToken: 'a'.repeat(32), manualRegionalModeQualified: true,
  documentBoundaryQualified: true, withdrawalQualified: true };
function request(path = '/', country: unknown = 'US', headers: HeadersInit = {}, method = 'GET') {
  const value = new Request(origin + path, { headers, method });
  Object.defineProperty(value, 'cf', { value: { country } });
  return value;
}
afterEach(() => vi.restoreAllMocks());
describe('trusted country/request decision', () => {
  it('has the accepted exact 32 exclusions', () => {
    expect(new Set(ANALYTICS_DENIED_COUNTRIES).size).toBe(32);
  });
  it.each(ANALYTICS_DENIED_COUNTRIES)('excludes %s even with forged US headers', country => {
    const req = request('/', country, { 'CF-IPCountry': 'US', 'X-Country': 'US' });
    expect(analyticsCountryEligible(req)).toBe(false);
    expect(analyticsConfigured(analyticsForRequest(req, qualified))).toBe(false);
  });
  it.each([undefined, null, '', 'XX', 'T1', 'ZZ', 'XY', 'us', ' US', 'USA', 123, {}])('fails closed for missing/unknown country %j', country => {
    const req = new Request(origin); Object.defineProperty(req, 'cf', { value: { country } });
    expect(analyticsCountryEligible(req)).toBe(false);
  });
  it('does not accept client country headers without trusted metadata', () => {
    expect(analyticsCountryEligible(new Request(origin, { headers: { 'CF-IPCountry': 'US' } }))).toBe(false);
  });
  it.each(['US', 'CN', 'JP', 'AU', 'CA', 'HK'])('prepares allowed country %s without exposing it', country => {
    const config = analyticsForRequest(request('/', country), qualified);
    expect(config.regionEligible).toBe(true); expect(analyticsConfigured(config)).toBe(true);
    expect(JSON.stringify(config)).not.toContain(country);
  });
  it.each(ANALYTICS_PATHS)('binds the exact public document %s', path => {
    const config = analyticsForRequest(request(path), qualified);
    expect(config.documentPath).toBe(path); expect(config.regionEligible).toBe(true);
    expect(analyticsHtmlHeaders(config)['Referrer-Policy']).toBe('origin');
    expect(previewContentSecurityPolicy(false, config)).toContain('https://static.cloudflareinsights.com/beacon.min.js');
  });
  it.each(['/p/Alice/INTJ', '/p/Alice/variations', '/s/Alice', '/preview/Alice/INTJ.svg', '/me', '/mint',
    '/wallet', '/auth', '/admin', '/api', '/unknown', '/intj/', '/INTJ', '/about/', '/about?', '/about#secret',
    '/explore?handle=Alice', '/about?q=SECRET', '/assets/preview.js'])('closes route %s', path => {
    const config = analyticsForRequest(request(path), qualified);
    expect(config.regionEligible).toBe(false); expect(config.documentPath).toBe('');
    expect(analyticsHtmlHeaders(config)['Referrer-Policy']).toBe('no-referrer');
    expect(previewContentSecurityPolicy(false, config)).toContain("connect-src 'none'");
  });
  it.each([origin + '/mint', origin + '/p/Alice/INTJ', origin + '/about?secret=1',
    'https://external.invalid/private', 'http://external.invalid/'])('rejects unsafe request referrer %s', referer => {
    expect(analyticsForRequest(request('/', 'US', { Referer: referer }), qualified).regionEligible).toBe(false);
  });
  it.each(['', origin + '/about', 'https://external.invalid/'])('accepts conservative referrer %s', referer => {
    expect(analyticsForRequest(request('/', 'US', { Referer: referer }), qualified).regionEligible).toBe(true);
  });
  it('keeps staging and writes closed', () => {
    expect(analyticsForRequest(new Request('https://staging.signatures.gallery/'), qualified).regionEligible).toBe(false);
    expect(analyticsForRequest(request('/', 'US', {}, 'POST'), qualified).regionEligible).toBe(false);
  });
});
describe('actual Worker consistency and cache isolation', () => {
  const env = { PUBLIC_ORIGIN: origin, ASSETS: { fetch: vi.fn() } };
  const configOf = (html: string) => JSON.parse(/id="analytics-config">([^<]*)</.exec(html)![1]);
  it('real config stays OFF even when country is eligible', async () => {
    const res = await handlePreviewRequest(request(), env);
    const config = configOf(await res.text());
    expect(config.regionEligible).toBe(true); expect(config.enabled).toBe(false);
    expect(config.beaconToken).toBe(''); expect(config.documentBoundaryQualified).toBe(false);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
  });
  it('uses the same decision for config/CSP/referrer and prevents cross-country cached HTML', async () => {
    vi.spyOn(markup, 'galleryAnalytics').mockReturnValue(qualified);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
    for (const [path, country, eligible] of [['/', 'US', true], ['/', 'DE', false],
      ['/', 'US', true], ['/p/Alice/INTJ', 'US', false], ['/me', 'US', false],
      ['/explore?handle=bad-handle', 'US', false], ['/about', 'XX', false]] as const) {
      const res = await handlePreviewRequest(request(path, country), env);
      const config = configOf(await res.text());
      expect(config.regionEligible).toBe(eligible);
      expect(res.headers.get('referrer-policy')).toBe(eligible ? 'origin' : 'no-referrer');
      expect(res.headers.get('content-security-policy')!.includes('cloudflareinsights')).toBe(eligible);
      expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform');
      expect(res.headers.get('cdn-cache-control')).toBe('no-store');
      expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
      expect(res.headers.has('set-cookie')).toBe(false);
    }
    expect(network).not.toHaveBeenCalled();
  });
});


describe('real-binding Home-only pilot request scope', () => {
  const pilot: AnalyticsConfig = { ...markup.galleryAnalytics(origin), homePilot: HOME_PILOT_MODE, beaconToken: HOME_PILOT_BINDING.publicBeaconToken };
  it.each(ANALYTICS_DENIED_COUNTRIES)('fails closed for %s despite spoofed eligible headers', country => {
    expect(analyticsConfigured(analyticsForRequest(request('/',country,{'CF-IPCountry':'US'}),pilot))).toBe(false);
  });
  it.each([undefined, null, '', 'XX', 'T1', 'ZZ', 'us'])('fails closed for unknown %j', country => {
    const req = new Request(origin+'/'); Object.defineProperty(req, 'cf', { value: {country} });
    expect(analyticsConfigured(analyticsForRequest(req,pilot))).toBe(false);
  });
  it.each(['/about','/explore','/INTJ/','/mint','/me','/api','/p/Alice/INTJ','/?','/?secret=1','/#private'])('closes %s', path => {
    const cfg = analyticsForRequest(request(path),pilot);
    expect(cfg.regionEligible).toBe(false); expect(analyticsConfigured(cfg)).toBe(false);
  });
  it.each(['',origin+'/'])('allows exact Home with referrer %s', Referer => {
    const cfg = analyticsForRequest(request('/','US',{Referer}),pilot);
    expect(analyticsConfigured(cfg)).toBe(true);
    expect(analyticsHtmlHeaders(cfg)['Referrer-Policy']).toBe('origin');
    expect(JSON.stringify(cfg)).not.toContain('US');
  });
  it.each([origin+'/about','https://external.invalid/',origin+'/?',origin+'/#',origin+'/mint'])('rejects referrer %s', Referer => {
    expect(analyticsConfigured(analyticsForRequest(request('/','US',{Referer}),pilot))).toBe(false);
  });
});
