// Local reconstruction of the reviewed OFF candidate; no custom event sender.
export const ANALYTICS_ORIGIN = 'https://signatures.gallery';
export const ANALYTICS_EXCLUSION_KEY = 'signatures.analytics.excluded.v1';
export const ANALYTICS_MBTI_TYPES = Object.freeze(['ISTJ', 'ISFJ', 'INFJ', 'INTJ', 'ISTP', 'ISFP', 'INFP', 'INTP', 'ESTP', 'ESFP', 'ENFP', 'ENTP', 'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ'] as const);
export const ANALYTICS_PATHS: readonly string[] = Object.freeze(['/', '/about', '/explore', ...ANALYTICS_MBTI_TYPES.map(type => `/${type}/`)]);
export const CF_BEACON_SCRIPT = 'https://static.cloudflareinsights.com/beacon.min.js';
export const CF_BEACON_ENDPOINT = 'https://cloudflareinsights.com/cdn-cgi/rum';
export interface AnalyticsConfig {
  enabled: boolean;
  production: boolean;
  // REST site_token: public configuration, never site_tag or a reporting API key.
  beaconToken: string;
  manualRegionalModeQualified: boolean;
  documentBoundaryQualified: boolean;
  withdrawalQualified: boolean;
}
export function analyticsConfigured(config: AnalyticsConfig): boolean {
  return config?.enabled === true && config.production === true &&
    typeof config.beaconToken === 'string' && /^[a-f0-9]{32}$/.test(config.beaconToken) &&
    config.manualRegionalModeQualified === true &&
    config.documentBoundaryQualified === true && config.withdrawalQualified === true;
}
export function analyticsKnownAutomation(navigator: { webdriver?: unknown; userAgent?: unknown } = {}): boolean {
  return navigator.webdriver === true || /(?:HeadlessChrome|PhantomJS|Playwright|Puppeteer|Googlebot|bingbot|DuckDuckBot|Baiduspider|YandexBot|Applebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|PetalBot|Bytespider|GPTBot|ChatGPT-User|ClaudeBot|Claude-User|PerplexityBot|Perplexity-User|Amazonbot|OAI-SearchBot)/i.test(String(navigator.userAgent ?? ''));
}
// Native CF sees actual URLs/referrers. Coarse event labels cannot sanitize them.
export function analyticsUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === ANALYTICS_ORIGIN && !url.username && !url.password &&
      !value.includes('?') && !value.includes('#') && ANALYTICS_PATHS.includes(url.pathname);
  } catch { return false; }
}
export function analyticsReferrerAllowed(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    if (url.username || url.password || value.includes('?') || value.includes('#')) return false;
    return url.origin === ANALYTICS_ORIGIN ? analyticsUrlAllowed(value)
      : url.protocol === 'https:' && url.pathname === '/' && !url.port;
  } catch { return false; }
}
export function createAnalytics({ window: win, document: doc = win.document, config, onChange = () => {} }: {
  window: any; document?: any; config: AnalyticsConfig; onChange?: (state: any) => void;
}): any {
  if (win.__signaturesAnalyticsController) return win.__signaturesAnalyticsController;
  const settings = Object.freeze({ ...config });
  let started = false, blocked = false, writeFailed = false;
  function status() {
    let excluded = true, storageAvailable = false;
    try {
      const saved = win.localStorage.getItem(ANALYTICS_EXCLUSION_KEY);
      excluded = saved !== null && saved !== '0';
      storageAvailable = !writeFailed;
    } catch { /* Unknown exclusion means no measurement. */ }
    const allowed = !blocked && analyticsConfigured(settings) && storageAvailable && !excluded &&
      !analyticsKnownAutomation(win.navigator) && analyticsUrlAllowed(win.location.href) &&
      analyticsReferrerAllowed(doc.referrer);
    return { allowed, excluded, storageAvailable, started, reloadRequired: started && !allowed };
  }
  function refresh() {
    const state = status();
    if (state.allowed && !started) {
      started = true;
      const script = doc.createElement('script');
      script.type = 'module';
      script.defer = true;
      script.src = CF_BEACON_SCRIPT;
      script.referrerPolicy = 'no-referrer';
      script.setAttribute('data-cf-beacon', JSON.stringify({ token: settings.beaconToken, spa: false }));
      doc.head.append(script);
    }
    const next = status(); onChange(next); return next;
  }
  function preference(excluded: boolean) {
    // Script removal is not a stop API. No automatic reload of unsaved work.
    blocked = true;
    try {
      const value = excluded ? '1' : '0';
      win.localStorage.setItem(ANALYTICS_EXCLUSION_KEY, value);
      if (win.localStorage.getItem(ANALYTICS_EXCLUSION_KEY) !== value) throw new Error('Not saved');
    } catch { writeFailed = true; const next = status(); onChange(next); return next; }
    return refresh();
  }
  const controller = { status, refresh, exclude: () => preference(true), include: () => preference(false) };
  win.__signaturesAnalyticsController = controller;
  win.addEventListener('storage', (event: any) => {
    if (event.key === ANALYTICS_EXCLUSION_KEY || event.key === null) { blocked = true; refresh(); }
  });
  refresh();
  return controller;
}
