import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ROOT, jsonDigest } from '../contracts/tools/pulse-candidate-lock.mjs';
import { loadPulseAdminArtifact } from '../contracts/tools/pulse-admin-candidate.mjs';
import { ADMIN_PROFILE, sepoliaAdminTestPlan, validateSepoliaAdminTestPlan, planAdminFreeUpdate } from '../contracts/tools/pulse-sepolia-admin-plan.mjs';
import { DEPLOYER, INPUT_PROFILE, SEPOLIA } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { parseWalletRows, verifyAllowlistArtifacts, buildAllowlist } from '../contracts/tools/pulse-allowlist.mjs';
import { context, readOnlyContext, save, checkNetwork, sharedReadBlock, readContract, validateSignedStep,
  rpcTransport, retrySafeReads, boundedReadSource, SEPOLIA_SECONDARY_READ_RPC } from './pulse-sepolia.mjs';
import { createSepoliaReadFailover, withSepoliaReadSource } from './pulse-sepolia-rpc.mjs';
import { verifyPulseAdminDeployment } from './pulse-sepolia-admin-verify.mjs';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';
import { pulseAdminMintTypedData, pulseAdminMintDigest } from '../src/openMint/pulseAdminAuthorization.ts';

export const DIR = resolve(ROOT, '.local/pulse-sepolia-admin-v1');
const qty = value => '0x' + BigInt(value).toString(16);
const json = value => JSON.stringify(value, (_key, n) => typeof n === 'bigint' ? n.toString() : n, 2) + '\n';
const sameAddress = (a, b) => assert.equal(getAddress(a), getAddress(b));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const output = value => console.log(json(value));
const finished = saved => saved?.status === 'included' || saved?.status === 'reverted';

/** Test operator routing never edits the existing env file. Read-only operations
 * use validated primary/fallback; signing and raw delivery stay at the explicitly
 * selected primary. There is no write-method failover. */
export function operatorContext({ readOnly = false, env = process.env, baseFactory,
  transportFactory = rpcTransport, validateSource = checkNetwork, minimumStartIntervalMs = 1000 } = {}) {
  assert.ok(env.SEPOLIA_ADMIN_AUDIT_SOURCES === undefined || ['1', '2'].includes(env.SEPOLIA_ADMIN_AUDIT_SOURCES));
  const primaryUrl = env.SEPOLIA_ADMIN_RPC_URL, secondaryUrl = env.SEPOLIA_ADMIN_SECONDARY_RPC_URL;
  if (secondaryUrl) assert.ok(primaryUrl, 'Specify the admin primary with a custom secondary');
  if (primaryUrl) {
    const primary = new URL(primaryUrl), secondary = new URL(secondaryUrl ?? SEPOLIA_SECONDARY_READ_RPC);
    assert.equal(primary.protocol, 'https:'); assert.equal(secondary.protocol, 'https:');
    assert.notEqual(primary.hostname, secondary.hostname, 'Admin read endpoints must have distinct hosts');
  }
  const base = (baseFactory ?? (readOnly ? readOnlyContext : context))();
  const raw = { ...base,
    ...(primaryUrl ? { rpc: retrySafeReads(boundedReadSource(transportFactory(primaryUrl), minimumStartIntervalMs)) } : {}),
    ...(secondaryUrl ? { second: retrySafeReads(boundedReadSource(transportFactory(secondaryUrl), minimumStartIntervalMs)) } : {}) };
  const reads = createSepoliaReadFailover(raw, async source => { await validateSource(source); }, { attemptTimeoutMs: 60000 });
  return readOnly ? reads : { ...raw, readContext: reads, auditSources: env.SEPOLIA_ADMIN_AUDIT_SOURCES === '2' ? 2 : 1,
    validateWriteSource: () => validateSource({ rpc: raw.rpc, readPolicy: 'validated-write-primary/v1' }) };
}

export function loadAdminPlan(directory = DIR) {
  return validateSepoliaAdminTestPlan(read(resolve(directory, 'plan.json')));
}
export function loadAdminJournal(directory = DIR, plan = loadAdminPlan(directory)) {
  const journal = read(resolve(directory, 'journal.json'));
  assert.equal(journal.schema, 'sg-pulse-sepolia-admin-journal/v1');
  assert.equal(journal.planDigest, plan.digest); assert.ok(journal.transactions && journal.operations);
  return journal;
}

