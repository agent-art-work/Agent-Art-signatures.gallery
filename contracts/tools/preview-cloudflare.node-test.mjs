import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildPreviewCloudflare } from '../../scripts/build-preview-cloudflare.mjs';
import { loadPreviewArtifact, startPreviewLocal } from '../../scripts/preview-cloudflare-local.mjs';
import { MBTI_TYPES, RENDERER_VERSION, renderSignatureSvg } from '../../src/algorithmV2/index.ts';
import { FAVICON_CSP, FAVICON_URL } from '../../src/brand/favicon.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
let directory;
const builds = {};

// Every file and workerd socket is local, temporary and owned by this test.
// No account, credential, RPC, database, wallet or Cloudflare deployment is used.
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sg-preview-cloudflare-tests-'));
  for (const environment of ['staging', 'production']) {
    builds[environment] = await buildPreviewCloudflare({ environment, destination: join(directory, environment) });
  }
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function inventory(path, prefix = '') {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(join(path, entry.name), relative + '/'));
    else files.push(relative);
  }
  return files.sort();
}

async function configuration(environment) {
  return JSON.parse(await readFile(builds[environment].config, 'utf8'));
}

for (const environment of ['staging', 'production']) {
  test(`${environment} local adapter starts with provider configuration present but never exposes it`, async t => {
    const build = builds[environment];
    assert.ok(build.manifest.files.some(file => file.path === 'public/_headers'));
    const site = await startPreviewLocal({ directory: build.destination, port: 0 });
    t.after(site.close);
    assert.equal(site.publicOrigin, build.manifest.origin);
    const fetchPage = (path, init = {}) => fetch(site.localOrigin + path, { ...init, headers: { connection: 'close' } });
    const ready = await fetchPage('/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { live: true, frontendOnly: true, siteLaunchMode: 'prelaunch',
      mintingEnabled: false, walletConnectionEnabled: false, rpcEnabled: false });
    const css = await fetchPage('/assets/preview.css');
    assert.equal(css.status, 200);
    assert.equal(await css.text(), await readFile(join(build.destination, 'public/assets/preview.css'), 'utf8'));
    const head = await fetchPage('/assets/preview.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const hidden = await fetchPage('/_headers');
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(await hidden.text(), /Strict-Transport-Security:|Cache-Control:/);
    assert.equal((await fetchPage('/api/mint', { method: 'POST' })).status, 409);
  });

  test(`${environment} manifest exactly inventories a deterministic public preview package`, async () => {
    const result = builds[environment], manifest = result.manifest;
    assert.equal(manifest.schema, 'signatures-gallery.preview-cloudflare.v1');
    assert.equal(manifest.environment, environment);
    assert.equal(manifest.mintingEnabled, false);
    assert.equal(manifest.walletConnectionEnabled, false);
    assert.equal(manifest.fontVersion, '5.3.0');
    assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
    assert.deepEqual(await inventory(result.destination), [...manifest.files.map(file => file.path), 'manifest.json'].sort());
    for (const file of manifest.files) {
      assert.doesNotMatch(file.path, /^\/|\.\.|\\/);
      const bytes = await readFile(join(result.destination, file.path));
      assert.equal(bytes.length, file.bytes, file.path + ' byte count');
      assert.equal(digest(bytes), file.sha256, file.path + ' sha256');
    }
    assert.equal(digest(await readFile(join(result.destination, 'worker.mjs'))), manifest.artifactSha256);
    assert.deepEqual(JSON.parse(await readFile(join(result.destination, 'manifest.json'), 'utf8')), manifest);
    assert.doesNotMatch(JSON.stringify(manifest), /authorizer|private.?key|database|rpcUrl|\.env|rehearsal/i);
  });

  test(`${environment} includes all 16 native font subsets, OFL license and exact CSS paths`, async () => {
    const { destination, manifest } = builds[environment];
    const fontFiles = manifest.files.filter(file => file.path.endsWith('.woff2'));
    assert.equal(fontFiles.length, 16);
    const css = await readFile(join(destination, 'public/assets/preview.css'), 'utf8');
    assert.match(css, /@font-face/);
    assert.match(css, /font-family: 'Playpen Sans'/);
    assert.match(css, /font-weight: 100 800/);
    assert.match(css, /--ui-font-weight:300/);
    for (const font of fontFiles) {
      assert.ok(css.includes(font.path.replace(/^public/, '')), font.path + ' published CSS URL');
      assert.equal((await readFile(join(destination, font.path))).subarray(0, 4).toString(), 'wOF2');
    }
    const licensePath = `public/assets/fonts/playpen-sans-${manifest.fontVersion}/LICENSE.txt`;
    assert.ok(manifest.files.some(file => file.path === licensePath));
    assert.match(await readFile(join(destination, licensePath), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com|\.\/files\//);
  });

  test(`${environment} contains no backend, native renderer, secret or network-capable browser module`, async () => {
    const { destination } = builds[environment];
    const metafile = JSON.parse(await readFile(join(destination, 'metafile.json'), 'utf8'));
    const retained = Object.values(metafile.outputs).flatMap(output => Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
    assert.doesNotMatch(retained.join('\n'), /node_modules\/(?:sharp|pg|undici)|walletProviders|\/persistence\/|\/local\/|clientScript\.ts|pulse-sepolia|\/v1\/renderer\.ts/);
    for (const output of Object.values(metafile.outputs)) {
      assert.ok(output.imports.every(import_ => import_.external === true && import_.path === 'node:crypto'));
      // Runtime treats named exports as possible entrypoints. Unit-test
      // helpers and constants must not escape from the actual Worker entry.
      assert.deepEqual(output.exports, ['default']);
    }
    const client = await readFile(join(destination, 'public/assets/preview.js'), 'utf8');
    assert.doesNotMatch(client, /eth_requestAccounts|personal_sign|eth_sendTransaction|wallet_switchEthereumChain|eth_accounts|wallet_requestPermissions|\/api\/|fetch\(|XMLHttpRequest|WebSocket/);
    const paths = await inventory(destination);
    assert.ok(paths.every(path => !/(?:^|\/)(?:\.env|node_modules|src|contracts|authorizer|web-records|state\.json)|\.key$/.test(path)));
  });
}

test('staging and production isolate names/origins while sharing identical audited Worker and public assets', async () => {
  const staging = await configuration('staging'), production = await configuration('production');
  assert.equal(staging.name, 'signatures-gallery-staging');
  assert.equal(production.name, 'signatures-gallery');
  assert.equal(staging.account_id, 'a54e5847cc16e612aa3ad45a5dadb563');
  assert.equal(production.account_id, staging.account_id);
  for (const [config, origin] of [[staging, 'https://staging.signatures.gallery'], [production, 'https://signatures.gallery']]) {
    assert.deepEqual(config.vars, { PUBLIC_ORIGIN: origin });
    assert.deepEqual(config.routes, [{ pattern: new URL(origin).hostname, custom_domain: true }]);
    assert.equal(config.compatibility_date, '2026-10-03');
    assert.deepEqual(config.compatibility_flags, ['nodejs_compat']);
    assert.equal(config.no_bundle, true);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.deepEqual(config.assets, { directory: './public', binding: 'ASSETS', run_worker_first: false, html_handling: 'none', not_found_handling: 'none' });
    assert.equal(config.main, './worker.mjs');
    assert.doesNotMatch(JSON.stringify(config), /secrets|R2|D1|durable_objects|kv_namespaces|queues|database|rpc|private.?key/i);
  }
  assert.equal(builds.staging.manifest.artifactSha256, builds.production.manifest.artifactSha256);
  assert.deepEqual(await readFile(join(builds.staging.destination, 'worker.mjs')), await readFile(join(builds.production.destination, 'worker.mjs')));
  const publicFiles = builds.staging.manifest.files.filter(file => file.path.startsWith('public/') && file.path !== 'public/_headers');
  for (const file of publicFiles) assert.deepEqual(await readFile(join(builds.staging.destination, file.path)), await readFile(join(builds.production.destination, file.path)));
  const stagingHeaders = await readFile(join(builds.staging.destination, 'public/_headers'), 'utf8');
  const productionHeaders = await readFile(join(builds.production.destination, 'public/_headers'), 'utf8');
  assert.match(stagingHeaders, /X-Robots-Tag: noindex, nofollow/);
  assert.doesNotMatch(productionHeaders, /X-Robots-Tag/);
  assert.equal(stagingHeaders.replaceAll('  X-Robots-Tag: noindex, nofollow\n', ''), productionHeaders);
});

test('fresh packages rebuild reproducibly, but even an owned existing artifact is never overwritten', async () => {
  const original = builds.staging.manifest;
  const repeated = await buildPreviewCloudflare({ environment: 'staging', destination: join(directory, 'staging-fresh') });
  assert.deepEqual(repeated.manifest, original);
  await assert.rejects(buildPreviewCloudflare({ environment: 'staging', destination: builds.staging.destination }), /must be empty/);
});

test('local inspection still verifies the hash of non-public provider configuration', async () => {
  const result = await buildPreviewCloudflare({ environment: 'staging', destination: join(directory, 'tampered-headers') });
  await writeFile(join(result.destination, 'public/_headers'), 'Tampered configuration.');
  await assert.rejects(loadPreviewArtifact(result.destination), /Artifact differs from its manifest/);
});

test('local inspection rejects missing artifacts and invalid listener ports before starting', async () => {
  await assert.rejects(loadPreviewArtifact(), /artifact directory is required/);
  for (const port of [-1, 1, 1023, 65536, 1.5, NaN]) {
    await assert.rejects(startPreviewLocal({ directory: builds.staging.destination, port }), /AssertionError/);
  }
});

test('unknown environments and broad output directories are rejected', async () => {
  for (const environment of ['prod', 'development', 'toString', '__proto__']) {
    await assert.rejects(buildPreviewCloudflare({ environment, destination: join(directory, 'rejected-' + environment) }), /Choose staging or production/);
  }
  await assert.rejects(buildPreviewCloudflare({ destination: repository }), /repository root/);
  await assert.rejects(buildPreviewCloudflare({ destination: '/' }), /Invalid build output/);
});

test('an unrelated nonempty directory is never overwritten', async () => {
  const destination = join(directory, 'unrelated');
  await mkdir(destination);
  await writeFile(join(destination, 'keep.txt'), 'Owned unrelated content.');
  await assert.rejects(buildPreviewCloudflare({ destination }), /must be empty/);
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'Owned unrelated content.');
  assert.deepEqual(await readdir(destination), ['keep.txt']);
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ schema: 'unrelated-package.v1', environment: 'staging' }));
  const before = await readFile(join(destination, 'manifest.json'));
  await assert.rejects(buildPreviewCloudflare({ destination }), /must be empty/);
  assert.deepEqual(await readFile(join(destination, 'manifest.json')), before);
});

