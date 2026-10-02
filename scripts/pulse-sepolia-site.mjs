import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, openSync, closeSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeEventTopics, decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, keccak256, stringToHex, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DIR, readOnlyContext, loadPlan, loadJournal, verifyDeploymentAtSource, checkNetwork, readContract, sharedReadBlock, canonicalSepoliaLog, canonicalSepoliaMintReceipt, save } from './pulse-sepolia.mjs';
import { createSepoliaReadFailover, readSources, withSepoliaReadSource, requireRpcData, unavailableRpcData, requireSepoliaIntegrity, SEPOLIA_READ_POLICY } from './pulse-sepolia-rpc.mjs';
import { DEPLOYER, INPUT_PROFILE } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { loadPulseArtifact } from '../contracts/tools/pulse-candidate-lock.mjs';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';
import { pulseMintTypedData, PULSE_PAID_SLOT } from '../src/openMint/pulseAuthorization.ts';
import { PULSE_ADMIN_PROFILE, pulseAdminMintTypedData } from '../src/openMint/pulseAdminAuthorization.ts';
import { verifyAllowlistArtifacts } from '../contracts/tools/pulse-allowlist.mjs';
import { WalletSessions, opaqueCode, fields, PublicError } from '../src/openMint/security.ts';
import { canonicalHandle, preservedHandle, isMbti, MBTI_TYPES, RENDERER_VERSION } from '../src/openMint/identity.ts';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { homePage, mintPage, assessmentPage, revealedSignature, previewPage, previewVariationsPage, mbtiGalleryPage, collectionPage, aboutPage, errorPage, OPEN_MINT_CSS } from '../src/openMint/pages.ts';
import { SITE_CSS } from '../src/v1/siteCss.ts';
import { SITE_FONT_CSS, siteFontAsset } from '../src/v1/fonts.ts';
import { FAVICON_URL, FAVICON_SVG } from '../src/brand/favicon.ts';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../src/brand/sloganMbtiHero.ts';
import { SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT } from '../src/brand/sloganTooltipScript.ts';
import { mintControlStudyPage, MINT_CONTROL_STUDY_PATH, MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_CSS, MINT_CONTROL_STUDY_SCRIPT_PATH, MINT_CONTROL_STUDY_SCRIPT } from '../src/brand/mintControlStudy.ts';
import { renderSignatureSvg } from '../src/algorithmV2/index.ts';
import { SEPOLIA_TEST_CLIENT } from './pulse-sepolia-client.mjs';
import { requireForUser, requireFreshMintSnapshot, checkWalletSupport, publicFailure } from './pulse-sepolia-errors.mjs';
import { createReadRecovery, capabilityHealth, mintAvailabilityNotice, readUnavailable, integrityFailure } from './pulse-sepolia-recovery.mjs';
import { createSepoliaGalleryCache } from './pulse-sepolia-cache.mjs';
import { createSepoliaRelayScheduler } from './pulse-sepolia-relay.mjs';
import { openSepoliaRelayStore } from './pulse-sepolia-relay-store.mjs';
import { observeSepoliaOwnership } from './pulse-sepolia-ownership.mjs';
import { SEPOLIA_READINESS_CLIENT } from './pulse-sepolia-readiness-client.mjs';
import { createSepoliaUiRenderer } from './pulse-sepolia-ui.mjs';
import { inspectSepoliaAttempt, requireExpiredAttemptProof, savedMintAuthorization, validateRecoveryTransaction, sepoliaMintAbi, sepoliaAuthorizationDigest } from './pulse-sepolia-attempt-recovery.mjs';
import { createSepoliaAdminWebService } from './pulse-sepolia-admin-web-service.mjs';
import { sepoliaAdminPage, SEPOLIA_ADMIN_CSS } from './pulse-sepolia-admin-page.mjs';
import { SEPOLIA_ADMIN_CLIENT } from './pulse-sepolia-admin-client.mjs';

// Dedicated disposable rehearsal, NOT a relaxed local-real or hosted staging
// admission path. No provider SDK or deployer unlock is imported/called here.
// Only the isolated unfunded authorizer key enters this process. The optional
// RC2 admin page prepares role-checked calldata for the operator's browser
// wallet; HTTP never unlocks the admin, signs or broadcasts its transactions.
const qty = n => '0x' + BigInt(n).toString(16);
const stringify = v => JSON.stringify(v, (_k, n) => typeof n === 'bigint' ? n.toString() : n);
export function saleNotice(sale) {
  const count = `${sale.freeMinted}/${sale.freeMintQuota ?? sale.freeSlotCount} slots used`;
  if (sale.paused) return 'Minting is paused.';
  if (sale.phase === 1) return sale.endReason === 2
    ? `Free mint ended · Deadline reached · ${count}.`
    : `Free mint ended · ${count}.`;
  return `Free mint open · ${count}.`;
}
/** Public phase presentation is not a wallet quote or mint admission. */
export function publicSaleStatus(sale, now = Math.floor(Date.now() / 1000)) {
  if (!sale) return { phase: 'unknown', paused: false };
  assert.ok(sale.phase === 0 || sale.phase === 1);
  // A previously open free phase cannot still be advertised beyond its known
  // deadline. Wait for a new chain read; never invent a paid price or eligibility.
  if (sale.phase === 0 && sale.freeDeadline !== undefined && BigInt(sale.freeDeadline) <= BigInt(now))
    return { phase: 'unknown', paused: sale.paused === true };
  const used = Number(sale.freeMinted), quota = Number(sale.freeMintQuota ?? sale.freeSlotCount);
  return { phase: sale.phase === 0 ? 'free' : 'paid', paused: sale.paused === true,
    ...(sale.freeConfigRevision !== undefined ? { freeConfigRevision: String(sale.freeConfigRevision) } : {}),
    ...(Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(quota) && quota >= used
      ? { freeMinted: used, freeMintQuota: quota } : {}) };
}
export function fixtureMbti(handle) { return MBTI_TYPES[parseInt(keccak256(stringToHex(canonicalHandle(handle))).slice(2, 4), 16) % 16]; }
/** Durable submission tracking is not collection freshness. In particular,
 * beginning a wallet request does not prove broadcast, and expiry/absence of
 * a reported hash does not prove that it was never broadcast. */
export function submissionTrackingStatus(row) {
  if (!row) return { state: 'not-submitted', submissionStage: 'none' };
  assert.ok(['prepared', 'begun', 'reported', 'expired'].includes(row.stage));
  if (row.stage === 'prepared') return { state: 'not-submitted', submissionStage: 'prepared' };
  if (row.stage === 'begun') return { state: 'submission-unknown', submissionStage: 'begun' };
  if (row.stage === 'expired') return { state: 'retry-allowed', submissionStage: 'expired', attemptCode: row.code };
  assert.match(row.transactionHash, /^0x[a-f0-9]{64}$/);
  return { state: 'pending', submissionStage: 'reported', transactionHash: row.transactionHash };
}
export function testConsent(value) {
  const v = fields(value, ['handle', 'mode', 'maximumETH']);
  const renderHandle = preservedHandle(v.handle), handle = canonicalHandle(renderHandle);
  requireForUser(v.mode === 'free' || v.mode === 'paid', 'INVALID_MODE', 'Mint availability needs to be checked before continuing.');
  requireForUser(typeof v.maximumETH === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(v.maximumETH), 'INVALID_PRICE', 'Enter a valid maximum mint price.');
  const cap = parseEther(v.maximumETH);
  requireForUser(v.mode === 'free' ? cap === 0n : cap > 0n && cap <= 100000000000000n, 'INVALID_PRICE', 'The maximum mint price is 0.0001 Sepolia ETH. Network gas is additional.');
  return { handle, renderHandle, mode: v.mode, cap };
}

/** Inputs cannot change in this frozen collection. Read them and the generated
 * artwork at a recent validated block, instead of requiring a mint-time archive. */
export async function readObservedArtwork(c, at, mint, head, abi = loadPulseArtifact().abi) {
  return withSepoliaReadSource(c, source => readObservedArtworkAtSource(source, at, mint, head, abi));
}
async function readObservedArtworkAtSource(c, at, mint, head, abi) {
  const svgs = await Promise.all(readSources(c).map(async rpc => {
    const inputs = await readContract(rpc, at, 'inputs', [BigInt(mint.tokenId)], head.number, abi);
    requireSepoliaIntegrity(inputs[0] === mint.renderHandle && inputs[1] === mint.mbti, 'MINT_INPUT');
    const svg = await readContract(rpc, at, 'svg', [BigInt(mint.tokenId)], head.number, abi);
    if (requireRpcData(await rpc('eth_getBlockByNumber', [head.number, false])).hash !== head.hash) throw unavailableRpcData();
    return svg;
  }));
  for (const svg of svgs) assert.equal(svg, svgs[0]);
  assert.ok(svgs[0].startsWith('<svg') && svgs[0].length < 16384);
  return svgs[0];
}

function observedMint(binding, log, finalNumber) {
  assert.equal(log.removed, false); assert.equal(getAddress(log.address), getAddress(binding.collection));
  const { args } = decodeEventLog({ abi: sepoliaMintAbi(binding), ...log }), handle = canonicalHandle(args.renderHandle);
  assert.equal(args.handleKey, openMintHandleKey(handle)); assert.equal(args.tokenId, BigInt(args.handleKey)); assert.ok(isMbti(args.mbti));
  assert.equal(args.inputDigest, generativeInputDigest(args.renderHandle, args.mbti, binding.renderer.identity, INPUT_PROFILE));
  return { handle, renderHandle: args.renderHandle, mbti: args.mbti, tokenId: String(args.tokenId), transactionHash: log.transactionHash,
    block: log.blockNumber, blockHash: log.blockHash, inputDigest: args.inputDigest, assessmentDigest: args.assessmentDigest, wallet: args.recipient,
    state: BigInt(log.blockNumber) <= finalNumber ? 'minted' : 'confirming' };
}

/** Fast, read-only reveal evidence for an already reported transaction. This
 * has the same source validation/canonical/immutable-input gates as the observer;
 * a wallet hash alone, pending receipt, failed receipt or source mismatch cannot
 * reveal artwork. No history scan, archive access, signer or broadcast is used. */