/** Exact signed bytes are durable before delivery. Unknown delivery never gets
 * a fresh nonce, fee bump, replacement request, or automatic second send. */
export async function sendAdminStep(c, plan, journal, step, request, {
  nonce, persist = () => save('journal.json', journal, DIR), expectedSigner = DEPLOYER,
  pollTimeoutMs = 50000, pollIntervalMs = 2000, wait = sleep, beforeBroadcast = async () => {},
} = {}) {
  assert.equal(plan.contractProfile, ADMIN_PROFILE); assert.equal(plan.chainId, SEPOLIA);
  assert.equal(journal.planDigest, plan.digest);
  assert.match(step, /^(collection|configure-r[1-9][0-9]*|pause-[1-9][0-9]*|unpause-[1-9][0-9]*|free0)$/);
  assert.deepEqual(Object.keys(request).sort(), request.to ? ['data', 'to', 'value'] : ['data', 'value']);
  assert.match(request.data, /^0x(?:[0-9a-f]{2})+$/i); assert.equal(request.value, '0x0');
  if (request.to) sameAddress(request.to, plan.collection.address);
  assert.ok(Number.isSafeInteger(pollTimeoutMs) && pollTimeoutMs >= 0 && pollTimeoutMs <= 50000);
  assert.ok(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0);
  let saved = journal.transactions[step];
  if (!saved) {
    assert.ok(Object.entries(journal.transactions).every(([name, row]) => name === step || finished(row)),
      'Resolve the previous journal transaction before signing another');
    // A fallback read cannot authorize signing for an unvalidated write route.
    await c.validateWriteSource?.();
    const current = Number(BigInt(await c.rpc('eth_getTransactionCount', [expectedSigner, 'latest'])));
    assert.ok(Number.isSafeInteger(current) && current >= 0);
    assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [expectedSigner, 'pending']))), current,
      'Sender has an unresolved pending nonce');
    if (nonce !== undefined) assert.equal(current, nonce, 'Planned CREATE nonce changed');
    const head = await c.rpc('eth_getBlockByNumber', ['latest', false]);
    const gas = BigInt(await c.rpc('eth_estimateGas', [{ from: expectedSigner, ...request }]));
    assert.ok(gas > 0n);
    const gasLimit = gas + (gas + 4n) / 5n, priority = BigInt(plan.fees.maxPriorityFeePerGas);
    const fee = 2n * BigInt(head.baseFeePerGas) + priority;
    assert.ok(gasLimit <= BigInt(plan.fees.maxGasPerTransaction), 'Gas limit exceeds test policy');
    assert.ok(fee > 0n && fee <= BigInt(plan.fees.maxFeePerGas), 'Fee exceeds test policy');
    const exposure = gasLimit * fee;
    const used = Object.values(journal.transactions).reduce((n, row) => n + BigInt(row.worstCaseWei), 0n);
    assert.ok(used + exposure <= BigInt(plan.fees.totalWorstCaseWei), 'Total Sepolia test budget exceeded');
    assert.ok(BigInt(await c.rpc('eth_getBalance', [expectedSigner, 'latest'])) >= exposure, 'Insufficient Sepolia test ETH');
    const signer = c.unlock(); sameAddress(signer.address, expectedSigner);
    const raw = await signer.signTransaction({ chainId: SEPOLIA, type: 'eip1559', nonce: current, gas: gasLimit,
      maxFeePerGas: fee, maxPriorityFeePerGas: priority, value: 0n, data: request.data,
      ...(request.to ? { to: request.to } : {}) });
    saved = journal.transactions[step] = { request, nonce: current, raw, hash: keccak256(raw),
      worstCaseWei: String(exposure), status: 'signed' };
    await persist();
  }
  await validateSignedStep(saved, request, plan.fees, expectedSigner);
  assert.ok(Object.values(journal.transactions).reduce((n, row) => n + BigInt(row.worstCaseWei), 0n)
    <= BigInt(plan.fees.totalWorstCaseWei), 'Journal exceeds approved test budget');
  assert.notEqual(saved.status, 'reverted', 'Reverted transaction must not be replaced automatically');
  // An explicit resume also validates its receipt lookup/delivery route rather
  // than trusting a previously healthy or differently selected endpoint.
  await c.validateWriteSource?.();
  let receipt = await c.rpc('eth_getTransactionReceipt', [saved.hash]);
  if (!receipt) {
    const known = await c.rpc('eth_getTransactionByHash', [saved.hash]);
    if (!known) {
      assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [expectedSigner, 'latest']))), saved.nonce,
        'Signed nonce changed; inspect the existing transaction');
      assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [expectedSigner, 'pending']))), saved.nonce,
        'Pending sender activity must be resolved before resuming');
      await beforeBroadcast();
      saved.status = 'delivery-unknown'; await persist();
      try { assert.equal(await c.rpc('eth_sendRawTransaction', [saved.raw]), saved.hash, 'Returned transaction hash differs'); }
      catch (error) {
        saved.status = 'delivery-unknown'; try { await persist(); } catch {}
        throw new Error('Sepolia delivery is uncertain; the exact signed transaction is preserved. Resume this command, never replace its nonce.');
      }
    }
    saved.status = 'pending'; await persist();
    const until = Date.now() + pollTimeoutMs;
    while (!receipt && Date.now() < until) { await wait(pollIntervalMs); receipt = await c.rpc('eth_getTransactionReceipt', [saved.hash]); }
    if (!receipt) throw new Error('Transaction pending; resume the same command using its durable journal.');
  }
  assert.equal(receipt.transactionHash, saved.hash); sameAddress(receipt.from, expectedSigner);
  assert.equal(receipt.to === null ? null : getAddress(receipt.to), request.to ? getAddress(request.to) : null);
  if (step === 'collection' && receipt.status === '0x1') sameAddress(receipt.contractAddress, plan.collection.address);
  else assert.equal(receipt.contractAddress, null);
  assert.ok(receipt.status === '0x1' || receipt.status === '0x0');
  assert.equal((await c.rpc('eth_getBlockByNumber', [receipt.blockNumber, false])).hash, receipt.blockHash,
    'Receipt is not on the canonical chain');
  saved.receipt = receipt; saved.status = receipt.status === '0x1' ? 'included' : 'reverted'; await persist();
  assert.equal(receipt.status, '0x1', 'Transaction reverted; no automatic replacement');
  return receipt;
}

