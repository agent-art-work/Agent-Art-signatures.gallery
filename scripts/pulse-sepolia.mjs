import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeFunctionData, decodeEventLog, keccak256, stringToHex, getAddress, formatEther, parseTransaction, recoverTransactionAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEPLOYER, SEPOLIA, GENESIS, CORE, INPUT_PROFILE, sepoliaTestPlan, validateSepoliaTestPlan } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { ROOT, verifyPulseCandidate, loadPulseArtifact } from '../contracts/tools/pulse-candidate-lock.mjs';
import { expectedPulseRuntime } from '../contracts/tools/pulse-integration.mjs';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';
import { decodeBoundedRead, GENERATIVE_READ_LIMITS } from '../src/openMint/generativeReadLimits.ts';
import { pulseMintTypedData, PULSE_PAID_SLOT } from '../src/openMint/pulseAuthorization.ts';
import { readSources, withSepoliaReadSource, requireRpcData, unavailableRpcData, requireSepoliaIntegrity } from './pulse-sepolia-rpc.mjs';

export const DIR = resolve(ROOT, '.local/pulse-sepolia-v1');
// Pin the read-only secondary instead of inheriting an SDK default that can
// change providers independently of this rehearsal's reviewed configuration.
export const SEPOLIA_SECONDARY_READ_RPC = 'https://sepolia.gateway.tenderly.co';
const ENV_FILE = resolve(homedir(), '.opsec/path/env/sepolia.env');
const PLAN = resolve(DIR, 'plan.json'), JOURNAL = resolve(DIR, 'journal.json'), KEY = resolve(DIR, 'authorizer.key');
const json = v => JSON.stringify(v, (_k, n) => typeof n === 'bigint' ? n.toString() : n, 2) + '\n';
const qty = n => '0x' + BigInt(n).toString(16);
const expand = p => p?.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const sameAddress = (a, b) => assert.equal(getAddress(a), getAddress(b));

/** Generated journals are private, durable, atomic and confined to this run.
 * Signed bytes are saved BEFORE broadcast. Unknown delivery never chooses a new nonce. */
export function save(name, value, directory = DIR) {
  assert.ok(/^[a-z][a-z0-9-]*\.json$/.test(name));
  const path = resolve(directory, name), temp = path + '.' + randomUUID();
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directoryFd = openSync(directory, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

/** Use the configured proxy without putting an RPC credential in argv or logs.
 * Errors are redacted. Only the separate read wrapper may retry safe reads. */
export function rpcTransport(url) {
  const parsed = new URL(url); assert.equal(parsed.protocol, 'https:');
  return async (method, params = [], options = {}) => {
    options.signal?.throwIfAborted();
    assert.match(method, /^eth_[A-Za-z]+$/);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const config = `url = ${JSON.stringify(url)}\nheader = "content-type: application/json"\ndata = ${JSON.stringify(body)}\n`;
    const raw = await new Promise((accept, reject) => {
      const child = spawn('curl', ['--silent', '--show-error', '--fail', '--max-time', '20', '--write-out', '\nSG_HTTP_STATUS:%{http_code}', '--config', '-'], { stdio: ['pipe', 'pipe', 'ignore'], signal: options.signal });
      const chunks = []; let size = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
      child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('Sepolia transport unavailable. Credentials suppressed.'), { retryableRead: true })); });
      child.stdout.on('data', part => { size += part.length; if (size > 4 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(part); });
      child.stdin.on('error', () => undefined);
      child.on('close', code => {
        clearTimeout(timer);
        if (options.signal?.aborted) { reject(options.signal.reason); return; }
        const output = Buffer.concat(chunks).toString('utf8'), status = output.match(/\nSG_HTTP_STATUS:(\d{3})$/);
        if (code === 0 && status) accept(output.slice(0, status.index));
        else reject(Object.assign(new Error(`Sepolia ${method} transport failed. Credentials suppressed.`), {
          retryableRead: size <= 4 * 1024 * 1024,
          // Numeric diagnostics only; never expose the URL, request or response.
          transportExitCode: code, httpStatus: status ? Number(status[1]) : undefined,
        }));
      });
      child.stdin.end(config);
    });
    let result; try { result = JSON.parse(raw); } catch { throw unavailableRpcData(); }
    if (result.error || result.id !== 1 || !Object.hasOwn(result, 'result')) throw Object.assign(new Error(`Sepolia ${method} RPC refused the request; details suppressed.`), {
      retryableRead: !!result.error && /rate|limit|temporar|timeout|historical state|missing trie/i.test(String(result.error.message)),
      rateLimited: !!result.error && /rate|limit/i.test(String(result.error.message)),
      rpcErrorCode: Number.isInteger(result.error?.code) ? result.error.code : undefined,
    });
    return result.result;
  };
}

