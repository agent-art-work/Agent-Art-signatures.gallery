import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { sharedReadBlock, retrySafeReads, boundedReadSource, readOnlyContext, SEPOLIA_SECONDARY_READ_RPC, canonicalSepoliaReceipt, canonicalSepoliaLog } from '../../scripts/pulse-sepolia.mjs';
import { readObservedArtwork, observeSepoliaCollection, advanceSepoliaCollectionIfUnchanged, observeSepoliaMintReceipt, restoreSepoliaCheckpoint } from '../../scripts/pulse-sepolia-site.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';
import { INPUT_PROFILE } from './pulse-sepolia-plan.mjs';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { createSepoliaReadFailover, SEPOLIA_READ_POLICY } from '../../scripts/pulse-sepolia-rpc.mjs';
import { PULSE_PAID_SLOT, pulseMintDigest } from '../../src/openMint/pulseAuthorization.ts';

const hash = '0x' + 'ab'.repeat(32), now = 2000000;
const head = { number: '0x100', hash, timestamp: '0x7d0' };
const log = { address: '0x' + 'ab'.repeat(20), data: '0xabcd', topics: [hash], removed: false,
  blockHash: hash, blockNumber: '0x100', transactionHash: hash, transactionIndex: '0x1', logIndex: '0x2' };
const receipt = { type: '0x2', status: '0x1', transactionHash: hash, transactionIndex: '0x1',
  blockHash: hash, blockNumber: '0x100', from: log.address, to: null, contractAddress: log.address,
  cumulativeGasUsed: '0x1000', gasUsed: '0x100', effectiveGasPrice: '0x10', logsBloom: '0x' + '00'.repeat(256), logs: [log] };
