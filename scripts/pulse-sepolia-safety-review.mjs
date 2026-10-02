import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIR, loadPlan, loadJournal, readOnlyContext, checkNetwork, verifyDeploymentAtSource, sharedReadBlock, readContract } from './pulse-sepolia.mjs';
import { createSepoliaReadFailover, withSepoliaReadSource, requireRpcData, requireSepoliaIntegrity } from './pulse-sepolia-rpc.mjs';
import { createSepoliaGalleryCache } from './pulse-sepolia-cache.mjs';
import { observeSepoliaMintReceipt, readSepoliaMintState } from './pulse-sepolia-site.mjs';
import { readFailureDiagnostic } from './pulse-sepolia-recovery.mjs';

const reviews = new WeakMap();
const sha = value => createHash('sha256').update(value).digest('hex');
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item)
  : item instanceof Map ? [...item] : item);
const fields = ['handle', 'renderHandle', 'mbti', 'tokenId', 'transactionHash', 'block', 'blockHash',
  'inputDigest', 'assessmentDigest', 'wallet', 'state'];
const key = row => row.transactionHash + ':' + row.blockHash;
const syncDirectory = directory => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
function durableArchive(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Explicit operator review, never a startup/HTTP recovery shortcut. Revalidate
 * every saved finalized receipt, immutable input and SVG; prove completeness
 * against the frozen non-burnable contract's current mint counter. No keys,
 * signatures, broadcasts, price changes or two-provider runtime quorum. */
export async function reviewSepoliaSafetyHalt({ plan = loadPlan(), journal = loadJournal(), directory = DIR,
  context, verify = verifyDeploymentAtSource, receipt = observeSepoliaMintReceipt, mintState = readSepoliaMintState } = {}) {
  const cachePath = resolve(directory, 'gallery-cache.json'), haltPath = resolve(directory, 'gallery-safety-halt.json');
  const originalCache = readFileSync(cachePath), originalHalt = readFileSync(haltPath);
  const cache = createSepoliaGalleryCache(plan, directory), candidate = cache.reviewCandidate();
  assert.equal(cache.state().safetyHalted, true, 'No safety halt to review');
  assert.equal(cache.state().error, undefined, 'Corrupt safety/cache files cannot be approved');
  assert.ok(candidate?.mints.length, 'Missing finalized evidence requires a separate full review');
  const c = context ?? createSepoliaReadFailover(readOnlyContext(), checkNetwork);
  const binding = await withSepoliaReadSource(c, source => verify(source, plan, journal),
    { signal: AbortSignal.timeout(150000), sourceTimeoutMs: 60000 });
  assert.equal(binding.testOnly, true); assert.equal(binding.deployment.finalized, true);
  const artworks = new Map(), mints = new Map(), cachedArt = cache.artworks();
  for (const saved of candidate.mints) {
    const observed = await withSepoliaReadSource(c, source => receipt(source, binding, {
      handle: saved.handle, wallet: saved.wallet, transactionHash: saved.transactionHash }),
    { signal: AbortSignal.timeout(150000), sourceTimeoutMs: 60000 });
    assert.equal(observed.state, 'minted', 'Review needs finalized receipt evidence');
    for (const field of fields) requireSepoliaIntegrity(observed.mint[field] === saved[field], 'MINT_INPUT');
    assert.ok(typeof observed.svg === 'string' && observed.svg.startsWith('<svg'));
    if (cachedArt.has(key(saved))) requireSepoliaIntegrity(cachedArt.get(key(saved)) === observed.svg, 'MINT_INPUT');
    mints.set(saved.handle, { ...observed.mint }); artworks.set(key(saved), observed.svg);
  }
  const snapshot = await withSepoliaReadSource(c, async source => {
    const state = await mintState(source, binding, plan);
    const finalized = await sharedReadBlock(source, 'finalized');
    if (BigInt(finalized.number) > BigInt(state.head.number))
      throw Object.assign(Error('Head moved during review'), { code: 'RPC_DATA_UNAVAILABLE', retryableRead: true });
    assert.ok(BigInt(finalized.number) >= BigInt(candidate.finalized.number));
    requireSepoliaIntegrity(requireRpcData(await source.rpc('eth_getBlockByNumber', [candidate.finalized.number, false])).hash
      === candidate.finalized.hash, 'FINALIZED_ANCHOR');
    const paid = state.sale.phase === 1
      ? (await readContract(source.rpc, binding.collection, 'getPulseState', [], state.head.number)).epochIndex : 0n;
    // If new works exist, this narrow recovery deliberately refuses approval.
    // An operator must reconcile them with a full observer scan instead.
    assert.equal(BigInt(mints.size), BigInt(state.sale.freeMinted) + BigInt(paid), 'Saved finalized set is not the complete current collection');
    assert.ok([...mints.values()].every(row => BigInt(row.block) <= BigInt(finalized.number)));
    if (requireRpcData(await source.rpc('eth_getBlockByNumber', [state.head.number, false])).hash !== state.head.hash)
      throw Object.assign(Error('Head moved during review'), { code: 'RPC_DATA_UNAVAILABLE', retryableRead: true });
    return { at: Date.now(), head: state.head, finalized, finalNumber: BigInt(finalized.number),
      mints, sale: state.sale, expectedMintCount: mints.size, readSource: source.readSource };
  }, { signal: AbortSignal.timeout(150000), sourceTimeoutMs: 60000 });
  const review = Object.freeze({ schema: 'sg-pulse-safety-review/v1', collection: plan.collection.address,
    checkedAt: new Date(snapshot.at).toISOString(), mintCount: mints.size,
    finalized: Object.freeze({ number: snapshot.finalized.number, hash: snapshot.finalized.hash, timestamp: snapshot.finalized.timestamp }),
    originalCacheSha256: sha(originalCache), originalHaltSha256: sha(originalHalt) });
  reviews.set(review, { plan: structuredClone(plan), directory, originalCache, originalHalt,
    snapshot: structuredClone(snapshot), artworks: new Map(artworks) });
  return review;
}

/** Apply only a successful review created in this process, with the site stopped
 * and its exact input files unchanged. Archive originals before replacement;
 * the marker is removed LAST, so interrupted repair remains fail-closed. */
export function applySepoliaSafetyReview(review) {
  const verified = reviews.get(review); assert.ok(verified, 'Successful in-process chain review required');
  const { plan, directory, originalCache, originalHalt, snapshot, artworks } = verified;
  assert.equal(existsSync(resolve(directory, 'site.lock')), false, 'Stop the site before applying a safety review');
  const cachePath = resolve(directory, 'gallery-cache.json'), haltPath = resolve(directory, 'gallery-safety-halt.json');
  assert.equal(sha(readFileSync(cachePath)), review.originalCacheSha256, 'Cache changed during review');
  assert.equal(sha(readFileSync(haltPath)), review.originalHaltSha256, 'Safety marker changed during review');
  assert.ok(Date.now() >= snapshot.at && Date.now() - snapshot.at <= 90000, 'Review expired; revalidate before applying');
  // Use the site's own exclusive lock during the replacement too, so a
  // concurrent launcher cannot start between the stopped check and commit.
  const lock = resolve(directory, 'site.lock'), fd = openSync(lock, 'wx', 0o600);
  let closed = false;
  try {
    writeFileSync(fd, String(process.pid)); closeSync(fd); closed = true;
    const archive = mkdtempSync(resolve(directory, 'safety-review-'));
    durableArchive(resolve(archive, 'original-gallery-cache.json'), originalCache);
    durableArchive(resolve(archive, 'original-gallery-safety-halt.json'), originalHalt);
    durableArchive(resolve(archive, 'review.json'), serialize(review));
    syncDirectory(archive);
    const replacement = createSepoliaGalleryCache(plan, archive); replacement.save(snapshot, snapshot.finalized, artworks);
    renameSync(resolve(archive, 'gallery-cache.json'), cachePath);
    syncDirectory(directory);
    unlinkSync(haltPath);
    syncDirectory(directory);
    reviews.delete(review);
    return { ...review, applied: true, archive };
  } finally { if (!closed) closeSync(fd); unlinkSync(lock); syncDirectory(directory); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--apply');
  try {
    const review = await reviewSepoliaSafetyHalt();
    console.log(serialize(process.argv[2] === '--apply' ? applySepoliaSafetyReview(review) : review));
  } catch (error) { console.error(serialize({ reviewApproved: false, ...readFailureDiagnostic(error) })); process.exitCode = 1; }
}
