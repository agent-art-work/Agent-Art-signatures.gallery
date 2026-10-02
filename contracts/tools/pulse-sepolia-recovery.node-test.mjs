import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { createReadRecovery, capabilityHealth, galleryAvailabilityNotice, mintAvailabilityNotice, readFailureDiagnostic } from '../../scripts/pulse-sepolia-recovery.mjs';
import { createSepoliaGalleryCache } from '../../scripts/pulse-sepolia-cache.mjs';
import { readSepoliaMintState } from '../../scripts/pulse-sepolia-site.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { INPUT_PROFILE } from './pulse-sepolia-plan.mjs';

const hash = '0x' + 'ab'.repeat(32), address = '0x' + '11'.repeat(20);
const plan = { digest: hash, collection: { address }, renderer: { identity: hash, runtimeCodeHash: hash } };
const head = { number: '0x100', hash, timestamp: '0x100' };
const mint = { handle: 'alice', renderHandle: 'Alice', mbti: 'INTJ', tokenId: String(BigInt(openMintHandleKey('alice'))),
  transactionHash: hash, block: '0xf0', blockHash: hash, inputDigest: generativeInputDigest('Alice', 'INTJ', hash, INPUT_PROFILE),
  assessmentDigest: hash, wallet: address, state: 'minted' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
const snapshot = () => ({ at: Date.now(), head, mints: new Map([['alice', mint]]) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = () => Object.assign(Error('private transport'), { retryableRead: true });
function directory(t) { const path = mkdtempSync(join(tmpdir(), 'sg-read-cache-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test('verified public cache survives restart, excludes private authority and stays presentation-only', t => {
  const path = directory(t), cache = createSepoliaGalleryCache(plan, path), state = snapshot();
  state.privateKey = 'must-not-persist'; state.sale = { secret: true };
  cache.save(state, head, new Map([[hash + ':' + hash, svg]]));
  assert.equal(statSync(join(path, 'gallery-cache.json')).mode & 0o077, 0);
  assert.doesNotMatch(readFileSync(join(path, 'gallery-cache.json'), 'utf8'), /must-not-persist|secret|privateKey/);
  const restored = createSepoliaGalleryCache(plan, path);
  assert.equal(restored.state().error, undefined); assert.equal(restored.presentation().mints.get('alice').state, 'minted');
  assert.equal(restored.artworks().get(hash + ':' + hash), svg);
  assert.equal(capabilityHealth({ history: restored.presentation(), sale: { at: Date.now() } }).mintReady, false);
  assert.equal(capabilityHealth({ history: restored.presentation() }).observerHealthy, false);
  const copy = restored.presentation(); copy.mints.delete('alice'); assert.equal(restored.presentation().mints.size, 1);
  copy.head.hash = 'changed'; assert.equal(restored.presentation().head.hash, hash);
});
test('safety conflicts persist before the first mint and cannot be cleared by cache writes', t => {
  const path = directory(t), cache = createSepoliaGalleryCache(plan, path); cache.invalidate();
  assert.equal(cache.presentation(), undefined);
  const restored = createSepoliaGalleryCache(plan, path); assert.equal(restored.state().safetyHalted, true);
  assert.equal(statSync(join(path, 'gallery-safety-halt.json')).mode & 0o077, 0);
  assert.throws(() => restored.save(snapshot(), head, new Map()), /Safety halt/);
  writeFileSync(join(path, 'gallery-safety-halt.json'), 'corrupt');
  assert.equal(createSepoliaGalleryCache(plan, path).state().safetyHalted, true);
});
test('cache corruption, mismatched deployment and unsupported authority fields are quarantined', t => {
  const path = directory(t), cache = createSepoliaGalleryCache(plan, path);
  cache.save(snapshot(), head, new Map([[hash + ':' + hash, svg]]));
  const original = JSON.parse(readFileSync(join(path, 'gallery-cache.json'), 'utf8'));
  original.payload.artworks[0].svg = '<svg>forged</svg>';
  writeFileSync(join(path, 'gallery-cache.json'), JSON.stringify(original));
  assert.equal(createSepoliaGalleryCache(plan, path).state().error, 'CACHE_INVALID');
  // Recomputing the envelope does not bypass record/input/artwork validation.
  original.sha256 = createHash('sha256').update(JSON.stringify(original.payload)).digest('hex');
  writeFileSync(join(path, 'gallery-cache.json'), JSON.stringify(original));
  assert.equal(createSepoliaGalleryCache(plan, path).presentation(), undefined);
  cache.save(snapshot(), head, new Map());
  assert.equal(createSepoliaGalleryCache({ ...plan, digest: 'changed' }, path).presentation(), undefined);
  const invalid = snapshot(); invalid.mints.set('alice', { ...mint, signedAuthorization: 'forged' });
  cache.save(invalid, head, new Map()); // Writer explicitly selects public fields.
  assert.doesNotMatch(readFileSync(join(path, 'gallery-cache.json'), 'utf8'), /signedAuthorization/);
});
test('a cached Confirming work is not imported as a finalized checkpoint; conflicts survive restart', t => {
  const path = directory(t), cache = createSepoliaGalleryCache(plan, path), value = snapshot();
  value.mints.set('alice', { ...mint, state: 'confirming' }); cache.save(value, { ...head, number: '0xe0' }, new Map());
  assert.equal(cache.checkpoint().mints.length, 0);
  cache.invalidate(); const restored = createSepoliaGalleryCache(plan, path);
  assert.equal(restored.presentation().invalidated, true); assert.equal(restored.checkpoint(), undefined);
  assert.equal(capabilityHealth({ history: restored.presentation(), conflict: true }).mintReady, false);
});
test('transient read recovery is automatic and stops cleanly without effects', async t => {
  let attempts = 0;
  const lane = createReadRecovery(async () => { if (++attempts < 2) throw transient(); }, { intervalMs: 5, maxBackoffMs: 10, timeoutMs: 100, once: true });
  t.after(lane.close); lane.start();
  for (let i = 0; i < 50 && lane.snapshot().phase !== 'ready'; i++) await pause(3);
  assert.equal(lane.snapshot().phase, 'ready'); assert.equal(attempts, 2);
  await lane.close(); await pause(15); assert.equal(attempts, 2);
});
test('a read deadline revokes readiness immediately and never overlaps a late pass', async t => {
  let release, active = 0, peak = 0, committed = 0;
  const lane = createReadRecovery(async signal => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => { release = resolve; }); active--; signal.throwIfAborted();
  }, { intervalMs: 5, maxBackoffMs: 10, timeoutMs: 5, onSuccess: () => committed++ });
  t.after(async () => { release?.(); await lane.close(); }); lane.start(); await pause(15);
  assert.equal(lane.snapshot().phase, 'unavailable'); assert.equal(active, 1);
  void lane.refresh(); assert.equal(peak, 1); release(); await pause(2); await lane.close();
  assert.equal(committed, 0); assert.equal(peak, 1);
});
test('integrity failure halts the recovery lane instead of retrying for a nicer answer', async t => {
  let attempts = 0;
  const lane = createReadRecovery(async () => { attempts++; throw Object.assign(Error('conflict'), { code: 'MINT_EVIDENCE_CONFLICT' }); },
    { intervalMs: 5, maxBackoffMs: 10, timeoutMs: 100 });
  t.after(lane.close); lane.start(); await pause(20); await lane.refresh();
  assert.equal(lane.snapshot().phase, 'safety-halted'); assert.equal(attempts, 1);
});
test('an unknown assertion blocks only its lane, records redacted details and permits explicit operator refresh', async t => {
  let fail = true, attempts = 0;
  const lane = createReadRecovery(async () => {
    attempts++; if (fail) assert.equal('private actual', 'private expected');
  }, { intervalMs: 5, maxBackoffMs: 10, timeoutMs: 100 });
  t.after(lane.close); lane.start(); await pause(20);
  assert.equal(lane.snapshot().phase, 'blocked'); assert.equal(lane.snapshot().kind, 'service');
  assert.equal(lane.snapshot().code, 'ERR_ASSERTION'); await lane.wake(); assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(lane.snapshot()), /private|actual|expected|stack/);
  fail = false; await lane.refresh(); assert.equal(lane.snapshot().phase, 'ready');
});
test('read diagnostics survive restart and never persist raw errors, credentials or assertion values', t => {
  const path = directory(t), cache = createSepoliaGalleryCache(plan, path);
  const failure = Object.assign(TypeError('https://private.example/SECRET'), {
    code: 'SECRET_CODE', readSource: 'primary', readMethod: 'eth_call', httpStatus: 503,
    actual: 'PRIVATE_ACTUAL', expected: 'PRIVATE_EXPECTED', stack: 'SECRET_STACK', url: 'SECRET_URL' });
  cache.recordReadFailure('sale', failure);
  const body = readFileSync(join(path, 'read-diagnostics.json'), 'utf8');
  assert.doesNotMatch(body, /SECRET|PRIVATE|private|actual|expected|stack|https/);
  assert.equal(cache.state().safetyHalted, false); assert.equal(cache.state().lastReadFailure.kind, 'service');
  const restored = createSepoliaGalleryCache(plan, path);
  assert.equal(restored.state().lastReadFailure.method, 'eth_call'); assert.equal(restored.state().lastReadFailure.code, 'READ_SERVICE_BLOCKED');
  for (let i = 0; i < 40; i++) restored.recordReadFailure('observer', transient());
  assert.equal(JSON.parse(readFileSync(join(path, 'read-diagnostics.json'), 'utf8')).payload.failures.length, 32);
  assert.equal(readFailureDiagnostic({ code: 'MINT_EVIDENCE_CONFLICT', integrityCheck: 'SECRET' }).integrityCheck, undefined);
});
test('gallery outage does not revoke sale readiness; transient sale refresh keeps a recent verified sale', () => {
  const now = 1000, binding = {}, history = { at: now, mints: new Map([['alice', mint]]) }, sale = { at: now };
  const healthySale = capabilityHealth({ binding, sale, history, observerError: transient(), now });
  assert.equal(healthySale.mintReady, true); assert.equal(healthySale.galleryAvailable, true);
  assert.equal(galleryAvailabilityNotice(healthySale), undefined); assert.equal(mintAvailabilityNotice(healthySale), undefined);
  const healthyGallery = capabilityHealth({ binding, snapshot: history, sale, saleError: transient(), now });
  assert.equal(healthyGallery.mintReady, true); assert.equal(healthyGallery.observerHealthy, true);
  assert.equal(healthyGallery.mintState, 'ready'); assert.equal(healthyGallery.saleReadState, 'retrying');
  assert.equal(galleryAvailabilityNotice(healthyGallery), undefined);
  assert.equal(mintAvailabilityNotice(healthyGallery), undefined);
  assert.equal(capabilityHealth({ binding, sale, conflict: true, now }).mintReady, false);
  assert.equal(capabilityHealth({ binding, sale, now: now + 90001 }).mintReady, false);
  assert.equal(capabilityHealth({ binding, sale: { ...sale, sale: { paused: true } }, now }).mintReady, false);
});
test('transient sale retries never extend the original verified window or bypass admission blockers', () => {
  const at = 1000, binding = {}, sale = { at, sale: { paused: false } };
  const recent = (overrides = {}) => capabilityHealth({ binding, sale, saleError: transient(), now: at + 90000, ...overrides });
  const lastFresh = recent();
  assert.equal(lastFresh.mintReady, true); assert.equal(lastFresh.saleReadState, 'retrying');
  assert.equal(lastFresh.lastSaleCheckedAt, at); assert.equal(mintAvailabilityNotice(lastFresh), undefined);
  const expired = recent({ now: at + 90001 });
  assert.equal(expired.mintReady, false); assert.equal(expired.mintState, 'unavailable');
  assert.equal(expired.saleReadState, 'unavailable'); assert.equal(expired.lastSaleCheckedAt, at);
  assert.match(mintAvailabilityNotice(expired), /Mint availability cannot be checked/);
  for (const saleError of [transient(), Object.assign(Error('read timeout'), { code: 'RPC_DATA_UNAVAILABLE' }),
    new DOMException('read timeout', 'TimeoutError'), new DOMException('read cancelled', 'AbortError')]) {
    assert.equal(recent({ saleError }).mintReady, true);
  }
  for (const overrides of [{ binding: undefined }, { sale: undefined }, { now: at - 1 },
    { bootstrapError: transient() }, { bootstrapError: Error('service') },
    { saleError: Error('service') }, { saleError: { code: 'ERR_ASSERTION' } },
    { saleError: { code: 'MINT_EVIDENCE_CONFLICT', retryableRead: true } },
    { saleError: { code: 'OWNERSHIP_EVIDENCE_CONFLICT', retryableRead: true } },
    { sale: { ...sale, sale: { paused: true } } }, { conflict: true }]) {
    const blocked = recent(overrides);
    assert.equal(blocked.mintReady, false); assert.equal(galleryAvailabilityNotice(blocked), undefined);
  }
  const paused = recent({ sale: { ...sale, sale: { paused: true } } });
  assert.equal(paused.mintState, 'paused'); assert.equal(mintAvailabilityNotice(paused), undefined);
  const blocked = recent({ saleError: Error('service') });
  assert.equal(blocked.saleReadState, 'unavailable'); assert.match(mintAvailabilityNotice(blocked), /Mint availability/);
  const recovered = recent({ saleError: undefined });
  assert.equal(recovered.mintReady, true); assert.equal(recovered.saleReadState, 'current');
});
test('idle age, startup and pause are not outages; a verified empty gallery remains available', () => {
  const now = 200000, old = { at: now - 90001, mints: new Map() };
  const cached = capabilityHealth({ binding: {}, snapshot: old, sale: { at: old.at }, now });
  assert.equal(cached.galleryAvailable, true); assert.equal(cached.observerHealthy, false);
  assert.equal(cached.galleryState, 'cached'); assert.equal(cached.mintState, 'checking');
  assert.equal(cached.mintReady, false); assert.equal(galleryAvailabilityNotice(cached), undefined);
  const cold = capabilityHealth({ now });
  assert.equal(cold.galleryState, 'checking'); assert.equal(cold.galleryAvailable, false);
  assert.equal(galleryAvailabilityNotice(cold), undefined);
  const paused = capabilityHealth({ binding: {}, snapshot: { ...old, at: now },
    sale: { at: now, sale: { paused: true } }, now });
  assert.equal(paused.mintState, 'paused'); assert.equal(paused.mintReady, false);
  assert.equal(galleryAvailabilityNotice(paused), undefined);
  assert.equal(galleryAvailabilityNotice(capabilityHealth({ history: old, relayError: 'RPC_DATA_UNAVAILABLE', now })), undefined);
  assert.equal(capabilityHealth({ binding: {}, sale: { at: old.at, sale: { paused: true } }, now }).mintState, 'checking');
});

test('request-driven recovery respects outage backoff without replacing explicit refresh', async t => {
  let attempts = 0;
  const lane = createReadRecovery(async () => { attempts++; throw transient(); },
    { autoSchedule: false, intervalMs: 50, maxBackoffMs: 100, timeoutMs: 100 });
  t.after(lane.close); await lane.wake();
  await Promise.all(Array.from({ length: 20 }, () => lane.wake()));
  assert.equal(attempts, 1); await lane.refresh(); assert.equal(attempts, 2);
});
test('viewer failures remain silent regardless of duration, cache presence or integrity; mint notices retain admission gates', () => {
  const since = 1000000, history = { at: 1, mints: new Map([['alice', mint]]) };
  const health = (now, overrides = {}) => capabilityHealth({ history, binding: {},
    sale: { at: now }, relayError: 'RPC_DATA_UNAVAILABLE', galleryFailureSince: since, now, ...overrides });
  for (const elapsed of [0, 180000, 86400000]) {
    const current = health(since + elapsed);
    assert.equal(current.galleryState, 'unavailable'); assert.equal(current.observerHealthy, false);
    assert.equal(Object.hasOwn(current, 'galleryWarningDeferred'), false); assert.equal(current.mintReady, true);
    assert.equal(current.galleryFailureSince, since); assert.equal(mintAvailabilityNotice(current), undefined);
    assert.equal(galleryAvailabilityNotice(current), undefined);
  }
  // Diagnostics are retained; neither missing data nor conflict makes a
  // passive viewer responsible for fixing the relay's upstream dependencies.
  for (const overrides of [{ history: undefined }, { galleryFailureSince: undefined },
    { galleryFailureSince: since + 1 }, { galleryFailureSince: NaN }, { conflict: true }]) {
    assert.equal(Object.hasOwn(health(since, overrides), 'galleryWarningDeferred'), false);
    assert.equal(galleryAvailabilityNotice(health(since, overrides)), undefined);
  }
  const admissionFailure = health(since, { saleError: transient(), sale: { at: since - 90001 } });
  assert.equal(admissionFailure.mintReady, false); assert.match(mintAvailabilityNotice(admissionFailure), /Mint availability/);
  const halted = health(since, { conflict: true });
  assert.equal(halted.mintReady, false); assert.match(mintAvailabilityNotice(halted), /before minting can continue/);
  const recovered = health(since + 180000, { relayError: undefined });
  assert.equal(recovered.galleryState, 'cached'); assert.equal(recovered.galleryFailureSince, undefined);
  assert.equal(galleryAvailabilityNotice(recovered), undefined);
  const empty = health(since, { history: { at: 1, mints: new Map() } });
  assert.equal(empty.galleryAvailable, true); assert.equal(galleryAvailabilityNotice(empty), undefined);
  for (const state of ['ready', 'checking', 'paused']) assert.equal(mintAvailabilityNotice({ mintState: state }), undefined);
});
test('recovery preserves the first failure across retry/checking and clears it only on success', async t => {
  let fail = true, release;
  const lane = createReadRecovery(async () => {
    if (release === null) await new Promise(resolve => { release = resolve; });
    if (fail) throw transient();
  }, { autoSchedule: false, intervalMs: 5, maxBackoffMs: 10, timeoutMs: 1000 });
  t.after(lane.close); await lane.refresh();
  const first = lane.snapshot().firstFailedAt; assert.ok(Number.isSafeInteger(first));
  await pause(2); release = null; const second = lane.refresh();
  await pause(2); assert.equal(lane.snapshot().phase, 'checking');
  assert.equal(lane.snapshot().firstFailedAt, first); release(); await second;
  assert.equal(lane.snapshot().firstFailedAt, first);
  fail = false; await lane.refresh(); assert.equal(lane.snapshot().firstFailedAt, undefined);
  await pause(2); fail = true; await lane.refresh(); assert.ok(lane.snapshot().firstFailedAt > first);
});
test('mint preflight uses pinned mutable state without a gallery scan, on-chain write or signature', async () => {
  const calls = [], abi = loadPulseArtifact().abi;
  const current = { ...head, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
  const sale = { phase: 1, paused: false, freeMinted: 2n, freeSlotCount: 2n, freeDeadline: 1n, paidStartTime: 1n, endReason: 1, lastPaidMintBlock: 1n };
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'eth_getBlockByNumber') return current;
    if (method === 'eth_getCode') return '0x';
    assert.equal(method, 'eth_call'); assert.equal(params[1], current.number);
    const { functionName } = decodeFunctionData({ abi, data: params[0].data });
    const values = { saleStatus: sale, trustedAuthorizer: address, getCurrentPrice: 1n, mintedHandle: false };
    assert.ok(Object.hasOwn(values, functionName));
    return encodeFunctionResult({ abi, functionName, result: values[functionName] });
  };
  const result = await readSepoliaMintState({ rpc }, { collection: address, authorizer: address }, { allowlist: { proofs: [] } }, { wallet: address, handle: 'alice' });
  assert.equal(result.paid, true); assert.equal(result.minted, false); assert.equal(result.priceWei, '1');
  assert.ok(calls.every(method => ['eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method)));
});
test('independent preflight checks exact wallet slots, pause, claimed slots, authorizer and unchanged canonical head', async () => {
  const abi = loadPulseArtifact().abi, current = { ...head, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
  const sale = { phase: 0, paused: false, freeMinted: 0n, freeSlotCount: 2n, freeDeadline: BigInt(current.timestamp) + 100n,
    paidStartTime: 0n, endReason: 0, lastPaidMintBlock: 0n };
  let claimed = false, changedAuthority = false, changedHead = false;
  const rpc = async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { ...current, hash: changedHead && params[0] === current.number ? '0x' + 'cc'.repeat(32) : hash };
    if (method === 'eth_getCode') return '0x';
    assert.equal(method, 'eth_call'); assert.equal(params[1], current.number);
    const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
    if (functionName === 'isFreeSlotClaimed') assert.equal(args[0], 9n);
    const values = { saleStatus: sale, trustedAuthorizer: changedAuthority ? '0x' + '22'.repeat(20) : address, isFreeSlotClaimed: claimed, mintedHandle: false };
    assert.ok(Object.hasOwn(values, functionName)); return encodeFunctionResult({ abi, functionName, result: values[functionName] });
  };
  const binding = { collection: address, authorizer: address }, plan = { allowlist: { proofs: [{ wallet: address, slotId: '9' }] } };
  const read = () => readSepoliaMintState({ rpc }, binding, plan, { wallet: address, handle: 'alice' });
  assert.equal((await read()).slot, '9'); assert.equal((await read()).free, true);
  claimed = true; assert.equal((await read()).free, false);
  claimed = false; sale.paused = true; assert.equal((await read()).free, false); sale.paused = false;
  changedAuthority = true; await assert.rejects(read()); changedAuthority = false;
  changedHead = true; await assert.rejects(read());
});