export function retrySafeReads(request) {
  const safe = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_call', 'eth_estimateGas']);
  return async (method, params = [], options = {}) => {
    options.signal?.throwIfAborted();
    try { return await request(method, params, options); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!safe.has(method) || error.retryableRead !== true) throw error;
      if (error.httpStatus === 429 || error.rateLimited === true) {
        try { await sleep(3000, undefined, { signal: options.signal }); }
        catch (aborted) { options.signal?.throwIfAborted(); throw aborted; }
      }
      options.signal?.throwIfAborted(); return request(method, params, options);
    }
  };
}

/** Public endpoints and the local proxy have bounded connection capacity.
 * Queue and space bursts per endpoint, including the one permitted safe-read retry.
 * This changes scheduling only, never the required evidence or retry count. */
export function boundedReadSource(request, minimumStartIntervalMs = 1000) {
  assert.ok(Number.isInteger(minimumStartIntervalMs) && minimumStartIntervalMs >= 0 && minimumStartIntervalMs <= 1000);
  let active = 0, lastStartedAt = -Infinity, timer, actionBurst = 0;
  const queues = { action: [], background: [] };
  const queued = () => queues.action.length + queues.background.length;
  function pump() {
    clearTimeout(timer); timer = undefined;
    while (active < 2 && queued()) {
      // Sleeping dispatches do not reserve either capacity or a future start.
      // Choose priority at actual dispatch, so a new action may overtake a scan
      // without increasing this endpoint's physical request rate.
      const delay = lastStartedAt + minimumStartIntervalMs - Date.now();
      if (delay > 0) { timer = setTimeout(pump, delay); return; }
      // At most four action dispatches may overtake waiting background work;
      // neither lane can starve the other, and each lane keeps its own FIFO.
      const priority = queues.action.length && (!queues.background.length || actionBurst < 4) ? 'action' : 'background';
      const entry = queues[priority].shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      if (priority === 'background' || !queues.background.length) actionBurst = 0;
      else actionBurst++;
      active++; lastStartedAt = Date.now();
      let result;
      try { entry.signal?.throwIfAborted(); result = request(...entry.args); }
      catch (error) { result = Promise.reject(error); }
      // The transport's synchronous dispatch prologue can cross a clock tick
      // or briefly wait for CPU. Anchor conservatively after that prologue,
      // not just before it, so actual request starts keep the full spacing.
      finally { lastStartedAt = Math.max(lastStartedAt, Date.now()); }
      Promise.resolve(result).then(entry.resolve, entry.reject).finally(() => { active--; pump(); });
    }
  }
  return async (...args) => {
    const signal = args[2]?.signal; signal?.throwIfAborted();
    const priority = args[2]?.readPriority ?? 'action';
    assert.ok(priority === 'action' || priority === 'background', 'Invalid read priority');
    if (queued() >= 64) throw unavailableRpcData();
    return new Promise((resolve, reject) => {
      const entry = { args, signal, resolve, reject, abort: undefined };
      entry.abort = () => {
        const index = queues[priority].indexOf(entry);
        if (index < 0) return;
        queues[priority].splice(index, 1);
        reject(signal.reason); pump();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      queues[priority].push(entry); pump();
    });
  };
}

export function readOnlyContext(env = parseEnv(readFileSync(ENV_FILE, 'utf8'))) {
  const primaryUrl = process.env.SEPOLIA_READ_RPC_URL ?? env.SEPOLIA_RPC_URL;
  const primary = new URL(primaryUrl), secondary = new URL(SEPOLIA_SECONDARY_READ_RPC);
  assert.equal(primary.protocol, 'https:');
  assert.notEqual(primary.hostname, secondary.hostname, 'Sepolia reads require different RPC hosts');
  return { rpc: retrySafeReads(boundedReadSource(rpcTransport(primaryUrl))),
    second: retrySafeReads(boundedReadSource(rpcTransport(SEPOLIA_SECONDARY_READ_RPC))) };
}

export function context() {
  const env = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  assert.ok(env.SEPOLIA_RPC_URL && env.SEPOLIA_DEPLOY_KEYSTORE_JSON && env.SEPOLIA_DEPLOY_KEYSTORE_PASSWORD_FILE);
  const keyStore = expand(env.SEPOLIA_DEPLOY_KEYSTORE_JSON), passwordFile = expand(env.SEPOLIA_DEPLOY_KEYSTORE_PASSWORD_FILE);
  for (const file of [keyStore, passwordFile]) assert.equal(statSync(file).mode & 0o077, 0, 'Signing files must be private');
  if (env.SIGNING_OS_MARKER_FILE) assert.ok(existsSync(expand(env.SIGNING_OS_MARKER_FILE)), 'Signing environment marker absent');
  return { ...readOnlyContext(), unlock() {
    let out; try { out = execFileSync('cast', ['wallet', 'private-key', '--keystore', keyStore, '--password-file', passwordFile], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { throw new Error('Could not unlock the approved Sepolia deployer.'); }
    const match = out.trim().match(/^(?:0x)?([a-f0-9]{64})$/i); assert.ok(match, 'Keystore output rejected');
    const signer = privateKeyToAccount('0x' + match[1]); sameAddress(signer.address, DEPLOYER); return signer;
  } };
}

export async function checkNetwork(c) {
  return withSepoliaReadSource(c, checkNetworkAtSource);
}
async function checkNetworkAtSource(c) {
  const coreHash = JSON.parse(readFileSync(resolve(ROOT, 'contracts/vendor/pulse-core-v1.0.0/consumer-lock.json'))).runtimeCodeHash;
  await Promise.all(readSources(c).map(async rpc => {
    requireSepoliaIntegrity(BigInt(await rpc('eth_chainId')) === BigInt(SEPOLIA), 'NETWORK_CHAIN');
    requireSepoliaIntegrity(requireRpcData(await rpc('eth_getBlockByNumber', ['0x0', false])).hash === GENESIS, 'NETWORK_GENESIS');
    const code = await rpc('eth_getCode', [CORE, 'finalized']);
    assert.match(code, /^0x(?:[a-f0-9]{2})*$/i);
    requireSepoliaIntegrity(keccak256(code) === coreHash, 'CORE_CODE');
  }));
  const head = requireRpcData(await c.rpc('eth_getBlockByNumber', ['latest', false]));
  if (Math.abs(Date.now() / 1000 - Number(BigInt(head.timestamp))) >= 180) throw unavailableRpcData();
  return head;
}

export function loadPlan() { return validateSepoliaTestPlan(read(PLAN)); }
export function loadJournal() { const j = read(JOURNAL); assert.equal(j.planDigest, loadPlan().digest); return j; }
export async function prepare() {
  verifyPulseCandidate(); const c = context(), head = await checkNetwork(c);
  if (existsSync(PLAN)) { const p = loadPlan(); console.log(json({ status: 'existing-plan', digest: p.digest, renderer: p.renderer.address, collection: p.collection.address })); return; }
  assert.ok(!existsSync(DIR), 'Existing incomplete run directory requires inspection; no files overwritten');
  const nonce = Number(BigInt(await c.rpc('eth_getTransactionCount', [DEPLOYER, 'latest'])));
  assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [DEPLOYER, 'pending']))), nonce, 'Deployer has a pending transaction');
  const signer = c.unlock(); sameAddress(signer.address, DEPLOYER);
  const authorizerKey = generatePrivateKey(), authorizer = privateKeyToAccount(authorizerKey);
  const p = sepoliaTestPlan({ deployer: DEPLOYER, authorizer: authorizer.address, nonce, createdAt: Number(BigInt(head.timestamp)) });
  mkdirSync(DIR, { mode: 0o700 });
  writeFileSync(KEY, authorizerKey + '\n', { mode: 0o600, flag: 'wx' });
  save('plan.json', p); save('journal.json', { schema: 'sg-pulse-sepolia-journal/v1', planDigest: p.digest, transactions: {} });
  console.log(json({ status: 'prepared-not-broadcast', digest: p.digest, deployer: DEPLOYER, authorizer: authorizer.address,
    renderer: p.renderer.address, collection: p.collection.address, freeSlots: 2, deadline: new Date(Number(p.sale.freeDeadline) * 1000).toISOString(), testOnly: true }));
}

