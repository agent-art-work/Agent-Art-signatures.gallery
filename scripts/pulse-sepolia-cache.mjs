import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, readFileSync, closeSync, writeFileSync, fsyncSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress } from 'viem';
import { canonicalHandle, preservedHandle, isMbti } from '../src/openMint/identity.ts';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';
import { INPUT_PROFILE } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { readFailureDiagnostic } from './pulse-sepolia-recovery.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fields = ['handle', 'renderHandle', 'mbti', 'tokenId', 'transactionHash', 'block', 'blockHash', 'inputDigest', 'assessmentDigest', 'wallet', 'state'];
const hash = value => assert.match(value, /^0x[a-f0-9]{64}$/);
const quantity = value => { assert.match(value, /^0x(?:0|[1-9a-f][a-f0-9]*)$/); return BigInt(value); };
const cacheKey = mint => mint.transactionHash + ':' + mint.blockHash;
const publicMint = mint => Object.fromEntries(fields.map(field => [field, mint[field]]));

/** A private, atomic cache of public presentation data ONLY. A checksum detects
 * corruption, not malicious privileged edits. Restored records are never live
 * chain authority; the observer must independently revalidate a checkpoint. */
export function createSepoliaGalleryCache(plan, directory) {
  const path = resolve(directory, 'gallery-cache.json');
  const haltPath = resolve(directory, 'gallery-safety-halt.json');
  const diagnosticsPath = resolve(directory, 'read-diagnostics.json');
  const diagnostics = [];
  const lanes = ['validation', 'bootstrap', 'sale', 'observer', 'artwork', 'relay', 'ownership'];
  let error, payload, revision = 0, safetyHalted = false;
  const pins = { planDigest: plan.digest, collection: getAddress(plan.collection.address),
    rendererIdentity: plan.renderer.identity, rendererRuntimeCodeHash: plan.renderer.runtimeCodeHash };
  function validateMint(mint) {
    assert.deepEqual(Object.keys(mint).sort(), fields.slice().sort());
    assert.equal(canonicalHandle(mint.handle), mint.handle); assert.equal(preservedHandle(mint.renderHandle), mint.renderHandle);
    assert.equal(canonicalHandle(mint.renderHandle), mint.handle); assert.ok(isMbti(mint.mbti));
    assert.equal(mint.tokenId, String(BigInt(openMintHandleKey(mint.handle))));
    assert.ok(['minted', 'confirming'].includes(mint.state)); getAddress(mint.wallet);
    for (const field of ['transactionHash', 'blockHash', 'inputDigest', 'assessmentDigest']) hash(mint[field]);
    quantity(mint.block);
    assert.equal(mint.inputDigest, generativeInputDigest(mint.renderHandle, mint.mbti, pins.rendererIdentity, INPUT_PROFILE));
  }
  function validate(value) {
    assert.deepEqual(Object.keys(value).sort(), ['schema', 'pins', 'at', 'head', 'finalized', 'mints', 'artworks', 'invalidated'].sort());
    assert.equal(value.schema, 'sg-pulse-gallery-presentation/v1'); assert.deepEqual(value.pins, pins);
    assert.ok(Number.isSafeInteger(value.at) && value.at > 0 && value.at <= Date.now() + 300000);
    assert.equal(typeof value.invalidated, 'boolean');
    for (const header of [value.head, value.finalized].filter(Boolean)) {
      assert.deepEqual(Object.keys(header).sort(), ['number', 'hash', 'timestamp'].sort());
      quantity(header.number); quantity(header.timestamp); hash(header.hash);
    }
    assert.ok(value.head); if (value.finalized) assert.ok(quantity(value.finalized.number) <= quantity(value.head.number));
    assert.ok(Array.isArray(value.mints) && value.mints.length <= 100);
    const mints = new Map();
    for (const mint of value.mints) {
      validateMint(mint); assert.ok(!mints.has(mint.handle)); mints.set(mint.handle, mint);
      assert.ok(quantity(mint.block) <= quantity(value.head.number));
    }
    assert.ok(Array.isArray(value.artworks) && value.artworks.length <= 100);
    const keys = new Set();
    for (const art of value.artworks) {
      assert.deepEqual(Object.keys(art).sort(), ['handle', 'key', 'svg', 'sha256'].sort());
      assert.ok(mints.has(art.handle)); assert.equal(art.key, cacheKey(mints.get(art.handle)));
      assert.ok(!keys.has(art.key)); keys.add(art.key);
      assert.equal(typeof art.svg, 'string'); assert.ok(art.svg.startsWith('<svg') && Buffer.byteLength(art.svg) <= 16384);
      assert.equal(art.sha256, digest(art.svg));
    }
    return value;
  }
  function atomicWrite(target, value) {
    const body = JSON.stringify(value), envelope = JSON.stringify({ sha256: digest(body), payload: value });
    assert.ok(Buffer.byteLength(envelope) <= 4 * 1024 * 1024);
    const temp = target + '.' + randomUUID(); let fd;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, envelope); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, target);
      const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (failure) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error = 'CACHE_WRITE_UNAVAILABLE'; }
      error = 'CACHE_WRITE_UNAVAILABLE'; throw failure;
    }
  }
  function store(value) { validate(value); atomicWrite(path, value); payload = value; error = undefined; revision++; }
  function readEnvelope(target) {
    const stat = lstatSync(target); assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.size <= 4 * 1024 * 1024);
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value; try { value = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
    assert.deepEqual(Object.keys(value).sort(), ['sha256', 'payload'].sort());
    assert.equal(value.sha256, digest(JSON.stringify(value.payload))); return value.payload;
  }
  try {
    payload = validate(readEnvelope(path)); safetyHalted = payload.invalidated;
  } catch (failure) { if (failure.code !== 'ENOENT') error = 'CACHE_INVALID'; }
  try {
    const halt = readEnvelope(haltPath);
    assert.deepEqual(halt, { schema: 'sg-pulse-gallery-safety-halt/v1', pins }); safetyHalted = true;
  } catch (failure) { if (failure.code !== 'ENOENT') { safetyHalted = true; error = 'SAFETY_HALT_INVALID'; } }
  try {
    const saved = readEnvelope(diagnosticsPath);
    assert.equal(saved.schema, 'sg-pulse-read-diagnostics/v1'); assert.deepEqual(saved.pins, pins);
    assert.ok(Array.isArray(saved.failures) && saved.failures.length <= 32);
    for (const row of saved.failures) {
      assert.ok(lanes.includes(row.lane) && Number.isSafeInteger(row.at) && row.at > 0);
      diagnostics.push({ lane: row.lane, at: row.at, ...readFailureDiagnostic({ code: row.code, name: row.name,
        retryableRead: row.kind === 'transient', readSource: row.source, readMethod: row.method,
        httpStatus: row.httpStatus, rpcErrorCode: row.rpcCode, operator: row.operator, integrityCheck: row.integrityCheck }) });
    }
  } catch { /* Diagnostics never become chain authority or a safety halt. */ }
  return Object.freeze({
    state: () => ({ revision, error, safetyHalted, savedAt: payload?.at, mintCount: payload?.mints.length ?? 0,
      lastReadFailure: diagnostics.at(-1) && { ...diagnostics.at(-1) } }),
    presentation() { if (!payload) return undefined; return { at: payload.at, head: { ...payload.head },
      mints: new Map(payload.mints.map(mint => [mint.handle, { ...mint }])), invalidated: safetyHalted }; },
    checkpoint() { if (!payload?.finalized || safetyHalted) return undefined;
      return { finalized: { ...payload.finalized }, mints: payload.mints.filter(mint => mint.state === 'minted').map(mint => ({ ...mint })) }; },
    // Operator-review input ONLY. Runtime must still use checkpoint(), which
    // refuses halted data. Every returned receipt/input must be revalidated.
    reviewCandidate() { if (!payload?.finalized) return undefined;
      return { finalized: { ...payload.finalized }, mints: payload.mints.filter(mint => mint.state === 'minted').map(mint => ({ ...mint })) }; },
    artworks: () => new Map((payload?.artworks ?? []).map(art => [art.key, art.svg])),
    recordReadFailure(lane, failure) {
      assert.ok(lanes.includes(lane));
      diagnostics.push({ lane, at: Date.now(), ...readFailureDiagnostic(failure) });
      if (diagnostics.length > 32) diagnostics.shift();
      atomicWrite(diagnosticsPath, { schema: 'sg-pulse-read-diagnostics/v1', pins, failures: diagnostics });
    },
    save(snapshot, checkpoint, artworks) {
      assert.equal(safetyHalted, false, 'Safety halt requires operator review');
      const mints = [...snapshot.mints.values()].map(publicMint), keys = new Set(mints.map(cacheKey));
      store({ schema: 'sg-pulse-gallery-presentation/v1', pins, at: snapshot.at,
        head: { number: snapshot.head.number, hash: snapshot.head.hash, timestamp: snapshot.head.timestamp },
        finalized: checkpoint ? { number: checkpoint.number, hash: checkpoint.hash, timestamp: checkpoint.timestamp } : null,
        mints, artworks: mints.filter(mint => artworks.has(cacheKey(mint))).map(mint => ({ handle: mint.handle,
          key: cacheKey(mint), svg: artworks.get(cacheKey(mint)), sha256: digest(artworks.get(cacheKey(mint))) })), invalidated: false });
      assert.ok(keys.size <= 100);
    },
    invalidate() {
      // Persist even before the first observed mint. A restart must not clear a
      // real chain/configuration conflict just because the gallery was empty.
      safetyHalted = true;
      atomicWrite(haltPath, { schema: 'sg-pulse-gallery-safety-halt/v1', pins });
      if (payload && !payload.invalidated) store({ ...payload, invalidated: true });
    },
  });
}
