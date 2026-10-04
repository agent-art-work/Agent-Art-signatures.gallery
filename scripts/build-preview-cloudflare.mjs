import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as fonts from '../src/v1/fonts.ts';
import { SITE_CSS } from '../src/v1/siteCss.ts';
import { OPEN_MINT_CSS } from '../src/openMint/pages.ts';
import { FAVICON_CSP, FAVICON_SVG, FAVICON_URL } from '../src/brand/favicon.ts';
import { SLOGAN_MBTI_HERO_SCRIPT, SLOGAN_MBTI_HERO_SCRIPT_URL } from '../src/brand/sloganMbtiHero.ts';
import { SLOGAN_TOOLTIP_SCRIPT, SLOGAN_TOOLTIP_SCRIPT_URL } from '../src/brand/sloganTooltipScript.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const accountId = 'a54e5847cc16e612aa3ad45a5dadb563';
export const PREVIEW_TARGETS = Object.freeze({
  staging: { name: 'signatures-gallery-staging', origin: 'https://staging.signatures.gallery' },
  production: { name: 'signatures-gallery', origin: 'https://signatures.gallery' },
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Build only public presentation. No environment, local runtime or deployment keys are read. */
export async function buildPreviewCloudflare({ environment = 'staging', destination } = {}) {
  assert.ok(Object.hasOwn(PREVIEW_TARGETS, environment), 'Choose staging or production.');
  const target = PREVIEW_TARGETS[environment];
  if (destination === undefined) {
    const parent = join(root, '.local/preview-cloudflare');
    await mkdir(parent, { recursive: true });
    assert.ok(!(await lstat(parent)).isSymbolicLink(), 'Build parent must not be a symlink.');
    destination = await mkdtemp(join(parent, environment + '-'));
  }
  destination = resolve(destination);
  assert.notEqual(destination, root, 'Build output must not be the repository root.');
  assert.notEqual(destination, '/', 'Invalid build output directory.');
  await mkdir(destination, { recursive: true });
  assert.ok(!(await lstat(destination)).isSymbolicLink(), 'Build output must not be a symlink.');
  assert.equal((await readdir(destination)).length, 0, 'Build output must be empty; never reuse an old artifact.');
  const files = new Map();
  const asset = (url, bytes) => files.set('public' + new URL(url, target.origin).pathname, bytes);
  asset('/assets/preview.css', SITE_CSS + OPEN_MINT_CSS);
  asset(FAVICON_URL, FAVICON_SVG);
  asset(SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT);
  asset(SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT);

  const fontPackage = '@fontsource-variable/playpen-sans';
  const fontVersion = JSON.parse(await readFile(require.resolve(fontPackage + '/package.json'), 'utf8')).version;
  const distributor = await readFile(require.resolve(fontPackage + '/wght.css'), 'utf8');
  for (const [, filename] of distributor.matchAll(/url\(\.\/files\/(playpen-sans-[a-z0-9-]+\.woff2)\)/g)) {
    const url = `/assets/fonts/playpen-sans-${fontVersion}/${filename}`;
    const value = fonts.siteFontAsset(url);
    assert.ok(value, 'Missing exact font asset.'); asset(url, value.bytes);
  }
  const fontLicense = `/assets/fonts/playpen-sans-${fontVersion}/LICENSE.txt`;
  asset(fontLicense, fonts.siteFontAsset(fontLicense).bytes);
  assert.equal([...files.keys()].filter(name => name.endsWith('.woff2')).length, 16);

  const fontModule = ['SITE_FONT_FAMILY', 'SITE_FONT_WEIGHT', 'SITE_FONT_EMPHASIS_WEIGHT', 'SITE_FONT_CSS', 'SITE_FONT_PRELOAD']
    .map(name => `export const ${name} = ${JSON.stringify(fonts[name])};`).join('\n');
  const worker = await build({
    entryPoints: [join(root, 'src/preview/cloudflare.ts')], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true,
    external: ['node:crypto'], plugins: [{ name: 'build-time-public-fonts', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)fonts\.js$/ }, args => {
        if (resolve(args.resolveDir, args.path) === join(root, 'src/v1/fonts.js')) return { path: 'fonts', namespace: 'public-fonts' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'public-fonts' }, () => ({ contents: fontModule, loader: 'js' }));
    } }],
  });
  for (const input of Object.keys(worker.metafile.inputs)) {
    assert.ok(!/(?:sharp|\/pg\/|undici|walletProviders|clientScript\.ts|\/persistence\/|\/local\/|pulse-sepolia)/.test(input), `Unsafe preview dependency: ${input}`);
  }
  for (const output of Object.values(worker.metafile.outputs)) {
    assert.ok(output.imports.every(item => item.external && item.path === 'node:crypto'), 'Unexpected runtime import.');
    assert.deepEqual(output.exports, ['default'], 'Cloudflare Worker must expose only its default entry point.');
  }
  const workerBytes = worker.outputFiles[0].contents;
  files.set('worker.mjs', workerBytes);
  const client = await build({ entryPoints: [join(root, 'src/preview/client.ts')], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'es2022', minify: true, metafile: true });
  const clientText = client.outputFiles[0].text;
  assert.ok(!/eth_requestAccounts|personal_sign|eth_sendTransaction|wallet_switchEthereumChain|fetch\(/.test(clientText), 'Preview client contains a network/wallet action.');
  asset('/assets/preview.js', clientText);
  // Existing files are served by Cloudflare's asset service without invoking
  // the user Worker. Exact per-file rules avoid overlapping CSP/cache headers;
  // this special configuration file is not itself a public asset endpoint.
  const assetHeaders = [...files.keys()].filter(name => name.startsWith('public/')).map(name => {
    const path = name.slice('public'.length);
    const headers = {
      'Cache-Control': path === '/assets/preview.css' || path === '/assets/preview.js' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': path === new URL(FAVICON_URL, target.origin).pathname ? FAVICON_CSP
        : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Strict-Transport-Security': 'max-age=31536000',
      ...(environment === 'staging' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    };
    return path + '\n' + Object.entries(headers).map(([key, value]) => `  ${key}: ${value}`).join('\n');
  }).join('\n\n') + '\n';
  files.set('public/_headers', assetHeaders);
  const config = {
    name: target.name, account_id: accountId, main: './worker.mjs',
    compatibility_date: '2026-10-03', compatibility_flags: ['nodejs_compat'],
    no_bundle: true, workers_dev: false, preview_urls: false,
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: false, html_handling: 'none', not_found_handling: 'none' },
    vars: { PUBLIC_ORIGIN: target.origin },
    routes: [{ pattern: new URL(target.origin).hostname, custom_domain: true }],
  };
  files.set('wrangler.json', JSON.stringify(config, null, 2) + '\n');
  files.set('metafile.json', JSON.stringify(worker.metafile, null, 2) + '\n');
  const manifest = { schema: 'signatures-gallery.preview-cloudflare.v1', environment,
    origin: target.origin, worker: target.name, mintingEnabled: false, walletConnectionEnabled: false,
    artifactSha256: hash(workerBytes), fontVersion,
    files: [...files].map(([name, bytes]) => ({ path: name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  for (const [name, bytes] of files) {
    const path = join(destination, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { destination, config: join(destination, 'wrangler.json'), manifest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 1, 'Usage: build-preview-cloudflare.mjs [staging|production]');
  const result = await buildPreviewCloudflare({ environment: args[0] ?? 'staging' });
  console.log(JSON.stringify({ destination: relative(root, result.destination), origin: result.manifest.origin,
    artifactSha256: result.manifest.artifactSha256, mintingEnabled: false }, null, 2));
}