test('read bursts are bounded to two in-flight calls per source and release capacity on failure', async () => {
  let active = 0, peak = 0;
  const started = [], releases = [];
  const source = boundedReadSource(async index => {
    started.push(index); active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve)); active--;
    if (index === 1) throw Error('Temporary read failure');
    return index;
  }, 0);
  const pending = Array.from({ length: 6 }, (_, index) => source(index).catch(error => error));
  assert.deepEqual(started, [0, 1]);
  while (releases.length || started.length < 6) { releases.shift()?.(); await new Promise(resolve => setImmediate(resolve)); }
  const result = await Promise.all(pending);
  assert.equal(peak, 2); assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.ok(result[1] instanceof Error); assert.equal(result[5], 5);
});
test('per-source scheduling spaces physical safe-read retries without retrying a broadcast', async () => {
  const starts = []; let fail = true;
  const source = retrySafeReads(boundedReadSource(async method => {
    starts.push({ method, time: Date.now() });
    if (fail) { fail = false; throw Object.assign(Error('transient'), { retryableRead: true }); }
    return 'ok';
  }, 30));
  assert.equal(await source('eth_getCode'), 'ok');
  assert.equal(await source('eth_call'), 'ok');
  assert.equal(starts.length, 3);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index].time - starts[index - 1].time >= 29);
  fail = true;
  await assert.rejects(source('eth_sendRawTransaction'));
  assert.equal(starts.length, 4);
  for (const invalid of [-1, 1001, 1.5, NaN]) assert.throws(() => boundedReadSource(async () => undefined, invalid));
});
test('aborted queued reads leave immediately without dispatch or reserving endpoint capacity', async () => {
  const started = [], releases = [];
  const source = boundedReadSource(async index => {
    started.push(index); await new Promise(resolve => releases.push(resolve)); return index;
  }, 0);
  const active = [source(0), source(1)];
  const controller = new AbortController(), reason = Error('Queued request cancelled');
  const cancelled = source(2, [], { signal: controller.signal, readPriority: 'background' });
  const rejected = assert.rejects(cancelled, error => error === reason);
  controller.abort(reason); await rejected;
  assert.deepEqual(started, [0, 1]);
  const action = source(3, [], { readPriority: 'action' });
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 3]);
  while (releases.length) releases.shift()();
  assert.deepEqual(await Promise.all([...active, action]), [0, 1, 3]);
});
test('cancelled throttle sleepers reject promptly and do not consume a future dispatch slot', async () => {
  const started = [];
  const source = boundedReadSource(async index => { started.push(index); return index; }, 100);
  await source(0);
  const controller = new AbortController(), reason = Error('Sleeping read cancelled');
  const pending = source(1, [], { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error === reason);
  controller.abort(reason);
  assert.equal(await Promise.race([rejected.then(() => 'cancelled'), new Promise(resolve => setImmediate(() => resolve('still sleeping')))]), 'cancelled');
  assert.deepEqual(started, [0]);
  await source(2); assert.deepEqual(started, [0, 2]);
});
test('cancelling a full endpoint queue releases its bound without sending cancelled reads', async () => {
  const started = [], releases = [], controller = new AbortController();
  const source = boundedReadSource(async index => {
    started.push(index); await new Promise(resolve => releases.push(resolve)); return index;
  }, 0);
  const active = [source(0), source(1)];
  const waiting = Array.from({ length: 64 }, (_, index) => source(index + 2, [], { signal: controller.signal }).catch(error => error));
  await assert.rejects(source(66), { code: 'RPC_DATA_UNAVAILABLE' });
  controller.abort(Error('Queue cancelled')); await Promise.all(waiting);
  const next = source(67); releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 67]);
  while (releases.length) releases.shift()(); await Promise.all([...active, next]);
});
test('actions overtake queued scans with bounded fairness and FIFO within each priority', async () => {
  const started = [], releases = [];
  const source = boundedReadSource(async index => {
    started.push(index); await new Promise(resolve => releases.push(resolve)); return index;
  }, 0);
  const pending = [source('active-0'), source('active-1'),
    source('scan-0', [], { readPriority: 'background' }), source('scan-1', [], { readPriority: 'background' }),
    ...Array.from({ length: 7 }, (_, index) => source('action-' + index, [], { readPriority: 'action' }))];
  while (started.length < pending.length) {
    releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  }
  while (releases.length) releases.shift()(); await Promise.all(pending);
  assert.deepEqual(started, ['active-0', 'active-1', 'action-0', 'action-1', 'action-2', 'action-3',
    'scan-0', 'action-4', 'action-5', 'action-6', 'scan-1']);
  await assert.rejects(source('invalid', [], { readPriority: 'urgent' }), /Invalid read priority/);
});
test('mixed-priority reads retain physical spacing and the two-active endpoint limit', async () => {
  let active = 0, peak = 0;
  const starts = [];
  const source = boundedReadSource(async index => {
    starts.push({ index, at: Date.now() }); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 45)); active--; return index;
  }, 20);
  await Promise.all(Array.from({ length: 8 }, (_, index) => source(index, [], { readPriority: index % 2 ? 'action' : 'background' })));
  assert.ok(peak <= 2); assert.equal(starts.length, 8);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index].at - starts[index - 1].at >= 20,
    'Physical dispatch gap: ' + (starts[index].at - starts[index - 1].at) + ' ms');
});
test('a delayed transport dispatch prologue does not shorten the next physical start gap', async () => {
  const starts = [];
  const source = boundedReadSource(async index => {
    if (index === 0) {
      // Simulate synchronous transport startup/CPU delay before the request
      // is actually handed off, rather than an ordinary async response wait.
      const until = Date.now() + 12;
      while (Date.now() < until) {}
    }
    starts.push(Date.now()); return index;
  }, 20);
  await Promise.all([source(0), source(1), source(2)]);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 20);
});
test('canonical deployment receipt tolerates zero blob annotations and formatting, not a false source disagreement', () => {
  const annotated = { ...receipt, blobGasUsed: '0x0', providerMetadata: 'ignored',
    from: log.address.toUpperCase().replace('0X', '0x'), blockNumber: '0x0100',
    logs: [{ ...log, data: '0xABCD', blockTimestamp: '0x1234' }] };
  assert.deepEqual(canonicalSepoliaReceipt(annotated), canonicalSepoliaReceipt(receipt));
  assert.equal(receipt.blobGasUsed, undefined, 'Original evidence must not be mutated');
});
test('canonical receipt and log comparisons reject every altered critical field, omission and malformed value', () => {
  const otherHash = '0x' + 'cd'.repeat(32), otherAddress = '0x' + 'cd'.repeat(20);
  const patches = [{ type: '0x3' }, { status: '0x0' }, { transactionHash: otherHash }, { transactionIndex: '0x2' },
    { blockHash: otherHash }, { blockNumber: '0x101' }, { from: otherAddress }, { to: otherAddress },
    { contractAddress: otherAddress }, { cumulativeGasUsed: '0x1001' }, { gasUsed: '0x101' },
    { effectiveGasPrice: '0x11' }, { logsBloom: '0x' + '11'.repeat(256) }, { logs: [] }, { blobGasUsed: '0x1' }];
  for (const patch of patches) assert.throws(() => assert.deepEqual(canonicalSepoliaReceipt({ ...receipt, ...patch }), canonicalSepoliaReceipt(receipt)));
  for (const key of Object.keys(receipt)) {
    const missing = { ...receipt }; delete missing[key]; assert.throws(() => canonicalSepoliaReceipt(missing), key);
  }
  const logPatches = [{ address: otherAddress }, { data: '0x1234' }, { topics: [otherHash] }, { removed: true },
    { blockHash: otherHash }, { blockNumber: '0x101' }, { transactionHash: otherHash },
    { transactionIndex: '0x2' }, { logIndex: '0x3' }];
  for (const patch of logPatches) assert.throws(() => assert.deepEqual(canonicalSepoliaLog({ ...log, ...patch }), canonicalSepoliaLog(log)));
  for (const key of Object.keys(log)) {
    const missing = { ...log }; delete missing[key]; assert.throws(() => canonicalSepoliaLog(missing), key);
  }
  for (const patch of [{ data: '0xa' }, { transactionHash: '0xab' }, { topics: [null] },
    { topics: [hash, hash, hash, hash, hash] }, { removed: 'false' }, { logIndex: '-1' }]) {
    assert.throws(() => canonicalSepoliaLog({ ...log, ...patch }));
  }
});
test('secondary read RPC stays explicitly pinned instead of drifting with SDK defaults', () => {
  assert.equal(SEPOLIA_SECONDARY_READ_RPC, 'https://sepolia.gateway.tenderly.co');
  assert.match(readOnlyContext.toString(), /rpcTransport\(SEPOLIA_SECONDARY_READ_RPC\)/);
  assert.doesNotMatch(readOnlyContext.toString(), /rpcUrls\.default/);
});
test('two-source context rejects a duplicate RPC host or insecure primary before making requests', () => {
  const previous = process.env.SEPOLIA_READ_RPC_URL;
  delete process.env.SEPOLIA_READ_RPC_URL;
  try {
    const c = readOnlyContext({ SEPOLIA_RPC_URL: 'https://primary.example.test' });
    assert.equal(typeof c.rpc, 'function'); assert.equal(typeof c.second, 'function');
    for (const url of [SEPOLIA_SECONDARY_READ_RPC, 'https://sepolia.gateway.tenderly.co/another-path',
      'https://SEPOLIA.GATEWAY.TENDERLY.CO:443/', 'http://primary.example.test']) {
      assert.throws(() => readOnlyContext({ SEPOLIA_RPC_URL: url }));
    }
  } finally {
    if (previous === undefined) delete process.env.SEPOLIA_READ_RPC_URL; else process.env.SEPOLIA_READ_RPC_URL = previous;
  }
});
test('process-only RPC override retains HTTPS and distinct-host guards without replacing the private configuration', () => {
  const previous = process.env.SEPOLIA_READ_RPC_URL, env = { SEPOLIA_RPC_URL: 'https://private.example.test' };
  try {
    for (const url of [SEPOLIA_SECONDARY_READ_RPC, 'http://override.example.test', '']) {
      process.env.SEPOLIA_READ_RPC_URL = url;
      assert.throws(() => readOnlyContext(env));
    }
    process.env.SEPOLIA_READ_RPC_URL = 'https://override.example.test';
    assert.equal(typeof readOnlyContext(env).rpc, 'function');
    assert.deepEqual(env, { SEPOLIA_RPC_URL: 'https://private.example.test' });
  } finally {
    if (previous === undefined) delete process.env.SEPOLIA_READ_RPC_URL; else process.env.SEPOLIA_READ_RPC_URL = previous;
  }
});
test('shared reads pin the lower common canonical height and reject stale or disagreeing sources', async () => {
  const seen = [];
  const rpc = async (_method, [tag]) => { seen.push(tag); return tag === 'latest' ? { ...head, number: '0x101' } : head; };
  const second = async () => head;
  assert.deepEqual(await sharedReadBlock({ rpc, second }, 'latest', now), head);
  assert.ok(seen.includes('0x100'));
  await assert.rejects(sharedReadBlock({ rpc: async () => head, second: async () => ({ ...head, hash: '0x' + 'cd'.repeat(32) }) }, 'latest', now));
  await assert.rejects(sharedReadBlock({ rpc: second, second }, 'latest', now + 181000));
  await assert.rejects(sharedReadBlock({ rpc: async () => null, second }, 'latest', now));
  assert.deepEqual(await sharedReadBlock({ rpc: second, second }, 'finalized', now + 10000000), head);
});

test('one bounded retry is allowed only for classified transient reads, never broadcasts or reverts', async () => {
  const calls = [];
  const transient = Object.assign(Error('transient'), { retryableRead: true });
  const request = retrySafeReads(async (method, params) => { calls.push([method, params]); if (calls.length % 2) throw transient; return 'ok'; });
  assert.equal(await request('eth_call', [{ to: 'test' }, '0x100']), 'ok'); assert.deepEqual(calls[0], calls[1]);
  calls.length = 0; await assert.rejects(request('eth_sendRawTransaction', ['signed'])); assert.equal(calls.length, 1);
  let count = 0;
  await assert.rejects(retrySafeReads(async () => { count++; throw transient; })('eth_getLogs', [])); assert.equal(count, 2);
  count = 0;
  await assert.rejects(retrySafeReads(async () => { count++; throw Error('execution reverted'); })('eth_call', [])); assert.equal(count, 1);
});