export async function observeSepoliaMintReceipt(c, binding, { handle, wallet, transactionHash, attempt }) {
  let receiptSeen = false;
  try { return await withSepoliaReadSource(c, source => observeSepoliaMintReceiptAtSource(source, binding,
    { handle, wallet, transactionHash, attempt }, () => { receiptSeen = true; })); }
  catch (error) {
    // An incomplete attempt that found a receipt cannot be downgraded to
    // "pending" just because the fallback has not indexed that receipt yet.
    if (!receiptSeen && error?.code === 'RPC_DATA_UNAVAILABLE' && error.missingMintReceipt) return { state: 'pending' };
    throw error;
  }
}
async function observeSepoliaMintReceiptAtSource(c, binding, { handle, wallet, transactionHash, attempt }, onReceipt) {
  assert.equal(canonicalHandle(handle), handle); assert.match(transactionHash, /^0x[a-f0-9]{64}$/);
  const sources = readSources(c), receipts = await Promise.all(sources.map(rpc => rpc('eth_getTransactionReceipt', [transactionHash])));
  if (receipts.some(receipt => receipt === null)) {
    if (c.readPolicy === SEPOLIA_READ_POLICY) throw Object.assign(unavailableRpcData(), { missingMintReceipt: true });
    return { state: 'pending' };
  }
  onReceipt();
  const pair = receipts.map(canonicalSepoliaMintReceipt); for (const receipt of pair) assert.deepEqual(receipt, pair[0]);
  const receipt = pair[0]; assert.equal(receipt.transactionHash, transactionHash);
  assert.equal(receipt.from, getAddress(wallet)); assert.equal(receipt.to, getAddress(binding.collection)); assert.equal(receipt.contractAddress, null);
  if (attempt) for (const rpc of sources) {
    const transaction = validateRecoveryTransaction(attempt, binding, transactionHash, await rpc('eth_getTransactionByHash', [transactionHash]));
    assert.equal(transaction.blockHash, receipt.blockHash); assert.equal(BigInt(transaction.blockNumber), BigInt(receipt.blockNumber));
    assert.equal(BigInt(transaction.transactionIndex), BigInt(receipt.transactionIndex));
  }
  const [head, finalized] = await Promise.all([sharedReadBlock(c), sharedReadBlock(c, 'finalized')]);
  assert.ok(BigInt(receipt.blockNumber) >= BigInt(binding.deployment.blockNumber) && BigInt(receipt.blockNumber) <= BigInt(head.number));
  const blocks = await Promise.all(sources.map(rpc => rpc('eth_getBlockByNumber', [receipt.blockNumber, false])));
  for (const value of blocks) { const block = requireRpcData(value); assert.equal(block.number, receipt.blockNumber); assert.equal(block.hash, receipt.blockHash); }
  for (const log of receipt.logs) {
    assert.equal(log.removed, false); assert.equal(log.blockNumber, receipt.blockNumber);
    assert.equal(log.blockHash, receipt.blockHash); assert.equal(log.transactionHash, transactionHash);
    assert.equal(log.transactionIndex, receipt.transactionIndex);
  }
  if (receipt.status === '0x0') { assert.equal(receipt.logs.length, 0); return { state: 'reverted', transactionHash }; }
  const abi = sepoliaMintAbi(binding), topic = encodeEventTopics({ abi, eventName: 'GenerativeSignatureMinted' })[0];
  const logs = receipt.logs.filter(log => getAddress(log.address) === getAddress(binding.collection) && log.topics[0] === topic);
  assert.equal(logs.length, 1);
  const mint = observedMint(binding, logs[0], BigInt(finalized.number));
  if (attempt) {
    const authorization = savedMintAuthorization(binding, attempt), { args } = decodeEventLog({ abi, ...logs[0] });
    assert.equal(args.nonce, authorization.nonce); assert.equal(args.assessmentDigest, authorization.assessmentDigest);
    assert.equal(args.inputDigest, authorization.inputDigest);
    assert.equal(args.authorizationDigest, sepoliaAuthorizationDigest(binding, authorization));
  }
  assert.equal(mint.handle, handle); assert.equal(getAddress(mint.wallet), getAddress(wallet));
  assert.equal(mint.block, receipt.blockNumber); assert.equal(mint.blockHash, receipt.blockHash); assert.equal(mint.transactionHash, transactionHash);
  const transferTopic = encodeEventTopics({ abi, eventName: 'Transfer' })[0];
  const transfers = receipt.logs.filter(log => getAddress(log.address) === getAddress(binding.collection) && log.topics[0] === transferTopic)
    .map(log => decodeEventLog({ abi, ...log }).args);
  assert.equal(transfers.filter(args => args.from === '0x' + '0'.repeat(40) && getAddress(args.to) === getAddress(wallet) && args.tokenId === BigInt(mint.tokenId)).length, 1);
  const [svg] = await Promise.all([readObservedArtwork(c, binding.collection, mint, head, abi), ...sources.map(async rpc => {
    requireSepoliaIntegrity(getAddress(await readContract(rpc, binding.collection, 'trustedAuthorizer', [], head.number, abi)) === getAddress(binding.authorizer), 'AUTHORIZER');
    if (requireRpcData(await rpc('eth_getBlockByNumber', [head.number, false])).hash !== head.hash) throw unavailableRpcData();
  })]);
  return { state: mint.state, mint, head, finalized, svg };
}

// Checkpoints are verified, process-local evidence, not an imported database
// cursor. Keep the finalized prefix private so a caller cannot mutate it.
const collectionCheckpoints = new WeakMap();
const bindingKey = binding => JSON.stringify([getAddress(binding.collection), getAddress(binding.authorizer),
  binding.renderer.identity, qty(binding.deployment.blockNumber), binding.contractProfile ?? 'generative-pulse-v1-rc1']);
const evidenceConflict = 'MINT_EVIDENCE_CONFLICT';
export function collectionObservationFailure(previous, next) {
  // Once evidence is contradicted, a later timeout is not a recovery. Only a
  // successful anchored pass can clear this condition in a raw audit context.
  // The runtime failover controller additionally latches genuine conflicts
  // until operator review and restart; it cannot perform that recovery silently.
  return previous?.code === evidenceConflict ? previous : next;
}

/** A new scan may withdraw an unfinalized receipt after a reorg, but cannot
 * silently erase or replace a previously finalized receipt. Check everything
 * before publishing the snapshot or deleting any receipt evidence. */
export function supersededReceiptHints(snapshot, immediateMints) {
  const covered = [];
  for (const [handle, early] of immediateMints) {
    if (BigInt(snapshot.head.number) < BigInt(early.head.number)) continue;
    if (early.mint.state === 'minted') {
      const mint = snapshot.mints.get(handle);
      requireForUser(mint?.state === 'minted' && ['handle', 'renderHandle', 'mbti', 'tokenId', 'transactionHash',
        'block', 'blockHash', 'inputDigest', 'assessmentDigest', 'wallet'].every(field => mint[field] === early.mint[field]),
      evidenceConflict, 'Previously verified mints need to be checked before minting can continue.');
    }
    covered.push(handle);
  }
  return covered;
}

/** Bootstrap once, then reuse the verified finalized prefix and rebuild the
 * entire unfinalized suffix. The selected source must preserve the old finalized
 * anchor and current heads. A failed pass never mutates/publishes a snapshot;
 * failover retries the entire pass, not individual pages of its history. */
export async function observeSepoliaCollection(c, binding, previous) {
  return withSepoliaReadSource(c, source => observeSepoliaCollectionAtSource(source, binding, previous));
}
async function observeSepoliaCollectionAtSource(c, binding, previous) {
  const at = binding.collection, abi = sepoliaMintAbi(binding);
  const checkpoint = previous && collectionCheckpoints.get(previous), key = bindingKey(binding);
  if (previous) assert.ok(checkpoint?.key === key, 'Observer checkpoint is not verified for this deployment');
  const [head, finalized] = await Promise.all([sharedReadBlock(c), sharedReadBlock(c, 'finalized')]);
  const finalNumber = BigInt(finalized.number);
  const deploymentBlock = BigInt(binding.deployment.blockNumber), until = BigInt(head.number);
  assert.ok(until >= deploymentBlock && until - deploymentBlock < 10000000n, 'Observer range exceeded');
  assert.ok(finalNumber <= until, 'Finalized block is ahead of the shared head');
  if (checkpoint) {
    const anchors = await Promise.all(readSources(c).map(async rpc => requireRpcData(await rpc('eth_getBlockByNumber', [checkpoint.finalized.number, false]))));
    for (const anchor of anchors) { assert.equal(anchor.number, checkpoint.finalized.number); assert.equal(anchor.hash, anchors[0].hash, 'RPC sources disagree on the finalized checkpoint'); }
    requireForUser(anchors[0].hash === checkpoint.finalized.hash, evidenceConflict,
      'Previously verified mints need to be checked before minting can continue.');
    // A lagging finalized tag cannot advance or replace our checkpoint.
    if (finalNumber < checkpoint.finalNumber && c.readPolicy === SEPOLIA_READ_POLICY) throw unavailableRpcData();
    assert.ok(finalNumber >= checkpoint.finalNumber, 'Finalized observation regressed');
  }
  const from = checkpoint && checkpoint.finalNumber >= deploymentBlock ? checkpoint.finalNumber + 1n : deploymentBlock;
  // The bounded test collection has at most 53 supported fixture mints.
  // Rebuild the tail to withdraw reorged inclusions on every pass.
  const topic = encodeEventTopics({ abi, eventName: 'GenerativeSignatureMinted' });
  const logs = [];
  // The public secondary RPC allows at most 1,000 requested blocks, inclusive.
  // Keep pagination below that cap as the deployment's history grows.
  for (let start = from; start <= until; start += 1000n) {
    const end = start + 999n < until ? start + 999n : until;
    const filter = { address: at, fromBlock: qty(start), toBlock: qty(end), topics: topic };
    const pair = await Promise.all(readSources(c).map(rpc => rpc('eth_getLogs', [filter])));
    assert.ok(pair.every(rows => Array.isArray(rows) && rows.length <= 10000));
    const canonical = pair.map(rows => rows.map(canonicalSepoliaLog));
    for (const rows of canonical) assert.deepEqual(rows, canonical[0]);
    for (const log of canonical[0]) assert.ok(BigInt(log.blockNumber) >= start && BigInt(log.blockNumber) <= end, 'Log is outside its requested range');
    logs.push(...canonical[0]);
  }
  assert.ok(logs.length <= 100000);
  const mints = new Map(checkpoint?.mints ?? []);
  for (const log of logs) {
    const mint = observedMint(binding, log, finalNumber);
    assert.ok(!mints.has(mint.handle)); mints.set(mint.handle, Object.freeze(mint));
  }
  assert.ok(mints.size <= 100000);
  const [authorizers, counters] = await Promise.all([
    Promise.all(readSources(c).map(rpc => readContract(rpc, at, 'trustedAuthorizer', [], head.number, abi))),
    Promise.all(readSources(c).map(async rpc => {
      const sale = await readContract(rpc, at, 'saleStatus', [], head.number, abi);
      // In this bytecode-bound, non-burnable collection, each successful free
      // mint increments freeMinted and each paid mint advances epochIndex once.
      // A provider may return HTTP 200 with an incomplete historical log index.
      // Compare the complete map to current contract state, not a saved DB count.
      const paid = sale.phase === 1 ? (await readContract(rpc, at, 'getPulseState', [], head.number, abi)).epochIndex : 0n;
      return { sale, count: BigInt(sale.freeMinted) + BigInt(paid) };
    })),
  ]);
  for (const authorizer of authorizers) requireSepoliaIntegrity(getAddress(authorizer) === getAddress(binding.authorizer), 'AUTHORIZER');
  for (const counter of counters) assert.deepEqual(counter, counters[0], 'RPC mint counters disagree');
  const { sale, count: expectedMintCount } = counters[0];
  assert.ok(expectedMintCount <= 100000n, 'Observer mint limit exceeded');
  if (BigInt(mints.size) < expectedMintCount) throw Object.assign(unavailableRpcData(), { incompleteMintHistory: true });
  requireForUser(BigInt(mints.size) === expectedMintCount, evidenceConflict,
    'Previously verified mints need to be checked before minting can continue.');
  // Pin the newly finalized prefix and latest tail after all log reads.
  await Promise.all(readSources(c).flatMap(rpc => [head, finalized].map(async anchor => {
    const block = requireRpcData(await rpc('eth_getBlockByNumber', [anchor.number, false]));
    assert.equal(block.number, anchor.number);
    if (anchor === finalized) requireSepoliaIntegrity(block.hash === anchor.hash, 'FINALIZED_ANCHOR');
    else if (block.hash !== anchor.hash) throw unavailableRpcData();
  })));
  if (Math.abs(Date.now() / 1000 - Number(BigInt(head.timestamp))) >= 180) throw unavailableRpcData();
  const value = { at: Date.now(), head, finalized, finalNumber, mints, sale, scanFrom: qty(from), scanTo: head.number,
    expectedMintCount: Number(expectedMintCount), readPolicy: c.readPolicy, readSource: c.readSource };
  collectionCheckpoints.set(value, { key, finalized: { number: finalized.number, hash: finalized.hash }, finalNumber,
    mints: new Map([...mints].filter(([, mint]) => mint.state === 'minted')) });
  return value;
}

