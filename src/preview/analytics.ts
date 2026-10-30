// Optional audience measurement, ported from AgentArt.work's consent module.
// Importing this module performs no browser work.
// Browser bundle: never import the renderer (it needs node:crypto). The test
// asserts this list equals the renderer's MBTI_TYPES.
export const ANALYTICS_MBTI_TYPES = Object.freeze(["ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP", "ESTP", "ESFP", "ENFP", "ENTP", "ESTJ", "ESFJ", "ENFJ", "ENTJ"] as const);
const MBTI_TYPES: readonly string[] = ANALYTICS_MBTI_TYPES;
export const ANALYTICS_ORIGIN = 'https://signatures.gallery';
export const ANALYTICS_PREFERENCE_KEY = 'signatures.analytics.preference.v1';
export const ANALYTICS_EXCLUSION_KEY = 'signatures.analytics.excluded.v1';
export const ANALYTICS_PROBE_KEY = 'signatures.analytics.storage-probe.v1';
export const ANALYTICS_CHANNEL = 'signatures.analytics.choice.v1';
export const ANALYTICS_COOKIE_PREFIX = 'signatures_analytics';
export const ANALYTICS_POLICY_VERSION = 1;
export const ANALYTICS_CHOICE_MS = 90 * 24 * 60 * 60 * 1000;

export interface AnalyticsCategory { readonly path: string; readonly title: string }
export interface AnalyticsConfig { enabled?: unknown; production?: unknown; measurementId?: unknown }
const category = (path: string, title: string): AnalyticsCategory => Object.freeze({ path, title });
const galleries = category('/galleries/', 'MBTI galleries');
// This is a closed list, not a rule that turns arbitrary URLs into event labels.
// Handles never leave the browser: every preview page reports one category.
export const ANALYTICS_ROUTES: Readonly<Record<string, AnalyticsCategory>> = Object.freeze({
  '/': category('/', 'Home'),
  '/about/': category('/about/', 'About'),
  '/explore/': category('/explore/', 'Explore'),
  ...Object.fromEntries(MBTI_TYPES.map(mbti => [`/${mbti}/`, galleries])),
});
export const ANALYTICS_PREVIEWS = category('/previews/', 'Previews');
const PREVIEW_PATH = /^\/p\/[A-Za-z0-9_]{1,15}\/([A-Za-z]+)\/$/;

export function parseAnalyticsPreference(raw: unknown, now = Date.now()): { choice: 'allow' | 'reject'; version: number; expiresAt: number } | null {
  try {
    const value = JSON.parse(raw as string);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'choice,expiresAt,version' ||
        value.version !== ANALYTICS_POLICY_VERSION || !['allow', 'reject'].includes(value.choice) ||
        !Number.isFinite(value.expiresAt) || value.expiresAt <= now ||
        value.expiresAt > now + ANALYTICS_CHOICE_MS) return null;
    return value;
  } catch { return null; }
}

export function analyticsScreen(value: string | URL): AnalyticsCategory | null {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.origin !== ANALYTICS_ORIGIN || url.username || url.password ||
        url.href.split('#')[0].includes('?')) return null;
    let path = url.pathname.replace(/\/index\.html$/, '/');
    if (!path.endsWith('/') && !path.endsWith('.html')) path += '/';
    if (Object.hasOwn(ANALYTICS_ROUTES, path)) return ANALYTICS_ROUTES[path];
    const suffix = PREVIEW_PATH.exec(path)?.[1];
    return suffix === 'variations' || MBTI_TYPES.includes(suffix ?? '') ? ANALYTICS_PREVIEWS : null;
  } catch { return null; }
}

export function analyticsEnvironmentAllowed(config: AnalyticsConfig | undefined, value: string | URL, webdriver = false): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return config?.enabled === true && config?.production === true && webdriver === false &&
      url.origin === ANALYTICS_ORIGIN && !url.username && !url.password &&
      typeof config.measurementId === 'string' && /^G-[A-Z0-9]{6,20}$/.test(config.measurementId) &&
      !config.measurementId.includes('TEST');
  } catch { return false; }
}

export function analyticsKnownAutomation(navigator: { webdriver?: unknown; userAgent?: unknown } = {}): boolean {
  // A local exclusion hint, not proof that every other browser is human.
  // This value is never placed in our event payloads.
  return navigator.webdriver === true || /(?:HeadlessChrome|PhantomJS|Playwright|Puppeteer|Googlebot|bingbot|DuckDuckBot|Baiduspider|YandexBot|Applebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|PetalBot|Bytespider|GPTBot|ChatGPT-User|ClaudeBot|Claude-User|PerplexityBot|Perplexity-User|Amazonbot|OAI-SearchBot)/i.test(String(navigator.userAgent ?? ''));
}

export function analyticsContext(screen: AnalyticsCategory) {
  return {
    page_location: `${ANALYTICS_ORIGIN}${screen.path}`, page_title: screen.title,
    page_referrer: '', campaign_id: '', campaign_source: '', campaign_medium: '',
    campaign_name: '', campaign_term: '', campaign_content: '',
  };
}