test('HTTP rate limits wait before the one safe-read retry and still never retry a broadcast', async () => {
  let calls = 0;
  const limited = Object.assign(Error('rate limited'), { retryableRead: true, httpStatus: 429 });
  const request = retrySafeReads(async () => { calls++; if (calls === 1) throw limited; return 'ok'; });
  const started = Date.now();
  assert.equal(await request('eth_getCode'), 'ok');
  assert.ok(Date.now() - started >= 2900); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(request('eth_sendRawTransaction')); assert.equal(calls, 1);
});
test('aborting a rate-limit delay rejects promptly without issuing the safe-read retry', async () => {
  const controller = new AbortController(), reason = Error('Read budget ended');
  let calls = 0;
  const source = retrySafeReads(async () => {
    calls++; throw Object.assign(Error('Rate limited'), { retryableRead: true, httpStatus: 429 });
  });
  const pending = source('eth_call', [], { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error === reason);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(reason);
  assert.equal(await Promise.race([rejected.then(() => 'cancelled'), new Promise(resolve => setImmediate(() => resolve('still sleeping')))]), 'cancelled');
  assert.equal(calls, 1);
});

test('artwork is checked against immutable mint inputs at a recent block, without archive access', async () => {
  const abi = loadPulseArtifact().abi, mint = { tokenId: '1', renderHandle: 'Alice', mbti: 'INTJ', block: '0x1' }, calls = [];
  function source({ wrongInput = false, wrongArt = false, reorg = false } = {}) {
    return async (method, params) => {
      if (method === 'eth_getBlockByNumber') { assert.equal(params[0], head.number); return { ...head, hash: reorg ? '0x' + 'cd'.repeat(32) : hash }; }
      assert.equal(method, 'eth_call'); assert.equal(params[1], head.number);
      const { functionName } = decodeFunctionData({ abi, data: params[0].data }); calls.push(functionName);
      const result = functionName === 'inputs' ? [wrongInput ? 'WrongHandle' : mint.renderHandle, mint.mbti] : wrongArt ? '<svg>wrong</svg>' : '<svg></svg>';
      return encodeFunctionResult({ abi, functionName, result });
    };
  }
  assert.equal(await readObservedArtwork({ rpc: source(), second: source() }, '0x' + '11'.repeat(20), mint, head), '<svg></svg>');
  assert.equal(calls.filter(c => c === 'inputs').length, 2);
  for (const mismatch of [{ wrongInput: true }, { wrongArt: true }, { reorg: true }]) {
    await assert.rejects(readObservedArtwork({ rpc: source(), second: source(mismatch) }, '0x' + '11'.repeat(20), mint, head));
  }
});

test('observer can be checked read-only and never returns a snapshot on history or authority disagreement', async () => {
  const abi = loadPulseArtifact().abi, address = '0x' + '11'.repeat(20);
  const binding = { collection: address, authorizer: address, renderer: { identity: hash }, deployment: { blockNumber: '1' } };
  const current = { ...head, number: '0x801', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) }, ranges = [];
  const sale = { phase: 0, paused: false, freeMinted: 0n, freeSlotCount: 2n, freeDeadline: 1n, paidStartTime: 0n, endReason: 0, lastPaidMintBlock: 0n };
  const source = ({ logs = [], wrongAuthorizer = false } = {}) => async (method, params) => {
    if (method === 'eth_getBlockByNumber') return current;
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock } = params[0];
      assert.ok(BigInt(toBlock) - BigInt(fromBlock) + 1n <= 1000n, 'RPC rejects more than 1,000 requested blocks');
      ranges.push([BigInt(fromBlock), BigInt(toBlock)]); return logs.filter(log => log.blockNumber === undefined
        || BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock));
    }
    assert.equal(method, 'eth_call'); assert.equal(params[1], current.number);
    const { functionName } = decodeFunctionData({ abi, data: params[0].data });
    assert.ok(['saleStatus', 'trustedAuthorizer'].includes(functionName));
    const result = functionName === 'saleStatus' ? { ...sale, freeMinted: BigInt(logs.length) } : wrongAuthorizer ? '0x' + '22'.repeat(20) : address;
    return encodeFunctionResult({ abi, functionName, result });
  };
  const snapshot = await observeSepoliaCollection({ rpc: source(), second: source() }, binding);
  assert.equal(snapshot.mints.size, 0); assert.deepEqual(snapshot.sale, sale);
  assert.deepEqual(ranges, [[1n, 1000n], [1n, 1000n], [1001n, 2000n], [1001n, 2000n], [2001n, 2049n], [2001n, 2049n]]);
  await assert.rejects(observeSepoliaCollection({ rpc: source(), second: source({ logs: [{ removed: true }] }) }, binding));
  await assert.rejects(observeSepoliaCollection({ rpc: source({ wrongAuthorizer: true }), second: source() }, binding),
    error => error.code === 'MINT_EVIDENCE_CONFLICT' && error.integrityCheck === 'AUTHORIZER');
  const event = abi.find(entry => entry.type === 'event' && entry.name === 'GenerativeSignatureMinted');
  const handleKey = openMintHandleKey('alice');
  const args = { handleKey, nonce: hash, recipient: address, tokenId: BigInt(handleKey), renderHandle: 'Alice', mbti: 'INTJ',
    assessmentDigest: hash, inputDigest: generativeInputDigest('Alice', 'INTJ', hash, INPUT_PROFILE), authorizationDigest: hash };
  const emitted = { ...log, address, topics: encodeEventTopics({ abi, eventName: event.name, args }),
    data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => args[input.name])) };
  const annotated = { ...emitted, blockTimestamp: current.timestamp, providerMetadata: 'ignored' };
  const included = await observeSepoliaCollection({ rpc: source({ logs: [emitted] }), second: source({ logs: [annotated] }) }, binding);
  assert.equal(included.mints.size, 1); assert.equal(included.mints.get('alice').state, 'minted');
  for (const patch of [{ data: '0x' }, { topics: [hash] }, { blockHash: '0x' + 'cd'.repeat(32) }, { transactionHash: '0x' + 'cd'.repeat(32) },
    { removed: true }, { logIndex: '0x3' }]) {
    await assert.rejects(observeSepoliaCollection({ rpc: source({ logs: [emitted] }), second: source({ logs: [{ ...annotated, ...patch }] }) }, binding));
  }
});