export async function readAdminPolicy(c, plan, replacementSlotIds = []) {
  return withSepoliaReadSource(c.readContext ?? c, source => readAdminPolicyAtSource(source, plan, replacementSlotIds));
}
async function readAdminPolicyAtSource(c, plan, replacementSlotIds) {
  const head = await sharedReadBlock(c), abi = loadPulseAdminArtifact().abi, at = plan.collection.address;
  const [sale, root, admin, paused] = await Promise.all([
    readContract(c.rpc, at, 'saleStatus', [], head.number, abi),
    readContract(c.rpc, at, 'freeMintRoot', [], head.number, abi),
    readContract(c.rpc, at, 'defaultAdmin', [], head.number, abi),
    readContract(c.rpc, at, 'paused', [], head.number, abi),
  ]);
  let claimedSlotIds;
  if (replacementSlotIds.length) {
    assert.equal(new Set(replacementSlotIds).size, replacementSlotIds.length);
    assert.ok(replacementSlotIds.every(id => Number.isSafeInteger(id) && id >= 0 && BigInt(id) < sale.freeSlotCount));
    const states = await Promise.all(replacementSlotIds.map(id =>
      readContract(c.rpc, at, 'isFreeSlotClaimed', [BigInt(id)], head.number, abi)));
    assert.ok(states.every(value => typeof value === 'boolean'));
    claimedSlotIds = replacementSlotIds.filter((_id, i) => states[i]).map(String);
  }
  assert.equal((await c.rpc('eth_getBlockByNumber', [head.number, false])).hash, head.hash);
  return { phase: sale.phase, paused, root, admin: getAddress(admin), slotCount: String(sale.freeSlotCount),
    quota: String(sale.freeMintQuota), revision: String(sale.freeConfigRevision), freeMinted: String(sale.freeMinted),
    freeDeadline: String(sale.freeDeadline), timestamp: String(BigInt(head.timestamp)),
    head: { number: head.number, hash: head.hash, timestamp: head.timestamp },
    ...(claimedSlotIds ? { claimedSlotIds } : {}) };
}