/** A new block need not imply a new work. After verifying that the prior head
 * is still canonical and the immutable mint counter did not move, advance the
 * observer checkpoint without fetching the history suffix again. This never
 * upgrades mint eligibility; sale/price admission remains a separate read. */
export async function advanceSepoliaCollectionIfUnchanged(c, binding, previous, head, finalized, options = {}) {
  const abi = sepoliaMintAbi(binding);
  const checkpoint = previous && collectionCheckpoints.get(previous);
  if (!checkpoint || checkpoint.key !== bindingKey(binding) ||
    BigInt(head.number) < BigInt(previous.head.number)) return undefined;
  return withSepoliaReadSource(c, async source => {
    const priorFinal = requireRpcData(await source.rpc('eth_getBlockByNumber', [checkpoint.finalized.number, false]));
    if (priorFinal.hash !== checkpoint.finalized.hash) throw new PublicError(409, evidenceConflict,
      'Previously verified mints need to be checked before minting can continue.');
    if (BigInt(finalized.number) < checkpoint.finalNumber) throw unavailableRpcData();
    const priorHead = requireRpcData(await source.rpc('eth_getBlockByNumber', [previous.head.number, false]));
    if (priorHead.hash !== previous.head.hash) return undefined; // Unfinalized reorg: rebuild the suffix.
    const [currentHead, currentFinal] = await Promise.all([
      source.rpc('eth_getBlockByNumber', [head.number, false]),
      source.rpc('eth_getBlockByNumber', [finalized.number, false]),
    ]);
    if (requireRpcData(currentHead).hash !== head.hash || requireRpcData(currentFinal).hash !== finalized.hash)
      throw unavailableRpcData();
    const sale = await readContract(source.rpc, binding.collection, 'saleStatus', [], head.number, abi);
    const paid = sale.phase === 1 ? (await readContract(source.rpc, binding.collection, 'getPulseState', [], head.number, abi)).epochIndex : 0n;
    const count = BigInt(sale.freeMinted) + BigInt(paid);
    if (count !== BigInt(previous.expectedMintCount)) return undefined;
    if (await readContract(source.rpc, binding.collection, 'trustedAuthorizer', [], head.number, abi) !== binding.authorizer)
      throw new PublicError(409, evidenceConflict, 'Mint authority changed.');
    if (requireRpcData(await source.rpc('eth_getBlockByNumber', [head.number, false])).hash !== head.hash)
      throw unavailableRpcData();
    const finalNumber = BigInt(finalized.number);
    const mints = new Map([...previous.mints].map(([handle, mint]) => [handle,
      Object.freeze({ ...mint, state: BigInt(mint.block) <= finalNumber ? 'minted' : 'confirming' })]));
    const value = { ...previous, at: Date.now(), head, finalized, finalNumber, mints, sale,
      readSource: source.readSource, scanFrom: previous.scanFrom, scanTo: head.number };
    collectionCheckpoints.set(value, { key: checkpoint.key, finalized: { number: finalized.number, hash: finalized.hash },
      finalNumber, mints: new Map([...mints].filter(([, mint]) => mint.state === 'minted')) });
    return value;
  }, options);
}

/** A disk cursor is not evidence. Revalidate its canonical finalized anchor
 * and EVERY cached finalized mint receipt/input before creating a private
 * incremental checkpoint. A forged, missing or reorged entry cannot skip logs. */
export async function restoreSepoliaCheckpoint(c, binding, cached, options = {}) {
  if (!cached) return undefined;
  const abi = sepoliaMintAbi(binding);
  return withSepoliaReadSource(c, async source => {
    const [head, finalized, anchor] = await Promise.all([sharedReadBlock(source), sharedReadBlock(source, 'finalized'),
      source.rpc('eth_getBlockByNumber', [cached.finalized.number, false]).then(requireRpcData)]);
    if (BigInt(finalized.number) < BigInt(cached.finalized.number)) throw unavailableRpcData();
    requireForUser(anchor.number === cached.finalized.number && anchor.hash === cached.finalized.hash,
      evidenceConflict, 'Previously verified mints need to be checked before minting can continue.');
    const mints = new Map(), artworks = new Map();
    for (const prior of cached.mints) {
      assert.equal(prior.state, 'minted'); assert.ok(BigInt(prior.block) <= BigInt(anchor.number));
      const result = await observeSepoliaMintReceipt(source, binding, prior);
      if (!result.mint) throw unavailableRpcData();
      requireForUser(result.state === 'minted' && ['handle', 'renderHandle', 'mbti', 'tokenId', 'transactionHash',
        'block', 'blockHash', 'inputDigest', 'assessmentDigest', 'wallet'].every(field => prior[field] === result.mint[field]),
      evidenceConflict, 'Previously verified mints need to be checked before minting can continue.');
      assert.ok(!mints.has(prior.handle)); mints.set(prior.handle, Object.freeze(result.mint));
      artworks.set(prior.transactionHash + ':' + prior.blockHash, result.svg);
    }
    // Receipt-only/partial caches must not skip unseen earlier mints. If the
    // RPC cannot serve this historical counter, retain presentation and do a
    // fresh cold scan instead; archive support is an optimization, not admission.
    const prefixSale = await readContract(source.rpc, binding.collection, 'saleStatus', [], anchor.number, abi);
    const paid = prefixSale.phase === 1 ? (await readContract(source.rpc, binding.collection, 'getPulseState', [], anchor.number, abi)).epochIndex : 0n;
    if (BigInt(mints.size) !== BigInt(prefixSale.freeMinted) + BigInt(paid)) throw unavailableRpcData();
    assert.equal(requireRpcData(await source.rpc('eth_getBlockByNumber', [anchor.number, false])).hash, anchor.hash);
    const value = { at: 0, head, finalized: anchor, finalNumber: BigInt(anchor.number), mints };
    collectionCheckpoints.set(value, { key: bindingKey(binding), finalized: anchor, finalNumber: BigInt(anchor.number), mints: new Map(mints) });
    return { snapshot: value, artworks };
  }, options);
}

/** Mint eligibility is independent of the history index. All mutable sale,
 * price, slot, wallet and handle checks use one recent, validated source/head. */
export async function readSepoliaMintState(c, binding, plan, { wallet, handle } = {}, options = {}) {
  const abi = sepoliaMintAbi(binding), admin = binding.contractProfile === PULSE_ADMIN_PROFILE;
  const { allowlistProvider, ...readOptions } = options;
  return withSepoliaReadSource(c, async source => {
    const head = await sharedReadBlock(source), at = binding.collection;
    const sale = await readContract(source.rpc, at, 'saleStatus', [], head.number, abi);
    requireSepoliaIntegrity(getAddress(await readContract(source.rpc, at, 'trustedAuthorizer', [], head.number, abi)) === getAddress(binding.authorizer), 'AUTHORIZER');
    let currentAllowlist, freeRoot, allowlistReady = !admin;
    if (admin) {
      // Mutable admin policy is ordinary block-pinned sale state, not a changed
      // immutable deployment. A stale local list cannot poison paid mint/gallery.
      freeRoot = await readContract(source.rpc, at, 'freeMintRoot', [], head.number, abi);
      assert.ok(sale.freeConfigRevision > 0n && sale.freeMintQuota >= 0n
        && sale.freeMintQuota <= sale.freeSlotCount && sale.freeMinted <= sale.freeMintQuota);
      try {
        const artifact = allowlistProvider ? await allowlistProvider() : undefined;
        verifyAllowlistArtifacts(artifact);
        assert.equal(artifact.manifest.root, freeRoot);
        assert.equal(BigInt(artifact.manifest.slotCount), sale.freeSlotCount);
        currentAllowlist = structuredClone(artifact); allowlistReady = true;
      } catch { allowlistReady = false; }
    } else currentAllowlist = plan.allowlist;
    if (wallet) await checkWalletSupport(source, wallet, head);
    let slot, proof;
    if (wallet && allowlistReady && sale.phase === 0 && BigInt(sale.freeDeadline) > BigInt(head.timestamp)
      && (!admin || sale.freeMinted < sale.freeMintQuota)) {
      for (const row of currentAllowlist.proofs) if (getAddress(row.wallet) === getAddress(wallet)
        && !(await readContract(source.rpc, at, 'isFreeSlotClaimed', [BigInt(row.slotId)], head.number, abi))) {
        slot = row.slotId; if (admin) proof = [...row.siblings]; break;
      }
    }
    const price = sale.phase === 1 ? await readContract(source.rpc, at, 'getCurrentPrice', [], head.number, abi) : 0n;
    const minted = handle ? await readContract(source.rpc, at, 'mintedHandle', [openMintHandleKey(handle)], head.number, abi) : undefined;
    if (requireRpcData(await source.rpc('eth_getBlockByNumber', [head.number, false])).hash !== head.hash) throw unavailableRpcData();
    return { at: Date.now(), head, sale, minted, free: slot !== undefined && !sale.paused, paid: sale.phase === 1 && !sale.paused,
      slot, ...(admin ? { proof, freeRoot, allowlistReady, freeConfigRevision: String(sale.freeConfigRevision) } : {}),
      saleNotice: saleNotice(sale), priceWei: String(price), priceETH: formatEther(price) };
  }, readOptions);
}