export async function validateSignedStep(saved, request, fees, expectedSigner = DEPLOYER) {
  assert.deepEqual(saved.request, request, 'Existing signed transaction cannot be replaced implicitly');
  assert.equal(keccak256(saved.raw), saved.hash, 'Journal transaction hash mismatch');
  const tx = parseTransaction(saved.raw);
  assert.equal(tx.chainId, SEPOLIA); assert.equal(tx.type, 'eip1559'); assert.equal(tx.nonce, saved.nonce);
  sameAddress(await recoverTransactionAddress({ serializedTransaction: saved.raw }), expectedSigner);
  assert.equal(tx.data, request.data); assert.equal(tx.value ?? 0n, BigInt(request.value ?? '0x0'));
  assert.equal(tx.to?.toLowerCase(), request.to?.toLowerCase());
  assert.ok(tx.gas > 0n && tx.gas <= BigInt(fees.maxGasPerTransaction));
  assert.ok(tx.maxFeePerGas > 0n && tx.maxFeePerGas <= BigInt(fees.maxFeePerGas));
  assert.ok(tx.maxPriorityFeePerGas >= 0n && tx.maxPriorityFeePerGas <= BigInt(fees.maxPriorityFeePerGas));
  assert.equal(String(tx.gas * tx.maxFeePerGas + (tx.value ?? 0n)), saved.worstCaseWei);
}

