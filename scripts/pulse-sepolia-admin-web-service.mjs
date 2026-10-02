import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, stringToHex } from 'viem';
import { PublicError, fields, isCode, opaqueCode } from '../src/openMint/security.ts';
import { jsonDigest } from '../contracts/tools/pulse-candidate-lock.mjs';
import { loadPulseAdminArtifact } from '../contracts/tools/pulse-admin-candidate.mjs';
import { ADMIN_PROFILE, planAdminFreeUpdate } from '../contracts/tools/pulse-sepolia-admin-plan.mjs';
import { buildAllowlist, parseWalletRows, verifyAllowlistArtifacts } from '../contracts/tools/pulse-allowlist.mjs';
import { readAdminPolicy } from './pulse-sepolia-admin.mjs';
import { canonicalSepoliaMintReceipt, checkNetwork, readContract } from './pulse-sepolia.mjs';
import { createSepoliaReadFailover, requireRpcData, withSepoliaReadSource } from './pulse-sepolia-rpc.mjs';

const CHAIN = 11155111, HASH = /^0x[0-9a-f]{64}$/i;
const DEFAULT_ADMIN = '0x' + '00'.repeat(32), PAUSER = keccak256(stringToHex('PAUSER_ROLE'));
const READ_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_estimateGas', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const MAX_SLOTS = 5000, MAX_REVIEWS = 8, MAX_INTENTS = 64, MAX_BYTES = 16 * 1024 * 1024;
const REVIEW_TTL_MS = 30 * 60 * 1000;
const qty = n => '0x' + BigInt(n).toString(16);
const fail = (status, code, message) => { throw new PublicError(status, code, message); };
const requireThat = (test, code, message, status = 409) => { if (!test) fail(status, code, message); };
const sameAddress = (a, b) => getAddress(a) === getAddress(b);
const fingerprint = p => ({ root: p.root, slotCount: p.slotCount, quota: p.quota, revision: p.revision,
  freeMinted: p.freeMinted, freeDeadline: p.freeDeadline, phase: p.phase, admin: p.admin });
const unresolved = intent => ['prepared', 'submitted'].includes(intent.state);
const summaryIntent = row => ({ intentId: row.intentId, action: row.action, state: row.state,
  ...(row.transactionHash || row.reportedHash ? { transactionHash: row.transactionHash ?? row.reportedHash,
    hashValidated: row.hashValidated === true } : {}),
  ...(row.reviewId ? { reviewId: row.reviewId } : {}) });

/** Only JSON and read-only RPC enter this service. WalletSessions and CSRF are
 * enforced by its caller; the supplied wallet must already be authenticated.
 * The browser is the only transaction signer and sender. */