/** Inputs come only from successful RPC validators in this process. A fresh
 * receipt must not be vetoed by a failing history scan. Historical evidence is
 * presentation-only, never mint or ownership authority. A transient RPC failure
 * cannot undo finalized evidence; a verified checkpoint conflict can. */
export function presentedSepoliaMints(snapshot, refreshError, immediateMints, includeHistorical = false, now = Date.now()) {
  const live = !!snapshot && !refreshError && now - snapshot.at <= 90000;
  const invalidated = refreshError?.code === evidenceConflict;
  const mints = new Map();
  if (snapshot) for (const [handle, mint] of snapshot.mints) {
    assert.ok(mint.state === 'confirming' || mint.state === 'minted');
    if (live || includeHistorical || mint.state === 'minted' && !invalidated)
      mints.set(handle, { ...mint, head: snapshot.head, mintObservationUnavailable: !live, mintEvidenceInvalidated: invalidated });
  }
  let recentReceipt = false;
  for (const [handle, early] of immediateMints) {
    assert.ok(early.mint.state === 'confirming' || early.mint.state === 'minted');
    if (live && BigInt(snapshot.head.number) >= BigInt(early.head.number)) continue;
    if (mints.get(handle)?.state === 'minted') continue;
    const recent = now - early.at <= 90000;
    if (recent && !invalidated) recentReceipt = true;
    if (!invalidated && (recent || early.mint.state === 'minted') || includeHistorical && !mints.has(handle)) mints.set(handle,
      { ...early.mint, head: early.head, mintObservationUnavailable: !recent || invalidated, mintEvidenceInvalidated: invalidated });
  }
  if (!includeHistorical && invalidated) throw refreshError;
  if (!includeHistorical && !live && !recentReceipt && !mints.size) requireFreshMintSnapshot(snapshot, refreshError, now);
  return mints;
}