export async function sendStep(c, p, j, step, request, nonce, persist = () => save('journal.json', j)) {
  assert.match(step, /^(renderer|collection|unpause|free0|free1|paid0)$/);
  let saved = j.transactions[step];
  if (!saved) {
    const current = Number(BigInt(await c.rpc('eth_getTransactionCount', [DEPLOYER, 'latest'])));
    assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [DEPLOYER, 'pending']))), current, 'Unresolved sender nonce; will not skip it');
    if (nonce !== undefined) assert.equal(current, nonce, 'Planned CREATE nonce changed; operator review required');
    const head = await c.rpc('eth_getBlockByNumber', ['latest', false]);
    const gas = BigInt(await c.rpc('eth_estimateGas', [{ from: DEPLOYER, ...request }]));
    const gasLimit = gas + (gas + 4n) / 5n;
    const priority = BigInt(p.fees.maxPriorityFeePerGas), fee = 2n * BigInt(head.baseFeePerGas) + priority;
    assert.ok(gasLimit <= BigInt(p.fees.maxGasPerTransaction), 'Gas limit exceeds test policy');
    assert.ok(fee <= BigInt(p.fees.maxFeePerGas), 'Fee exceeds test policy');
    const exposure = gasLimit * fee + BigInt(request.value ?? '0x0');
    const used = Object.values(j.transactions).reduce((n, t) => n + BigInt(t.worstCaseWei), 0n);
    assert.ok(used + exposure <= BigInt(p.fees.totalWorstCaseWei), 'Total test budget exceeded');
    assert.ok(BigInt(await c.rpc('eth_getBalance', [DEPLOYER, 'latest'])) >= exposure, 'Insufficient Sepolia ETH');
    const signer = c.unlock();
    const raw = await signer.signTransaction({ chainId: SEPOLIA, type: 'eip1559', nonce: current, gas: gasLimit,
      maxFeePerGas: fee, maxPriorityFeePerGas: priority, value: BigInt(request.value ?? '0x0'), data: request.data, ...(request.to ? { to: request.to } : {}) });
    saved = j.transactions[step] = { request, nonce: current, raw, hash: keccak256(raw), worstCaseWei: exposure.toString(), status: 'signed' };
    await persist();
  } else assert.deepEqual(saved.request, request, 'Existing signed transaction cannot be replaced implicitly');
  await validateSignedStep(saved, request, p.fees);
  assert.ok(Object.values(j.transactions).reduce((n, t) => n + BigInt(t.worstCaseWei), 0n) <= BigInt(p.fees.totalWorstCaseWei));
  let receipt = await c.rpc('eth_getTransactionReceipt', [saved.hash]);
  if (!receipt) {
    const known = await c.rpc('eth_getTransactionByHash', [saved.hash]);
    if (!known) {
      assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [DEPLOYER, 'latest']))), saved.nonce, 'Signed nonce already changed; inspect before proceeding');
      const returned = await c.rpc('eth_sendRawTransaction', [saved.raw]); assert.equal(returned, saved.hash);
    }
    console.log(json({ step, transactionHash: saved.hash, status: 'pending' }));
    const until = Date.now() + 50000;
    while (!receipt && Date.now() < until) { await sleep(2000); receipt = await c.rpc('eth_getTransactionReceipt', [saved.hash]); }
    if (!receipt) throw new Error('Transaction pending; journal is preserved. Resume the same command, never clear or replace it.');
  }
  assert.equal(receipt.transactionHash, saved.hash, 'Receipt hash mismatch'); sameAddress(receipt.from, DEPLOYER);
  saved.receipt = receipt; saved.status = receipt.status === '0x1' ? 'included' : 'reverted'; await persist();
  assert.equal(receipt.status, '0x1', 'Transaction reverted; no automatic replacement');
  assert.equal((await c.rpc('eth_getBlockByNumber', [receipt.blockNumber, false])).hash, receipt.blockHash, 'Receipt no longer canonical');
  console.log(json({ step, transactionHash: saved.hash, status: saved.status, gasUsed: BigInt(receipt.gasUsed).toString() }));
  return receipt;
}

export async function readContract(rpc, at, name, args = [], block = 'latest') {
  const abi = loadPulseArtifact().abi;
  const artwork = name === 'svg' || name === 'tokenURI';
  const data = await rpc('eth_call', [{ to: at, data: encodeFunctionData({ abi, functionName: name, args }), gas: qty(artwork ? GENERATIVE_READ_LIMITS.artworkGas : GENERATIVE_READ_LIMITS.scalarGas) }, block]);
  return decodeBoundedRead(abi, name, data, artwork ? GENERATIVE_READ_LIMITS.artworkAbiBytes : GENERATIVE_READ_LIMITS.scalarAbiBytes);
}