function configurationFor(plan, journal, policy, directory = DIR) {
  let value;
  if (policy.revision === '1') value = { schema: 'sg-pulse-free-configuration/v1', planDigest: plan.digest,
    contract: plan.collection.address, root: plan.sale.freeMintRoot, slotCount: plan.sale.freeSlotCount,
    quota: plan.sale.freeMintQuota, revision: '1', allowlist: plan.allowlist };
  else if (existsSync(resolve(directory, 'free-config.json'))) value = read(resolve(directory, 'free-config.json'));
  if (!value || value.revision !== policy.revision || value.root !== policy.root)
    value = Object.values(journal.operations).map(op => op.configuration).find(v => v?.revision === policy.revision && v.root === policy.root);
  assert.ok(value, 'Current allowlist artifacts are not available');
  assert.equal(value.planDigest, plan.digest); sameAddress(value.contract, plan.collection.address);
  assert.equal(value.root, policy.root); assert.equal(value.slotCount, policy.slotCount); assert.equal(value.quota, policy.quota);
  verifyAllowlistArtifacts(value.allowlist); assert.equal(value.allowlist.manifest.root, value.root);
  assert.equal(String(value.allowlist.manifest.slotCount), value.slotCount);
  return value;
}
const persistJournal = journal => () => save('journal.json', journal, DIR);

async function prepare() {
  if (existsSync(resolve(DIR, 'plan.json'))) {
    const p = loadAdminPlan(); loadAdminJournal(DIR, p);
    output({ status: 'existing-plan', digest: p.digest, collection: p.collection.address }); return;
  }
  assert.ok(!existsSync(DIR), 'Incomplete private run requires inspection; no files overwritten');
  const c = operatorContext({ readOnly: true });
  const authorizerKey = generatePrivateKey(), authorizer = privateKeyToAccount(authorizerKey);
  const plan = await withSepoliaReadSource(c, async source => {
    const head = await checkNetwork(source);
    const nonce = Number(BigInt(await source.rpc('eth_getTransactionCount', [DEPLOYER, 'latest'])));
    assert.equal(Number(BigInt(await source.rpc('eth_getTransactionCount', [DEPLOYER, 'pending']))), nonce);
    const value = sepoliaAdminTestPlan({ deployer: DEPLOYER, authorizer: authorizer.address,
      nonce, createdAt: Number(BigInt(head.timestamp)) });
    assert.equal(keccak256(await source.rpc('eth_getCode', [value.renderer.address, head.number])), value.renderer.runtimeCodeHash);
    assert.equal((await source.rpc('eth_getBlockByNumber', [head.number, false])).hash, head.hash);
    return value;
  });
  mkdirSync(DIR, { mode: 0o700 });
  writeFileSync(resolve(DIR, 'authorizer.key'), authorizerKey + '\n', { mode: 0o600, flag: 'wx' });
  save('plan.json', plan, DIR); save('journal.json', { schema: 'sg-pulse-sepolia-admin-journal/v1',
    planDigest: plan.digest, transactions: {}, operations: {} }, DIR);
  output({ status: 'prepared-not-broadcast', collection: plan.collection.address,
    renderer: plan.renderer.address, authorizer: plan.authorities.authorizer, digest: plan.digest, testOnly: true });
}

async function verified(c, plan, journal, { audit = false } = {}) {
  // Ordinary operator checks use one whole semantic read at one validated
  // source. Two-source agreement is an explicit inspect audit, not runtime gate.
  const value = await verifyPulseAdminDeployment(audit ? c : c.readContext ?? c, plan, journal);
  save('deployment.json', value.verification, DIR); return value.binding;
}
async function deploy() {
  const p = loadAdminPlan(), j = loadAdminJournal(DIR, p), c = operatorContext();
  await c.validateWriteSource();
  assert.ok(BigInt(p.sale.freeDeadline) > BigInt((await sharedReadBlock(c.readContext)).timestamp), 'Planned free deadline expired');
  const receipt = await sendAdminStep(c, p, j, 'collection', { data: p.collection.data, value: '0x0' },
    { nonce: p.collection.nonce, persist: persistJournal(j) });
  await verified(c, p, j);
  const policy = await readAdminPolicy(c, p); save('free-config.json', configurationFor(p, j, policy), DIR);
  output({ status: 'deployed-paused', collection: p.collection.address, transactionHash: receipt.transactionHash, policy });
}

