import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSepoliaFrontend } from '../../scripts/pulse-sepolia-fe.mjs';

// Separate test servers reuse this port, not a previous closing keepalive socket.
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } });

test('read-only Sepolia FE serves the correct network and previews but refuses all wallet and mint APIs', async t => {
  const site = await startSepoliaFrontend({ port: 32004, collection: '0x88c435146A017338E48Abe3BEE2F11BcEab79cC2' });
  t.after(site.close);
  const response = await fetch(site.origin + '/mint?handle=AnAgentArtist'), html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /Ethereum Sepolia/); assert.doesNotMatch(html, /Local Anvil|No mint fee/);
  assert.match(html, /data-pulse-mint="true"/); assert.match(html, /value="AnAgentArtist"/);
  assert.match(html, /data-request-submit disabled/); assert.match(html, /cannot be checked right now/);
  const health = await (await fetch(site.origin + '/health')).json();
  assert.equal(health.chainId, 11155111); assert.equal(health.frontendOnly, true); assert.equal(health.observerHealthy, false);
  for (const name of ['session', 'options', 'status', 'challenge', 'verify', 'prepare', 'begin', 'report', 'logout']) {
    for (const method of ['GET', 'POST']) {
      const result = await fetch(site.origin + '/api/test/' + name, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json', origin: site.origin }, body: '{}' } : {}) });
      assert.equal(result.status, 503); assert.equal((await result.json()).code, 'OBSERVATION_UNAVAILABLE');
      assert.equal(result.headers.get('set-cookie'), null);
    }
  }
  for (const path of ['/', '/ISTJ/', '/me', '/p/AnAgentArtist/ISTJ', '/p/AnAgentArtist/variations', '/assets/sepolia.css', '/assets/sepolia.js']) {
    assert.equal((await fetch(site.origin + path)).status, 200);
  }
  for (const path of ['/', '/ISTJ/', '/me', '/p/AnAgentArtist/ISTJ', '/p/AnAgentArtist/variations', '/about']) {
    const page = await (await fetch(site.origin + path)).text();
    assert.doesNotMatch(page, /data-mint-observation-warning|gallery could not be loaded right now|Mint status cannot be verified right now|Mint availability cannot be checked right now/);
    assert.doesNotMatch(page, /No signatures minted|This wallet has no minted signatures/);
    assert.doesNotMatch(page, /<main[^>]*><p class="open-preview-notice/);
  }
  assert.match(await (await fetch(site.origin + '/')).text(), /Checking for minted signatures/);
  assert.match(await (await fetch(site.origin + '/ISTJ/')).text(), /Checking for minted signatures/);
  const art = await fetch(site.origin + '/preview/AnAgentArtist/ISTJ.svg');
  assert.equal(art.status, 200); assert.match(await art.text(), /^<svg/);
  assert.equal((await fetch(site.origin + '/signatures/AnAgentArtist')).status, 503);
});
test('read-only frontend refuses hosted production', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(startSepoliaFrontend({ port: 32004, collection: '0x' + '11'.repeat(20) })); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('read-only fallback keeps cached works and images visible without upstream or integrity warnings', async t => {
  const hash = '0x' + 'ab'.repeat(32), address = '0x' + '11'.repeat(20);
  const mint = { handle: 'alice', renderHandle: 'Alice', mbti: 'INTJ', tokenId: '1', transactionHash: hash,
    blockHash: hash, wallet: address, state: 'minted', inputDigest: hash, assessmentDigest: hash };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
  const cache = {
    presentation: () => ({ invalidated: true, mints: new Map([['alice', mint]]) }),
    artworks: () => new Map([[hash + ':' + hash, svg]]),
    state: () => ({ safetyHalted: true }),
  };
  const site = await startSepoliaFrontend({ port: 32004, collection: address, cache,
    plan: { collection: { address }, renderer: { identity: hash } } }); t.after(site.close);
  for (const path of ['/', '/INTJ/', '/signatures/alice', '/p/Alice/ISTJ', '/p/Alice/variations', '/me']) {
    const response = await fetch(site.origin + path); assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /data-mint-observation-warning|Gallery updates could not be checked|Live network checks are temporarily unavailable|Mint status cannot be verified right now|Previously verified mints need to be checked/);
  }
  assert.match(await (await fetch(site.origin + '/')).text(), /@Alice/);
  assert.equal(await (await fetch(site.origin + '/test-art/alice.svg')).text(), svg);
  const health = await (await fetch(site.origin + '/health')).json();
  assert.equal(health.safetyHalted, true); assert.equal(health.mintReady, false);
  assert.match(await (await fetch(site.origin + '/mint')).text(), /Mint availability cannot be checked right now/);
});