function collectionFixture() {
  const abi = loadPulseArtifact().abi, address = '0x' + '11'.repeat(20);
  const binding = { collection: address, authorizer: address, renderer: { identity: hash }, deployment: { blockNumber: '1' } };
  const timestamp = '0x' + Math.floor(Date.now() / 1000).toString(16), calls = [];
  const block = number => ({ number: '0x' + BigInt(number).toString(16), hash: '0x' + BigInt(number).toString(16).padStart(64, '0'), timestamp });
  const sale = { phase: 1, paused: false, freeMinted: 2n, freeSlotCount: 2n, freeDeadline: 1n, paidStartTime: 2n, endReason: 1, lastPaidMintBlock: 3n };
  const event = abi.find(entry => entry.type === 'event' && entry.name === 'GenerativeSignatureMinted');
  function mint(renderHandle, number) {
    const handleKey = openMintHandleKey(renderHandle.toLowerCase()), anchor = block(number);
    const args = { handleKey, nonce: hash, recipient: address, tokenId: BigInt(handleKey), renderHandle, mbti: 'INTJ',
      assessmentDigest: hash, inputDigest: generativeInputDigest(renderHandle, 'INTJ', hash, INPUT_PROFILE), authorizationDigest: hash };
    return { ...log, address, blockNumber: anchor.number, blockHash: anchor.hash,
      topics: encodeEventTopics({ abi, eventName: event.name, args }),
      data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => args[input.name])) };
  }
  const logs = [mint('Alice', 1000), mint('Bob', 4200)];
  function context({ latest = 5000, finalized = 3500, rows = logs, badAnchor, disagreeAnchor, failLogs = false,
    authorityChanged = false, outOfRange = false, movedHead = false, mintCount = 2 } = {}) {
    const source = secondary => async (method, params) => {
      calls.push({ method, params, secondary });
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0], number = tag === 'latest' ? latest : tag === 'finalized' ? finalized : BigInt(tag);
        const header = block(number);
        if (BigInt(number) === BigInt(badAnchor ?? -1) && (disagreeAnchor ? secondary : true)) header.hash = hash;
        if (movedHead && tag === block(latest).number && secondary) header.hash = hash;
        return header;
      }
      if (method === 'eth_getLogs') {
        if (failLogs) throw Error('Temporary RPC failure');
        const filter = params[0];
        assert.ok(BigInt(filter.toBlock) - BigInt(filter.fromBlock) < 1000n);
        return outOfRange ? [logs[0]] : rows.filter(row => BigInt(row.blockNumber) >= BigInt(filter.fromBlock) && BigInt(row.blockNumber) <= BigInt(filter.toBlock));
      }
      assert.equal(method, 'eth_call'); assert.equal(params[1], block(latest).number);
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      assert.ok(['saleStatus', 'getPulseState', 'trustedAuthorizer'].includes(functionName));
      const freeMinted = BigInt(Math.min(2, mintCount));
      const result = functionName === 'saleStatus' ? { ...sale, freeMinted, endReason: freeMinted === 2n ? 1 : 2 }
        : functionName === 'getPulseState' ? { epochIndex: BigInt(mintCount) - freeMinted, openTime: 1n, curveStartTime: 1n, anchorTime: 2n, floorPrice: 1n }
        : authorityChanged ? '0x' + '22'.repeat(20) : address;
      return encodeFunctionResult({ abi, functionName, result });
    };
    return { rpc: source(false), second: source(true) };
  }
  return { binding, context, calls, logs, mint };
}

test('incremental observer reuses only a private finalized prefix and reads only the unfinalized tail', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(f.context(), f.binding);
  assert.equal(first.mints.get('alice').state, 'minted'); assert.equal(first.mints.get('bob').state, 'confirming');
  assert.equal(first.scanFrom, '0x1');
  f.calls.length = 0;
  // External presentation mutation cannot alter the trusted prefix.
  first.mints.delete('alice');
  const second = await observeSepoliaCollection(f.context({ latest: 5010, finalized: 3510 }), f.binding, first);
  assert.equal(second.mints.get('alice').state, 'minted'); assert.equal(second.mints.get('bob').state, 'confirming');
  assert.equal(BigInt(second.scanFrom), 3501n);
  const ranges = f.calls.filter(call => call.method === 'eth_getLogs').map(call => call.params[0]);
  assert.equal(ranges.length, 4); assert.ok(ranges.every(range => BigInt(range.fromBlock) >= 3501n));
  assert.equal(f.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0xdac').length, 2, 'Both sources recheck the old finalized block');
  assert.ok(f.calls.every(call => ['eth_getBlockByNumber', 'eth_getLogs', 'eth_call'].includes(call.method)));
});

test('unchanged mint count advances finality without fetching history and remains a valid private checkpoint', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(f.context(), f.binding);
  f.calls.length = 0;
  const at = number => ({ number: '0x' + BigInt(number).toString(16),
    hash: '0x' + BigInt(number).toString(16).padStart(64, '0'), timestamp: first.head.timestamp });
  const fast = await advanceSepoliaCollectionIfUnchanged(f.context({ latest: 5010, finalized: 4500 }),
    f.binding, first, at(5010), at(4500));
  assert.ok(fast);
  assert.equal(fast.mints.get('bob').state, 'minted');
  assert.equal(f.calls.filter(call => call.method === 'eth_getLogs').length, 0);
  const next = await observeSepoliaCollection(f.context({ latest: 5020, finalized: 4510 }), f.binding, fast);
  assert.equal(next.mints.size, 2);
  assert.equal(BigInt(next.scanFrom), 4501n);
});

test('incremental observer withdraws reorged inclusions and finalizes only newly verified tail events', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(f.context(), f.binding);
  const replacement = f.mint('Carol', 4300);
  const next = await observeSepoliaCollection(f.context({ latest: 5010, finalized: 3510, rows: [replacement] }), f.binding, first);
  assert.equal(next.mints.has('bob'), false); assert.equal(next.mints.get('carol').state, 'confirming');
  assert.equal(next.mints.get('alice').state, 'minted');
  const final = await observeSepoliaCollection(f.context({ latest: 5020, finalized: 4400, rows: [replacement] }), f.binding, next);
  assert.equal(final.mints.get('carol').state, 'minted');
  f.calls.length = 0;
  const stable = await observeSepoliaCollection(f.context({ latest: 5030, finalized: 4500, rows: [] }), f.binding, final);
  assert.deepEqual([...stable.mints.keys()], ['alice', 'carol']);
  assert.ok(f.calls.filter(call => call.method === 'eth_getLogs').every(call => BigInt(call.params[0].fromBlock) === 4401n));
  assert.equal(first.mints.get('bob').state, 'confirming', 'Earlier snapshot was not mutated');
});

test('failed incremental passes publish nothing and leave the checkpoint reusable after recovery', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(f.context(), f.binding);
  const before = [...first.mints];
  for (const patch of [{ failLogs: true }, { authorityChanged: true }, { outOfRange: true }, { movedHead: true }]) {
    await assert.rejects(observeSepoliaCollection(f.context(patch), f.binding, first));
    assert.deepEqual([...first.mints], before);
  }
  const recovered = await observeSepoliaCollection(f.context({ latest: 5010 }), f.binding, first);
  assert.equal(BigInt(recovered.scanFrom), 3501n); assert.equal(recovered.mints.size, 2);
});