export function configurationOperation(plan, journal, previous, wallets, quota, policy) {
  const desired = buildAllowlist(wallets), quotaString = String(BigInt(quota));
  const unresolved = Object.entries(journal.operations).find(([step, op]) => op.kind === 'configure' && !finished(journal.transactions[step]));
  if (unresolved) {
    const [step, op] = unresolved;
    assert.equal(op.configuration.root, desired.manifest.root, 'Resume the exact pending allowlist update');
    assert.equal(op.configuration.quota, quotaString, 'Resume the exact pending quota');
    assert.ok(policy.revision === String(BigInt(op.configuration.revision) - 1n) || policy.revision === op.configuration.revision);
    return { step, configuration: op.configuration };
  }
  if (desired.manifest.root === policy.root && quotaString === policy.quota) return { alreadyCurrent: true, configuration: previous };
  const next = planAdminFreeUpdate(previous.allowlist, wallets, quotaString, policy);
  const configuration = { ...next, planDigest: plan.digest, contract: plan.collection.address };
  return { step: 'configure-r' + next.revision, configuration };
}

async function configure(walletFile, quota) {
  const p = loadAdminPlan(), j = loadAdminJournal(DIR, p), c = operatorContext(); await verified(c, p, j);
  const wallets = parseWalletRows(readFileSync(walletFile, 'utf8')), policy = await readAdminPolicy(c, p);
  sameAddress(policy.admin, DEPLOYER);
  const previous = configurationFor(p, j, policy);
  assert.ok(wallets.length >= previous.allowlist.slots.length, 'Existing slot IDs cannot be removed');
  const replacements = previous.allowlist.slots.filter((row, index) => getAddress(wallets[index]) !== getAddress(row.wallet)).map(row => row.slotId);
  const claimedPolicy = replacements.length ? await readAdminPolicy(c, p, replacements) : policy;
  assert.equal(claimedPolicy.root, policy.root); assert.equal(claimedPolicy.revision, policy.revision);
  const operation = configurationOperation(p, j, previous, wallets, quota, claimedPolicy);
  if (operation.alreadyCurrent) { save('free-config.json', operation.configuration, DIR); output({ status: 'configuration-current', policy }); return; }
  const { step, configuration } = operation;
  j.operations[step] ??= { kind: 'configure', configuration }; save('journal.json', j, DIR);
  const abi = loadPulseAdminArtifact().abi, request = { to: p.collection.address, value: '0x0',
    data: encodeFunctionData({ abi, functionName: 'configureFreeMint',
      args: [configuration.root, BigInt(configuration.slotCount), BigInt(configuration.quota)] }) };
  const receipt = await sendAdminStep(c, p, j, step, request, { persist: persistJournal(j), beforeBroadcast: async () => {
    const current = await readAdminPolicy(c, p, replacements);
    assert.equal(current.paused, true); assert.equal(current.phase, 0); sameAddress(current.admin, DEPLOYER);
    assert.equal(BigInt(current.revision) + 1n, BigInt(configuration.revision)); assert.ok(BigInt(current.timestamp) < BigInt(current.freeDeadline));
    assert.ok(BigInt(configuration.quota) >= BigInt(current.freeMinted));
    if (replacements.length) assert.deepEqual(current.claimedSlotIds, [], 'Replacement slot was claimed before delivery');
  } });
  const event = receipt.logs.filter(log => getAddress(log.address) === p.collection.address)
    .map(log => { try { return decodeEventLog({ abi, ...log }); } catch { return undefined; } })
    .find(log => log?.eventName === 'FreeMintConfigured');
  assert.ok(event); assert.equal(event.args.root, configuration.root);
  assert.equal(String(event.args.slotCount), configuration.slotCount); assert.equal(String(event.args.quota), configuration.quota);
  assert.equal(String(event.args.revision), configuration.revision);
  assert.equal(event.args.configHash, keccak256(encodeAbiParameters(
    ['bytes32', 'uint256', 'uint256', 'uint64'].map(type => ({ type })),
    [configuration.root, BigInt(configuration.slotCount), BigInt(configuration.quota), BigInt(configuration.revision)])));
  const current = await readAdminPolicy(c, p);
  assert.equal(current.root, configuration.root); assert.equal(current.quota, configuration.quota); assert.equal(current.revision, configuration.revision);
  const applied = { ...configuration, transactionHash: receipt.transactionHash };
  save('free-config.json', applied, DIR);
  j.operations[step].configuration = applied; j.operations[step].completed = true; save('journal.json', j, DIR);
  output({ status: 'free-policy-configured', collection: p.collection.address, transactionHash: receipt.transactionHash, policy: current });
}

