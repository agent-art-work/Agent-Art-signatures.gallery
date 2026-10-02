import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionResult } from 'viem';
import { createSepoliaGalleryCache } from '../../scripts/pulse-sepolia-cache.mjs';
import { reviewSepoliaSafetyHalt, applySepoliaSafetyReview } from '../../scripts/pulse-sepolia-safety-review.mjs';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { INPUT_PROFILE } from './pulse-sepolia-plan.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';

const hash = '0x' + 'ab'.repeat(32), address = '0x' + '11'.repeat(20);
const plan = { digest: hash, collection: { address }, renderer: { identity: hash, runtimeCodeHash: hash } };
const mint = { handle: 'alice', renderHandle: 'Alice', mbti: 'INTJ', tokenId: String(BigInt(openMintHandleKey('alice'))),
  transactionHash: hash, block: '0xf0', blockHash: hash, inputDigest: generativeInputDigest('Alice', 'INTJ', hash, INPUT_PROFILE),
  assessmentDigest: hash, wallet: address, state: 'minted' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
const header = number => ({ number, hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-safety-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cache = createSepoliaGalleryCache(plan, directory);
  cache.save({ at: Date.now(), head: header('0x100'), mints: new Map([['alice', mint]]) }, header('0xf5'), new Map([[hash + ':' + hash, svg]]));
  cache.invalidate();
  const state = { at: Date.now(), head: header('0x100'), sale: { phase: 0, freeMinted: 1n } };
  const reads = [];
  const args = { plan, journal: {}, directory,
    context: { rpc: async (method, params) => {
      reads.push(method); assert.ok(['eth_getBlockByNumber', 'eth_call'].includes(method), 'Read-only review');
      if (method === 'eth_call') return encodeFunctionResult({ abi: loadPulseArtifact().abi, functionName: 'getPulseState',
        result: { epochIndex: 1n, openTime: 1n, curveStartTime: 1n, anchorTime: 1n, floorPrice: 1n } });
      return header(params[0] === 'finalized' ? '0xff' : params[0]);
    } },
    verify: async () => ({ testOnly: true, deployment: { finalized: true }, collection: address }),
    receipt: async () => ({ state: 'minted', mint: { ...mint }, svg }),
    mintState: async () => ({ ...state, sale: { ...state.sale }, head: { ...state.head } }) };
  return { args, directory, reads, state, cache };
}
test('operator recovery revalidates finalized evidence, archives originals and releases only the old halt', async t => {
  const f = fixture(t);
  const original = readFileSync(join(f.directory, 'gallery-cache.json'));
  const halt = readFileSync(join(f.directory, 'gallery-safety-halt.json'));
  const review = await reviewSepoliaSafetyHalt(f.args);
  assert.equal(review.mintCount, 1); assert.equal(createSepoliaGalleryCache(plan, f.directory).state().safetyHalted, true);
  assert.throws(() => { review.finalized.hash = 'forged'; }, TypeError);
  const applied = applySepoliaSafetyReview(review);
  assert.equal(applied.applied, true); assert.equal(existsSync(join(f.directory, 'site.lock')), false);
  assert.equal(existsSync(join(f.directory, 'gallery-safety-halt.json')), false);
  assert.deepEqual(readFileSync(join(applied.archive, 'original-gallery-cache.json')), original);
  assert.deepEqual(readFileSync(join(applied.archive, 'original-gallery-safety-halt.json')), halt);
  assert.equal(statSync(join(applied.archive, 'review.json')).mode & 0o077, 0);
  const restored = createSepoliaGalleryCache(plan, f.directory);
  assert.equal(restored.state().safetyHalted, false); assert.equal(restored.state().error, undefined);
  assert.equal(restored.checkpoint().mints.length, 1); assert.equal(restored.artworks().size, 1);
  assert.ok(f.reads.length > 0); assert.throws(() => applySepoliaSafetyReview(review), /in-process/);
});
test('operator recovery cannot be manufactured from a JSON report', () => {
  assert.throws(() => applySepoliaSafetyReview({ schema: 'sg-pulse-safety-review/v1' }), /in-process/);
});
test('recovery refuses conflicting receipts, SVGs, deployment and finalized anchors without editing evidence', async t => {
  for (const kind of ['receipt', 'svg', 'deployment', 'anchor']) {
    const f = fixture(t), original = readFileSync(join(f.directory, 'gallery-cache.json'));
    if (kind === 'receipt') f.args.receipt = async () => ({ state: 'minted', mint: { ...mint, mbti: 'ENTJ' }, svg });
    if (kind === 'svg') f.args.receipt = async () => ({ state: 'minted', mint: { ...mint }, svg: '<svg>different</svg>' });
    if (kind === 'deployment') f.args.verify = async () => { throw Object.assign(Error('conflict'), { code: 'MINT_EVIDENCE_CONFLICT' }); };
    if (kind === 'anchor') { const rpc = f.args.context.rpc; f.args.context.rpc = async (...args) => {
      const result = await rpc(...args); return args[1][0] === '0xf5' ? { ...result, hash: '0x' + 'cd'.repeat(32) } : result;
    }; }
    await assert.rejects(reviewSepoliaSafetyHalt(f.args), error => error.code === 'MINT_EVIDENCE_CONFLICT');
    assert.deepEqual(readFileSync(join(f.directory, 'gallery-cache.json')), original);
    assert.equal(createSepoliaGalleryCache(plan, f.directory).state().safetyHalted, true);
  }
});
test('recovery refuses incomplete collection, pending evidence, outages and corrupt saved input', async t => {
  for (const kind of ['counter', 'pending', 'outage', 'corrupt']) {
    const f = fixture(t);
    if (kind === 'counter') f.state.sale = { phase: 1, freeMinted: 1n }; // One extra paid mint is absent from the saved set.
    if (kind === 'pending') f.args.receipt = async () => ({ state: 'pending' });
    if (kind === 'outage') f.args.mintState = async () => { throw Object.assign(Error('outage'), { retryableRead: true }); };
    if (kind === 'corrupt') writeFileSync(join(f.directory, 'gallery-cache.json'), 'corrupt');
    await assert.rejects(reviewSepoliaSafetyHalt(f.args));
    assert.equal(existsSync(join(f.directory, 'gallery-safety-halt.json')), true);
  }
});
test('recovery refuses a running site and a changed input file; neither clears the halt', async t => {
  for (const kind of ['running', 'cache', 'marker']) {
    const f = fixture(t), review = await reviewSepoliaSafetyHalt(f.args);
    if (kind === 'running') writeFileSync(join(f.directory, 'site.lock'), String(process.pid));
    else writeFileSync(join(f.directory, kind === 'cache' ? 'gallery-cache.json' : 'gallery-safety-halt.json'), 'changed');
    assert.throws(() => applySepoliaSafetyReview(review), /Stop the site|changed during review/);
    assert.equal(existsSync(join(f.directory, 'gallery-safety-halt.json')), true);
  }
});
test('recovery approval expires and an ahead-of-head finalized tag is unavailable rather than an integrity conflict', async t => {
  const f = fixture(t), review = await reviewSepoliaSafetyHalt(f.args), now = Date.now;
  try {
    Date.now = () => now() + 90001;
    assert.throws(() => applySepoliaSafetyReview(review), /expired/);
  } finally { Date.now = now; }
  assert.equal(existsSync(join(f.directory, 'gallery-safety-halt.json')), true);
  const g = fixture(t), rpc = g.args.context.rpc;
  g.args.context.rpc = async (...args) => {
    const result = await rpc(...args); return args[1][0] === 'finalized' ? { ...result, number: '0x101' } : result;
  };
  await assert.rejects(reviewSepoliaSafetyHalt(g.args), { code: 'RPC_DATA_UNAVAILABLE' });
  assert.equal(existsSync(join(g.directory, 'gallery-safety-halt.json')), true);
});