test('finalized checkpoint conflicts differ from provider disagreement and neither can advance a snapshot', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(f.context(), f.binding);
  await assert.rejects(observeSepoliaCollection(f.context({ badAnchor: 3500 }), f.binding, first), { code: 'MINT_EVIDENCE_CONFLICT' });
  await assert.rejects(observeSepoliaCollection(f.context({ badAnchor: 3500, disagreeAnchor: true }), f.binding, first), error => {
    assert.notEqual(error.code, 'MINT_EVIDENCE_CONFLICT'); return true;
  });
  await assert.rejects(observeSepoliaCollection(f.context({ finalized: 3490 }), f.binding, first), /Finalized observation regressed/);
  await assert.rejects(observeSepoliaCollection(f.context({ finalized: 5010 }), f.binding, first), /Finalized block is ahead/);
  assert.equal(first.mints.get('alice').state, 'minted');
});

test('incremental checkpoints cannot be forged, imported, or reused across deployment bindings', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(f.context(), f.binding);
  for (const checkpoint of [{ ...first }, { mints: first.mints, finalNumber: 999999n }]) {
    await assert.rejects(observeSepoliaCollection(f.context(), f.binding, checkpoint), /checkpoint is not verified/);
  }
  for (const patch of [{ collection: '0x' + '22'.repeat(20) }, { authorizer: '0x' + '22'.repeat(20) },
    { renderer: { identity: '0x' + '22'.repeat(32) } }, { deployment: { blockNumber: '2' } }]) {
    await assert.rejects(observeSepoliaCollection(f.context(), { ...f.binding, ...patch }, first), /checkpoint is not verified/);
  }
});

function receiptFixture() {
  const abi = loadPulseArtifact().abi, address = '0x' + '11'.repeat(20);
  const binding = { collection: address, authorizer: address, renderer: { identity: hash }, deployment: { blockNumber: '1' } };
  const current = { number: '0x102', hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
  const tokenId = BigInt(openMintHandleKey('alice'));
  const args = { handleKey: openMintHandleKey('alice'), nonce: hash, recipient: address, tokenId, renderHandle: 'Alice', mbti: 'INTJ',
    assessmentDigest: hash, inputDigest: generativeInputDigest('Alice', 'INTJ', hash, INPUT_PROFILE), authorizationDigest: hash };
  const event = abi.find(entry => entry.type === 'event' && entry.name === 'GenerativeSignatureMinted');
  const minted = { ...log, address, topics: encodeEventTopics({ abi, eventName: event.name, args }),
    data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => args[input.name])) };
  const transfer = { ...log, address, logIndex: '0x1', data: '0x', topics: encodeEventTopics({ abi, eventName: 'Transfer',
    args: { from: '0x' + '0'.repeat(40), to: address, tokenId } }) };
  const included = { ...receipt, from: address, to: address, contractAddress: null, logs: [transfer, minted] }, calls = [];
  function source({ receiptPatch, logPatch, absent = false, finalized = false, wrongBlock = false, wrongInput = false, wrongArt = false, wrongAuthorizer = false, headReorg = false } = {}) {
    return async (method, params) => {
      calls.push(method);
      if (method === 'eth_getTransactionReceipt') return absent ? null : { ...included, ...receiptPatch,
        ...(logPatch ? { logs: included.logs.map(l => ({ ...l, ...logPatch })) } : {}) };
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0];
        if (tag === 'finalized' || tag === '0xff') return { ...current, number: finalized ? current.number : '0xff' };
        if (tag === receipt.blockNumber) return { ...current, number: tag, ...(wrongBlock ? { hash: '0x' + 'cd'.repeat(32) } : {}) };
        return { ...current, ...(headReorg && tag === current.number ? { hash: '0x' + 'cd'.repeat(32) } : {}) };
      }
      assert.equal(method, 'eth_call'); assert.equal(params[1], current.number);
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      const result = functionName === 'trustedAuthorizer' ? wrongAuthorizer ? '0x' + '22'.repeat(20) : address
        : functionName === 'inputs' ? [wrongInput ? 'Wrong' : 'Alice', 'INTJ'] : wrongArt ? '<svg>wrong</svg>' : '<svg></svg>';
      return encodeFunctionResult({ abi, functionName, result });
    };
  }
  return { binding, input: { handle: 'alice', wallet: address, transactionHash: hash }, source, calls, included };
}

function authorizedReceiptFixture(mode = 'paid') {
  const f = receiptFixture(), abi = loadPulseArtifact().abi, address = f.input.wallet;
  const code = 'strict-receipt-' + mode, issuedAt = BigInt(Math.floor(Date.now() / 1000) - 30), deadline = issuedAt + 900n;
  const authorization = { handleKey: openMintHandleKey('alice'), assessmentDigest: hash,
    inputDigest: generativeInputDigest('Alice', 'INTJ', hash, INPUT_PROFILE), recipient: address,
    nonce: keccak256(stringToHex(code)), issuedAt, deadline, mintMode: mode === 'paid' ? 1 : 0,
    slotId: mode === 'paid' ? PULSE_PAID_SLOT : 0n, maxPrice: mode === 'paid' ? 100000000000000n : 0n };
  const args = ['Alice', 'INTJ', authorization, '0x' + '01'.repeat(65), ...(mode === 'free' ? [[]] : [])];
  const transaction = { hash, from: address, to: f.binding.collection, chainId: '0xaa36a7',
    input: encodeFunctionData({ abi, functionName: mode === 'paid' ? 'mintPaid' : 'mintFree', args }),
    value: '0x' + authorization.maxPrice.toString(16), blockHash: f.included.blockHash,
    blockNumber: f.included.blockNumber, transactionIndex: f.included.transactionIndex };
  const attempt = { code, wallet: address, mode, cap: String(authorization.maxPrice), stage: 'reported',
    deadline: Number(deadline), renderHandle: 'Alice', mbti: 'INTJ', transaction: {
      from: address, to: f.binding.collection, chainId: '0xaa36a7', data: transaction.input, value: transaction.value, gas: '0x200000' } };
  const event = abi.find(entry => entry.type === 'event' && entry.name === 'GenerativeSignatureMinted');
  const mintArgs = { ...decodeEventLog({ abi, ...f.included.logs[1] }).args, nonce: authorization.nonce,
    authorizationDigest: pulseMintDigest({ chainId: 11155111, verifyingContract: f.binding.collection }, authorization) };
  const mintLog = patch => {
    const data = { ...mintArgs, ...patch };
    return { ...f.included.logs[1], topics: encodeEventTopics({ abi, eventName: event.name, args: data }),
      data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => data[input.name])) };
  };
  f.included.logs[1] = mintLog({});
  return { ...f, transaction, attempt, input: { ...f.input, attempt }, source: ({ transactionPatch = {}, eventPatch, missingTransaction = false, ...rest } = {}) => {
    const base = f.source(rest);
    return async (method, params) => {
      if (method === 'eth_getTransactionByHash') {
        f.calls.push(method); assert.equal(params[0], hash);
        return missingTransaction ? null : { ...transaction, ...transactionPatch };
      }
      const result = await base(method, params);
      return method === 'eth_getTransactionReceipt' && result && eventPatch
        ? { ...result, logs: [result.logs[0], mintLog(eventPatch)] } : result;
    };
  } };
}