export function createSepoliaAdminWebService({ plan, context, directory, getAllowlist,
  persistAllowlist, requireBinding, onUpdated = () => {} }) {
  requireThat(plan?.contractProfile === ADMIN_PROFILE && plan.chainId === CHAIN && plan.testOnly === true
    && plan.productionApproved === false, 'ADMIN_UNSUPPORTED', 'Admin controls require the Sepolia RC2 test deployment.', 503);
  assert.equal(typeof context?.rpc, 'function'); assert.equal(typeof getAllowlist, 'function');
  assert.equal(typeof persistAllowlist, 'function'); assert.equal(typeof requireBinding, 'function');
  const at = getAddress(plan.collection.address), abi = loadPulseAdminArtifact().abi;
  const path = resolve(directory, 'admin-web.json');
  // A raw context is supported for stand-alone callers. The site's already
  // validated failover controller is reused without inventing a write route.
  const reads = context.readContext ?? (context.readStatus ? context : context.second
    ? createSepoliaReadFailover(context, checkNetwork, { attemptTimeoutMs: 20000 }) : context);
  let journal, journalValidated = false;

  function validateSaved() {
    try {
      const ids = new Set(), decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
      const validHead = head => HASH.test(head?.hash ?? '') && /^0x[0-9a-f]+$/i.test(head?.number ?? '') && /^0x[0-9a-f]+$/i.test(head?.timestamp ?? '');
      const validPrevious = previous => HASH.test(previous?.root ?? '') && [0, 1].includes(previous.phase)
        && ['slotCount', 'quota', 'revision', 'freeMinted', 'freeDeadline'].every(key => decimal(previous[key]))
        && getAddress(previous.admin) === previous.admin;
      for (const row of journal.reviews) {
        assert.ok(isCode(row.reviewId) && !ids.has(row.reviewId)); ids.add(row.reviewId);
        assert.equal(getAddress(row.wallet), row.wallet); assert.ok(validPrevious(row.previous) && validHead(row.head));
        assert.ok(Number.isSafeInteger(row.expiresAt) && Array.isArray(row.wallets) && row.wallets.length <= MAX_SLOTS);
        assert.ok(Array.isArray(row.replacements) && new Set(row.replacements).size === row.replacements.length
          && row.replacements.every(id => Number.isSafeInteger(id) && id >= 0 && BigInt(id) < BigInt(row.previous.slotCount)));
        const rebuilt = buildAllowlist(row.wallets);
        assert.equal(row.summary.reviewId, row.reviewId); assert.equal(row.summary.root, rebuilt.manifest.root);
        assert.equal(row.summary.slotCount, String(row.wallets.length)); assert.ok(decimal(row.summary.quota));
        assert.equal(row.summary.revision, String(BigInt(row.previous.revision) + 1n));
      }
      for (const row of journal.intents) {
        assert.ok(isCode(row.intentId) && !ids.has(row.intentId)); ids.add(row.intentId);
        assert.equal(getAddress(row.wallet), row.wallet); assert.ok(validPrevious(row.previous) && validHead(row.head));
        assert.ok(['pause', 'unpause', 'configure'].includes(row.action)
          && ['prepared', 'submitted', 'abandoned', 'confirmed', 'reverted', 'superseded'].includes(row.state));
        const tx = row.transaction;
        assert.ok(tx && sameAddress(tx.from, row.wallet) && sameAddress(tx.to, at));
        assert.equal(tx.chainId, qty(CHAIN)); assert.equal(tx.value, '0x0');
        assert.match(tx.nonce, /^0x[0-9a-f]+$/i); assert.match(tx.gas, /^0x[0-9a-f]+$/i); assert.ok(BigInt(tx.gas) > 0n);
        const configuration = row.configuration;
        if (row.action === 'configure') {
          assert.ok(isCode(row.reviewId)); assert.equal(configuration.planDigest, plan.digest); assert.ok(sameAddress(configuration.contract, at));
          assert.equal(configuration.schema, 'sg-pulse-free-configuration/v1'); assert.match(configuration.root, HASH);
          assert.ok(decimal(configuration.slotCount));
          if (configuration.allowlist) {
            verifyAllowlistArtifacts(configuration.allowlist);
            assert.equal(configuration.root, configuration.allowlist.manifest.root);
            assert.equal(configuration.slotCount, String(configuration.allowlist.slots.length));
          } else if (configuration.wallets) {
            assert.ok(['abandoned', 'prepared', 'submitted'].includes(row.state));
            const rebuilt = buildAllowlist(configuration.wallets);
            assert.equal(configuration.root, rebuilt.manifest.root); assert.equal(configuration.slotCount, String(rebuilt.slots.length));
          } else assert.ok(['confirmed', 'reverted', 'superseded'].includes(row.state));
          assert.ok(decimal(configuration.quota) && BigInt(configuration.quota) <= BigInt(configuration.slotCount));
          assert.equal(configuration.revision, String(BigInt(row.previous.revision) + 1n));
        }
        assert.equal(tx.data, encodeFunctionData({ abi, functionName: row.action === 'configure' ? 'configureFreeMint'
          : row.action === 'pause' ? 'pauseMinting' : 'unpauseMinting',
          ...(configuration ? { args: [configuration.root, BigInt(configuration.slotCount), BigInt(configuration.quota)] } : {}) }));
        if (row.transactionHash) assert.match(row.transactionHash, HASH);
        if (row.reportedHash) assert.match(row.reportedHash, HASH);
        if (['confirmed', 'reverted'].includes(row.state)) {
          assert.equal(row.hashValidated, true); const receipt = canonicalSepoliaMintReceipt(row.receipt);
          assert.equal(receipt.transactionHash, row.transactionHash); assert.ok(sameAddress(receipt.from, row.wallet) && sameAddress(receipt.to, at));
        }
      }
      if (journal.checkpoint) {
        assert.match(journal.checkpoint.number, /^0x[0-9a-f]+$/i); assert.match(journal.checkpoint.hash, HASH);
        assert.match(journal.checkpoint.transactionHash, HASH);
      }
    } catch { fail(503, 'ADMIN_STORAGE_UNAVAILABLE', 'Saved admin history is invalid. Reconcile it before continuing.'); }
  }

  async function safely(operation) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof PublicError) throw error;
      // Never return assertions, provider messages, URLs, file paths or secrets.
      fail(503, 'ADMIN_READ_UNAVAILABLE', 'Admin state could not be verified. Try again shortly.');
    }
  }
  function write(next) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    requireThat(dir.isDirectory() && !dir.isSymbolicLink() && (dir.mode & 0o077) === 0,
      'ADMIN_STORAGE_UNAVAILABLE', 'Private admin storage is unavailable.', 503);
    if (existsSync(path)) {
      const file = lstatSync(path);
      requireThat(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0,
        'ADMIN_STORAGE_UNAVAILABLE', 'Private admin storage is unavailable.', 503);
    }
    const bytes = JSON.stringify(next, null, 2) + '\n';
    requireThat(Buffer.byteLength(bytes) <= MAX_BYTES, 'ADMIN_STORAGE_FULL', 'Admin history needs operator review before another action.', 503);
    const temporary = resolve(directory, '.admin-web-' + randomUUID() + '.tmp');
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path); journal = next;
      const directoryFd = openSync(directory, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
    journal = next;
  }
  function commit(change) {
    const next = structuredClone(journal); change(next);
    for (const row of next.intents) if (row.configuration) {
      const configuration = row.configuration;
      if (row.state === 'abandoned' && configuration.allowlist) {
        configuration.wallets = configuration.allowlist.slots.map(slot => slot.wallet);
        delete configuration.allowlist;
      } else if (['confirmed', 'reverted', 'superseded'].includes(row.state)) {
        if (configuration.allowlist) configuration.allowlistDigest = jsonDigest(configuration.allowlist);
        delete configuration.allowlist; delete configuration.wallets;
      }
    }
    for (const row of next.intents) if (['confirmed', 'reverted'].includes(row.state) && row.receipt
      && (!next.checkpoint || BigInt(row.receipt.blockNumber) > BigInt(next.checkpoint.number)))
      next.checkpoint = { number: row.receipt.blockNumber, hash: row.receipt.blockHash, transactionHash: row.receipt.transactionHash };
    next.reviews = next.reviews.slice(-MAX_REVIEWS);
    // Abandoned and settled records remain as audit history; unresolved wallet
    // delivery never expires and is never silently pruned.
    while (next.intents.length > MAX_INTENTS) {
      const index = next.intents.findIndex(row => ['confirmed', 'reverted', 'superseded'].includes(row.state));
      requireThat(index >= 0, 'ADMIN_STORAGE_FULL', 'Resolve pending admin actions before continuing.', 503);
      next.intents.splice(index, 1);
    }
    write(next);
  }
  function load(binding) {
    requireThat(binding && binding.chainId === CHAIN && binding.contractProfile === ADMIN_PROFILE
      && binding.planDigest === plan.digest && sameAddress(binding.collection, at)
      && HASH.test(binding.deployment?.blockHash ?? ''), 'ADMIN_BINDING_UNAVAILABLE',
    'The admin deployment cannot be verified right now.', 503);
    const identity = { planDigest: plan.digest, chainId: CHAIN, contractProfile: ADMIN_PROFILE, collection: at,
      deployment: { blockNumber: String(BigInt(binding.deployment.blockNumber)), blockHash: binding.deployment.blockHash,
        ...(binding.deployment.transactionHash ? { transactionHash: binding.deployment.transactionHash } : {}) },
      ...(binding.runtimeCodeHash ? { runtimeCodeHash: binding.runtimeCodeHash } : {}) };
    if (!journal) {
      if (existsSync(path)) {
        const file = lstatSync(path);
        requireThat(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.size <= MAX_BYTES,
          'ADMIN_STORAGE_UNAVAILABLE', 'Private admin storage is unavailable.', 503);
        journal = JSON.parse(readFileSync(path, 'utf8'));
      } else journal = { schema: 'sg-pulse-sepolia-admin-web/v1', binding: identity, reviews: [], intents: [] };
    }
    requireThat(journal.schema === 'sg-pulse-sepolia-admin-web/v1' && jsonDigest(journal.binding) === jsonDigest(identity)
      && Array.isArray(journal.reviews) && journal.reviews.length <= MAX_REVIEWS
      && Array.isArray(journal.intents) && journal.intents.length <= MAX_INTENTS,
    'ADMIN_BINDING_CHANGED', 'Saved admin history belongs to a different deployment.', 503);
    if (!journalValidated) { validateSaved(); journalValidated = true; }
    return binding;
  }
  async function checkSettled(source) {
    // Inclusion is immediately useful to the admin workflow, but remains
    // subject to reorgs. Every subsequent operation checks the most recent
    // settled block; its hash also commits to all preceding settled blocks.
    const recent = journal.intents.filter(row => ['confirmed', 'reverted'].includes(row.state) && row.receipt)
      .sort((a, b) => BigInt(a.receipt.blockNumber) > BigInt(b.receipt.blockNumber) ? -1 : 1)[0];
    const checkpoint = journal.checkpoint ?? (recent ? { number: recent.receipt.blockNumber, hash: recent.receipt.blockHash } : undefined);
    if (checkpoint) requireThat(requireRpcData(await source.rpc('eth_getBlockByNumber', [checkpoint.number, false])).hash === checkpoint.hash,
      'ADMIN_EVIDENCE_CONFLICT', 'A previously confirmed admin transaction is no longer canonical. Reconcile the deployment before continuing.');
  }
  async function run(operation) {
    // The semantic read also has a deadline when a caller supplies a single
    // source without the shared failover controller.
    const controller = new AbortController();
    const until = Date.now() + 45000;
    const timer = setTimeout(() => controller.abort(new PublicError(503, 'ADMIN_READ_UNAVAILABLE',
      'Admin state could not be verified. Try again shortly.')), 45000);
    const abort = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    try {
      return await Promise.race([withSepoliaReadSource(reads, async source => {
        const rpc = async (method, params = [], options = {}) => {
          requireThat(READ_METHODS.has(method), 'ADMIN_READ_ONLY', 'Unsupported admin operation.', 400);
          controller.signal.throwIfAborted();
          const value = await source.rpc(method, params, { ...options, signal: options.signal ?? controller.signal });
          controller.signal.throwIfAborted(); return value;
        };
        const result = await operation({ ...source, rpc });
        controller.signal.throwIfAborted();
        requireThat(Date.now() <= until, 'ADMIN_READ_UNAVAILABLE', 'Admin state could not be verified. Try again shortly.', 503);
        return result;
      }, { signal: controller.signal, sourceTimeoutMs: 20000 }), abort]);
    } finally { clearTimeout(timer); }
  }
  async function policyAt(source, wallet, binding, replacements = []) {
    const p = await readAdminPolicy(source, plan, replacements);
    const [isAdmin, canPause, code] = await Promise.all([
      readContract(source.rpc, at, 'hasRole', [DEFAULT_ADMIN, wallet], p.head.number, abi),
      readContract(source.rpc, at, 'hasRole', [PAUSER, wallet], p.head.number, abi),
      binding.runtimeCodeHash ? source.rpc('eth_getCode', [at, p.head.number]) : undefined,
    ]);
    requireThat(sameAddress(p.admin, wallet) && isAdmin === true, 'ADMIN_REQUIRED', 'Connect the current collection admin wallet.', 403);
    requireThat(!binding.runtimeCodeHash || keccak256(code) === binding.runtimeCodeHash,
      'ADMIN_EVIDENCE_CONFLICT', 'The collection deployment no longer matches verified evidence.');
    requireThat(requireRpcData(await source.rpc('eth_getBlockByNumber', [p.head.number, false])).hash === p.head.hash,
      'ADMIN_EVIDENCE_CONFLICT', 'The admin policy block is no longer canonical.');
    return { ...p, canPause: canPause === true };
  }
  async function authorize(wallet, operation) {
    let address;
    try { address = getAddress(wallet); } catch { fail(403, 'ADMIN_REQUIRED', 'Connect the current collection admin wallet.'); }
    const binding = load(await requireBinding());
    return run(async source => { await checkSettled(source); return operation(source, address, binding); });
  }
  async function configuration(p) {
    try {
      const value = await getAllowlist();
      assert.equal(value.schema, 'sg-pulse-free-configuration/v1'); assert.equal(value.planDigest, plan.digest);
      assert.ok(sameAddress(value.contract, at));
      for (const key of ['root', 'slotCount', 'quota', 'revision']) assert.equal(value[key], p[key]);
      verifyAllowlistArtifacts(value.allowlist);
      assert.equal(value.allowlist.manifest.root, p.root); assert.equal(String(value.allowlist.manifest.slotCount), p.slotCount);
      return value;
    } catch { fail(409, 'ADMIN_ARTIFACTS_MISMATCH', 'Current allowlist files do not match the on-chain policy. Reconcile them before configuring.'); }
  }
  function readyForFree(p) {
    requireThat(p.phase === 0 && BigInt(p.timestamp) < BigInt(p.freeDeadline), 'FREE_POLICY_CLOSED',
      'The paid phase has begun or the free deadline has passed. Free minting cannot be reopened.');
  }
  function noPending() {
    requireThat(!journal.intents.some(unresolved), 'ADMIN_ACTION_PENDING', 'Resolve the pending wallet action before preparing another.');
  }
  function findIntent(id, wallet) {
    requireThat(isCode(id), 'INVALID_INPUT', 'Invalid admin action reference.', 400);
    const row = journal.intents.find(item => item.intentId === id);
    requireThat(row && sameAddress(row.wallet, wallet), 'ADMIN_INTENT_NOT_FOUND', 'This admin action is unavailable.', 404);
    return row;
  }
  async function status(wallet) {
    return safely(() => authorize(wallet, async (source, address, binding) => {
      const p = await policyAt(source, address, binding);
      let wallets = [], configurationError;
      try { wallets = (await configuration(p)).allowlist.slots.map(row => row.wallet); }
      catch (error) { if (!(error instanceof PublicError)) throw error; configurationError = error.message; }
      const pending = journal.intents.find(unresolved);
      const lastIntent = [...journal.intents].reverse().find(row => row.wallet === address && !unresolved(row));
      const resolvedIntents = journal.intents.filter(row => row.wallet === address && !unresolved(row)).map(summaryIntent);
      const review = [...journal.reviews].reverse().find(row => row.wallet === address && row.expiresAt > Date.now()
        && jsonDigest(row.previous) === jsonDigest(fingerprint(p)));
      return { collection: at, chainId: CHAIN, admin: p.admin, policy: p, wallets,
        ...(configurationError ? { configurationError } : {}),
        ...(pending ? { pending: summaryIntent(pending) } : {}), ...(lastIntent ? { lastIntent: summaryIntent(lastIntent) } : {}),
        resolvedIntents,
        ...(review ? { review: review.summary } : {}) };
    }));
  }
  async function review(wallet, body) {
    return safely(async () => {
      const input = fields(body, ['wallets', 'quota']);
      requireThat(typeof input.wallets === 'string' && input.wallets.length <= 230000
        && typeof input.quota === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(input.quota),
      'INVALID_INPUT', 'Enter the full ordered wallet list and a decimal quota.', 400);
      let wallets;
      try { wallets = parseWalletRows(input.wallets); } catch { fail(400, 'INVALID_WALLETS', 'Enter one valid nonzero wallet address per line.'); }
      requireThat(wallets.length <= MAX_SLOTS, 'INVALID_WALLETS', 'The admin editor supports at most 5,000 slots.', 400);
      return authorize(wallet, async (source, address, binding) => {
        noPending();
        let p = await policyAt(source, address, binding); readyForFree(p);
        const previous = await configuration(p);
        requireThat(wallets.length >= previous.allowlist.slots.length, 'SLOT_CAPACITY_SHRINK', 'Existing slot IDs cannot be removed.', 400);
        const replacements = previous.allowlist.slots.filter((row, index) => row.wallet !== wallets[index]).map(row => row.slotId);
        if (replacements.length) {
          const checked = await policyAt(source, address, binding, replacements);
          requireThat(jsonDigest(fingerprint(checked)) === jsonDigest(fingerprint(p)), 'ADMIN_POLICY_CHANGED', 'The free policy changed. Refresh and review again.');
          p = checked;
          requireThat(p.claimedSlotIds.length === 0, 'CLAIMED_SLOT_REPLACEMENT', 'A claimed slot wallet cannot be replaced.', 400);
        }
        requireThat(BigInt(input.quota) >= BigInt(p.freeMinted) && BigInt(input.quota) <= BigInt(wallets.length),
          'INVALID_QUOTA', 'Quota must cover successful free mints and fit the slot capacity.', 400);
        const next = planAdminFreeUpdate(previous.allowlist, wallets, input.quota, { ...p, paused: true });
        const reviewId = opaqueCode();
        const summary = { reviewId, root: next.root, slotCount: next.slotCount, quota: next.quota,
          previousQuota: p.quota, previousSlotCount: p.slotCount, revision: next.revision,
          addedSlots: wallets.length - previous.allowlist.slots.length, reassignedSlots: replacements.length,
          endsFreeMint: next.quota === p.freeMinted };
        const row = { reviewId, wallet: address, wallets, replacements, previous: fingerprint(p), head: p.head,
          summary, expiresAt: Date.now() + REVIEW_TTL_MS };
        return { summary, row };
      }).then(({ summary, row }) => { commit(nextJournal => nextJournal.reviews.push(row)); return summary; });
    });
  }
  async function action(wallet, body) {
    return safely(async () => {
      const input = fields(body, ['action'], ['reviewId']);
      requireThat(['pause', 'configure', 'unpause'].includes(input.action)
        && (input.action === 'configure' ? isCode(input.reviewId) : input.reviewId === undefined),
      'INVALID_INPUT', 'Choose a supported admin action.', 400);
      return authorize(wallet, async (source, address, binding) => {
        noPending();
        const reviewed = input.action === 'configure' ? journal.reviews.find(row => row.reviewId === input.reviewId && row.wallet === address) : undefined;
        if (input.action === 'configure') requireThat(reviewed && reviewed.expiresAt > Date.now(), 'ADMIN_REVIEW_EXPIRED', 'Review the configuration again before sending it.');
        const p = await policyAt(source, address, binding, reviewed?.replacements ?? []);
        let next, summary;
        if (input.action === 'configure') {
          readyForFree(p);
          requireThat(p.paused, 'ADMIN_PAUSE_REQUIRED', 'Pause minting before sending this configuration.');
          requireThat(jsonDigest(reviewed.previous) === jsonDigest(fingerprint(p))
            && requireRpcData(await source.rpc('eth_getBlockByNumber', [reviewed.head.number, false])).hash === reviewed.head.hash,
          'ADMIN_REVIEW_STALE', 'The policy or mint count changed. Refresh and review again.');
          const previous = await configuration(p);
          requireThat(!p.claimedSlotIds?.length, 'CLAIMED_SLOT_REPLACEMENT', 'A claimed slot wallet cannot be replaced.');
          next = { ...planAdminFreeUpdate(previous.allowlist, reviewed.wallets, reviewed.summary.quota, p), planDigest: plan.digest, contract: at };
          requireThat(next.root === reviewed.summary.root && next.revision === reviewed.summary.revision, 'ADMIN_REVIEW_STALE', 'Review the configuration again before sending it.');
          requireThat(next.root !== p.root || next.quota !== p.quota, 'ADMIN_CONFIGURATION_CURRENT', 'This configuration is already current.');
          summary = reviewed.summary;
        } else {
          requireThat(p.canPause, 'ADMIN_PAUSER_REQUIRED', 'This admin wallet does not hold the pauser role.', 403);
          requireThat(p.paused !== (input.action === 'pause'), 'ADMIN_ALREADY_CURRENT', 'Minting is already in the requested pause state.');
          summary = { paused: input.action === 'pause', revision: p.revision };
        }
        const data = encodeFunctionData({ abi, functionName: input.action === 'configure' ? 'configureFreeMint'
          : input.action === 'pause' ? 'pauseMinting' : 'unpauseMinting',
          ...(next ? { args: [next.root, BigInt(next.slotCount), BigInt(next.quota)] } : {}) });
        const [latest, pending, estimated] = await Promise.all([
          source.rpc('eth_getTransactionCount', [address, 'latest']), source.rpc('eth_getTransactionCount', [address, 'pending']),
          source.rpc('eth_estimateGas', [{ from: address, to: at, data, value: '0x0' }, p.head.number]),
        ]);
        // Two abandoned requests must compete for the same nonce, never both
        // execute successive revisions after a delayed wallet broadcast.
        requireThat(BigInt(latest) === BigInt(pending), 'ADMIN_WALLET_PENDING', 'This wallet has a queued transaction. Wait for it to settle before preparing another admin action.');
        const gas = BigInt(estimated) + (BigInt(estimated) + 4n) / 5n;
        requireThat(BigInt(estimated) > 0n && gas <= BigInt(plan.fees?.maxGasPerTransaction ?? '8000000'),
          'ADMIN_GAS_LIMIT', 'The estimated transaction gas exceeds the Sepolia admin limit.');
        requireThat(requireRpcData(await source.rpc('eth_getBlockByNumber', [p.head.number, false])).hash === p.head.hash,
          'ADMIN_EVIDENCE_CONFLICT', 'The admin policy block is no longer canonical.');
        const transaction = { from: address, to: at, chainId: qty(CHAIN), data, value: '0x0', gas: qty(gas), nonce: qty(latest) };
        const intent = { intentId: opaqueCode(), wallet: address, action: input.action, state: 'prepared',
          transaction, summary, previous: fingerprint(p), head: p.head, createdAt: Date.now(),
          ...(reviewed ? { reviewId: reviewed.reviewId, configuration: next } : {}) };
        return intent;
      }).then(intent => {
        commit(nextJournal => nextJournal.intents.push(intent));
        return { intentId: intent.intentId, action: intent.action, transaction: intent.transaction, summary: intent.summary };
      });
    });
  }
  function validateTransaction(tx, intent, hash, receipt) {
    try {
      const expected = intent.transaction;
      assert.equal(tx.hash.toLowerCase(), hash); assert.ok(sameAddress(tx.from, expected.from)); assert.ok(sameAddress(tx.to, at));
      assert.equal(BigInt(tx.chainId), BigInt(CHAIN)); assert.equal(BigInt(tx.value), 0n);
      assert.equal((tx.input ?? tx.data).toLowerCase(), expected.data.toLowerCase()); assert.equal(BigInt(tx.nonce), BigInt(expected.nonce));
      assert.equal(BigInt(tx.gas), BigInt(expected.gas));
      const decoded = decodeFunctionData({ abi, data: tx.input ?? tx.data });
      assert.equal(decoded.functionName, intent.action === 'configure' ? 'configureFreeMint' : intent.action === 'pause' ? 'pauseMinting' : 'unpauseMinting');
      if (intent.action === 'configure') assert.deepEqual(decoded.args, [intent.configuration.root, BigInt(intent.configuration.slotCount), BigInt(intent.configuration.quota)]);
      if (receipt) {
        assert.equal(tx.blockHash.toLowerCase(), receipt.blockHash); assert.equal(BigInt(tx.blockNumber), BigInt(receipt.blockNumber));
        assert.equal(BigInt(tx.transactionIndex), BigInt(receipt.transactionIndex));
      }
    } catch { fail(409, 'ADMIN_TRANSACTION_MISMATCH', 'The transaction does not match this prepared admin action.'); }
  }
  async function report(wallet, body) {
    return safely(async () => {
      const input = fields(body, ['intentId', 'transactionHash']);
      requireThat(typeof input.transactionHash === 'string' && HASH.test(input.transactionHash), 'INVALID_INPUT', 'Enter a valid transaction hash.', 400);
      const hash = input.transactionHash.toLowerCase();
      const prepared = await authorize(wallet, async (source, address, binding) => {
        await policyAt(source, address, binding);
        const intent = findIntent(input.intentId, address);
        requireThat(intent.state !== 'superseded', 'ADMIN_INTENT_SUPERSEDED', 'Another verified transaction consumed this action’s nonce.');
        requireThat(!intent.transactionHash || intent.transactionHash === hash || !intent.hashValidated,
          'ADMIN_TRANSACTION_MISMATCH', 'This action already tracks another verified transaction.');
        if (['confirmed', 'reverted'].includes(intent.state)) {
          requireThat(intent.transactionHash === hash, 'ADMIN_TRANSACTION_MISMATCH', 'This action already tracks another verified transaction.');
          return { settled: { state: intent.state, transactionHash: hash } };
        }
        return { intent: structuredClone(intent), address, binding };
      });
      if (prepared.settled) return prepared.settled;
      const { intent, address, binding } = prepared;
      if (intent.configuration?.wallets) {
        const built = buildAllowlist(intent.configuration.wallets);
        requireThat(built.manifest.root === intent.configuration.root, 'ADMIN_STORAGE_UNAVAILABLE', 'Saved admin configuration is invalid.', 503);
        intent.configuration.allowlist = { manifest: built.manifest, slots: built.slots, tree: built.tree, proofs: built.proofs };
        delete intent.configuration.wallets;
      }
        // Save a reported candidate before asking RPC. An unindexed hash is
        // uncertain delivery, never proof of success and never a resend cue.
        commit(next => {
          const row = next.intents.find(item => item.intentId === intent.intentId);
          row.reportedHash = hash;
        });
      return run(async source => {
        await policyAt(source, address, binding);
        const [rawReceipt, tx] = await Promise.all([
          source.rpc('eth_getTransactionReceipt', [hash]), source.rpc('eth_getTransactionByHash', [hash]),
        ]);
        if (tx) validateTransaction(tx, intent, hash);
        if (!rawReceipt || !tx) {
          return { state: 'pending', transactionHash: hash, hashValidated: !!tx };
        }
        let receipt;
        try {
          receipt = canonicalSepoliaMintReceipt(rawReceipt);
          assert.equal(receipt.transactionHash, hash); assert.ok(sameAddress(receipt.from, address)); assert.ok(sameAddress(receipt.to, at));
          assert.equal(receipt.contractAddress, null);
          for (const log of receipt.logs) {
            assert.equal(log.removed, false); assert.equal(log.transactionHash, hash); assert.equal(log.blockHash, receipt.blockHash);
            assert.equal(BigInt(log.blockNumber), BigInt(receipt.blockNumber)); assert.equal(BigInt(log.transactionIndex), BigInt(receipt.transactionIndex));
          }
          const block = requireRpcData(await source.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]));
          assert.equal(block.hash, receipt.blockHash); assert.equal(BigInt(block.number), BigInt(receipt.blockNumber));
        } catch (error) {
          if (error?.retryableRead || error?.code === 'RPC_DATA_UNAVAILABLE') throw error;
          fail(409, 'ADMIN_EVIDENCE_CONFLICT', 'The transaction receipt does not match canonical chain evidence.');
        }
        validateTransaction(tx, intent, hash, receipt);
        if (receipt.status === '0x0') {
          requireThat(receipt.logs.length === 0, 'ADMIN_EVIDENCE_CONFLICT', 'The reverted transaction has inconsistent event evidence.');
          return { state: 'reverted', transactionHash: hash, receipt };
        }
        const events = receipt.logs.filter(log => sameAddress(log.address, at)).map(log => {
          try { return decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); } catch { return undefined; }
        });
        const eventName = intent.action === 'configure' ? 'FreeMintConfigured' : intent.action === 'pause' ? 'Paused' : 'Unpaused';
        const matching = events.filter(event => event?.eventName === eventName);
        requireThat(matching.length === 1, 'ADMIN_EVIDENCE_CONFLICT', 'The transaction did not emit the expected admin event.');
        const event = matching[0];
        if (intent.action === 'configure') {
          const next = intent.configuration;
          requireThat(event.args.root === next.root && String(event.args.slotCount) === next.slotCount
            && String(event.args.quota) === next.quota && String(event.args.revision) === next.revision
            && event.args.configHash === keccak256(encodeAbiParameters(['bytes32', 'uint256', 'uint256', 'uint64'].map(type => ({ type })),
              [next.root, BigInt(next.slotCount), BigInt(next.quota), BigInt(next.revision)])),
          'ADMIN_EVIDENCE_CONFLICT', 'The configured policy event does not match the reviewed configuration.');
        } else requireThat(sameAddress(event.args.account, address), 'ADMIN_EVIDENCE_CONFLICT', 'The pause event names another wallet.');
        const [sale, root, paused] = await Promise.all([
          readContract(source.rpc, at, 'saleStatus', [], receipt.blockNumber, abi),
          readContract(source.rpc, at, 'freeMintRoot', [], receipt.blockNumber, abi),
          readContract(source.rpc, at, 'paused', [], receipt.blockNumber, abi),
        ]);
        let publishConfiguration = false;
        if (intent.action === 'configure') {
          const next = intent.configuration;
          // A later transaction in this same block can legitimately replace
          // the policy or unpause minting. The exact event proves this action;
          // block-end and current state determine whether its files are current.
          requireThat(String(sale.freeDeadline) === intent.previous.freeDeadline,
            'ADMIN_EVIDENCE_CONFLICT', 'The free deadline differs from the verified deployment.');
          const atReceipt = root === next.root && String(sale.freeSlotCount) === next.slotCount && String(sale.freeMintQuota) === next.quota
            && String(sale.freeConfigRevision) === next.revision;
          const current = await policyAt(source, address, binding);
          publishConfiguration = atReceipt && ['root', 'slotCount', 'quota', 'revision'].every(key => current[key] === next[key]);
        }
        requireThat(requireRpcData(await source.rpc('eth_getBlockByNumber', [receipt.blockNumber, false])).hash === receipt.blockHash,
          'ADMIN_EVIDENCE_CONFLICT', 'The transaction block is no longer canonical.');
        // No side effects inside a failover attempt: returning verified evidence
        // prevents a timed-out source from publishing late results.
        return { state: 'verified', intentId: intent.intentId, transactionHash: hash, receipt,
          ...(publishConfiguration ? { configuration: { ...intent.configuration, transactionHash: hash } } : {}),
          ...(intent.action === 'configure' && !publishConfiguration ? { configurationSuperseded: true } : {}) };
      }).then(async result => {
        if (result.state === 'pending') {
          commit(next => Object.assign(next.intents.find(row => row.intentId === intent.intentId),
            { state: 'submitted', transactionHash: hash, hashValidated: result.hashValidated }));
          return { state: 'pending', transactionHash: hash, hashValidated: result.hashValidated };
        }
        if (result.state === 'reverted') {
          commit(next => {
            Object.assign(next.intents.find(row => row.intentId === intent.intentId),
              { state: 'reverted', transactionHash: hash, hashValidated: true, receipt: result.receipt });
            for (const row of next.intents) if (row.intentId !== intent.intentId && unresolved(row)
              && row.wallet === intent.wallet && row.transaction.nonce === intent.transaction.nonce)
              Object.assign(row, { state: 'superseded', supersededBy: intent.intentId });
          });
          return { state: 'reverted', transactionHash: hash };
        }
        if (result.configuration) await persistAllowlist(result.configuration);
        commit(next => {
          Object.assign(next.intents.find(row => row.intentId === result.intentId),
            { state: 'confirmed', transactionHash: result.transactionHash, hashValidated: true, receipt: result.receipt,
              ...(result.configurationSuperseded ? { configurationSuperseded: true } : {}) });
          for (const row of next.intents) if (row.intentId !== result.intentId && unresolved(row)
            && row.wallet === intent.wallet && row.transaction.nonce === intent.transaction.nonce)
            Object.assign(row, { state: 'superseded', supersededBy: result.intentId });
        });
        await onUpdated();
        return { state: 'confirmed', transactionHash: result.transactionHash,
          ...(result.configurationSuperseded ? { configurationSuperseded: true } : {}) };
      });
    });
  }
  async function cancel(wallet, body) {
    return safely(async () => {
      const input = fields(body, ['intentId']);
      return authorize(wallet, async (source, address, binding) => {
        await policyAt(source, address, binding);
        const intent = findIntent(input.intentId, address);
        requireThat(intent.state === 'abandoned' || intent.state === 'prepared' && !intent.transactionHash && !intent.reportedHash,
          'ADMIN_ACTION_UNCERTAIN', 'A submitted or uncertain wallet action must be reconciled by transaction hash.');
        // Explicit authenticated acknowledgement after wallet error 4001. This
        // records intent abandonment, not proof that no transaction exists.
        // Exact transaction and nonce remain recoverable by a later report.
        return { state: 'abandoned', intentId: intent.intentId };
      }).then(result => {
        if (journal.intents.find(row => row.intentId === result.intentId).state !== 'abandoned')
          commit(next => Object.assign(next.intents.find(row => row.intentId === result.intentId),
            { state: 'abandoned', abandonedAt: Date.now() }));
        return result;
      });
    });
  }
  return { status, review, action, report, cancel };
}