async function setPaused(paused) {
  const p = loadAdminPlan(), j = loadAdminJournal(DIR, p), c = operatorContext(); await verified(c, p, j);
  const policy = await readAdminPolicy(c, p);
  const prefix = paused ? 'pause-' : 'unpause-';
  const pending = Object.keys(j.transactions).find(step => step.startsWith(prefix) && !finished(j.transactions[step]));
  if (policy.paused === paused && !pending) { output({ status: paused ? 'already-paused' : 'already-unpaused', policy }); return; }
  const step = pending ?? prefix + String(Object.keys(j.transactions).length + 1);
  const request = { to: p.collection.address, value: '0x0',
    data: encodeFunctionData({ abi: loadPulseAdminArtifact().abi, functionName: paused ? 'pauseMinting' : 'unpauseMinting' }) };
  const receipt = await sendAdminStep(c, p, j, step, request, { persist: persistJournal(j) });
  const current = await readAdminPolicy(c, p); assert.equal(current.paused, paused);
  output({ status: paused ? 'paused' : 'unpaused', transactionHash: receipt.transactionHash, policy: current });
}

async function smoke() {
  const p = loadAdminPlan(), j = loadAdminJournal(DIR, p), c = operatorContext(), binding = await verified(c, p, j);
  const abi = loadPulseAdminArtifact().abi, at = p.collection.address, handle = 'SGSepoliaAdm01', mbti = 'INTJ';
  let request = j.transactions.free0?.request;
  if (!request) {
    const policy = await readAdminPolicy(c, p); assert.equal(policy.paused, false); assert.equal(policy.phase, 0);
    const configuration = configurationFor(p, j, policy);
    const proof = configuration.allowlist.proofs.find(row => getAddress(row.wallet) === DEPLOYER && row.slotId === 0);
    assert.ok(proof); assert.equal(await readContract(c.rpc, at, 'isFreeSlotClaimed', [0n], policy.head.number, abi), false);
    const keyFile = resolve(DIR, 'authorizer.key'); assert.equal(statSync(keyFile).mode & 0o077, 0);
    const signer = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim()); sameAddress(signer.address, p.authorities.authorizer);
    const now = BigInt(policy.timestamp), deadline = now + 900n > BigInt(policy.freeDeadline) ? BigInt(policy.freeDeadline) : now + 900n;
    const authorization = { handleKey: openMintHandleKey(handle.toLowerCase()), assessmentDigest: keccak256(stringToHex('DISPOSABLE RC2 FIXTURE NOT GROK:' + p.digest + ':' + handle)),
      inputDigest: generativeInputDigest(handle, mbti, p.renderer.identity, INPUT_PROFILE), recipient: DEPLOYER,
      nonce: keccak256(stringToHex(p.digest + ':free0')), issuedAt: now, deadline, mintMode: 0, slotId: 0n,
      maxPrice: 0n, freeConfigRevision: BigInt(policy.revision) };
    const signature = await signer.signTypedData(pulseAdminMintTypedData({ chainId: SEPOLIA, verifyingContract: at }, authorization));
    request = { to: at, value: '0x0', data: encodeFunctionData({ abi, functionName: 'mintFree', args: [handle, mbti, authorization, signature, proof.siblings] }) };
  }
  const decoded = decodeFunctionData({ abi, data: request.data }), authorization = decoded.args[2];
  assert.equal(decoded.functionName, 'mintFree');
  const receipt = await sendAdminStep(c, p, j, 'free0', request, { persist: persistJournal(j), beforeBroadcast: async () => {
    const current = await readAdminPolicy(c, p); assert.equal(current.paused, false); assert.equal(current.phase, 0);
    assert.equal(current.revision, String(authorization.freeConfigRevision));
    assert.ok(BigInt(current.timestamp) >= authorization.issuedAt && BigInt(current.timestamp) < authorization.deadline);
  } });
  const id = BigInt(authorization.handleKey);
  sameAddress(await readContract(c.rpc, at, 'ownerOf', [id], receipt.blockNumber, abi), DEPLOYER);
  assert.deepEqual(await readContract(c.rpc, at, 'inputs', [id], receipt.blockNumber, abi), [handle, mbti]);
  const events = receipt.logs.filter(log => getAddress(log.address) === at).map(log => {
    try { return decodeEventLog({ abi, ...log }); } catch { return undefined; }
  });
  const mint = events.find(event => event?.eventName === 'GenerativeSignatureMinted');
  const economics = events.find(event => event?.eventName === 'MintEconomics');
  assert.ok(mint && economics); sameAddress(mint.args.recipient, DEPLOYER);
  assert.equal(mint.args.nonce, authorization.nonce); assert.equal(mint.args.handleKey, authorization.handleKey);
  assert.equal(mint.args.authorizationDigest, pulseAdminMintDigest({ chainId: SEPOLIA, verifyingContract: at }, authorization));
  assert.equal(economics.args.mintMode, 0); assert.equal(economics.args.price, 0n);
  assert.equal(events.filter(event => event?.eventName === 'Sale').length, 0);
  const svg = await readContract(c.rpc, at, 'svg', [id], receipt.blockNumber, abi); assert.ok(svg.startsWith('<svg'));
  const result = { handle, mbti, tokenId: String(id), transactionHash: receipt.transactionHash,
    freeConfigRevision: String(authorization.freeConfigRevision), provider: 'fixture-not-grok', realProviderCalls: 0 };
  save('smoke.json', { schema: 'sg-pulse-sepolia-admin-smoke/v1', planDigest: p.digest, collection: at,
    contractProfile: binding.contractProfile, results: [result] }, DIR);
  output({ status: 'one-free-mint-included', ...result, policy: await readAdminPolicy(c, p) });
}