test('saved free and paid attempts reveal only with exact transaction bytes and matching mint commitments', async () => {
  for (const mode of ['free', 'paid']) for (const finalized of [false, true]) {
    const f = authorizedReceiptFixture(mode), before = structuredClone(f.attempt);
    const result = await observeSepoliaMintReceipt({ rpc: f.source({ finalized }), second: f.source({ finalized }) }, f.binding, f.input);
    assert.equal(result.state, finalized ? 'minted' : 'confirming'); assert.equal(result.svg, '<svg></svg>');
    assert.equal(result.mint.transactionHash, hash); assert.equal(result.mint.handle, 'alice');
    assert.equal(f.calls.filter(method => method === 'eth_getTransactionByHash').length, 2);
    assert.deepEqual(f.attempt, before, 'Receipt observation is read-only');
    assert.ok(!f.calls.some(method => /send|sign|estimate|eth_getLogs/i.test(method)));
  }
});

test('agreement on a foreign or malformed saved-attempt transaction cannot authorize a successful or reverted receipt', async () => {
  const patches = [{ hash: '0x' + 'cd'.repeat(32) }, { from: '0x' + '22'.repeat(20) }, { to: '0x' + '22'.repeat(20) },
    { input: '0xdeadbeef' }, { input: null }, { value: '0x1' }, { value: null }, { chainId: '0x1' },
    { blockHash: '0x' + 'cd'.repeat(32) }, { blockNumber: '0x101' }, { transactionIndex: '0x2' },
    { blockHash: null }, { blockNumber: undefined }, { transactionIndex: undefined }];
  for (const mode of ['free', 'paid']) for (const failed of [false, true]) for (const transactionPatch of patches) {
    const f = authorizedReceiptFixture(mode), options = { transactionPatch, ...(failed ? { receiptPatch: { status: '0x0', logs: [] } } : {}) };
    await assert.rejects(observeSepoliaMintReceipt({ rpc: f.source(options), second: f.source(options) }, f.binding, f.input),
      mode + ':' + JSON.stringify(transactionPatch));
    assert.ok(!f.calls.includes('eth_call'), 'Rejected transaction cannot read or expose artwork');
  }
});

test('a failed receipt for the exact saved authorization stays failed without revealing or mutating the attempt', async () => {
  const f = authorizedReceiptFixture(), before = structuredClone(f.attempt), options = { receiptPatch: { status: '0x0', logs: [] } };
  const result = await observeSepoliaMintReceipt({ rpc: f.source(options), second: f.source(options) }, f.binding, f.input);
  assert.deepEqual(result, { state: 'reverted', transactionHash: hash });
  assert.deepEqual(f.attempt, before); assert.ok(!f.calls.includes('eth_call'));
});

test('saved-attempt receipt events must match nonce, assessment, inputs and authorization digest even when both sources agree', async () => {
  for (const field of ['nonce', 'assessmentDigest', 'inputDigest', 'authorizationDigest']) {
    const f = authorizedReceiptFixture(), options = { eventPatch: { [field]: '0x' + 'cd'.repeat(32) } };
    await assert.rejects(observeSepoliaMintReceipt({ rpc: f.source(options), second: f.source(options) }, f.binding, f.input), field);
    assert.ok(!f.calls.includes('eth_call'), 'A contradictory event never grants artwork access');
  }
});

test('missing saved-attempt transaction data retries a whole receipt check on fallback, never a partial-source reveal', async () => {
  const f = authorizedReceiptFixture(), primary = f.source({ missingTransaction: true }), secondary = f.source();
  let fallbackCalls = 0;
  const c = createSepoliaReadFailover({ rpc: primary, second: async (...args) => { fallbackCalls++; return secondary(...args); } }, async () => undefined);
  const result = await observeSepoliaMintReceipt(c, f.binding, f.input);
  assert.equal(result.state, 'confirming'); assert.ok(fallbackCalls > 0); assert.equal(c.readStatus().activeSource, 'secondary');
  const unavailable = createSepoliaReadFailover({ rpc: f.source({ missingTransaction: true }), second: f.source({ missingTransaction: true }) }, async () => undefined);
  await assert.rejects(observeSepoliaMintReceipt(unavailable, f.binding, f.input), { code: 'RPC_DATA_UNAVAILABLE' });
  assert.equal(unavailable.readStatus().evidenceConflict, false);
});

test('a contradictory saved-attempt transaction is not replaced with a more agreeable fallback result', async () => {
  const f = authorizedReceiptFixture(); let fallbackCalls = 0;
  const c = createSepoliaReadFailover({ rpc: f.source({ transactionPatch: { input: '0xdeadbeef' } }),
    second: async (...args) => { fallbackCalls++; return f.source()(...args); } }, async () => undefined);
  await assert.rejects(observeSepoliaMintReceipt(c, f.binding, f.input), { code: 'RECOVERY_TRANSACTION_MISMATCH' });
  assert.equal(fallbackCalls, 0); assert.ok(!f.calls.includes('eth_call'));
});

test('a saved finalized cursor is accepted only after every receipt/input and the complete prefix counter are revalidated', async () => {
  const f = receiptFixture(), abi = loadPulseArtifact().abi, base = f.source({ finalized: true });
  const observed = await observeSepoliaMintReceipt({ rpc: base }, f.binding, f.input);
  const candidate = { finalized: observed.finalized, mints: [observed.mint] };
  const counters = { phase: 0, paused: false, freeMinted: 1n, freeSlotCount: 2n, freeDeadline: 1n, paidStartTime: 0n, endReason: 0, lastPaidMintBlock: 0n };
  let count = 1n, conflict = false;
  const rpc = async (method, params) => {
    if (method === 'eth_getLogs') { assert.ok(BigInt(params[0].fromBlock) > BigInt(candidate.finalized.number)); return []; }
    if (method === 'eth_getBlockByNumber' && conflict && params[0] === candidate.finalized.number) return { ...candidate.finalized, hash: '0x' + 'cc'.repeat(32) };
    if (method === 'eth_call') {
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      if (functionName === 'saleStatus') return encodeFunctionResult({ abi, functionName, result: { ...counters, freeMinted: count } });
    }
    return base(method, params);
  };
  const restored = await restoreSepoliaCheckpoint({ rpc }, f.binding, candidate);
  assert.equal(restored.snapshot.at, 0, 'Restoration is not yet a live complete gallery snapshot');
  assert.equal(restored.artworks.get(hash + ':' + hash), '<svg></svg>');
  const next = await observeSepoliaCollection({ rpc }, f.binding, restored.snapshot);
  assert.equal(next.scanFrom, '0x103'); assert.equal(next.mints.get('alice').state, 'minted');
  count = 2n; await assert.rejects(restoreSepoliaCheckpoint({ rpc }, f.binding, candidate), error => error.code === 'RPC_DATA_UNAVAILABLE');
  count = 1n;
  await assert.rejects(restoreSepoliaCheckpoint({ rpc }, f.binding, { ...candidate, mints: [{ ...observed.mint, mbti: 'ENFP' }] }), error => error.code === 'MINT_EVIDENCE_CONFLICT');
  conflict = true; await assert.rejects(restoreSepoliaCheckpoint({ rpc }, f.binding, candidate), error => error.code === 'MINT_EVIDENCE_CONFLICT');
});

