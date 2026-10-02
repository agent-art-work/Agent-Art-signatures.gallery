import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeEventTopics } from 'viem';
import { observeSepoliaOwnership } from '../../scripts/pulse-sepolia-ownership.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';
import { createSepoliaReadFailover } from '../../scripts/pulse-sepolia-rpc.mjs';

const hash = digit => '0x' + digit.repeat(64);
const wallet = digit => '0x' + digit.repeat(40);
const zero = wallet('0');
const collection = wallet('4'), alice = wallet('1'), bob = wallet('2'), carol = wallet('3');
const abi = loadPulseArtifact().abi;
const block = number => ({ number: '0x' + number.toString(16), hash: hash(number.toString(16)) });
const binding = { collection, deployment: { blockNumber: '0xa' } };
const tokenId = '123';
const log = (number, index, from, to) => ({ address: collection, data: '0x',
  topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to, tokenId: BigInt(tokenId) } }),
  removed: false, blockHash: block(number).hash, blockNumber: block(number).number,
  transactionHash: hash(String(index + 1)), transactionIndex: '0x0', logIndex: '0x' + index.toString(16) });
const mint = log(10, 0, zero, alice), transfer = log(11, 1, alice, bob), next = log(12, 2, bob, carol);
const snapshot = (head, final) => ({ head: block(head), finalized: block(final),
  mints: new Map([['alice', { tokenId }]]) });
const source = rows => async (method, params) => {
  if (method === 'eth_getBlockByNumber') return block(Number(BigInt(params[0])));
  assert.equal(method, 'eth_getLogs');
  return rows.filter(row => BigInt(row.blockNumber) >= BigInt(params[0].fromBlock)
    && BigInt(row.blockNumber) <= BigInt(params[0].toBlock));
};

test('ownership relay indexes Transfer logs, rewinds the provisional tail, and advances a verified final prefix', async () => {
  const first = await observeSepoliaOwnership({ rpc: source([mint, transfer]) }, binding, snapshot(11, 10));
  assert.equal(first.owners.get(tokenId), bob);
  assert.equal(first.finalizedOwners.get(tokenId), alice);
  const second = await observeSepoliaOwnership({ rpc: source([mint, transfer, next]) }, binding, snapshot(12, 11), first);
  assert.equal(second.owners.get(tokenId), carol);
  assert.equal(second.finalizedOwners.get(tokenId), bob);
  const replacement = log(11, 1, alice, carol);
  const reorged = await observeSepoliaOwnership({ rpc: source([mint, replacement]) }, binding, snapshot(12, 10), first);
  assert.equal(reorged.owners.get(tokenId), carol);
  assert.equal(reorged.finalizedOwners.get(tokenId), alice);
});

test('incomplete or contradictory owner histories cannot become a collection result', async () => {
  await assert.rejects(observeSepoliaOwnership({ rpc: source([]) }, binding, snapshot(11, 10)),
    { code: 'RPC_DATA_UNAVAILABLE' });
  await assert.rejects(observeSepoliaOwnership({ rpc: source([log(10, 0, bob, alice)]) }, binding, snapshot(11, 10)),
    { code: 'OWNERSHIP_EVIDENCE_CONFLICT' });
  const first = await observeSepoliaOwnership({ rpc: source([mint, transfer]) }, binding, snapshot(11, 10));
  const wrongAnchor = async (method, params) => method === 'eth_getBlockByNumber' && params[0] === '0xa'
    ? { ...block(10), hash: hash('f') } : source([mint, transfer])(method, params);
  await assert.rejects(observeSepoliaOwnership({ rpc: wrongAnchor }, binding, snapshot(12, 10), first),
    { code: 'OWNERSHIP_EVIDENCE_CONFLICT' });
});

test('cold ownership scans honor their explicit source budget and caller cancellation', async () => {
  let reads = 0;
  const rpc = async (...args) => {
    reads++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return source([mint, transfer])(...args);
  };
  const context = createSepoliaReadFailover({ rpc, second: (...args) => rpc(...args) },
    async () => {}, { attemptTimeoutMs: 1 });
  const result = await observeSepoliaOwnership(context, binding, snapshot(11, 10), undefined,
    { sourceTimeoutMs: 200 });
  assert.equal(result.owners.get(tokenId), bob);
  assert.equal(result.readSource, 'primary');
  const before = reads, controller = new AbortController(); controller.abort();
  await assert.rejects(observeSepoliaOwnership(context, binding, snapshot(11, 10), undefined,
    { signal: controller.signal, sourceTimeoutMs: 200 }), { name: 'AbortError' });
  assert.equal(reads, before);
});
