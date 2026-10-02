import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fixtureMbti, testConsent, saleNotice, presentedSepoliaMints, collectionObservationFailure, supersededReceiptHints } from '../../scripts/pulse-sepolia-site.mjs';
import { isMbti } from '../../src/openMint/identity.ts';
import { requireFreshMintSnapshot, publicFailure } from '../../scripts/pulse-sepolia-errors.mjs';
import { PublicError } from '../../src/openMint/security.ts';
test('sale status explains exhaustion, deadline, open and paused states without wallet access', () => {
  const sale = { phase: 1, endReason: 1, freeMinted: 2n, freeSlotCount: 2n, paused: false };
  assert.equal(saleNotice(sale), 'Free mint ended · 2/2 slots used.');
  assert.equal(saleNotice({ ...sale, endReason: 2, freeMinted: 1n }), 'Free mint ended · Deadline reached · 1/2 slots used.');
  assert.equal(saleNotice({ ...sale, phase: 0, freeMinted: 0n }), 'Free mint open · 0/2 slots used.');
  assert.equal(saleNotice({ ...sale, paused: true }), 'Minting is paused.');
});
test('test consent requires an explicit phase, valid handle and bounded ETH ceiling', () => {
  assert.deepEqual(testConsent({ handle: '@Alice_Bob', mode: 'paid', maximumETH: '0.0001' }), { handle: 'alice_bob', renderHandle: 'Alice_Bob', mode: 'paid', cap: 100000000000000n });
  assert.equal(testConsent({ handle: '__proto__', mode: 'free', maximumETH: '0' }).handle, '__proto__');
  for (const patch of [{ maximumETH: '1' }, { maximumETH: '0.000100000000000001' }, { maximumETH: '1e-6' }, { maximumETH: '-1' },
    { maximumETH: 0.0001 }, { maximumETH: '0' }, { mode: 'auto' }, { handle: 'spaces fail' }, { handle: 'abcdefghijklmnop' }, { mbti: 'INTJ' }]) {
    assert.throws(() => testConsent({ handle: 'test', mode: 'paid', maximumETH: '0.0001', ...patch }));
  }
  assert.throws(() => testConsent({ handle: 'test', mode: 'free', maximumETH: '0.0001' }));
});
test('test MBTI is deterministic and explicitly separate from Grok authority', () => {
  for (const h of ['alice', 'Alice_Bob', '__proto__', 'constructor']) { assert.ok(isMbti(fixtureMbti(h))); assert.equal(fixtureMbti(h), fixtureMbti(h.toUpperCase())); }
  const server = readFileSync(new URL('../../scripts/pulse-sepolia-site.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes("assessmentProvenance: 'development-fixture'"));
  for (const forbidden of ['GrokAssessmentProvider', 'XApiIdentityResolver', '.unlock()', 'eth_sendRawTransaction', 'eth_sendTransaction', '31337']) assert.ok(!server.includes(forbidden), forbidden);
  assert.ok(server.includes("server.listen(port, '127.0.0.1'"));
});
test('test client only submits after a user click, Sepolia/wallet checks and a persisted begin fence', () => {
  const client = readFileSync(new URL('../../scripts/pulse-sepolia-client.mjs', import.meta.url), 'utf8');
  assert.ok(client.indexOf("await api('/api/test/begin'") < client.indexOf("method: 'eth_sendTransaction'"));
  assert.ok(client.includes("plan.transaction.chainId !== '0xaa36a7'"));
  assert.ok(client.includes('plan.transaction.from.toLowerCase() !== wallet.toLowerCase()'));
  assert.ok(client.includes('plan.transaction.to.toLowerCase() !== document.body.dataset.contract.toLowerCase()'));
  assert.equal((client.match(/method: 'eth_sendTransaction'/g) ?? []).length, 1);
});

test('control comparisons are isolated from wallet sessions, relay demand and readiness polling', () => {
  const server = readFileSync(new URL('../../scripts/pulse-sepolia-site.mjs', import.meta.url), 'utf8');
  const route = server.indexOf("if (path === MINT_CONTROL_STUDY_PATH) return send");
  assert.ok(route > 0);
  assert.ok(route < server.indexOf("if (!path.startsWith('/api/') || path === '/api/test/status') demand();"));
  assert.ok(route < server.indexOf('const found = sessions.session(req.headers.cookie)'));
  assert.match(server.slice(route, server.indexOf('\n', route)), /'text\/html; charset=utf-8', false\);/);
  assert.match(server, /if \(readiness && type.startsWith\('text\/html'\)\)/);
  const worker = readFileSync(new URL('../../scripts/pulse-sepolia-ui-worker.mjs', import.meta.url), 'utf8');
  assert.ok(worker.includes("request.name === 'mintControlStudyPage'"));
  for (const asset of ['MINT_CONTROL_STUDY_CSS_PATH', 'MINT_CONTROL_STUDY_SCRIPT_PATH']) {
    assert.ok(server.includes(`[${asset},`));
    assert.ok(worker.includes(`[${asset},`));
  }
});

test('fresh receipt inclusion reveals independently of a failed or stale full-history scan', () => {
  const mint = Object.freeze({ handle: 'alice', state: 'confirming', transactionHash: 'verified' });
  const early = { at: 100000, head: { number: '0x101' }, mint };
  const hints = new Map([['alice', early]]);
  const snapshot = { at: 100000, head: { number: '0x100' }, mints: new Map() };
  for (const previous of [undefined, snapshot]) {
    const shown = presentedSepoliaMints(previous, Error('history unavailable'), hints, false, 190000);
    assert.equal(shown.get('alice').state, 'confirming');
    assert.equal(shown.get('alice').mintObservationUnavailable, false);
  }
  assert.throws(() => presentedSepoliaMints(snapshot, Error('history unavailable'), hints, false, 190001));
  assert.equal(mint.mintObservationUnavailable, undefined, 'Verified input is not mutated');
  const server = readFileSync(new URL('../../scripts/pulse-sepolia-site.mjs', import.meta.url), 'utf8');
  const statusRoute = server.slice(server.indexOf('if (stateMatch) {'), server.indexOf('const art = /^'));
  assert.match(statusRoute, /requireForUser\(!conflict\(\), evidenceConflict/);
  assert.match(statusRoute, /let m = includedMints\(true\)\.get\(handle\)/);
  assert.match(statusRoute, /if \(!m && row\?\.stage === 'reported'\)/);
  assert.match(statusRoute, /await receiptStatus\(handle, row\)/);
  assert.doesNotMatch(statusRoute, /fresh\(\)|requireFreshMintSnapshot/);
});

test('finalized presentation survives outages without becoming fresh admission or ownership authority', () => {
  const mint = { handle: 'alice', state: 'minted' };
  const snapshot = { at: 100000, head: { number: '0x100' }, mints: new Map([['alice', mint]]) };
  for (const [error, now] of [[undefined, 190001], [Error('history failed'), 100000]]) {
    const shown = presentedSepoliaMints(snapshot, error, new Map(), true, now);
    assert.equal(shown.get('alice').mintObservationUnavailable, true);
    assert.equal(shown.get('alice').mintEvidenceInvalidated, false);
    assert.equal(presentedSepoliaMints(snapshot, error, new Map(), false, now).get('alice').state, 'minted');
    assert.throws(() => requireFreshMintSnapshot(snapshot, error, now), { code: 'OBSERVATION_UNAVAILABLE' });
  }
  assert.equal(presentedSepoliaMints(undefined, Error('no evidence'), new Map(), true, 100000).size, 0);
  assert.equal(presentedSepoliaMints(snapshot, undefined, new Map(), false, 100000).get('alice').mintObservationUnavailable, false);
  for (const state of ['pending', 'unknown', 'unminted']) assert.throws(() => presentedSepoliaMints({ ...snapshot,
    mints: new Map([['alice', { ...mint, state }]]) }, undefined, new Map(), true, 100000));
});

test('unfinalized history expires, while finalized receipt evidence remains presentation-only', () => {
  const hint = state => new Map([['alice', { at: 100000, head: { number: '0x101' }, mint: { handle: 'alice', state } }]]);
  assert.throws(() => presentedSepoliaMints(undefined, Error('RPC'), hint('confirming'), false, 190001));
  const stale = presentedSepoliaMints(undefined, Error('RPC'), hint('confirming'), true, 190001).get('alice');
  assert.equal(stale.state, 'confirming'); assert.equal(stale.mintObservationUnavailable, true);
  const final = presentedSepoliaMints(undefined, Error('RPC'), hint('minted'), false, 190001).get('alice');
  assert.equal(final.state, 'minted'); assert.equal(final.mintObservationUnavailable, true);
  const snapshot = { at: 100000, head: { number: '0x100' }, mints: new Map([['alice', { state: 'minted' }]]) };
  assert.equal(presentedSepoliaMints(snapshot, Error('RPC'), hint('confirming'), true, 100000).get('alice').state, 'minted');
});

test('a verified finality conflict invalidates historical labels and refuses status/receipt fallback', () => {
  const conflict = new PublicError(409, 'MINT_EVIDENCE_CONFLICT', 'Previously verified mints need to be checked before minting can continue.');
  const snapshot = { at: 100000, head: { number: '0x100' }, mints: new Map([['alice', { state: 'minted' }]]) };
  const hints = new Map([['bob', { at: 100000, head: { number: '0x101' }, mint: { state: 'minted' } }]]);
  assert.throws(() => presentedSepoliaMints(snapshot, conflict, hints, false, 100000), { code: conflict.code });
  const historical = presentedSepoliaMints(snapshot, conflict, hints, true, 100000);
  assert.ok([...historical.values()].every(mint => mint.mintEvidenceInvalidated && mint.mintObservationUnavailable));
  assert.equal(publicFailure(conflict).code, conflict.code);
  assert.equal(collectionObservationFailure(conflict, Error('Later timeout')), conflict);
  assert.equal(collectionObservationFailure(Error('Earlier timeout'), conflict), conflict);
  const timeout = Error('Temporary RPC failure');
  assert.equal(collectionObservationFailure(undefined, timeout), timeout);
});

test('a newer canonical full snapshot withdraws older receipt hints, including real reorgs', () => {
  const hints = new Map([['alice', { at: 100000, head: { number: '0x101' }, mint: { handle: 'alice', state: 'confirming' } }]]);
  const snapshot = { at: 100000, head: { number: '0x102' }, mints: new Map() };
  assert.equal(presentedSepoliaMints(snapshot, undefined, hints, true, 100000).size, 0);
  assert.equal(presentedSepoliaMints(snapshot, undefined, hints, false, 100000).size, 0);
});

test('covered finalized receipts cannot be silently withdrawn, downgraded or replaced by a new scan', () => {
  const mint = { handle: 'alice', state: 'minted', renderHandle: 'Alice', mbti: 'INTJ', tokenId: '1', transactionHash: 'tx',
    block: '0x100', blockHash: 'block', inputDigest: 'input', assessmentDigest: 'assessment', wallet: 'recipient' };
  const hints = new Map([['alice', { head: { number: '0x101' }, mint }]]);
  const snapshot = mints => ({ head: { number: '0x102' }, mints });
  assert.deepEqual(supersededReceiptHints(snapshot(new Map([['alice', { ...mint }]])), hints), ['alice']);
  assert.equal(hints.size, 1, 'Validation does not mutate the hints');
  for (const changed of [undefined, { ...mint, state: 'confirming' }, ...Object.keys(mint).filter(field => field !== 'state')
    .map(field => ({ ...mint, [field]: 'changed' }))]) {
    const value = snapshot(new Map(changed ? [['alice', changed]] : []));
    assert.throws(() => supersededReceiptHints(value, hints), { code: 'MINT_EVIDENCE_CONFLICT' });
    assert.equal(hints.get('alice').mint, mint);
  }
  assert.deepEqual(supersededReceiptHints({ ...snapshot(new Map()), head: { number: '0x100' } }, hints), []);
  assert.deepEqual(supersededReceiptHints(snapshot(new Map()), new Map([['alice', { ...hints.get('alice'), mint: { ...mint, state: 'confirming' } }]])), ['alice']);
});