test('a valid staging package cannot be overwritten with production config', async () => {
  const before = await readFile(builds.staging.config);
  await assert.rejects(buildPreviewCloudflare({ environment: 'production', destination: builds.staging.destination }), /must be empty/);
  assert.deepEqual(await readFile(builds.staging.config), before);
});

test('a stale public subtree is refused rather than silently included in a new artifact', async () => {
  const destination = join(directory, 'stale'), publicPath = join(destination, 'public');
  await mkdir(publicPath, { recursive: true });
  await writeFile(join(publicPath, 'stale-secret.txt'), 'Unrelated file that must not become a public asset.');
  await assert.rejects(buildPreviewCloudflare({ destination }), /must be empty/);
  assert.equal(await readFile(join(publicPath, 'stale-secret.txt'), 'utf8'), 'Unrelated file that must not become a public asset.');
});

test('a symlink output directory is never followed or modified', async () => {
  const target = join(directory, 'symlink-target'), destination = join(directory, 'symlink-output');
  await mkdir(target);
  await symlink(target, destination);
  await assert.rejects(buildPreviewCloudflare({ destination }), /must not be a symlink/);
  assert.deepEqual(await readdir(target), []);
});

for (const environment of ['staging', 'production']) {
  test(`${environment} packaged Worker and assets execute inside real Cloudflare workerd`, { timeout: 60000 }, async t => {
    const build = builds[environment], config = await configuration(environment);
    let outbound = 0;
    // This test-only wrapper marks every user-handler invocation. A successful
    // static response without the marker proves the actual asset router bypassed
    // user code, rather than the handler merely forwarding to its asset binding.
    const observedEntry = join(directory, environment + '-observed.mjs');
    await writeFile(observedEntry, `import worker from './${environment}/worker.mjs';
      export default { async fetch(request, env, context) {
        const response = await worker.fetch(request, env, context);
        const headers = new Headers(response.headers);
        headers.set('X-Preview-Test-User-Worker', 'invoked');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } };`);
    // Installed Miniflare 5 exposes an official v4-option converter. Keep the
    // package's familiar Workers assets configuration, not a Node-fetch shim.
    const packagedWorker = {
      name: config.name,
      rootPath: directory,
      modulesRoot: directory,
      modules: [
        { type: 'ESModule', path: observedEntry },
        { type: 'ESModule', path: join(build.destination, 'worker.mjs') },
      ],
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      assets: { directory: join(build.destination, 'public'), binding: config.assets.binding,
        run_worker_first: config.assets.run_worker_first,
        routerConfig: { has_user_worker: true }, assetConfig: {
          html_handling: config.assets.html_handling, not_found_handling: config.assets.not_found_handling,
        } },
      bindings: config.vars,
      outboundService() { outbound++; return new Response('External network access is forbidden in this test.', { status: 503 }); },
    };
    // Miniflare's local HTTP dispatcher preserves URL but replaces Host with
    // its loopback port. Its Node getWorker proxy hangs in the installed alpha.
    // A real workerd ingress uses an ordinary service binding, restoring only
    // that transport header before invoking the unchanged packaged Worker.
    // Unlike "upstream", it preserves hostile origins and HTTP for guard tests.
    const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
      name: 'preview-test-ingress', rootPath: build.destination, modules: true,
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      serviceBindings: { PREVIEW: config.name },
      script: `export default { fetch(request, env) {
        const headers = new Headers(request.headers);
        headers.set('Host', new URL(request.url).host);
        return env.PREVIEW.fetch(new Request(request, { headers }));
      } };`,
    }, packagedWorker] }));
    t.after(() => runtime.dispose());
    const fetch = (path, init = {}) => runtime.dispatchFetch(config.vars.PUBLIC_ORIGIN + path, {
      ...init, headers: { Host: new URL(config.vars.PUBLIC_ORIGIN).host, ...init.headers }, redirect: 'manual',
    });
    for (const path of ['/', '/about', '/explore', '/mint?handle=Alice_Bob_Key', '/me', ...MBTI_TYPES.map(mbti => `/${mbti}/`)]) {
      const response = await fetch(path), html = await response.text();
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('x-preview-test-user-worker'), 'invoked', path + ' dynamic user handler');
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate, no-transform', path);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.match(html, /data-preview-wallet-notice/);
      assert.doesNotMatch(html, /data-connect-wallet|data-wallet-controls|data-mint-process|data-request-submit|Checking for minted signatures|RPC unavailable|deterministic fixture/);
      assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    }
    const home = await (await fetch('/')).text();
    if (environment === 'staging') {
      assert.match(home, /<meta name="robots" content="noindex">/);
      assert.match((await fetch('/')).headers.get('x-robots-tag'), /noindex/);
      assert.match(await (await fetch('/robots.txt')).text(), /Disallow: \/\n/);
    } else {
      assert.doesNotMatch(home, /<meta name="robots" content="noindex">/);
      assert.match(home, /rel="canonical" href="https:\/\/signatures\.gallery\/"/);
      assert.match(await (await fetch('/robots.txt')).text(), /Sitemap: https:\/\/signatures\.gallery\/sitemap\.xml/);
    }
    const variations = await (await fetch('/p/Alice_Bob_Key/variations')).text();
    assert.equal((variations.match(/class="open-preview-card"/g) ?? []).length, 16);
    const imagePaths = [...variations.matchAll(/<img src="([^\"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
    assert.equal(imagePaths.length, 16);
    assert.ok(imagePaths.every(path => path.includes(`?renderer=${RENDERER_VERSION}`)));
    for (const imagePath of imagePaths) {
      const response = await fetch(imagePath);
      assert.equal(response.status, 200, imagePath);
      assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
      const mbti = /\/([A-Z]{4})\.svg/.exec(imagePath)[1];
      assert.equal(await response.text(), renderSignatureSvg('Alice_Bob_Key', mbti));
    }
    const extra = await fetch(`/preview/012345678901234/ENFP.svg?renderer=${RENDERER_VERSION}`);
    assert.equal(extra.status, 200);
    assert.equal(await extra.text(), renderSignatureSvg('012345678901234', 'ENFP'));

    const assetUrls = build.manifest.files.filter(file => file.path.startsWith('public/') && file.path !== 'public/_headers')
      .map(file => '/' + file.path.slice('public/'.length));
    for (const path of assetUrls) {
      const response = await fetch(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('x-preview-test-user-worker'), null, path + ' bypasses user Worker');
      const type = path.endsWith('.woff2') ? /^font\// : path.endsWith('.css') ? /^text\/css/ : path.endsWith('.js') ? /^(?:application|text)\/javascript/ : path.endsWith('.svg') ? /^image\/svg\+xml/ : /^text\/plain/;
      assert.match(response.headers.get('content-type'), type, path);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
      assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      assert.equal(response.headers.get('cache-control'), /\/preview\.(?:css|js)$/.test(path) ? 'no-cache' : 'public, max-age=300');
      const csp = response.headers.get('content-security-policy');
      if (path === new URL(FAVICON_URL, config.vars.PUBLIC_ORIGIN).pathname) assert.equal(csp, FAVICON_CSP);
      else assert.equal(csp, (await fetch('/')).headers.get('content-security-policy'));
      assert.equal(response.headers.get('x-robots-tag'), environment === 'staging' ? 'noindex, nofollow' : null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(build.destination, 'public', path.slice(1))), path + ' served bytes');
      const head = await fetch(path, { method: 'HEAD' });
      assert.equal(head.status, 200, path + ' HEAD');
      assert.equal(head.headers.get('x-preview-test-user-worker'), null, path + ' HEAD bypasses user Worker');
      assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
      assert.equal(head.headers.get('content-security-policy'), csp);
      assert.equal(await head.text(), '', path + ' HEAD body');
    }
    assert.equal((await fetch(FAVICON_URL)).status, 200);
    // Query strings cannot alter packaged public bytes and do not need a user
    // Worker invocation just to reject harmless cache-busting parameters.
    const queriedAsset = await fetch('/assets/preview.js?secret=true');
    assert.equal(queriedAsset.status, 200);
    assert.equal(queriedAsset.headers.get('x-preview-test-user-worker'), null);
    assert.equal(queriedAsset.headers.get('cache-control'), 'no-cache');
    assert.equal(await queriedAsset.text(), await readFile(join(build.destination, 'public/assets/preview.js'), 'utf8'));
    for (const path of ['/assets/missing.js', '/assets/fonts/playpen-sans-5.3.0/missing.woff2', '/_headers']) {
      const missing = await fetch(path);
      assert.equal(missing.status, 404, path);
      assert.equal(missing.headers.get('x-preview-test-user-worker'), 'invoked', path + ' missing asset uses explicit Worker 404');
      assert.equal(missing.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await missing.text(), /data-home-mint-cta|data-preview-explorer|Content-Security-Policy:/, path + ' no public-file or home fallback');
    }
    for (const path of ['/api/session', '/api/test/options', '/api/mint', '/api/admin']) {
      const response = await fetch(path, { method: 'POST', body: 'No wallet consent.' });
      assert.equal(response.status, 409);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).code, 'SITE_NOT_OPEN');
      assert.equal(response.headers.get('set-cookie'), null);
    }
    const healthResponse = await fetch('/health/ready');
    assert.equal(healthResponse.headers.get('cache-control'), 'no-store');
    const health = await healthResponse.json();
    assert.deepEqual(health, { live: true, frontendOnly: true, siteLaunchMode: 'prelaunch', mintingEnabled: false, walletConnectionEnabled: false, rpcEnabled: false });
    const redirect = await fetch('/explore?handle=%40Alice_Bob_Key');
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/p/Alice_Bob_Key/variations');
    for (const [path, status] of [['/explore?handle=Alice&phase=free', 400], ['/.env.local', 404]]) {
      const response = await fetch(path);
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
    }
    assert.equal((await fetch('/about', { method: 'POST' })).status, 405);
    const head = await fetch('/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(head.headers.get('cache-control'), 'public, max-age=0, must-revalidate, no-transform');
    const wrong = await runtime.dispatchFetch('https://evil.example/', { redirect: 'manual' });
    assert.equal(wrong.status, 421);
    const http = await runtime.dispatchFetch(config.vars.PUBLIC_ORIGIN.replace('https:', 'http:') + '/about', { redirect: 'manual' });
    assert.equal(http.status, 308);
    assert.equal(http.headers.get('location'), config.vars.PUBLIC_ORIGIN + '/about');
    assert.equal((await runtime.dispatchFetch(config.vars.PUBLIC_ORIGIN.replace('https:', 'http:') + '/api/mint', { method: 'POST', redirect: 'manual' })).status, 421);
    assert.equal(outbound, 0, 'The actual Worker does not call an RPC, host or external API.');
  });
}
