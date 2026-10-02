import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIR, loadPlan } from './pulse-sepolia.mjs';
import { createSepoliaGalleryCache } from './pulse-sepolia-cache.mjs';
import { homePage, mintPage, assessmentPage, previewPage, previewVariationsPage, mbtiGalleryPage, collectionPage, aboutPage, errorPage, OPEN_MINT_CSS } from '../src/openMint/pages.ts';
import { isMbti, preservedHandle } from '../src/openMint/identity.ts';
import { renderSignatureSvg } from '../src/algorithmV2/index.ts';
import { SITE_CSS } from '../src/v1/siteCss.ts';
import { SITE_FONT_CSS, siteFontAsset } from '../src/v1/fonts.ts';
import { FAVICON_URL, FAVICON_SVG } from '../src/brand/favicon.ts';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../src/brand/sloganMbtiHero.ts';
import { SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT } from '../src/brand/sloganTooltipScript.ts';
import { SEPOLIA_TEST_CLIENT } from './pulse-sepolia-client.mjs';

// A separate, explicitly read-only frontend for RPC outages. It never starts
// the mint backend, reads an authorizer/key/session/request database, or calls
// any RPC. An optional public-data cache is historical presentation only.
export async function startSepoliaFrontend({ port = 3004, collection, plan, cache } = {}) {
  plan ??= collection ? undefined : loadPlan(); collection ??= plan.collection.address;
  cache ??= plan ? createSepoliaGalleryCache(plan, DIR) : undefined;
  const history = cache?.presentation(), artworks = cache?.artworks() ?? new Map();
  if (history?.mints.size) { assert.ok(plan); assert.equal(collection.toLowerCase(), plan.collection.address.toLowerCase()); }
  const entries = [...(history?.mints.values() ?? [])].map(mint => ({ ...mint, code: '', mintObservationUnavailable: true,
    mintEvidenceInvalidated: history.invalidated, imageUrl: `/test-art/${mint.handle}.svg`, url: `/signatures/${mint.handle}`,
    mint: { state: mint.state, tokenId: mint.tokenId, transactionHash: mint.transactionHash } }));
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  assert.match(collection, /^0x[a-fA-F0-9]{40}$/);
  const origin = `http://127.0.0.1:${port}`;
  const unavailable = { code: 'OBSERVATION_UNAVAILABLE', error: 'Minting is temporarily unavailable. You can still explore previews.' };
  const options = { publicOrigin: origin, stylesheetUrl: '/assets/sepolia.css', clientScriptUrl: '/assets/sepolia.js',
    chainId: '11155111', chainName: 'Ethereum Sepolia', contract: collection, generativeArtwork: true, pulseMint: true,
    assessmentSource: 'sample', mintObservationNotice: 'Mint availability cannot be checked right now. Please try again shortly.' };
  const assets = new Map([
    ['/assets/sepolia.css', [SITE_FONT_CSS + SITE_CSS + OPEN_MINT_CSS, 'text/css']],
    ['/assets/sepolia.js', [SEPOLIA_TEST_CLIENT, 'text/javascript']], [FAVICON_URL, [FAVICON_SVG, 'image/svg+xml']],
    [SLOGAN_MBTI_HERO_SCRIPT_URL, [SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript']],
    [SLOGAN_TOOLTIP_SCRIPT_URL, [SLOGAN_TOOLTIP_SCRIPT, 'text/javascript']],
  ].map(([url, value]) => [new URL(url, origin).pathname, value]));
  const state = { live: true, galleryAvailable: !!history, mintReady: false, observerHealthy: false,
    galleryState: 'unavailable', mintState: 'unavailable',
    safetyHalted: cache?.state().safetyHalted === true };
  const galleryOptions = { ...options, galleryPending: !history, mintObservationManaged: true };
  const server = createServer((req, res) => {
    const send = (status, value, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type }); res.end(value); };
    const json = (status, value) => send(status, JSON.stringify(value), 'application/json');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      assert.equal(req.headers.host, new URL(origin).host); assert.ok((req.url?.length ?? 0) <= 2048);
      const url = new URL(req.url, origin), path = url.pathname;
      assert.equal(url.origin, origin);
      // Every API, including session/challenge/verify and saved submissions,
      // fails closed. This cannot obtain a signature or issue a mint voucher.
      if (path.startsWith('/api/')) return json(503, unavailable);
      if (req.method !== 'GET') return send(405, 'Method not allowed.', 'text/plain');
      const asset = assets.get(path), font = siteFontAsset(path);
      if (asset) return send(200, asset[0], asset[1]); if (font) return send(200, font.bytes, font.contentType);
      if (path === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /\n', 'text/plain');
      if (['/health', '/health/live', '/health/ready'].includes(path)) return json(path === '/health/ready' ? 503 : 200,
        { chainId: 11155111, collection, testOnly: true, frontendOnly: true, ...state });
      if (path === '/') return send(200, homePage(galleryOptions, entries));
      if (path === '/mint') return send(200, mintPage(url.searchParams.get('handle') ?? '', options));
      if (path === '/about') return send(200, aboutPage(options));
      if (path === '/me') return send(200, collectionPage([], galleryOptions));
      const group = /^\/([A-Z]{4})\/$/.exec(path);
      if (group && isMbti(group[1])) return send(200, mbtiGalleryPage(group[1], entries, galleryOptions));
      const artwork = /^\/test-art\/([a-z0-9_]{1,15})\.svg$/.exec(path);
      if (artwork) {
        const mint = history?.mints.get(artwork[1]), svg = mint && artworks.get(mint.transactionHash + ':' + mint.blockHash);
        if (!svg) return send(503, 'Artwork is temporarily unavailable.', 'text/plain');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); return send(200, svg, 'image/svg+xml');
      }
      const detail = /^\/signatures\/([a-z0-9_]{1,15})$/.exec(path);
      if (detail && history?.mints.has(detail[1])) {
        const mint = history.mints.get(detail[1]);
        return send(200, assessmentPage({ ...mint, code: '', status: 'ready', canMint: false,
          imageUrl: `/test-art/${mint.handle}.svg`, svgUrl: `/test-art/${mint.handle}.svg`,
          rendererIdentity: plan.renderer.identity, rendererVersion: 'sg-evm-renderer-1.0.0-rc.1',
          assessmentProvenance: 'development-fixture', assessmentModel: 'sepolia-controlled-fixture-v1',
          mintObservationUnavailable: true, mintEvidenceInvalidated: history.invalidated,
          mint: { state: mint.state, tokenId: mint.tokenId, transactionHash: mint.transactionHash } }, galleryOptions));
      }
      const image = /^\/preview\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})\.svg$/.exec(path);
      if (image && isMbti(image[2])) { res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); return send(200, renderSignatureSvg(image[1], image[2]), 'image/svg+xml'); }
      const preview = /^\/(p|s)\/([A-Za-z0-9_]{1,15})(?:\/(variations|[A-Za-z]{4}))?$/.exec(path);
      if (preview) {
        const handle = preservedHandle(preview[2]), suffix = preview[3] ?? 'variations';
        if (preview[1] === 's' || !preview[3]) { res.setHeader('Location', `/p/${handle}/${suffix}`); return send(308, ''); }
        return send(200, suffix === 'variations' ? previewVariationsPage(handle, options, { state: 'unavailable' }) : previewPage(handle, suffix.toUpperCase(), options, { state: 'unavailable' }));
      }
      if (path.startsWith('/signatures/')) return send(503, errorPage('The gallery is temporarily unavailable. Please try again shortly.', options));
      return send(404, errorPage('Page not found.', options));
    } catch { return send(400, errorPage('The request could not be completed.', options)); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  const close = () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  console.log(JSON.stringify({ origin, chainId: 11155111, collection, frontendOnly: true, mintingEnabled: false, signingKeysLoaded: false }));
  return { server, close, origin };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startSepoliaFrontend({ port: Number(process.env.PORT ?? 3004) }).then(({ close }) => {
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  }).catch(() => { console.error('Sepolia frontend could not start. Check the port and local deployment plan.'); process.exitCode = 1; });
}