/** Pin one concrete block; never mix "latest" reads. Runtime failover contexts
 * use one validated source. Explicit audit contexts still compare both sources.
 * Current state is sufficient for immutable code/inputs and present authority.
 * Constructor facts come from the canonical CREATE receipt, not archive calls. */
export async function sharedReadBlock(c, tag = 'latest', now = Date.now()) {
  return withSepoliaReadSource(c, source => sharedReadBlockAtSource(source, tag, now));
}
async function sharedReadBlockAtSource(c, tag, now) {
  assert.ok(tag === 'latest' || tag === 'finalized');
  const sources = readSources(c);
  const heads = await Promise.all(sources.map(async rpc => requireRpcData(await rpc('eth_getBlockByNumber', [tag, false]))));
  assert.ok(heads.every(h => h && /^0x[0-9a-f]+$/.test(h.number) && /^0x[0-9a-f]{64}$/.test(h.hash)));
  const selected = heads.reduce((a, b) => BigInt(a.number) < BigInt(b.number) ? a : b);
  const blocks = await Promise.all(sources.map((rpc, i) => heads[i].number === selected.number ? heads[i] : rpc('eth_getBlockByNumber', [selected.number, false])));
  for (const value of blocks) { const block = requireRpcData(value); assert.equal(block.number, selected.number); assert.equal(block.hash, selected.hash, 'RPC sources disagree on canonical block'); assert.equal(block.timestamp, selected.timestamp); }
  if (tag === 'latest' && Math.abs(now / 1000 - Number(BigInt(selected.timestamp))) >= 180) throw unavailableRpcData();
  return selected;
}

const canonicalQuantity = value => {
  assert.equal(typeof value, 'string'); assert.match(value, /^0x[0-9a-f]+$/i);
  return qty(value);
};
const canonicalHex = (value, bytes) => {
  assert.equal(typeof value, 'string'); assert.match(value, /^0x(?:[0-9a-f]{2})*$/i);
  if (bytes !== undefined) assert.equal(value.length, 2 + bytes * 2);
  return value.toLowerCase();
};
/** Compare consensus-relevant log fields, not optional provider annotations
 * such as blockTimestamp. Missing fields and malformed values fail closed. */
export function canonicalSepoliaLog(log) {
  assert.ok(log && typeof log === 'object'); assert.equal(typeof log.removed, 'boolean');
  assert.ok(Array.isArray(log.topics) && log.topics.length <= 4);
  return { address: getAddress(log.address), data: canonicalHex(log.data),
    topics: log.topics.map(topic => canonicalHex(topic, 32)), removed: log.removed,
    blockHash: canonicalHex(log.blockHash, 32), blockNumber: canonicalQuantity(log.blockNumber),
    transactionHash: canonicalHex(log.transactionHash, 32), transactionIndex: canonicalQuantity(log.transactionIndex),
    logIndex: canonicalQuantity(log.logIndex) };
}
/** This frozen deployment uses EIP-1559 CREATE transactions, not blob txs.
 * Some RPCs append blobGasUsed: 0 to every receipt. Do not mistake that
 * annotation (or address/quantity formatting) for a canonical disagreement. */
export function canonicalSepoliaReceipt(receipt) {
  return canonicalReceipt(receipt, ['0x2']);
}
/** Browser mints may use legacy, access-list or EIP-1559 transactions. The
 * frozen deployment still requires type 2 through canonicalSepoliaReceipt. */
export function canonicalSepoliaMintReceipt(receipt) {
  return canonicalReceipt(receipt, ['0x0', '0x1', '0x2']);
}
function canonicalReceipt(receipt, allowedTypes) {
  assert.ok(receipt && typeof receipt === 'object');
  const type = canonicalQuantity(receipt.type); assert.ok(allowedTypes.includes(type));
  if (receipt.blobGasUsed !== undefined) assert.equal(canonicalQuantity(receipt.blobGasUsed), '0x0');
  const status = canonicalQuantity(receipt.status); assert.ok(status === '0x0' || status === '0x1');
  assert.ok(Array.isArray(receipt.logs) && receipt.logs.length <= 100);
  return { type, status, transactionHash: canonicalHex(receipt.transactionHash, 32),
    transactionIndex: canonicalQuantity(receipt.transactionIndex), blockHash: canonicalHex(receipt.blockHash, 32),
    blockNumber: canonicalQuantity(receipt.blockNumber), from: getAddress(receipt.from),
    to: receipt.to === null ? null : getAddress(receipt.to),
    contractAddress: receipt.contractAddress === null ? null : getAddress(receipt.contractAddress),
    cumulativeGasUsed: canonicalQuantity(receipt.cumulativeGasUsed), gasUsed: canonicalQuantity(receipt.gasUsed),
    effectiveGasPrice: canonicalQuantity(receipt.effectiveGasPrice), logsBloom: canonicalHex(receipt.logsBloom, 256),
    logs: receipt.logs.map(canonicalSepoliaLog) };
}