test('targeted receipt reveal validates both sources and immutable artwork without scanning history', async () => {
  for (const finalized of [false, true]) {
    const f = receiptFixture(), result = await observeSepoliaMintReceipt({ rpc: f.source({ finalized }), second: f.source({ finalized }) }, f.binding, f.input);
    assert.equal(result.state, finalized ? 'minted' : 'confirming'); assert.equal(result.mint.handle, 'alice');
    assert.equal(result.svg, '<svg></svg>');
    assert.equal(f.calls.filter(m => m === 'eth_getTransactionReceipt').length, 2);
    assert.ok(f.calls.every(m => ['eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_call'].includes(m)), 'Only read-only targeted RPC methods are allowed');
  }
});
test('a missing receipt or verified revert never reads or reveals artistic output', async () => {
  const f = receiptFixture();
  assert.deepEqual(await observeSepoliaMintReceipt({ rpc: f.source(), second: f.source({ absent: true }) }, f.binding, f.input), { state: 'pending' });
  assert.ok(!f.calls.includes('eth_call'));
  f.calls.length = 0;
  const failed = { receiptPatch: { status: '0x0', logs: [] } };
  assert.deepEqual(await observeSepoliaMintReceipt({ rpc: f.source(failed), second: f.source(failed) }, f.binding, f.input), { state: 'reverted', transactionHash: hash });
  assert.ok(!f.calls.includes('eth_call'));
});
test('receipt reveal rejects source, block, immutable input, artwork and authorizer disagreement', async () => {
  for (const patch of [{ receiptPatch: { transactionHash: '0x' + 'cd'.repeat(32) } }, { logPatch: { logIndex: '0x9' } },
    { wrongBlock: true }, { wrongInput: true }, { wrongArt: true }, { wrongAuthorizer: true }, { headReorg: true }]) {
    const f = receiptFixture();
    await assert.rejects(observeSepoliaMintReceipt({ rpc: f.source(), second: f.source(patch) }, f.binding, f.input));
  }
});
test('two sources agreeing on the wrong receipt or foreign logs still cannot authorize a reveal', async () => {
  for (const patch of [{ receiptPatch: { from: '0x' + '22'.repeat(20) } }, { receiptPatch: { to: '0x' + '22'.repeat(20) } },
    { receiptPatch: { contractAddress: '0x' + '22'.repeat(20) } }, { receiptPatch: { logs: [] } },
    { logPatch: { blockNumber: '0x99' } }, { logPatch: { blockHash: '0x' + 'cd'.repeat(32) } },
    { logPatch: { transactionHash: '0x' + 'cd'.repeat(32) } }, { logPatch: { transactionIndex: '0x2' } }, { logPatch: { removed: true } },
    { wrongAuthorizer: true }, { wrongInput: true }]) {
    const f = receiptFixture();
    await assert.rejects(observeSepoliaMintReceipt({ rpc: f.source(patch), second: f.source(patch) }, f.binding, f.input));
  }
  const f = receiptFixture();
  for (const input of [{ ...f.input, handle: 'bob' }, { ...f.input, wallet: '0x' + '22'.repeat(20) }]) {
    await assert.rejects(observeSepoliaMintReceipt({ rpc: f.source(), second: f.source() }, f.binding, input));
  }
});
test('targeted mint receipts accept common wallet transaction types without loosening frozen deployment checks', async () => {
  for (const type of ['0x0', '0x1', '0x2']) {
    const f = receiptFixture(), patch = { receiptPatch: { type } };
    assert.equal((await observeSepoliaMintReceipt({ rpc: f.source(patch), second: f.source(patch) }, f.binding, f.input)).state, 'confirming');
    if (type !== '0x2') assert.throws(() => canonicalSepoliaReceipt({ ...f.included, type }));
  }
});

