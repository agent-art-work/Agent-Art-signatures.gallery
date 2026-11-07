import { HOME_PILOT_BINDING, HOME_PILOT_MODE, HOME_MEASUREMENT_MODE } from './homePilotBinding.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAnalytics, analyticsConfigured, analyticsUrlAllowed, analyticsReferrerAllowed,
  ANALYTICS_EXCLUSION_KEY, ANALYTICS_PATHS, ANALYTICS_MBTI_TYPES, CF_BEACON_SCRIPT, CF_BEACON_ENDPOINT, type AnalyticsConfig } from './analytics.js';
import { galleryAnalytics, analyticsMarkup } from './analyticsMarkup.js';
import { bindAnalytics } from './analyticsUi.js';
import { previewContentSecurityPolicy } from './worker.js';
import { MBTI_TYPES } from '../openMint/identity.js';
const origin = 'https://signatures.gallery';
const site = { site_token: 'a'.repeat(32), site_tag: 'b'.repeat(32) };
const qualified: AnalyticsConfig = { enabled: true, production: true, beaconToken: site.site_token,
  manualRegionalModeQualified: true, documentBoundaryQualified: true, withdrawalQualified: true,
  regionEligible: true, documentPath: '/' };
// Offline DOM only. Appended scripts are recorded, never downloaded/executed.
function fixture(config: AnalyticsConfig = qualified) {
  const data = new Map([['work', 'KEEP'], ['auth', 'KEEP'], ['signatures.analytics.preference.v1', '{"choice":"allow"}']]);
  const scripts: any[] = [], writes: string[] = [], listeners: Record<string, (event: any) => void> = {};
  let failure = '';
  const controls = [{ hidden: true, dataset: { analyticsAction: 'exclude' } }, { hidden: true, dataset: { analyticsAction: 'include' } }];
  const message = { textContent: '' };
  const doc: any = { referrer: '', head: { append: (s: any) => scripts.push(s) },
    createElement: () => ({ attributes: {} as Record<string,string>, setAttribute(k: string, v: string) { this.attributes[k] = v; } }),
    getElementById: (id: string) => id === 'analytics-config' ? { textContent: JSON.stringify(config) }
      : id === 'analytics-status' ? message : id === 'measurement-privacy' ? {} : null,
    querySelectorAll: () => controls,
    addEventListener: (n: string, f: any) => { listeners['doc-' + n] = f; } };
  const win: any = { document: doc, location: { href: origin + '/' }, navigator: { webdriver: false, userAgent: 'Mozilla/5.0' },
    addEventListener: (n: string, f: any) => { listeners[n] = f; },
    localStorage: {
      getItem: (k: string) => { if (failure === 'read') throw Error('blocked'); return data.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (failure === 'write') throw Error('blocked'); writes.push(k); if (failure !== 'silent') data.set(k,v); },
    } };
  return { doc, win, data, writes, scripts, controls, message, listeners,
    fail: (mode: string) => { failure = mode; }, start: () => createAnalytics({ window: win, config }) };
}
describe('reconstructed analytics-OFF candidate — offline fixtures', () => {
  it('matches the locked MBTI list and keeps every actual build disabled', () => {
    expect(ANALYTICS_MBTI_TYPES).toEqual(MBTI_TYPES);
    for (const host of [origin, 'https://staging.signatures.gallery', 'http://localhost:3008', 'https://test.pages.dev', 'https://test.workers.dev']) {
      const cfg = galleryAnalytics(host); expect(analyticsConfigured(cfg)).toBe(false);
      expect(cfg.beaconToken).toBe(''); const f = fixture(cfg); f.start();
      expect(f.scripts).toEqual([]); expect(f.writes).toEqual([]);
    }
  });
  it.each(['enabled','production','manualRegionalModeQualified','documentBoundaryQualified','withdrawalQualified'] as const)('requires strict %s qualification', key => {
    for (const value of [false, undefined, 'true', 1]) {
      const f = fixture({ ...qualified, [key]: value } as AnalyticsConfig); f.start(); expect(f.scripts).toEqual([]);
    }
  });
  it.each(['','bad','G-LEGACY','https://tracker.invalid','<script>','a'.repeat(33)])('rejects malformed beaconToken %s', beaconToken => {
    const f=fixture({...qualified,beaconToken}); f.start(); expect(f.scripts).toEqual([]);
  });
  it.each(ANALYTICS_PATHS)('allows only exact reviewed path %s', path => {
    expect(analyticsUrlAllowed(origin+path)).toBe(true);
  });
  it.each(['/p/Alice/INFP','/p/Alice/variations','/s/Alice','/me','/mint','/api/mint','/auth','/admin',
    '/assets/preview.svg','/Alice','/about/','/about?','/about#','/about?wallet=SECRET','/explore?handle=Alice',
    '/about#private','/%61bout','/INTP/?q=1','/unknown'])('never appends collector on %s', path => {
    const f=fixture(); f.win.location.href=origin+path; f.start(); expect(f.scripts).toEqual([]);
  });
  it.each(['https://staging.signatures.gallery/','https://signatures.gallery.evil.invalid/','http://signatures.gallery/',
    'http://localhost:3008/','https://u:p@signatures.gallery/','https://test.pages.dev/','https://test.workers.dev/'])('rejects nonproduction URL %s', url => {
    const f=fixture(); f.win.location.href=url; f.start(); expect(f.scripts).toEqual([]);
  });
  it.each([origin+'/p/Alice/INFP',origin+'/mint',origin+'/me',origin+'/about?private=1','https://other.invalid/private',
    'https://other.invalid/?q=1','https://other.invalid/#secret','http://other.invalid/','bad','https://u:p@other.invalid/'])('rejects unsafe actual referrer %s', value => {
    expect(analyticsReferrerAllowed(value)).toBe(false);
    const f=fixture(); f.doc.referrer=value; f.start(); expect(f.scripts).toEqual([]);
  });
  it.each(['',origin+'/',origin+'/about','https://other.invalid/'])('accepts conservative referrer %s', value => {
    expect(analyticsReferrerAllowed(value)).toBe(true);
  });
  it.each(['HeadlessChrome','Playwright','GPTBot','ChatGPT-User','ClaudeBot','PerplexityBot','Googlebot'])('excludes known automation %s', userAgent => {
    const f=fixture(); f.win.navigator.userAgent=userAgent; f.start(); expect(f.scripts).toEqual([]);
  });
  it('excludes webdriver, unreadable preference and unrecognized excluded values', () => {
    const f=fixture(); f.win.navigator.webdriver=true; f.start(); expect(f.scripts).toEqual([]);
    const blocked=fixture(); blocked.fail('read'); expect(blocked.start().status().allowed).toBe(false); expect(blocked.scripts).toEqual([]);
    for(const value of ['1','true','unknown']) { const f=fixture(); f.data.set(ANALYTICS_EXCLUSION_KEY,value); f.start(); expect(f.scripts).toEqual([]); expect(f.data.get(ANALYTICS_EXCLUSION_KEY)).toBe(value); }
  });
  it('maps public site_token to native token, never the distinct reporting site_tag', () => {
    const f=fixture(); const c=f.start(); c.refresh(); f.start(); expect(f.scripts).toHaveLength(1);
    const script=f.scripts[0]; expect(script.src).toBe(CF_BEACON_SCRIPT); expect(script.type).toBe('module');
    expect(script.referrerPolicy).toBe('no-referrer'); expect(site.site_token).not.toBe(site.site_tag);
    expect(JSON.parse(script.attributes['data-cf-beacon'])).toEqual({ token: site.site_token, spa: false });
    expect(script.attributes['data-cf-beacon']).not.toContain(site.site_tag); expect(f.writes).toEqual([]);
    const missing=fixture({...qualified,beaconToken:'',siteTag:site.site_tag} as AnalyticsConfig);
    missing.start(); expect(missing.scripts).toEqual([]);
    expect(analyticsMarkup(galleryAnalytics(origin))).not.toMatch(/siteTag|site_tag|reportingSiteTag/);
  });
  it('preserves saved work/auth/history choices; only explicit exclusion writes the old boolean', () => {
    const f=fixture(galleryAnalytics(origin)); const c=f.start(); c.exclude(); c.include(); c.refresh();
    expect(f.writes).toEqual([ANALYTICS_EXCLUSION_KEY,ANALYTICS_EXCLUSION_KEY]);
    expect(f.data.get('work')).toBe('KEEP'); expect(f.data.get('auth')).toBe('KEEP');
    expect(f.data.get('signatures.analytics.preference.v1')).toBe('{"choice":"allow"}'); expect(f.scripts).toEqual([]);
  });
  it.each(['write','silent'])('keeps collection blocked if exclusion write fails: %s', mode => {
    const f=fixture(galleryAnalytics(origin)); const c=f.start(); f.fail(mode);
    expect(c.exclude().storageAvailable).toBe(false); expect(c.status().allowed).toBe(false);
    expect(f.data.get('work')).toBe('KEEP'); expect(f.scripts).toEqual([]);
  });
  it('never claims removal stops installed handlers or reloads unsaved work automatically', () => {
    const f=fixture(); const c=f.start(); c.exclude(); expect(c.status().reloadRequired).toBe(true);
    c.include(); expect(c.status().allowed).toBe(false); expect(f.scripts).toHaveLength(1);
    expect(f.win.location.reload).toBeUndefined(); expect(f.win.history).toBeUndefined();
  });
  it('blocks reactivation after a cross-tab preference change', () => {
    const f=fixture(); const c=f.start(); f.data.set(ANALYTICS_EXCLUSION_KEY,'1');
    f.listeners.storage({key:ANALYTICS_EXCLUSION_KEY}); expect(c.status().reloadRequired).toBe(true);
    f.data.set(ANALYTICS_EXCLUSION_KEY,'0'); f.listeners.storage({key:ANALYTICS_EXCLUSION_KEY});
    expect(c.status().allowed).toBe(false); expect(f.scripts).toHaveLength(1);
  });
  it.each(['pagehide','popstate','hashchange'])('blocks reuse after %s without pretending to stop vendor handlers', name => {
    const f=fixture(); const c=f.start(); f.listeners[name]({});
    expect(c.status().allowed).toBe(false); expect(c.status().reloadRequired).toBe(true);
    c.refresh(); expect(f.scripts).toHaveLength(1);
  });
  it('does not restart a restored BFCache document', () => {
    const f=fixture(); const c=f.start(); f.listeners.pageshow({persisted:true});
    expect(c.status().allowed).toBe(false); expect(f.scripts).toHaveLength(1);
  });
  it('requires the trusted coarse bit and matching document path independently of qualification flags', () => {
    for (const config of [{...qualified,regionEligible:false}, {...qualified,documentPath:'/about'}]) {
      const f=fixture(config); f.start(); expect(f.scripts).toEqual([]);
    }
  });
  it('renders quiet functional Privacy/exclusion controls, not consent UI', () => {
    const html=analyticsMarkup(galleryAnalytics(origin));
    expect(html).toContain('<details id="measurement-privacy">');
    expect(html).not.toMatch(/<dialog|<aside|Allow analytics|Reject analytics|googletagmanager|G-QBCNPY7QK1/);
    const f=fixture(galleryAnalytics(origin)); bindAnalytics(f.doc,f.win);
    expect(f.message.textContent).toContain('measurement is off'); expect(f.controls[0].hidden).toBe(false);
    f.listeners['doc-click']({target:{closest:()=>f.controls[0]}});
    expect(f.data.get(ANALYTICS_EXCLUSION_KEY)).toBe('1'); expect(f.controls[1].hidden).toBe(false);
    expect(f.scripts).toEqual([]);
  });
  it('keeps malformed config off and JSON inert', () => {
    expect(analyticsMarkup({...qualified,beaconToken:'</script><script>BAD</script>'})).not.toContain('</script><script>BAD');
    const f=fixture(); const get=f.doc.getElementById;
    f.doc.getElementById=(id:string)=>id==='analytics-config'?{textContent:'{bad'}:get(id);
    bindAnalytics(f.doc,f.win); expect(f.scripts).toEqual([]);
  });
  it('preserves closed default CSP; exact native endpoints only after mocked qualification', () => {
    const off=previewContentSecurityPolicy(false); expect(off).toContain("connect-src 'none'");
    expect(off).not.toMatch(/google|cloudflareinsights/); expect(previewContentSecurityPolicy(true,qualified)).toBe(off);
    const on=previewContentSecurityPolicy(false,qualified); expect(on).toContain(CF_BEACON_SCRIPT); expect(on).toContain(CF_BEACON_ENDPOINT);
    expect(on).not.toContain('*'); expect(on).toContain("img-src 'self'");
    expect(on).not.toContain('google');
  });
  it('contains no Google loader, custom collector/cookie writer or new visitor identity', () => {
    const source=readFileSync(new URL('./analytics.ts',import.meta.url),'utf8');
    expect(source).not.toMatch(/googletagmanager|google-analytics|signaturesAnalyticsLayer|fetch\(|sendBeacon\(|doc\.cookie|randomUUID|Math\.random/);
  });
});


describe.each([
  { purpose: 'pilot', selection: { homePilot: HOME_PILOT_MODE }, marker: 'homePilot' },
  { purpose: 'ongoing statistics', selection: { homeMeasurement: HOME_MEASUREMENT_MODE }, marker: 'homeMeasurement' },
] as const)('real-binding Home-only $purpose controller (offline DOM only)', ({ selection, marker }) => {
  const pilot: AnalyticsConfig = { ...galleryAnalytics(origin), ...selection,
    beaconToken: HOME_PILOT_BINDING.publicBeaconToken, regionEligible: true, documentPath: '/' };
  it('loads only the exact binding without claiming broad qualification', () => {
    expect(analyticsConfigured(pilot)).toBe(true);
    expect(pilot.enabled).toBe(false);
    for (const k of ['manualRegionalModeQualified','documentBoundaryQualified','withdrawalQualified'] as const) {
      expect(pilot[k]).toBe(false);
      expect(analyticsConfigured({ ...pilot, [k]: true })).toBe(false);
    }
    for (const config of [{ ...pilot, [marker]: false }, { ...pilot, [marker]: undefined },
      { ...pilot, beaconToken: 'a'.repeat(32) }, { ...pilot, beaconToken: 'b'.repeat(32) }, { ...pilot, enabled: true }, { ...qualified, ...selection },
      { ...pilot, homePilot: HOME_PILOT_MODE, homeMeasurement: HOME_MEASUREMENT_MODE }]) {
      expect(analyticsConfigured(config as AnalyticsConfig)).toBe(false);
    }
    const f = fixture(pilot); f.start();
    expect(f.scripts).toHaveLength(1);
    expect(JSON.parse(f.scripts[0].attributes['data-cf-beacon'])).toEqual({ token: HOME_PILOT_BINDING.publicBeaconToken, spa: false });
    expect(f.writes).toEqual([]);
  });
  it.each(['/about', '/explore', ...ANALYTICS_MBTI_TYPES.map(t => `/${t}/`), '/p/Alice/INTJ', '/mint', '/me',
    '/api', '/preview/Alice/INTJ.svg', '/?', '/#', '/?private=1', '/#private'])('does not load on %s', path => {
    const f = fixture(pilot); f.win.location.href = origin + path; f.start(); expect(f.scripts).toEqual([]);
  });
  it.each([origin+'/about', 'https://other.invalid/', origin+'/?', origin+'/#', origin+'/p/Alice/INTJ'])('closes referrer %s', referrer => {
    const f = fixture(pilot); f.doc.referrer = referrer; f.start(); expect(f.scripts).toEqual([]);
  });
  it.each(['', origin+'/'])('accepts only blank or literal Home referrer %s', referrer => {
    const f = fixture(pilot); f.doc.referrer = referrer; f.start(); expect(f.scripts).toHaveLength(1);
  });
  it('preserves exclusion, work and lifecycle reload semantics', () => {
    const f = fixture(pilot); const c = f.start(); c.exclude();
    expect(c.status()).toMatchObject({ allowed: false, reloadRequired: true });
    expect(f.data.get('work')).toBe('KEEP'); expect(f.data.get('auth')).toBe('KEEP');
    expect(f.writes).toEqual([ANALYTICS_EXCLUSION_KEY]); expect(f.scripts).toHaveLength(1);
    const next = fixture(pilot); next.data.set(ANALYTICS_EXCLUSION_KEY,'1'); next.start(); expect(next.scripts).toEqual([]);
    const life = fixture(pilot); const lc = life.start(); life.listeners.pagehide({}); life.listeners.pageshow({ persisted: true });
    expect(lc.status()).toMatchObject({ allowed: false, reloadRequired: true }); expect(life.scripts).toHaveLength(1);
    const bot = fixture(pilot); bot.win.navigator.webdriver = true; bot.start(); expect(bot.scripts).toEqual([]);
    const unreadable = fixture(pilot); unreadable.fail('read'); unreadable.start(); expect(unreadable.scripts).toEqual([]);
  });
  it('removing exclusion requires a later document and never changes saved work or broad flags', () => {
    const f = fixture(pilot); f.data.set(ANALYTICS_EXCLUSION_KEY,'1'); const c = f.start();
    expect(f.scripts).toEqual([]); c.include(); c.refresh();
    expect(c.status().allowed).toBe(false); expect(f.scripts).toEqual([]);
    expect(f.data.get(ANALYTICS_EXCLUSION_KEY)).toBe('0');
    expect(f.data.get('work')).toBe('KEEP'); expect(f.data.get('auth')).toBe('KEEP');
    const next = fixture(pilot); next.data.set(ANALYTICS_EXCLUSION_KEY, f.data.get(ANALYTICS_EXCLUSION_KEY)!);
    next.start(); expect(next.scripts).toHaveLength(1);
    expect(pilot.manualRegionalModeQualified).toBe(false); expect(pilot.documentBoundaryQualified).toBe(false);
    expect(pilot.withdrawalQualified).toBe(false);
  });
});

it('uses accurate ongoing Home purpose, status and reload copy without pilot or identifier promises', () => {
  const ongoing: AnalyticsConfig = { ...galleryAnalytics(origin), homeMeasurement: HOME_MEASUREMENT_MODE,
    beaconToken: HOME_PILOT_BINDING.publicBeaconToken, regionEligible: true, documentPath: '/' };
  const html = analyticsMarkup(ongoing);
  expect(html).toContain('estimate usage and performance of the public Home page');
  expect(html).toContain('after a reload or later visit');
  expect(html).not.toMatch(/measurement pilot|Routine audience measurement is not yet qualified|Allow analytics|<dialog/);
  const f = fixture(ongoing); bindAnalytics(f.doc, f.win);
  expect(f.message.textContent).toContain('Home-page measurement was requested');
  expect(f.scripts).toHaveLength(1);
  const off = fixture(galleryAnalytics(origin)); bindAnalytics(off.doc, off.win);
  expect(off.message.textContent).toBe('Browser measurement is off.');
});