/**
 * Basic consent: no Google script or request before verified permission.
 * Config comes from the build, never a URL, browser preference or document text.
 * Local tests substitute window/document; no dependency or remote SDK is needed.
 */
// The browser and offline fixtures share this loose shape.
export function createAnalytics({ window: win, document: doc = win.document, config = {}, onChange = () => {} }: { window: any; document?: any; config?: AnalyticsConfig; onChange?: (status: any) => void }): any {
  if (win.__signaturesAnalyticsController) return win.__signaturesAnalyticsController;
  const settings = Object.freeze({ enabled: config.enabled, production: config.production, measurementId: config.measurementId });
  const id = typeof settings.measurementId === 'string' ? settings.measurementId : '';
  const disableKey = id ? `ga-disable-${id}` : null;
  const now = () => win.Date?.now() ?? Date.now();
  let started = false, blocked = false, destroyed = false, storageAvailable = true, writeFailed = false;
  let script: any, expiryTimer: any, channel: any, lastRoute = '', generation = 0, lastNotification = '';
  const removers: Array<() => void> = [];

  function disable() { if (disableKey) win[disableKey] = true; }
  disable();

  function clearCookies() {
    // Only this integration's host-only/path=/ cookie scope, never work storage.
    try {
      for (const entry of doc.cookie.split(';')) {
        const name = entry.trim().split('=')[0];
        if (name === `${ANALYTICS_COOKIE_PREFIX}_ga` || name.startsWith(`${ANALYTICS_COOKIE_PREFIX}_ga_`)) {
          doc.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
        }
      }
    } catch { /* Cookie access can be unavailable independently of localStorage. */ }
  }

  function stop() {
    disable(); // This precedes queue cleanup; do not send a denied-consent ping.
    if (started) blocked = true;
    generation += 1;
    win.clearTimeout(expiryTimer);
    if (win.signaturesAnalyticsLayer) win.signaturesAnalyticsLayer.length = 0;
    script?.remove();
    clearCookies();
    lastRoute = '';
  }

  function readState() {
    try {
      // A stale reader must never write an old allowance over a newer refusal.
      // Probe before reading consent; the separate probe generates no feedback.
      win.localStorage.setItem(ANALYTICS_PROBE_KEY, '1');
      win.localStorage.removeItem(ANALYTICS_PROBE_KEY);
      const preference = parseAnalyticsPreference(win.localStorage.getItem(ANALYTICS_PREFERENCE_KEY), now());
      const exclusion = win.localStorage.getItem(ANALYTICS_EXCLUSION_KEY);
      storageAvailable = !writeFailed;
      return storageAvailable ? { preference, excluded: exclusion !== null && exclusion !== '0' } : { preference: null, excluded: true };
    } catch {
      storageAvailable = false;
      stop();
      return { preference: null, excluded: true };
    }
  }

  function inspect() {
    const state = readState();
    const screen = analyticsScreen(win.location.href);
    const environment = analyticsEnvironmentAllowed(settings, win.location.href, analyticsKnownAutomation(win.navigator));
    const eligible = environment && Boolean(screen) && !destroyed;
    const allowed = eligible && storageAvailable && !state.excluded && state.preference?.choice === 'allow' && !blocked;
    if (!allowed) stop();
    const reason = destroyed ? 'destroyed' : !environment ? 'environment-disabled' : !screen ? 'page-excluded' :
      !storageAvailable ? 'storage-unavailable' : state.excluded ? 'browser-excluded' : blocked ? 'reload-required' :
        state.preference?.choice === 'allow' ? 'allowed' : state.preference?.choice === 'reject' ? 'rejected' : 'choice-required';
    return {
      state, screen,
      status: { allowed, eligible, choice: state.preference?.choice ?? 'unknown', excluded: state.excluded,
        storageAvailable, reason, reloadRequired: blocked && !destroyed },
    };
  }

  function notify(status: Record<string, unknown>) {
    const serialized = JSON.stringify(status);
    if (serialized !== lastNotification) {
      lastNotification = serialized;
      onChange({ ...status });
    }
    return status;
  }

  function broadcastStop() {
    try { channel?.postMessage('stop'); } catch { /* Storage events remain the fallback. */ }
  }

  function persist(key: string, value: string, revoke = false) {
    try {
      win.localStorage.setItem(key, value);
      if (win.localStorage.getItem(key) !== value) throw new Error('Preference was not stored');
      return true;
    } catch {
      storageAvailable = false;
      writeFailed = true;
      blocked = true;
      stop();
      broadcastStop();
      if (revoke) {
        // A write may fail while deletion still works. Remove only our old
        // allowance so a later document cannot silently reuse it. If removal
        // also fails, storageAvailable remains false: durability is unknown.
        try { win.localStorage.removeItem(ANALYTICS_PREFERENCE_KEY); } catch { /* Best effort only. */ }
      }
      return false;
    }
  }

  function command(..._args: unknown[]) {
    // The native gtag queue consumes Arguments objects.
    win.signaturesAnalyticsLayer.push(arguments);
  }

  function refresh(): any {
    const { state, screen, status } = inspect();
    if (!status.allowed) return notify(status);
    win.clearTimeout(expiryTimer);
    expiryTimer = win.setTimeout(refresh, Math.min(state.preference!.expiresAt - now(), 2_147_483_647));
    // Allowed implies an approved screen and a valid measurement ID.
    const context = analyticsContext(screen!);
    if (!started) {
      started = true;
      win[disableKey!] = false;
      win.signaturesAnalyticsLayer = [];
      command('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied',
        ad_user_data: 'denied', ad_personalization: 'denied' });
      const privacy = { ...context, send_page_view: false, allow_google_signals: false,
        allow_ad_personalization_signals: false, allow_enhanced_conversions: false,
        ads_data_redaction: true, url_passthrough: false, user_id: null,
        linker: { domains: [], accept_incoming: false, decorate_forms: false } };
      command('set', privacy);
      command('js', new Date(now()));
      command('config', id, { ...privacy, cookie_domain: 'none', cookie_path: '/',
        cookie_prefix: ANALYTICS_COOKIE_PREFIX, cookie_expires: ANALYTICS_CHOICE_MS / 1000,
        cookie_update: false, cookie_flags: 'SameSite=Lax;Secure' });
      script = doc.createElement('script');
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.src = `https://www.googletagmanager.com/gtag/js?id=${id}&l=signaturesAnalyticsLayer`;
      const loadGeneration = generation;
      script.onload = () => { if (loadGeneration !== generation || destroyed || blocked) stop(); else refresh(); };
      script.onerror = () => { stop(); notify(inspect().status); };
      doc.head.append(script);
    }
    if (win.location.pathname !== lastRoute) {
      // Keep native engagement/session handling on the sanitized category context.
      // No pre-consent backlog, synthetic engagement or custom click events.
      command('config', id, { ...context, update: true, send_page_view: false });
      command('set', context);
      command('event', 'page_view', { ...context, send_to: id });
      lastRoute = win.location.pathname;
    }
    return notify(status);
  }

  function saveChoice(choice: 'allow' | 'reject') {
    return persist(ANALYTICS_PREFERENCE_KEY, JSON.stringify({ choice, version: ANALYTICS_POLICY_VERSION, expiresAt: now() + ANALYTICS_CHOICE_MS }), choice === 'reject');
  }

  const controller: any = {
    status: () => inspect().status,
    allow() {
      if (destroyed) return controller.status();
      const current = controller.status();
      if (current.eligible && current.storageAvailable && !current.excluded) saveChoice('allow');
      return refresh();
    },
    reject() {
      if (destroyed) return controller.status();
      stop(); broadcastStop(); saveChoice('reject'); return refresh();
    },
    exclude() {
      if (destroyed) return controller.status();
      stop(); broadcastStop(); persist(ANALYTICS_EXCLUSION_KEY, '1', true); return refresh();
    },
    include() {
      if (destroyed) return controller.status();
      // Removing an exclusion is not itself a new analytics grant.
      stop(); broadcastStop();
      if (saveChoice('reject')) persist(ANALYTICS_EXCLUSION_KEY, '0');
      return refresh();
    },
    refresh,
    destroy() {
      if (!destroyed) {
        destroyed = true;
        stop();
        for (const remove of removers) remove();
        channel?.close();
      }
      return notify(inspect().status);
    },
  };
  win.__signaturesAnalyticsController = controller;

  function listen(target: any, event: string, handler: (event: any) => void) {
    target.addEventListener(event, handler);
    removers.push(() => target.removeEventListener(event, handler));
  }
  try {
    channel = new win.BroadcastChannel(ANALYTICS_CHANNEL);
    listen(channel, 'message', event => {
      if (event.data === 'stop') { blocked = true; stop(); notify(inspect().status); }
    });
  } catch { /* Storage events also synchronize tabs. */ }
  listen(win, 'storage', event => {
    if (event.key === null || [ANALYTICS_PREFERENCE_KEY, ANALYTICS_EXCLUSION_KEY].includes(event.key)) {
      // Clear/delete/invalid/refused events revoke even if a newer event races us.
      if (event.key === null || (event.key === ANALYTICS_PREFERENCE_KEY &&
          parseAnalyticsPreference(event.newValue, now())?.choice !== 'allow') ||
          (event.key === ANALYTICS_EXCLUSION_KEY && event.newValue !== '0')) stop();
      refresh();
    }
  });
  for (const name of ['pushState', 'replaceState']) {
    const original = win.history[name];
    const replacement = function (data: any, unused: any, value: any) {
      if (value != null && !analyticsScreen(new URL(String(value), win.location.href))) stop();
      const result = original.call(win.history, data, unused, value);
      refresh();
      return result;
    };
    win.history[name] = replacement;
    removers.push(() => { if (win.history[name] === replacement) win.history[name] = original; });
  }
  for (const event of ['popstate', 'hashchange', 'pageshow', 'focus']) listen(win, event, refresh);
  listen(doc, 'visibilitychange', refresh);
  refresh();
  return controller;
}