const failoverContext = c => createSepoliaReadFailover(c, async () => undefined);
const readOutage = () => Object.assign(Error('Temporary RPC failure'), { retryableRead: true });
test('runtime observer uses only a healthy primary instead of requiring an unavailable secondary', async () => {
  const f = collectionFixture(), raw = f.context();
  const c = failoverContext({ rpc: raw.rpc, second: async () => { throw Error('Not a mandatory witness'); } });
  const snapshot = await observeSepoliaCollection(c, f.binding);
  assert.equal(snapshot.mints.size, 2); assert.equal(snapshot.readPolicy, SEPOLIA_READ_POLICY);
  assert.equal(snapshot.readSource, 'primary'); assert.equal(c.readStatus().activeSource, 'primary');
  assert.ok(f.calls.every(call => !call.secondary));
});
test('runtime history failover discards every partial primary page and publishes only a complete fallback scan', async () => {
  const f = collectionFixture();
  const partial = f.context({ rows: [f.mint('PrimaryOnly', 1000)], mintCount: 1 }), fallback = f.context({ rows: [f.mint('FallbackOnly', 2000)], mintCount: 1 });
  const c = failoverContext({ rpc: async (method, params) => {
    if (method === 'eth_getLogs' && BigInt(params[0].fromBlock) > 1000n) throw readOutage();
    return partial.rpc(method, params);
  }, second: fallback.second });
  const snapshot = await observeSepoliaCollection(c, f.binding);
  assert.deepEqual([...snapshot.mints.keys()], ['fallbackonly']);
  assert.equal(snapshot.readSource, 'secondary'); assert.equal(c.readStatus().failovers, 1);
});
test('HTTP-successful but incomplete bootstrap history triggers fallback using contract mint counters', async () => {
  const f = collectionFixture(), partial = f.context({ rows: [f.logs[1]], mintCount: 2 }), complete = f.context();
  const validations = [];
  const c = createSepoliaReadFailover({ rpc: partial.rpc, second: complete.second }, async source => {
    validations.push(source.readSource);
  });
  const snapshot = await observeSepoliaCollection(c, f.binding);
  assert.deepEqual([...snapshot.mints.keys()], ['alice', 'bob']);
  assert.equal(snapshot.expectedMintCount, 2); assert.equal(snapshot.readSource, 'secondary');
  assert.equal(c.readStatus().evidenceConflict, false); assert.equal(c.readStatus().failovers, 1);
  assert.deepEqual(c.readStatus().unavailableSources, []);
  assert.deepEqual(validations, ['primary', 'secondary']);
  assert.ok(f.calls.some(call => call.secondary && call.method === 'eth_call'
    && decodeFunctionData({ abi: loadPulseArtifact().abi, data: call.params[0].data }).functionName === 'trustedAuthorizer'),
  'Fallback must independently check collection authority, not just accept its log list');
  assert.ok(f.calls.some(call => call.secondary && call.method === 'eth_call'
    && decodeFunctionData({ abi: loadPulseArtifact().abi, data: call.params[0].data }).functionName === 'getPulseState'),
  'Fallback must independently verify complete mint counters');
  await c.rpc('eth_getBlockByNumber', ['latest', false]);
  assert.equal(c.readStatus().activeSource, 'primary');
  assert.deepEqual(validations, ['primary', 'secondary'], 'Log index lag must not force immutable validation for an unrelated head read');
  const unavailable = failoverContext({ rpc: partial.rpc, second: partial.second });
  await assert.rejects(observeSepoliaCollection(unavailable, f.binding), { code: 'RPC_DATA_UNAVAILABLE', incompleteMintHistory: true });
  assert.deepEqual(unavailable.readStatus().unavailableSources, []);
});
test('incremental completeness detects a missing tail without discarding finalized evidence or accepting a regressed mint counter', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(failoverContext(f.context()), f.binding);
  const partial = f.context({ rows: [] }), complete = f.context({ latest: 5010 });
  const c = failoverContext({ rpc: partial.rpc, second: complete.second });
  const next = await observeSepoliaCollection(c, f.binding, first);
  assert.equal(next.readSource, 'secondary'); assert.equal(next.mints.size, 2);
  assert.equal(first.mints.get('alice').state, 'minted');
  const corrupt = f.context({ rows: [], mintCount: 0 });
  const broken = failoverContext({ rpc: corrupt.rpc, second: complete.second });
  await assert.rejects(observeSepoliaCollection(broken, f.binding, first), { code: 'MINT_EVIDENCE_CONFLICT' });
  assert.equal(broken.readStatus().failovers, 0); assert.equal(broken.readStatus().evidenceConflict, true);
});
test('runtime fallback cannot overwrite a previously verified finalized checkpoint', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(failoverContext(f.context()), f.binding);
  const wrong = f.context({ badAnchor: 3500 });
  const c = failoverContext({ rpc: async () => { throw readOutage(); }, second: wrong.second });
  await assert.rejects(observeSepoliaCollection(c, f.binding, first), { code: 'MINT_EVIDENCE_CONFLICT' });
  assert.equal(c.readStatus().evidenceConflict, true); assert.equal(first.mints.get('alice').state, 'minted');
});
test('a lagging finalized tag can use fallback only after preserving the verified finalized anchor', async () => {
  const f = collectionFixture(), first = await observeSepoliaCollection(failoverContext(f.context()), f.binding);
  const lagging = f.context({ latest: 5010, finalized: 3490 }), current = f.context({ latest: 5010, finalized: 3510 });
  const c = failoverContext({ rpc: lagging.rpc, second: current.second });
  const next = await observeSepoliaCollection(c, f.binding, first);
  assert.equal(next.readSource, 'secondary'); assert.equal(next.finalNumber, 3510n);
  assert.equal(next.mints.get('alice').state, 'minted'); assert.equal(c.readStatus().evidenceConflict, false);
  const contradictory = f.context({ latest: 5010, finalized: 3490, badAnchor: 3500 });
  const broken = failoverContext({ rpc: contradictory.rpc, second: current.second });
  await assert.rejects(observeSepoliaCollection(broken, f.binding, first), { code: 'MINT_EVIDENCE_CONFLICT' });
  assert.equal(broken.readStatus().evidenceConflict, true); assert.equal(broken.readStatus().failovers, 0);
});
test('receipt reveal can use a single validated source and fallback when primary has no receipt', async () => {
  for (const absent of [false, true]) {
    const f = receiptFixture(), c = failoverContext({ rpc: f.source({ absent }), second: f.source() });
    const result = await observeSepoliaMintReceipt(c, f.binding, f.input);
    assert.equal(result.state, 'confirming'); assert.equal(result.svg, '<svg></svg>');
    assert.equal(c.readStatus().activeSource, absent ? 'secondary' : 'primary');
    assert.ok(!f.calls.includes('eth_getLogs'));
  }
});
test('no receipt stays pending; an unavailable header after inclusion is not misreported as pending', async () => {
  const f = receiptFixture(), empty = failoverContext({ rpc: f.source({ absent: true }), second: f.source({ absent: true }) });
  assert.deepEqual(await observeSepoliaMintReceipt(empty, f.binding, f.input), { state: 'pending' });
  assert.ok(!f.calls.includes('eth_call'));
  const source = f.source();
  const missingHeader = async (method, params) => method === 'eth_getBlockByNumber' ? null : source(method, params);
  const c = failoverContext({ rpc: missingHeader, second: (...args) => missingHeader(...args) });
  await assert.rejects(observeSepoliaMintReceipt(c, f.binding, f.input), { code: 'RPC_DATA_UNAVAILABLE' });
});
test('receipt-check failover cannot downgrade an incomplete included receipt to pending when fallback has no receipt yet', async () => {
  const f = receiptFixture(), source = f.source();
  const primary = async (method, params) => method === 'eth_getBlockByNumber' ? null : source(method, params);
  const c = failoverContext({ rpc: primary, second: f.source({ absent: true }) });
  await assert.rejects(observeSepoliaMintReceipt(c, f.binding, f.input), { code: 'RPC_DATA_UNAVAILABLE' });
  const recovered = failoverContext({ rpc: primary, second: f.source() });
  assert.equal((await observeSepoliaMintReceipt(recovered, f.binding, f.input)).state, 'confirming');
});
test('runtime receipt validation rejects bad wallet, immutable inputs and canonical blocks rather than falling back to a nicer result', async () => {
  for (const patch of [{ receiptPatch: { from: '0x' + '22'.repeat(20) } }, { wrongBlock: true }, { wrongInput: true }, { wrongAuthorizer: true }]) {
    const f = receiptFixture(), calls = [];
    const c = failoverContext({ rpc: f.source(patch), second: async (...args) => { calls.push(args); return f.source()(...args); } });
    await assert.rejects(observeSepoliaMintReceipt(c, f.binding, f.input));
    assert.equal(calls.length, 0);
  }
});
test('an unfinalized head changing during a receipt read retries the whole pass, not a permanent integrity halt', async () => {
  const f = receiptFixture(), c = failoverContext({ rpc: f.source({ headReorg: true }), second: f.source() });
  const result = await observeSepoliaMintReceipt(c, f.binding, f.input);
  assert.equal(result.state, 'confirming'); assert.equal(c.readStatus().activeSource, 'secondary');
  assert.equal(c.readStatus().evidenceConflict, false); assert.equal(c.readStatus().failovers, 1);
});
test('runtime artwork failover retains immutable-input checks and a pinned block', async () => {
  const f = receiptFixture(), result = await observeSepoliaMintReceipt(failoverContext({ rpc: f.source(), second: f.source() }), f.binding, f.input);
  const c = failoverContext({ rpc: async () => { throw readOutage(); }, second: f.source() });
  assert.equal(await readObservedArtwork(c, f.binding.collection, result.mint, result.head), '<svg></svg>');
  const wrong = failoverContext({ rpc: f.source({ wrongInput: true }), second: f.source() });
  await assert.rejects(readObservedArtwork(wrong, f.binding.collection, result.mint, result.head));
  assert.equal(wrong.readStatus().failovers, 0);
});