export async function verifyDeployment(c, p, j, pristine = false) {
  const result = await withSepoliaReadSource(c, source => verifyDeploymentAtSource(source, p, j, pristine));
  save('deployment.json', result); return result;
}
export async function verifyDeploymentAtSource(c, p, j, pristine = false) {
  await checkNetwork(c); const artifact = loadPulseArtifact();
  const receipt = requireRpcData(await c.rpc('eth_getTransactionReceipt', [j.transactions.collection.hash]));
  assert.equal(receipt?.status, '0x1'); sameAddress(receipt.contractAddress, p.collection.address);
  const block = receipt.blockNumber, created = requireRpcData(await c.rpc('eth_getBlockByNumber', [block, false]));
  assert.equal(created.hash, receipt.blockHash); assert.equal(receipt.transactionHash, j.transactions.collection.hash); sameAddress(receipt.from, DEPLOYER);
  const events = receipt.logs.filter(l => getAddress(l.address) === p.collection.address).map(l => { try { return decodeEventLog({ abi: artifact.abi, ...l }); } catch { return null; } });
  const configured = events.find(x => x?.eventName === 'SaleConfigured'), core = events.find(x => x?.eventName === 'CoreBound');
  assert.ok(configured && core); sameAddress(core.args.core, CORE); assert.equal(core.args.chainId, BigInt(SEPOLIA));
  const coreHash = JSON.parse(readFileSync(resolve(ROOT, 'contracts/vendor/pulse-core-v1.0.0/consumer-lock.json'))).runtimeCodeHash;
  assert.equal(core.args.runtimeCodeHash, coreHash);
  const sale = { core: CORE, coreRuntimeCodeHash: coreHash, treasury: DEPLOYER,
    root: p.sale.freeMintRoot, slotCount: '2', freeDeadline: p.sale.freeDeadline, deployedAt: String(BigInt(created.timestamp)), config: p.sale.pulse, saleConfigHash: configured.args.saleConfigHash };
  const expected = expectedPulseRuntime({ chainId: SEPOLIA, contract: p.collection.address, renderer: p.renderer, sale }, artifact);
  const rendererArtifact = JSON.parse(readFileSync(resolve(ROOT, 'contracts/out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json')));
  const anchor = await sharedReadBlock(c);
  // All checks remain bound to the same validated head. Bound independent reads
  // to small batches per endpoint rather than serializing both RPC providers.
  const sources = readSources(c);
  await Promise.all(sources.map(async rpc => {
    const [deploymentBlock, deploymentReceipt] = await Promise.all([
      rpc('eth_getBlockByNumber', [block, false]), rpc('eth_getTransactionReceipt', [receipt.transactionHash]),
    ]);
    assert.equal(requireRpcData(deploymentBlock).hash, receipt.blockHash, 'Deployment block differs between sources');
    assert.deepEqual(canonicalSepoliaReceipt(requireRpcData(deploymentReceipt)), canonicalSepoliaReceipt(receipt), 'Deployment receipt differs between sources');
    const [rendererCode, collectionCode, rendererTx, collectionTx] = await Promise.all([
      rpc('eth_getCode', [p.renderer.address, anchor.number]), rpc('eth_getCode', [p.collection.address, anchor.number]),
      rpc('eth_getTransactionByHash', [j.transactions.renderer.hash]), rpc('eth_getTransactionByHash', [j.transactions.collection.hash]),
    ]);
    assert.match(rendererCode, /^0x(?:[a-f0-9]{2})*$/i); assert.match(collectionCode, /^0x(?:[a-f0-9]{2})*$/i);
    requireSepoliaIntegrity(rendererCode === rendererArtifact.deployedBytecode.object, 'RENDERER_CODE');
    requireSepoliaIntegrity(collectionCode === expected, 'COLLECTION_CODE');
    for (const [step, tx] of [['renderer', rendererTx], ['collection', collectionTx]]) {
      requireRpcData(tx);
      assert.equal(tx.input, p[step].data); assert.equal(tx.to, null); sameAddress(tx.from, DEPLOYER);
      assert.equal(BigInt(tx.nonce), BigInt(p[step].nonce)); assert.equal(BigInt(tx.value), 0n); assert.equal(BigInt(tx.chainId), BigInt(SEPOLIA));
    }
    const [authorizer, admin, delay] = await Promise.all([
      readContract(rpc, p.collection.address, 'trustedAuthorizer', [], anchor.number),
      readContract(rpc, p.collection.address, 'defaultAdmin', [], anchor.number),
      readContract(rpc, p.collection.address, 'defaultAdminDelay', [], anchor.number),
    ]);
    requireSepoliaIntegrity(getAddress(authorizer) === getAddress(p.authorities.authorizer), 'AUTHORIZER'); sameAddress(admin, DEPLOYER);
    assert.equal(BigInt(delay), BigInt(p.authorities.adminDelay));
    await Promise.all(['AUTHORIZER_MANAGER_ROLE', 'PAUSER_ROLE', 'NONCE_REVOKER_ROLE'].map(async role => {
      const id = keccak256(stringToHex(role));
      assert.ok(events.some(e => e?.eventName === 'RoleGranted' && e.args.role === id && getAddress(e.args.account) === DEPLOYER));
      assert.equal(await readContract(rpc, p.collection.address, 'hasRole', [id, DEPLOYER], anchor.number), true);
    }));
    assert.equal(requireRpcData(await rpc('eth_getBlockByNumber', [anchor.number, false])).hash, anchor.hash);
  }));
  assert.ok(events.some(x => x?.eventName === 'Paused'));
  if (pristine) assert.equal(await readContract(c.rpc, p.collection.address, 'paused'), true);
  const finalized = await sharedReadBlock(c, 'finalized');
  const isFinal = BigInt(finalized.number) >= BigInt(block);
  const result = { schema: 'sg-pulse-sepolia-test-deployment/v1', testOnly: true, productionApproved: false, checkedAt: new Date().toISOString(),
    chainId: SEPOLIA, candidateLockSha256: p.candidateLockSha256, planDigest: p.digest, core: CORE, renderer: { address: p.renderer.address, identity: p.renderer.identity, runtimeCodeHash: p.renderer.runtimeCodeHash, inputProfile: INPUT_PROFILE },
    collection: p.collection.address, runtimeCodeHash: keccak256(expected), authorizer: p.authorities.authorizer, sale,
    deployment: { transactionHash: receipt.transactionHash, blockNumber: String(BigInt(block)), blockHash: receipt.blockHash, finalized: isFinal },
    sourceCount: sources.length, readPolicy: c.readPolicy ?? 'two-source-audit', readSource: c.readSource,
    sourceIndependence: sources.length === 1 ? 'One validated RPC source; no quorum or independence claim.' : 'Two endpoint checks; operator independence is not certified.', startedPaused: true,
    readBlock: { number: String(BigInt(anchor.number)), hash: anchor.hash }, historicalStateRequired: false,
    transactions: Object.fromEntries(Object.entries(j.transactions).map(([k, v]) => [k, { hash: v.hash, status: v.status, gasUsed: v.receipt ? String(BigInt(v.receipt.gasUsed)) : null }])) };
  return result;
}

