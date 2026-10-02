import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSepoliaUiRenderer } from '../../scripts/pulse-sepolia-ui.mjs';
import { SITE_FONT_CSS, SITE_FONT_PRELOAD, siteFontAsset } from '../../src/v1/fonts.ts';
import { SITE_CSS } from '../../src/v1/siteCss.ts';
import { OPEN_MINT_CSS } from '../../src/openMint/pages.ts';

test('render-only UI reload serves allowlisted Playpen font binaries through private JSON IPC', { timeout: 30000 }, async t => {
  const spawned = [], originalSpawn = ChildProcess.prototype.spawn;
  t.mock.method(ChildProcess.prototype, 'spawn', function (options) {
    spawned.push(options);
    return originalSpawn.call(this, options);
  });
  const ui = createSepoliaUiRenderer({ watchFiles: false });
  t.after(() => ui.close());

  const paths = [...new Set([...SITE_FONT_CSS.matchAll(/url\((?:['"])?([^)'"\s]+\.woff2)(?:['"])?\)/g)].map(match => match[1]))];
  assert.equal(paths.length, 16);
  for (const path of paths) assert.match(path, /^\/assets\/fonts\/playpen-sans-[^/]+\/playpen-sans-[a-z0-9-]+\.woff2$/);
  const license = paths[0].slice(0, paths[0].lastIndexOf('/') + 1) + 'LICENSE.txt';

  async function assertAssets() {
    const css = await ui.call('asset', '/assets/sepolia.css');
    assert.equal(typeof css[0], 'string');
    assert.equal(css[0], SITE_FONT_CSS + SITE_CSS + OPEN_MINT_CSS);
    assert.equal(css[1], 'text/css');
    assert.match(css[0], /--font-family:"Playpen Sans",sans-serif/);
    assert.match(css[0], /font-weight:300/);
    for (const path of [...paths, license]) {
      const actual = await ui.call('asset', path), expected = siteFontAsset(path);
      assert.ok(expected);
      assert.ok(Buffer.isBuffer(actual[0]));
      assert.deepEqual(actual, [expected.bytes, expected.contentType]);
      if (path.endsWith('.woff2')) assert.equal(actual[0].subarray(0, 4).toString(), 'wOF2');
      else assert.match(actual[0].toString(), /SIL OPEN FONT LICENSE/i);
    }
    for (const path of ['/assets/fonts/missing.woff2', '/assets/fonts/../authorizer.key', '/assets/fonts/%2e%2e/authorizer.key',
      '/assets/fonts/playpen-sans-5.3.0/../../.env', '/.env', '/authorizer.key', '/api/test/session', '/api/test/begin']) {
      assert.equal(await ui.call('asset', path), undefined);
    }
    const html = await ui.call('mintPage', 'AnAgentArtist', { stylesheetUrl: '/assets/sepolia.css' });
    assert.match(html, /value="AnAgentArtist"/);
    assert.ok(html.includes(SITE_FONT_PRELOAD));
    assert.match(html, /playpen-sans-latin-wght-normal\.woff2/);
  }

  await assertAssets();
  const initialRevision = ui.revision();
  await ui.reload();
  assert.equal(ui.revision(), initialRevision + 1);
  await assertAssets();
  assert.equal(spawned.length, 2);
  for (const options of spawned) {
    const names = options.envPairs.map(pair => pair.slice(0, pair.indexOf('='))).sort();
    assert.deepEqual(names, ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_ENV', 'PATH']);
    assert.ok(options.envPairs.includes('NODE_ENV=development'));
    assert.equal(options.stdio[3].type, 'pipe');
    assert.equal(options.stdio[3].ipc, true);
  }
  const worker = readFileSync(new URL('../../scripts/pulse-sepolia-ui-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /assert\.ok\(process\.send/);
  assert.doesNotMatch(worker, /createServer|startSepoliaTestSite|authorizer\.key|readOnlyContext|writeFile|saveRecords|relayStore/);
});