export async function startSepoliaTestSite(port = 3004, dependencies = {}) {
  assert.notEqual(process.env.NODE_ENV, 'production'); assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  const origin = `http://127.0.0.1:${port}`, p = dependencies.plan ?? loadPlan(), j = dependencies.journal ?? loadJournal();
  const intervalMs = dependencies.intervalMs ?? 15000;
  const directory = dependencies.directory ?? DIR, records = resolve(directory, 'web-records.json');
  const cache = dependencies.cache ?? createSepoliaGalleryCache(p, directory);
  // The PostgreSQL projection is optional for this disposable rehearsal. Its
  // schema is installed separately; a bad binding must refuse startup rather
  // than silently serving another deployment's public data.
  let relayPool, relayStore = dependencies.relayStore, relayWriteError;
  if (!relayStore && process.env.PULSE_RELAY_DATABASE_URL) {
    const { Pool } = await import('pg');
    relayPool = new Pool({ connectionString: process.env.PULSE_RELAY_DATABASE_URL, max: 4 });
    try { relayStore = await openSepoliaRelayStore(relayPool, p); }
    catch (error) {
      await relayPool.end(); relayPool = undefined;
      if (error?.code === evidenceConflict || /Relay deployment binding changed/.test(error?.message ?? '')) throw error;
      relayWriteError = 'RELAY_READ_UNAVAILABLE';
    }
  }
  let binding, refreshError, sale, saleError, bootstrapError, signer, checkpointAttempted = false, saleRevision = 0;
  let history = cache.presentation(), persisted, ownership, ownershipError;
  if (relayStore) {
    try {
      persisted = await relayStore.read();
      const localFinal = cache.checkpoint()?.finalized;
      if (persisted && localFinal && persisted.finalized.number === localFinal.number && persisted.finalized.hash !== localFinal.hash)
        throw new PublicError(409, evidenceConflict, 'Saved finalized chain evidence disagrees.');
      if (persisted && (!history || BigInt(persisted.head.number) >= BigInt(history.head.number))) history = persisted;
      ownership = await relayStore.readOwnership();
    } catch (error) {
      if (error?.code === evidenceConflict) { await relayPool?.end(); throw error; }
      relayWriteError = 'RELAY_READ_UNAVAILABLE';
    }
  }
  const c = createSepoliaReadFailover(dependencies.context ?? readOnlyContext(), dependencies.validateSource ?? (async source => {
    try {
      const head = await checkNetwork(source);
      if (binding) {
        const [collectionCode, rendererCode] = await Promise.all([
          source.rpc('eth_getCode', [binding.collection, head.number]),
          source.rpc('eth_getCode', [binding.renderer.address, head.number]),
        ]);
        assert.match(collectionCode, /^0x(?:[a-f0-9]{2})*$/i); assert.match(rendererCode, /^0x(?:[a-f0-9]{2})*$/i);
        requireSepoliaIntegrity(keccak256(collectionCode) === binding.runtimeCodeHash, 'COLLECTION_CODE');
        requireSepoliaIntegrity(keccak256(rendererCode) === binding.renderer.runtimeCodeHash, 'RENDERER_CODE');
        if (requireRpcData(await source.rpc('eth_getBlockByNumber', [head.number, false])).hash !== head.hash) throw unavailableRpcData();
      }
    } catch (error) {
      // A decoder/programming assertion is not proof of changed chain evidence.
      // Immutable/network comparisons raise explicit conflicts at their gates.
      observationError(error, 'validation');
      throw error;
    }
  }));
  const keyPath = resolve(directory, 'authorizer.key');
  // No key is needed to serve known artwork or retry read-only certification.
  const signingAccount = () => {
    assert.ok(binding && !conflict());
    if (!signer) {
      assert.equal(statSync(keyPath).mode & 0o077, 0);
      signer = privateKeyToAccount(readFileSync(keyPath, 'utf8').trim()); assert.equal(signer.address, p.authorities.authorizer);
    }
    return signer;
  };
  const abi = sepoliaMintAbi(p), at = p.collection.address, sessions = new WalletSessions(origin, 11155111);
  // Validate persisted state before taking the process lock, so a refused
  // startup cannot leave a stale owner claim behind.
  const db = existsSync(records) ? JSON.parse(readFileSync(records, 'utf8')) : { planDigest: p.digest, requests: {} };
  assert.equal(db.planDigest, p.digest);
  const lock = resolve(directory, 'site.lock'), fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  const saveRecords = dependencies.saveRecords ?? (() => save('web-records.json', db, directory));
  try { if (!existsSync(records)) saveRecords(); } catch (error) { unlinkSync(lock); throw error; }
  let snapshot, observerCheckpoint, running = true, serial = Promise.resolve(), lastRefreshMs, cacheWriteError, relay;
  const ui = dependencies.ui === false ? undefined : dependencies.ui ?? createSepoliaUiRenderer();
  const pageFunctions = { homePage, mintPage, assessmentPage, revealedSignature, previewPage, previewVariationsPage,
    mbtiGalleryPage, collectionPage, aboutPage, errorPage, mintControlStudyPage, sepoliaAdminPage, previewSvg: renderSignatureSvg };
  const render = async (name, ...args) => {
    if (ui) { try { return await ui.call(name, ...args); } catch {} }
    return pageFunctions[name](...args);
  };
  const svgBytes = cache.artworks(), artCache = new Map([...svgBytes].map(([key, svg]) => [key, Promise.resolve(svg)]));
  const receiptReads = new Map(), immediateMints = new Map();
  const conflict = () => c.readStatus().evidenceConflict || cache.state().safetyHalted || history?.invalidated
    || [refreshError, bootstrapError, saleError].some(error => error?.code === evidenceConflict);
  const health = () => {
    const state = relay?.state();
    // A newer successful observation supersedes an older transport failure;
    // an integrity conflict is separately latched and never expires this way.
    const relayError = state?.lastError && (!snapshot || state.failedAt > snapshot.at) ? state.lastError : undefined;
    const failures = [[refreshError, observer.snapshot().firstFailedAt],
      [bootstrapError, bootstrap.snapshot().firstFailedAt], [relayError, state?.firstFailedAt]]
      .filter(([error]) => error);
    // Only transient transport/data failures receive presentation grace.
    // A recovered lane no longer contributes its old failure timestamp.
    const galleryFailureSince = failures.length && failures.every(([error, at]) =>
      (error === 'RPC_DATA_UNAVAILABLE' || readUnavailable(error)) && Number.isSafeInteger(at))
      ? Math.min(...failures.map(([, at]) => at)) : undefined;
    return capabilityHealth({ binding, snapshot, history, sale, saleError, bootstrapError,
      observerError: refreshError, relayError, galleryFailureSince, conflict: conflict() });
  };
  const requireBinding = () => requireForUser(binding && !conflict(), 'OBSERVATION_UNAVAILABLE',
    'Mint availability cannot be checked right now. Please try again shortly.');
  const requireActive = () => { requireBinding(); requireForUser(running, 'OBSERVATION_UNAVAILABLE',
    'Mint availability cannot be checked right now. Please try again shortly.'); };
  if (dependencies.adminWeb) assert.equal(p.contractProfile, PULSE_ADMIN_PROFILE);
  const adminWeb = dependencies.adminWeb ? dependencies.adminWebService ?? createSepoliaAdminWebService({
    plan: p, context: c, directory,
    requireBinding: () => {
      requireForUser(binding && !conflict() && running, 'ADMIN_DEPLOYMENT_UNAVAILABLE',
        'Admin controls are not ready. Please try again shortly.');
      return binding;
    },
    getAllowlist: () => JSON.parse(readFileSync(resolve(directory, 'free-config.json'), 'utf8')),
    persistAllowlist: configuration => save('free-config.json', configuration, directory),
    onUpdated: () => { void saleLoop.refresh(); void observer.refresh(); },
  }) : undefined;
  function persistGallery() {
    try {
      if (conflict()) { if (!cache.state().safetyHalted) cache.invalidate(); return; }
      let view = snapshot ?? history;
      if (!view && immediateMints.size) {
        const latest = [...immediateMints.values()].sort((a, b) => BigInt(a.head.number) > BigInt(b.head.number) ? -1 : 1)[0];
        view = { at: latest.at, head: latest.head, mints: new Map() };
      }
      if (!view) return;
      const shown = presentedSepoliaMints(view, snapshot ? refreshError : unavailableRpcData(), immediateMints, true);
      let head = view.head;
      for (const entry of immediateMints.values()) if (BigInt(entry.head.number) > BigInt(head.number)) head = entry.head;
      cache.save({ ...view, head, mints: shown }, snapshot?.finalized ?? cache.checkpoint()?.finalized
        ?? [...immediateMints.values()].find(entry => entry.finalized)?.finalized, svgBytes);
      history = cache.presentation(); cacheWriteError = undefined;
    } catch { cacheWriteError = 'CACHE_WRITE_UNAVAILABLE'; }
  }
  function observationError(error, lane = 'observer') {
    try { cache.recordReadFailure(lane, error); } catch { cacheWriteError = 'DIAGNOSTIC_WRITE_UNAVAILABLE'; }
    if (error?.code === evidenceConflict) {
      try { cache.invalidate(); } catch { cacheWriteError = 'CACHE_WRITE_UNAVAILABLE'; }
    }
  }
  // Gallery/detail requests often ask for the same work concurrently. Share
  // the verified read, and evict failures so a later visit can try again.
  function artwork(mint, head) {
    const key = mint.transactionHash + ':' + mint.blockHash;
    if (!artCache.has(key)) artCache.set(key, (async () => {
      if (relayStore) {
        try { const saved = await relayStore.artwork(key); if (saved) return saved; }
        catch { relayWriteError = 'RELAY_READ_UNAVAILABLE'; }
      }
      return withSepoliaReadSource(c,
        source => readObservedArtwork(source, at, mint, head, abi), { signal: AbortSignal.timeout(45000) });
    })().then(async svg => {
      if (running && !conflict()) {
        svgBytes.set(key, svg); persistGallery();
        if (relayStore) try { await relayStore.publishArtwork(key, svg); }
          catch (error) { relayWriteError = error?.code === evidenceConflict ? evidenceConflict : 'RELAY_WRITE_UNAVAILABLE'; }
      }
      return svg;
    }).catch(error => { artCache.delete(key); throw error; }));
    return artCache.get(key);
  }
  const commit = saveRecords;
  // Absence in a preview may be called unminted only from fresh complete
  // history. This is separate from transaction tracking and sale readiness.
  const fresh = () => requireFreshMintSnapshot(snapshot, refreshError);
  // A sale check completed by an explicit action supersedes a background pass
  // that started earlier. Its late result/error cannot revoke newer evidence.
  const publishSale = value => { sale = value; saleError = undefined; saleRevision++; };
  const includedMints = (includeHistorical = false) => presentedSepoliaMints(snapshot ?? history,
    conflict() ? new PublicError(409, evidenceConflict, 'Previously verified mints need to be checked before minting can continue.')
      : snapshot ? refreshError : unavailableRpcData(), immediateMints, includeHistorical);
  const verify = dependencies.verifyDeployment ?? verifyDeploymentAtSource;
  const observe = dependencies.observe ?? observeSepoliaCollection;
  const readMintState = (context, deployed, plan, input, options) => (dependencies.readMintState ?? readSepoliaMintState)(
    context, deployed, plan, input, { ...options, allowlistProvider: dependencies.allowlistProvider });
  const bootstrap = createReadRecovery(async signal => {
    if (conflict()) throw new PublicError(409, evidenceConflict, 'Previously verified mints need to be checked before minting can continue.');
    const value = await withSepoliaReadSource(c, source => verify(source, p, j), { signal, sourceTimeoutMs: 45000 });
    signal.throwIfAborted(); assert.equal(value.testOnly, true); assert.equal(value.deployment.finalized, true);
    assert.equal(value.contractProfile ?? 'generative-pulse-v1-rc1', p.contractProfile ?? 'generative-pulse-v1-rc1');
    binding = value; c.resetValidation(); bootstrapError = undefined;
  }, { intervalMs, once: true, onError(error) { bootstrapError = error; observationError(error, 'bootstrap'); if (integrityFailure(error)) refreshError = error; persistGallery(); },
    onSuccess() { saleLoop.start(); observer.start(); } });
  let backgroundSaleRevision;
  const saleLoop = createReadRecovery(async signal => {
    backgroundSaleRevision = saleRevision;
    requireBinding();
    const value = await readMintState(c, binding, p, {}, { signal, readPriority: 'action' }); signal.throwIfAborted();
    if (saleRevision === backgroundSaleRevision) publishSale(value);
  }, { intervalMs, timeoutMs: 45000, autoSchedule: false,
    onError(error) {
      if (integrityFailure(error) || saleRevision === backgroundSaleRevision) saleError = error;
      observationError(error, 'sale'); persistGallery();
    } });
  const observer = createReadRecovery(async signal => {
    requireBinding(); const started = Date.now();
    if (!checkpointAttempted) {
      checkpointAttempted = true;
      const fileCheckpoint = cache.checkpoint();
      const databaseCheckpoint = persisted && { finalized: persisted.finalized,
        mints: [...persisted.mints.values()].filter(mint => mint.state === 'minted') };
      const candidate = databaseCheckpoint && (!fileCheckpoint || BigInt(databaseCheckpoint.finalized.number) >= BigInt(fileCheckpoint.finalized.number))
        ? databaseCheckpoint : fileCheckpoint;
      if (candidate) {
        try {
          const restored = await restoreSepoliaCheckpoint(c, binding, candidate, { signal, sourceTimeoutMs: 45000, readPriority: 'background' }); signal.throwIfAborted();
          observerCheckpoint = restored.snapshot;
          for (const [key, svg] of restored.artworks) { svgBytes.set(key, svg); artCache.set(key, Promise.resolve(svg)); }
        } catch (error) {
          if (!readUnavailable(error)) throw error;
          signal.throwIfAborted(); // Missing historical data may use a complete fresh bootstrap instead.
        }
      }
    }
    const value = await withSepoliaReadSource(c, source => observe(source, binding, snapshot ?? observerCheckpoint),
      { signal, sourceTimeoutMs: 45000, readPriority: 'background' });
    signal.throwIfAborted(); const covered = supersededReceiptHints(value, immediateMints);
    if (relayStore) try { await relayStore.publish(value, svgBytes); relayWriteError = undefined; persisted = value; }
      catch (error) { relayWriteError = error?.code === evidenceConflict ? evidenceConflict : 'RELAY_WRITE_UNAVAILABLE';
        if (error?.code === evidenceConflict) throw error; }
    signal.throwIfAborted();
    snapshot = value; observerCheckpoint = undefined; refreshError = undefined; lastRefreshMs = Date.now() - started;
    relay?.seed(value);
    for (const handle of covered) immediateMints.delete(handle);
    persistGallery();
    void ownershipLoop.refresh();
    // Populate a bounded number of immutable caches per pass. An artwork read
    // failure does not invalidate the verified history or halt mint eligibility.
    void artworkLoop.refresh();
  }, { intervalMs, autoSchedule: false,
    onError(error) { refreshError = collectionObservationFailure(refreshError, error); observationError(error); persistGallery(); } });
  const artworkLoop = createReadRecovery(async signal => {
    requireBinding();
    const view = snapshot; if (!view) return;
    const missing = [...view.mints.values()].filter(mint => !svgBytes.has(mint.transactionHash + ':' + mint.blockHash)).slice(0, 4);
    for (const mint of missing) {
      const svg = await withSepoliaReadSource(c, source => readObservedArtwork(source, at, mint, view.head, abi), { signal, readPriority: 'background' });
      signal.throwIfAborted(); const key = mint.transactionHash + ':' + mint.blockHash;
      svgBytes.set(key, svg); artCache.set(key, Promise.resolve(svg)); persistGallery();
      if (relayStore) try { await relayStore.publishArtwork(key, svg); }
        catch (error) { relayWriteError = error?.code === evidenceConflict ? evidenceConflict : 'RELAY_WRITE_UNAVAILABLE'; }
    }
  }, { intervalMs, timeoutMs: 60000, onError: error => observationError(error, 'artwork') });
  const ownershipLoop = createReadRecovery(async signal => {
    requireBinding();
    if (!snapshot) return;
    // A cold owner index needs one page per 1,000 blocks. Give it a bounded
    // scan budget rather than the shorter ordinary point-read deadline.
    const value = await observeSepoliaOwnership(c, binding, snapshot, ownership,
      { signal, sourceTimeoutMs: 45000, readPriority: 'background' });
    signal.throwIfAborted();
    if (relayStore) try { await relayStore.publishOwnership(value); }
      catch (error) { relayWriteError = error?.code === evidenceConflict ? 'OWNERSHIP_EVIDENCE_CONFLICT' : 'RELAY_WRITE_UNAVAILABLE';
        if (error?.code === evidenceConflict) throw Object.assign(new Error('Ownership projection conflicts with its saved finality.'),
          { code: 'OWNERSHIP_EVIDENCE_CONFLICT' }); }
    signal.throwIfAborted();
    ownership = value; ownershipError = undefined;
  }, { intervalMs, autoSchedule: false, timeoutMs: 120000,
    onError(error) { ownershipError = error; observationError(error, 'ownership'); } });
  const refresh = () => binding ? observer.refresh() : bootstrap.refresh();
  // A slow ownership scan must not monopolize price/sale readiness. Visitors
  // renew an aging sale independently, with single-flight and outage backoff.
  const refreshSaleIfDue = () => binding && (!sale || saleError || Date.now() - sale.at >= 45000)
    ? saleLoop.wake() : undefined;
  relay = createSepoliaRelayScheduler({ leaseMs: intervalMs, maxBackoffMs: 60000,
    probe: () => withSepoliaReadSource(c, async source => {
      const [head, finalized] = await Promise.all([sharedReadBlock(source), sharedReadBlock(source, 'finalized')]);
      return { head, finalized };
    }, { signal: AbortSignal.timeout(45000), readPriority: 'background' }),
    synchronize: async ({ head, finalized }) => {
      if (binding && snapshot && !refreshError) {
        const base = snapshot;
        const fast = await advanceSepoliaCollectionIfUnchanged(c, binding, base, head, finalized,
          { signal: AbortSignal.timeout(45000), readPriority: 'background' });
        if (fast) {
          if (snapshot !== base) return snapshot;
          const covered = supersededReceiptHints(fast, immediateMints);
          if (relayStore) try { await relayStore.publish(fast, svgBytes); relayWriteError = undefined; persisted = fast; }
            catch (error) { relayWriteError = error?.code === evidenceConflict ? evidenceConflict : 'RELAY_WRITE_UNAVAILABLE';
              if (error?.code === evidenceConflict) throw error; }
          if (snapshot !== base) return snapshot;
          snapshot = fast; refreshError = undefined;
          for (const handle of covered) immediateMints.delete(handle);
          persistGallery();
          await Promise.all([ownershipLoop.wake(), refreshSaleIfDue()]);
          return fast;
        }
      }
      await Promise.all([observer.wake(), refreshSaleIfDue()]);
      if (observer.snapshot().phase !== 'ready' || !snapshot) throw refreshError ?? unavailableRpcData();
      await ownershipLoop.wake();
      return snapshot;
    },
    onUnchanged: async value => {
      if (refreshError) await observer.wake();
      if (!refreshError && snapshot && snapshot.head.hash === value.head.hash && snapshot.finalized.hash === value.finalized.hash)
        snapshot.at = Date.now();
      if (snapshot && (!ownership || ownership.head.hash !== snapshot.head.hash || ownershipError))
        await ownershipLoop.wake();
      await refreshSaleIfDue();
      if (sale && sale.head.hash === value.head.hash && !saleError) {
        publishSale({ ...sale, at: Date.now() });
      }
    },
    onError: error => observationError(error, 'relay') });
  const demand = () => { if (binding && running && !conflict()) {
    void refreshSaleIfDue(); void relay.wake();
  } };
  function receiptStatus(handle, row) {
    requireBinding();
    const key = handle + ':' + row.transactionHash, previous = receiptReads.get(key);
    if (previous && (previous.pending || Date.now() - previous.at < 5000)) return previous.promise;
    const entry = { pending: true, at: Date.now() };
    entry.promise = withSepoliaReadSource(c,
      source => observeSepoliaMintReceipt(source, binding, { handle, wallet: row.wallet, transactionHash: row.transactionHash,
        ...(row.transaction ? { attempt: row } : {}) }),
      { signal: AbortSignal.timeout(45000) }).then(result => {
      if (result.mint && running && !conflict()) {
        immediateMints.set(handle, { at: Date.now(), mint: result.mint, head: result.head, finalized: result.finalized });
        artCache.set(result.mint.transactionHash + ':' + result.mint.blockHash, Promise.resolve(result.svg));
        svgBytes.set(result.mint.transactionHash + ':' + result.mint.blockHash, result.svg); persistGallery();
      }
      return result;
    }).finally(() => { entry.pending = false; entry.at = Date.now(); });
    receiptReads.set(key, entry); return entry.promise;
  }
  // The relay's last verified phase remains useful presentation while a new
  // admission lease is obtained. It never replaces prepare/begin's fresh reads.
  const currentSaleStatus = () => publicSaleStatus(binding && !conflict() ? sale?.sale : undefined);
  const currentSaleNotice = () => currentSaleStatus().phase !== 'unknown' ? saleNotice(sale.sale) : 'Checking mint availability…';
  const options = session => ({ publicOrigin: origin, stylesheetUrl: '/assets/sepolia.css', clientScriptUrl: '/assets/sepolia.js',
    chainId: '11155111', chainName: 'Ethereum Sepolia', contract: at, generativeArtwork: true, pulseMint: true,
    assessmentSource: 'sample', pulseSaleNotice: currentSaleNotice(), pulseSaleStatus: currentSaleStatus(),
    mintObservationManaged: true, galleryPending: !health().galleryAvailable,
    ...(session ? { csrfToken: session.csrf, wallet: session.wallet, walletVerified: !!session.walletProof && session.walletProof.expiresAt > Date.now() } : {}) });
  const entries = () => [...includedMints(true).values()].map(m => ({ ...m, code: '', imageUrl: `/test-art/${m.handle}.svg`, url: `/signatures/${m.handle}`, mint: { state: m.state, tokenId: m.tokenId, transactionHash: m.transactionHash } }));
  function model(m) { return { handle: m.handle, renderHandle: m.renderHandle, mbti: m.mbti, code: '', status: 'ready', canMint: false,
    imageUrl: `/test-art/${m.handle}.svg`, svgUrl: `/test-art/${m.handle}.svg`, inputDigest: m.inputDigest, assessmentDigest: m.assessmentDigest,
    rendererIdentity: p.renderer.identity, rendererVersion: 'sg-evm-renderer-1.0.0-rc.1', assessmentProvenance: 'development-fixture',
    assessmentModel: 'sepolia-controlled-fixture-v1', tokenId: m.tokenId,
    mintObservationUnavailable: m.mintObservationUnavailable === true,
    mintEvidenceInvalidated: m.mintEvidenceInvalidated === true,
    mint: { state: m.state, tokenId: m.tokenId, transactionHash: m.transactionHash, explorerUrl: `https://sepolia.etherscan.io/token/${at}?a=${m.tokenId}` } }; }
  function previewState(handle) {
    try { const m = includedMints().get(handle); if (!m) fresh(); return m ? { state: m.state, renderHandle: m.renderHandle, mbti: m.mbti, onchain: true,
      rendererVersion: 'sg-evm-renderer-1.0.0-rc.1', previewRendererVersion: RENDERER_VERSION, imageUrl: `/test-art/${m.handle}.svg`, url: `/signatures/${m.handle}` } : { state: 'unminted' }; }
    catch { return { state: 'unavailable' }; }
  }
  function verified(session) { requireForUser(session.wallet && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > Date.now(), 'CONNECT_WALLET', 'Connect and verify your Sepolia wallet.'); return session.wallet; }
  async function mintOptions(wallet) {
    requireBinding();
    let state;
    try { state = await readMintState(c, binding, p, { wallet }, { signal: AbortSignal.timeout(45000) }); }
    catch (error) {
      if (readUnavailable(error)) throw new PublicError(503, 'OBSERVATION_UNAVAILABLE', 'Mint availability cannot be checked right now. Please try again shortly.');
      throw error;
    }
    requireForUser(!state.sale.paused, 'MINT_PAUSED', 'Minting is paused.');
    publishSale(state);
    const saleStatus = publicSaleStatus(state.sale);
    requireForUser(saleStatus.phase !== 'unknown', 'OBSERVATION_UNAVAILABLE', 'Mint availability cannot be checked right now. Please try again shortly.');
    requireForUser(saleStatus.phase !== 'free' || state.allowlistReady !== false, 'FREE_ELIGIBILITY_UNAVAILABLE',
      'Your free mint eligibility cannot be checked right now. Please try again shortly.');
    return { free: state.free && saleStatus.phase === 'free', paid: state.paid && saleStatus.phase === 'paid', phase: saleStatus.phase,
      saleStatus, slot: state.slot, saleNotice: saleStatus.phase === 'unknown' ? 'Checking mint availability…' : state.saleNotice,
      priceWei: state.priceWei, priceETH: state.priceETH };
  }
  async function prepare(body, session) {
    const wallet = verified(session), generation = session.generation, consent = testConsent(body);
    requireBinding();
    const economic = await readMintState(c, binding, p, { wallet, handle: consent.handle }, { signal: AbortSignal.timeout(45000) });
    const head = economic.head;
    assert.equal(session.generation, generation); assert.equal(verified(session), wallet);
    requireForUser(!economic.sale.paused, 'MINT_PAUSED', 'Minting is paused.');
    requireForUser(!economic.minted, 'HANDLE_MINTED', 'This handle is already minted.');
    requireForUser(consent.mode === 'free' ? economic.free : economic.paid && consent.cap >= BigInt(economic.priceWei), 'QUOTE_CHANGED', 'Mint availability or price changed. Please check again before minting.');
    publishSale(economic);
    const prior = Object.hasOwn(db.requests, consent.handle) ? db.requests[consent.handle] : undefined;
    if (prior?.stage === 'expired') {
      requireExpiredAttemptProof(binding, prior);
      const proof = await inspectSepoliaAttempt(c, binding, prior, { signal: AbortSignal.timeout(45000) });
      requireForUser(proof.state === 'retry-allowed', 'RECOVERY_NOT_RESOLVED', 'The previous mint still needs to be checked before another can begin.');
      assert.equal(session.generation, generation); assert.equal(verified(session), wallet);
    } else if (prior) {
      requireForUser(prior.wallet === wallet, 'HANDLE_RESERVED', 'This handle already has a mint request.');
      requireForUser(prior.stage === 'prepared', 'SUBMISSION_STARTED', 'Submission was already started. Check wallet activity; no automatic resend.');
      requireForUser(prior.deadline > Math.floor(Date.now() / 1000), 'REQUEST_EXPIRED', 'This mint request has expired. Contact support before trying again.');
      assert.equal(prior.mode, consent.mode); assert.equal(prior.cap, String(consent.cap));
      if (binding.contractProfile === PULSE_ADMIN_PROFILE && prior.mode === 'free') {
        const authorization = savedMintAuthorization(binding, prior);
        requireForUser(authorization.freeConfigRevision === BigInt(economic.freeConfigRevision), 'QUOTE_CHANGED',
          'The free mint configuration changed. Check your previous mint before trying again.');
      }
      return { code: prior.code, handle: consent.handle, transaction: prior.transaction };
    }
    requireForUser(prior || Object.keys(db.requests).length < 50, 'PREPARATION_UNAVAILABLE', 'Mint preparation is currently unavailable.');
    const code = opaqueCode(), mbti = fixtureMbti(consent.handle);
    const admin = binding.contractProfile === PULSE_ADMIN_PROFILE;
    const freeDeadline = BigInt(admin ? economic.sale.freeDeadline : p.sale.freeDeadline);
    const now = BigInt(head.timestamp), deadline = consent.mode === 'free' && now + 900n > freeDeadline ? freeDeadline : now + 900n;
    const a = { handleKey: openMintHandleKey(consent.handle), assessmentDigest: keccak256(stringToHex('SEPOLIA FIXTURE NOT GROK:' + p.digest + ':' + consent.handle)),
      inputDigest: generativeInputDigest(consent.renderHandle, mbti, binding.renderer.identity, INPUT_PROFILE), recipient: wallet,
      nonce: keccak256(stringToHex(code)), issuedAt: now, deadline, mintMode: consent.mode === 'free' ? 0 : 1,
      slotId: consent.mode === 'free' ? BigInt(economic.slot) : PULSE_PAID_SLOT, maxPrice: consent.cap,
      ...(admin ? { freeConfigRevision: consent.mode === 'free' ? BigInt(economic.freeConfigRevision) : 0n } : {}) };
    const signature = await signingAccount().signTypedData((admin ? pulseAdminMintTypedData : pulseMintTypedData)({ chainId: 11155111, verifyingContract: at }, a));
    const proof = consent.mode === 'free' ? admin ? economic.proof : p.allowlist.proofs.find(row => BigInt(row.slotId) === a.slotId
      && getAddress(row.wallet) === getAddress(wallet)).siblings : undefined;
    if (consent.mode === 'free') assert.ok(Array.isArray(proof));
    const data = encodeFunctionData({ abi, functionName: consent.mode === 'free' ? 'mintFree' : 'mintPaid', args: consent.mode === 'free'
      ? [consent.renderHandle, mbti, a, signature, proof] : [consent.renderHandle, mbti, a, signature] });
    const gas = BigInt(await withSepoliaReadSource(c, source => source.rpc('eth_estimateGas',
      [{ from: wallet, to: at, data, value: qty(consent.cap) }]), { signal: AbortSignal.timeout(45000) }));
    requireActive();
    assert.equal(session.generation, generation); assert.equal(verified(session), wallet);
    const transaction = { from: wallet, to: at, chainId: '0xaa36a7', data, value: qty(consent.cap), gas: qty(gas * 12n / 10n + 1n) };
    // Do not select a browser nonce. The installed wallet owns its public-chain
    // transaction queue; no Anvil-specific nonce override is carried forward.
    const history = prior ? [...(prior.history ?? []), Object.fromEntries(Object.entries(prior).filter(([key]) => key !== 'history'))] : undefined;
    const next = { code, wallet, mode: consent.mode, cap: String(consent.cap), stage: 'prepared', deadline: Number(deadline), transaction, mbti, renderHandle: consent.renderHandle,
      ...(history ? { history } : {}) };
    Object.defineProperty(db.requests, consent.handle, { value: next, writable: true, enumerable: true, configurable: true });
    try { commit(); } catch (error) { if (prior) db.requests[consent.handle] = prior; else delete db.requests[consent.handle]; throw error; }
    return { code, handle: consent.handle, transaction };
  }

  async function recoverAttempt(body, session) {
    const value = fields(body, ['handle'], ['attemptCode', 'transactionHash']);
    const handle = canonicalHandle(value.handle), wallet = verified(session), generation = session.generation;
    requireBinding();
    const row = Object.hasOwn(db.requests, handle) ? db.requests[handle] : undefined;
    requireForUser(row && row.wallet === wallet, 'REQUEST_NOT_FOUND', 'Connect the wallet used for this mint before checking it.');
    requireForUser(value.attemptCode === undefined || value.attemptCode === row.code, 'RECOVERY_ATTEMPT_CHANGED', 'The previous mint request changed. Refresh its status before continuing.');
    const result = await inspectSepoliaAttempt(c, binding, row,
      { transactionHash: value.transactionHash, signal: AbortSignal.timeout(45000) });
    requireActive(); assert.equal(session.generation, generation); assert.equal(verified(session), wallet);
    requireForUser(db.requests[handle] === row, 'RECOVERY_ATTEMPT_CHANGED', 'The previous mint request changed. Refresh its status before continuing.');
    if (result.state === 'retry-allowed') {
      const next = { ...row, stage: 'expired', ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
        recovery: { kind: 'finalized-expired-unused', previousStage: row.recovery?.previousStage ?? row.stage,
          resolvedAt: Date.now(), proof: result.proof } };
      db.requests[handle] = next;
      try { commit(); } catch (error) { db.requests[handle] = row; throw error; }
      return { handle, state: 'retry-allowed', submissionStage: 'expired', recoveryWallet: wallet, attemptCode: row.code };
    }
    if (result.transactionHash) {
      const next = { ...row, stage: 'reported', transactionHash: result.transactionHash };
      db.requests[handle] = next;
      try { commit(); } catch (error) { db.requests[handle] = row; throw error; }
      const receipt = await receiptStatus(handle, next);
      return { handle, state: receipt.state, transactionHash: next.transactionHash, attemptCode: row.code };
    }
    const known = includedMints(true).get(handle);
    return { handle, state: known?.state ?? 'submission-unknown', ...(known ? { transactionHash: known.transactionHash } : {}), attemptCode: row.code };
  }

  const assets = new Map([
    ['/assets/sepolia.css', [SITE_FONT_CSS + SITE_CSS + OPEN_MINT_CSS, 'text/css']],
    ['/assets/sepolia.js', [SEPOLIA_TEST_CLIENT, 'text/javascript']], [FAVICON_URL, [FAVICON_SVG, 'image/svg+xml']],
    ['/assets/sepolia-readiness.js', [SEPOLIA_READINESS_CLIENT, 'text/javascript']],
    ...(adminWeb ? [
      ['/assets/sepolia-admin.js', [SEPOLIA_ADMIN_CLIENT, 'text/javascript']],
      ['/assets/sepolia-admin.css', [SEPOLIA_ADMIN_CSS, 'text/css']],
    ] : []),
    [SLOGAN_MBTI_HERO_SCRIPT_URL, [SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript']], [SLOGAN_TOOLTIP_SCRIPT_URL, [SLOGAN_TOOLTIP_SCRIPT, 'text/javascript']],
    [MINT_CONTROL_STUDY_CSS_PATH, [MINT_CONTROL_STUDY_CSS, 'text/css']],
    [MINT_CONTROL_STUDY_SCRIPT_PATH, [MINT_CONTROL_STUDY_SCRIPT, 'text/javascript']],
  ].map(([url, value]) => [new URL(url, origin).pathname, value]));
  const server = createServer(async (req, res) => {
    const send = (status, value, type = 'text/html; charset=utf-8', readiness = true) => {
      if (readiness && type.startsWith('text/html')) value = value.replace('</body>', '<script src="/assets/sepolia-readiness.js" defer></script></body>');
      res.writeHead(status, { 'Content-Type': type }); res.end(value);
    };
    const json = value => send(200, stringify(value), 'application/json');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      assert.equal(req.headers.host, new URL(origin).host); assert.ok((req.url?.length ?? 0) <= 2048);
      const url = new URL(req.url, origin), path = url.pathname;
      assert.equal(url.origin, origin);
      if (req.method === 'GET') {
        const asset = assets.get(path), font = siteFontAsset(path);
        if (ui && (path.startsWith('/assets/') || path === new URL(FAVICON_URL, origin).pathname) && !font) {
          try { const current = await ui.call('asset', path); if (current) return send(200, current[0], current[1]); } catch {}
        }
        if (asset) return send(200, asset[0], asset[1]); if (font) return send(200, font.bytes, font.contentType);
        if (path === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /\n', 'text/plain');
        // UI comparisons never poll capabilities, trigger relay demand or create a wallet session.
        if (path === MINT_CONTROL_STUDY_PATH) return send(200, await render('mintControlStudyPage', '/assets/sepolia.css'), 'text/html; charset=utf-8', false);
        if (path === '/health' || path === '/health/live' || path === '/health/ready' || path === '/api/test/capabilities') {
          const capabilities = health(), state = { chainId: 11155111, testOnly: true, frontendOnly: false, collection: at, ...capabilities,
          ...c.readStatus(), observationSource: snapshot?.readSource,
          observedMintCount: snapshot?.mints.size, expectedMintCount: snapshot?.expectedMintCount,
          lastRefreshMs, scanFrom: snapshot?.scanFrom, scanTo: snapshot?.scanTo,
          bootstrap: bootstrap.snapshot(), observer: observer.snapshot(), sale: saleLoop.snapshot(), cache: cache.state(),
          ownership: { ...ownershipLoop.snapshot(), indexedHead: ownership?.head.number, ownerCount: ownership?.owners.size },
          ownershipNotice: ownershipError ? ownershipError.code === 'OWNERSHIP_EVIDENCE_CONFLICT'
            ? 'Ownership history needs to be checked. This collection reflects the last verified ownership.'
            : 'Ownership updates could not be checked. This collection reflects the last verified ownership.' : undefined,
          collectionRevision: JSON.stringify([ownership?.head.hash, !!ownershipError, snapshot?.head.hash]),
          cacheWriteError, uiRevision: ui?.revision?.() ?? 0, relay: relay.state(), mintNotice: mintAvailabilityNotice(capabilities), saleStatus: currentSaleStatus(),
          relayStore: { configured: !!dependencies.relayStore || !!process.env.PULSE_RELAY_DATABASE_URL,
            enabled: !!relayStore, lastError: relayWriteError },
          revision: JSON.stringify([ui?.revision?.() ?? 0, svgBytes.size, capabilities.mintReady, capabilities.observerHealthy, capabilities.safetyHalted,
            [...includedMints(true).values()].map(m => [m.handle, m.state, m.blockHash, m.mintObservationUnavailable])]),
          unavailableSource: refreshError?.readSource, unavailableMethod: refreshError?.readMethod,
          unavailableHttpStatus: refreshError?.httpStatus, unavailableRpcCode: refreshError?.rpcErrorCode };
          if (path === '/api/test/capabilities') demand();
          return send(path === '/health/ready' && !capabilities.mintReady ? 503 : 200, stringify(state), 'application/json');
        }
        if (!path.startsWith('/api/') || path === '/api/test/status') demand();
        const stateMatch = /^\/api\/test\/status$/.test(path);
        if (stateMatch) {
          const handle = canonicalHandle(url.searchParams.get('handle'));
          const row = Object.hasOwn(db.requests, handle) ? db.requests[handle] : undefined;
          requireForUser(!conflict(), evidenceConflict, 'This mint needs to be rechecked before it can be confirmed. Do not submit another mint.');
          let m = includedMints(true).get(handle);
          // A cached finalized mint remains a verified fact. A stale confirming
          // hint must not grant a new reveal; use this transaction's receipt.
          if (m?.state === 'confirming' && m.mintObservationUnavailable) m = undefined;
          if (!m && row?.stage === 'reported') {
            try {
              const result = await receiptStatus(handle, row);
              if (result.state === 'reverted') return json({ handle, state: 'reverted', transactionHash: row.transactionHash });
              m = result.mint;
            } catch (error) {
              if (readUnavailable(error) || error.code === 'OBSERVATION_UNAVAILABLE')
                throw new PublicError(503, 'MINT_STATUS_UNAVAILABLE', 'Your transaction status could not be checked right now.');
              throw error;
            }
          }
          const tracking = m ? { state: m.state } : submissionTrackingStatus(row);
          if (tracking.state === 'retry-allowed') { requireBinding(); requireExpiredAttemptProof(binding, row); }
          const { session } = sessions.session(req.headers.cookie);
          // Only a still-valid proof for this request may clear a local stale
          // marker. Public absence alone is never recovery authority.
          const recoveryWallet = ['not-submitted', 'retry-allowed'].includes(tracking.state) && session.walletProof?.expiresAt > Date.now()
            && session.walletProof.wallet === session.wallet && (!row || row.wallet === session.wallet) ? session.wallet : undefined;
          return json({ handle, ...tracking, ...(recoveryWallet ? { recoveryWallet } : {}), ...(m ? { tokenId: m.tokenId, transactionHash: m.transactionHash,
            inputDigest: m.inputDigest, rendererIdentity: p.renderer.identity, url: '/signatures/' + handle,
            observationUnavailable: m.mintObservationUnavailable === true,
            html: await render('revealedSignature', model(m), options()) } : {}) });
        }
        const art = /^\/test-art\/([a-z0-9_]{1,15})\.svg$/.exec(path);
        if (art) {
          const m = includedMints(true).get(art[1]); assert.ok(m, 'Artwork has not been included on Sepolia.');
          const key = m.transactionHash + ':' + m.blockHash;
          let cached = artCache.get(key);
          if (!cached && relayStore) {
            try { const saved = await relayStore.artwork(key); if (saved) { cached = Promise.resolve(saved); artCache.set(key, cached); svgBytes.set(key, saved); } }
            catch { relayWriteError = 'RELAY_READ_UNAVAILABLE'; }
          }
          // Keep immutable verified SVG visible without a new status claim.
          // With no cached artifact, require a new successful receipt check.
          const result = !cached && m.mintObservationUnavailable ? await receiptStatus(m.handle, m) : undefined;
          const svg = cached ? await cached : result ? (assert.ok(result.svg), result.svg) : await artwork(m, m.head);
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); return send(200, svg, 'image/svg+xml');
        }
        const previewAsset = /^\/preview\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})\.svg$/.exec(path);
        if (previewAsset) { assert.ok(isMbti(previewAsset[2])); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); return send(200, await render('previewSvg', previewAsset[1], previewAsset[2]), 'image/svg+xml'); }
        const found = sessions.session(req.headers.cookie), session = found.session; if (found.created) res.setHeader('Set-Cookie', sessions.cookie(session));
        if (path === '/api/test/session') return json({ csrf: session.csrf, wallet: session.walletProof?.expiresAt > Date.now() ? session.wallet : undefined });
        if (path === '/api/test/options') return json(await mintOptions(verified(session)));
        if (path === '/api/test/admin/status') {
          requireForUser(!!adminWeb, 'ADMIN_UNAVAILABLE', 'Administration is not enabled for this deployment.');
          const wallet = verified(session), generation = session.generation;
          const result = await adminWeb.status(wallet);
          requireForUser(session.generation === generation && verified(session) === wallet,
            'CONNECT_WALLET', 'Connect and verify your admin wallet again.');
          return json(result);
        }
        const opts = options(session);
        if (path === '/') return send(200, await render('homePage', opts, entries()));
        if (path === '/admin' && adminWeb) return send(200, await render('sepoliaAdminPage', {
          ...opts, adminWallet: p.authorities.admin, clientScriptUrl: '/assets/sepolia-admin.js',
        }), 'text/html; charset=utf-8', false);
        // Relay viewing is quiet; only mutable mint admission owns a warning.
        if (path === '/mint') return send(200, await render('mintPage', url.searchParams.get('handle') ?? '',
          { ...opts, mintObservationNotice: mintAvailabilityNotice(health()) }));
        if (path === '/about') return send(200, await render('aboutPage', opts));
        if (path === '/me') {
          let mine = [];
          if (session.walletProof?.expiresAt > Date.now()) {
            const all = entries();
            mine = ownership ? all.filter(entry => ownership.owners.get(entry.tokenId) === session.wallet) : [];
          }
          return send(200, await render('collectionPage', mine, { ...opts,
            galleryPending: !!session.walletProof && session.walletProof.expiresAt > Date.now() && !ownership }));
        }
        const detail = /^\/signatures\/([A-Za-z0-9_]{1,15})$/.exec(path);
        if (detail) { const m = includedMints(true).get(canonicalHandle(detail[1])); assert.ok(m, 'This signature is not included on Sepolia yet.'); return send(200, await render('assessmentPage', model(m), opts)); }
        const group = /^\/([A-Z]{4})\/$/.exec(path); if (group && isMbti(group[1])) return send(200, await render('mbtiGalleryPage', group[1], entries(), opts));
        const preview = /^\/(p|s)\/([A-Za-z0-9_]{1,15})(?:\/(variations|[A-Za-z]{4}))?$/.exec(path);
        if (preview) {
          const spelling = preservedHandle(preview[2]), suffix = preview[3] ?? 'variations';
          if (preview[1] === 's' || !preview[3]) { res.setHeader('Location', `/p/${spelling}/${suffix}`); return send(308, ''); }
          const state = previewState(canonicalHandle(spelling));
          return send(200, suffix === 'variations' ? await render('previewVariationsPage', spelling, opts, state) : await render('previewPage', spelling, suffix.toUpperCase(), opts, state));
        }
        return send(404, await render('errorPage', 'Page not found.', opts));
      }
      requireForUser(running, 'OBSERVATION_UNAVAILABLE', 'Mint availability cannot be checked right now. Please try again shortly.');
      assert.equal(req.method, 'POST'); assert.equal(req.headers.origin, origin); assert.equal(req.headers['content-type'], 'application/json');
      const adminRoute = /^\/api\/test\/admin\/(review|action|report|cancel)$/.exec(path);
      let raw = ''; for await (const chunk of req) {
        raw += chunk;
        requireForUser(Buffer.byteLength(raw) <= (adminRoute?.[1] === 'review' ? 256 * 1024 : 4096),
          'INVALID_INPUT', 'The request is too large.');
      }
      const body = JSON.parse(raw), { session } = sessions.session(req.headers.cookie);
      sessions.authorizePost(session, req.headers.origin, req.headers['x-csrf-token']);
      if (adminRoute) {
        requireForUser(!!adminWeb, 'ADMIN_UNAVAILABLE', 'Administration is not enabled for this deployment.');
        const wallet = verified(session), generation = session.generation;
        const method = adminRoute[1];
        fields(body, method === 'review' ? ['wallets', 'quota'] : method === 'action' ? ['action'] : method === 'report'
          ? ['intentId', 'transactionHash'] : ['intentId'], method === 'action' ? ['reviewId'] : []);
        const task = serial.then(async () => {
          requireForUser(session.generation === generation && verified(session) === wallet,
            'CONNECT_WALLET', 'Connect and verify your admin wallet again.');
          const result = await adminWeb[method](wallet, body);
          requireForUser(session.generation === generation && verified(session) === wallet,
            'CONNECT_WALLET', 'Connect and verify your admin wallet again.');
          return result;
        });
        serial = task.catch(() => undefined);
        return json(await task);
      }
      if (path === '/api/test/logout') { fields(body, []); sessions.logout(session); return json({ disconnected: true }); }
      if (path === '/api/test/challenge' || path === '/api/test/admin/challenge') {
        if (path === '/api/test/admin/challenge') requireForUser(!!adminWeb, 'ADMIN_UNAVAILABLE', 'Administration is not enabled for this deployment.');
        fields(body, ['address']);
        requireBinding();
        // Reject unsupported accounts before asking the wallet to sign. Check
        // again at preparation/begin because delegation can change afterwards.
        delete session.walletProof; delete session.challenge; session.generation++;
        const generation = session.generation;
        const address = await checkWalletSupport(c, body.address);
        assert.equal(session.generation, generation);
        return json(sessions.challenge(session, address, undefined, path === '/api/test/admin/challenge' ? 'admin' : 'mint'));
      }
      if (path === '/api/test/verify') { fields(body, ['challengeId', 'signature']); return json({ wallet: await sessions.verify(session, body.challengeId, body.signature) }); }
      if (path === '/api/test/prepare') {
        const task = serial.then(() => prepare(body, session)); serial = task.catch(() => undefined); return json(await task);
      }
      if (path === '/api/test/recover') {
        const task = serial.then(() => recoverAttempt(body, session)); serial = task.catch(() => undefined); return json(await task);
      }
      if (path === '/api/test/begin' || path === '/api/test/report') {
        const task = serial.then(async () => {
          fields(body, path.endsWith('begin') ? ['code'] : ['code', 'transactionHash']); const wallet = verified(session);
          const entry = Object.entries(db.requests).find(([, row]) => row.code === body.code && row.wallet === wallet);
          requireForUser(entry, 'REQUEST_NOT_FOUND', 'Request not found.');
          const [handle, row] = entry;
          let next;
          if (path.endsWith('begin')) {
            const generation = session.generation;
            requireBinding();
            const preflight = await readMintState(c, binding, p, { wallet, handle }, { signal: AbortSignal.timeout(45000) });
            // RC1's paid path has no free slot/revision to decode. Keep its
            // existing behavior while RC2 binds every saved wire field.
            const authorization = binding.contractProfile === PULSE_ADMIN_PROFILE ? savedMintAuthorization(binding, row)
              : row.mode === 'free' ? decodeFunctionData({ abi, data: row.transaction.data }).args[2] : undefined;
            requireActive();
            requireForUser(!preflight.sale.paused && !preflight.minted
              && (row.mode === 'free' ? preflight.free && BigInt(preflight.slot) === authorization.slotId
                && (binding.contractProfile !== PULSE_ADMIN_PROFILE || BigInt(preflight.freeConfigRevision) === authorization.freeConfigRevision)
                : preflight.paid && BigInt(row.cap) >= BigInt(preflight.priceWei)),
            'QUOTE_CHANGED', 'Mint availability or price changed. Please check again before minting.');
            assert.equal(session.generation, generation); assert.equal(verified(session), wallet);
            requireForUser(row.stage === 'prepared', 'SUBMISSION_STARTED', 'Submission already started.'); assert.ok(row.deadline > Date.now() / 1000);
            publishSale(preflight); next = { ...row, stage: 'begun' };
          } else {
            assert.match(body.transactionHash, /^0x[a-f0-9]{64}$/);
            // A lost response can be retried, but never change the hash of a
            // reported attempt or revive an authorization retired by recovery.
            if (row.stage === 'reported' && row.transactionHash === body.transactionHash) return { saved: true };
            assert.equal(row.stage, 'begun'); next = { ...row, transactionHash: body.transactionHash, stage: 'reported' };
          }
          requireForUser(db.requests[handle] === row, 'RECOVERY_ATTEMPT_CHANGED', 'The previous mint request changed. Refresh its status before continuing.');
          db.requests[handle] = next;
          try { commit(); } catch (error) { db.requests[handle] = row; throw error; }
          // A wallet report never establishes inclusion; verification is read-only.
          if (path.endsWith('report')) void refresh();
          return { saved: true };
        });
        serial = task.catch(() => undefined); return json(await task);
      }
      return send(404, '{"error":"Page not found."}', 'application/json');
    } catch (error) {
      const failure = publicFailure(error);
      if (req.url?.startsWith('/api/')) return send(failure.status, JSON.stringify({ error: failure.error, code: failure.code }), 'application/json');
      return send(503, await render('errorPage', failure.error, options()));
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  try { await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); }); }
  catch (error) { await ui?.close(); await relayPool?.end(); unlinkSync(lock); throw error; }
  bootstrap.start();
  const close = async () => { if (!running) return; running = false; relay.stop();
    const closed = new Promise(resolve => server.close(resolve));
    await Promise.all([bootstrap.close(), observer.close(), saleLoop.close(), artworkLoop.close(), ownershipLoop.close()]);
    await closed; await serial;
    await Promise.allSettled([...receiptReads.values()].map(entry => entry.promise)); await ui?.close(); await relayPool?.end(); unlinkSync(lock);
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); };
  const shutdown = () => void close();
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  console.log(JSON.stringify({ origin, chainId: 11155111, collection: at, testOnly: true, provider: 'fixture-not-grok', deployerKeyLoaded: false }));
  return { server, close, refresh, snapshot: () => snapshot, health,
    refreshSale: saleLoop.refresh, reloadUi: () => ui?.reload(), recovery: () => ({ bootstrap: bootstrap.snapshot(), observer: observer.snapshot(), sale: saleLoop.snapshot() }) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startSepoliaTestSite(Number(process.env.PORT ?? 3004)).catch(() => { console.error('Sepolia test site refused startup. Inspect finalized deployment/RPC/lock state; secret details suppressed.'); process.exitCode = 1; });
}