async function deploy() {
  const p = loadPlan(), j = loadJournal(), c = context(); await checkNetwork(c);
  const head = await c.rpc('eth_getBlockByNumber', ['latest', false]);
  assert.ok(BigInt(p.sale.freeDeadline) > BigInt(head.timestamp), 'Test deadline expired; do not redeploy this plan');
  await sendStep(c, p, j, 'renderer', { data: p.renderer.data, value: '0x0' }, p.renderer.nonce);
  await sendStep(c, p, j, 'collection', { data: p.collection.data, value: '0x0' }, p.collection.nonce);
  console.log(json(await verifyDeployment(c, p, j, true)));
}

async function smoke() {
  const p = loadPlan(), j = loadJournal(), c = context();
  const binding = await verifyDeployment(c, p, j);
  const abi = loadPulseArtifact().abi, at = p.collection.address;
  assert.equal(statSync(KEY).mode & 0o077, 0, 'Authorizer file permissions changed');
  const authorizer = privateKeyToAccount(readFileSync(KEY, 'utf8').trim()); sameAddress(authorizer.address, p.authorities.authorizer);
  await sendStep(c, p, j, 'unpause', { to: at, value: '0x0', data: encodeFunctionData({ abi, functionName: 'unpauseMinting' }) });
  const results = [];
  for (const [index, step] of ['free0', 'free1', 'paid0'].entries()) {
    const handle = ['SGSepoliaFree01', 'SGSepoliaFree02', 'SGSepoliaPaid01'][index], mbti = 'INTJ';
    const handleKey = openMintHandleKey(handle.toLowerCase()), tokenId = BigInt(handleKey);
    let request = j.transactions[step]?.request;
    if (!request) {
      const head = await c.rpc('eth_getBlockByNumber', ['latest', false]);
      const now = BigInt(head.timestamp), paid = index === 2;
      const assessmentDigest = keccak256(stringToHex('DISPOSABLE SEPOLIA FIXTURE: NOT GROK:' + p.digest + ':' + handle));
      const a = { handleKey, assessmentDigest, inputDigest: generativeInputDigest(handle, mbti, binding.renderer.identity, INPUT_PROFILE), recipient: DEPLOYER,
        nonce: keccak256(stringToHex(p.digest + ':' + step)), issuedAt: now, deadline: now + 900n, mintMode: paid ? 1 : 0,
        slotId: paid ? PULSE_PAID_SLOT : BigInt(index), maxPrice: paid ? 100000000000000n : 0n };
      if (!paid && a.deadline > BigInt(p.sale.freeDeadline)) a.deadline = BigInt(p.sale.freeDeadline);
      const signature = await authorizer.signTypedData(pulseMintTypedData({ chainId: SEPOLIA, verifyingContract: at }, a));
      request = { to: at, value: qty(a.maxPrice), data: encodeFunctionData({ abi, functionName: paid ? 'mintPaid' : 'mintFree',
        args: paid ? [handle, mbti, a, signature] : [handle, mbti, a, signature, p.allowlist.proofs[index].siblings] }) };
    }
    const receipt = await sendStep(c, p, j, step, request);
    sameAddress(await readContract(c.rpc, at, 'ownerOf', [tokenId]), DEPLOYER);
    assert.deepEqual(await readContract(c.rpc, at, 'inputs', [tokenId]), [handle, mbti]);
    const uri = await readContract(c.rpc, at, 'tokenURI', [tokenId]);
    assert.ok(uri.startsWith('data:application/json;base64,'));
    const metadata = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    assert.equal(metadata.name, '@' + handle + ' × ' + mbti); assert.ok(metadata.image.startsWith('data:image/svg+xml;base64,'));
    const logs = receipt.logs.map(l => { try { return decodeEventLog({ abi, ...l }); } catch { return null; } });
    const economic = logs.find(x => x?.eventName === 'MintEconomics'); assert.ok(economic);
    assert.equal(economic.args.mintMode, index === 2 ? 1 : 0);
    const sales = logs.filter(x => x?.eventName === 'Sale'); assert.equal(sales.length, index === 2 ? 1 : 0);
    if (index === 2) {
      assert.equal(sales[0].args.epochIndex, 1n);
      assert.equal(economic.args.maxPrice, 100000000000000n);
      assert.ok(economic.args.price > 0n && economic.args.price < economic.args.maxPrice);
      assert.equal(sales[0].args.price, economic.args.price);
      assert.equal(BigInt(await c.rpc('eth_getBalance', [at, receipt.blockNumber])), 0n, 'Test payment was not fully distributed');
    }
    results.push({ handle, mbti, tokenId: tokenId.toString(), transactionHash: receipt.transactionHash, priceWei: String(economic.args.price),
      gasUsed: String(BigInt(receipt.gasUsed)), metadataFromChain: true, provider: 'fixture-not-grok' });
  }
  const status = await readContract(c.rpc, at, 'saleStatus'); assert.equal(status.phase, 1); assert.equal(status.freeMinted, 2n); assert.equal(status.endReason, 1);
  save('smoke.json', { schema: 'sg-pulse-sepolia-smoke/v1', testOnly: true, realProviderCalls: 0, chainId: SEPOLIA, collection: at, results });
  console.log(json({ status: 'test-mints-included', results, finalized: false, feesSepoliaETH: formatEther(Object.values(j.transactions).reduce((n, v) => n + BigInt(v.receipt?.gasUsed ?? 0) * BigInt(v.receipt?.effectiveGasPrice ?? 0), 0n)) }));
}

export async function main(args) {
  assert.ok(['prepare', 'deploy', 'verify', 'smoke'].includes(args[0]), 'Use prepare | deploy --broadcast | verify | smoke --broadcast');
  const writes = args[0] === 'deploy' || args[0] === 'smoke';
  assert.deepEqual(args.slice(1), writes ? ['--broadcast'] : [], 'Explicit --broadcast required for chain writes');
  if (args[0] === 'prepare') return prepare();
  const lock = resolve(DIR, 'operation.lock');
  const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  try {
    if (args[0] === 'deploy') return await deploy();
    if (args[0] === 'smoke') return await smoke();
    console.log(json(await verifyDeployment(context(), loadPlan(), loadJournal())));
  } finally { unlinkSync(lock); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    // Never serialize errors from signing/RPC libraries or subprocesses.
    console.error(error instanceof assert.AssertionError ? 'Sepolia invariant check failed: ' + (error.operator ?? 'assert') :
      /^(Transaction pending|Transaction reverted|Sepolia |Could not unlock|Malformed Sepolia)/.test(error.message) ? error.message : 'Sepolia operation stopped; inspect the private journal. No secret details logged.');
    process.exitCode = 1;
  });
}