export function parseAdminArgs(args) {
  const command = args[0];
  assert.ok(['prepare', 'deploy', 'configure', 'pause', 'unpause', 'inspect', 'smoke'].includes(command),
    'Use prepare | deploy/configure/pause/unpause/smoke --broadcast | inspect');
  if (command === 'configure') {
    assert.equal(args.length, 4); assert.ok(args[1] && args[1] !== '--broadcast');
    assert.match(args[2], /^(0|[1-9][0-9]*)$/); assert.equal(args[3], '--broadcast');
    return { command, walletFile: args[1], quota: args[2] };
  }
  const writes = ['deploy', 'pause', 'unpause', 'smoke'].includes(command);
  assert.deepEqual(args.slice(1), writes ? ['--broadcast'] : [], 'Explicit --broadcast required for chain writes');
  return { command };
}

export async function main(args) {
  const parsed = parseAdminArgs(args); // Reject implicit writes before reading secrets or opening an RPC.
  if (parsed.command === 'prepare') return prepare();
  assert.ok(lstatSync(DIR).isDirectory() && !lstatSync(DIR).isSymbolicLink());
  assert.equal(statSync(DIR).mode & 0o077, 0, 'Private run directory permissions changed');
  const lock = resolve(DIR, 'operation.lock'), fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  try {
    if (parsed.command === 'deploy') return await deploy();
    if (parsed.command === 'configure') return await configure(parsed.walletFile, parsed.quota);
    if (parsed.command === 'pause' || parsed.command === 'unpause') return await setPaused(parsed.command === 'pause');
    if (parsed.command === 'smoke') return await smoke();
    const p = loadAdminPlan(), j = loadAdminJournal(DIR, p), audit = process.env.SEPOLIA_ADMIN_AUDIT_SOURCES === '2';
    const c = operatorContext({ readOnly: !audit });
    await verified(c, p, j, { audit }); output({ collection: p.collection.address, policy: await readAdminPolicy(c, p),
      transactions: Object.fromEntries(Object.entries(j.transactions).map(([step, tx]) => [step, { hash: tx.hash, status: tx.status }])) });
  } finally { unlinkSync(lock); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    // Never serialize signing, subprocess, RPC-library errors, URLs or private bytes.
    const safe = /^(Transaction pending|Sepolia delivery is uncertain)/.test(error.message);
    console.error(safe ? error.message : 'Sepolia admin operation stopped. Inspect its private journal; no new transaction was requested automatically.');
    process.exitCode = 1;
  });
}
