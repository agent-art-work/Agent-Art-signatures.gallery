import assert from 'node:assert/strict';
import { decodeEventLog, encodeEventTopics, getAddress } from 'viem';
import { loadPulseArtifact } from '../contracts/tools/pulse-candidate-lock.mjs';
import { canonicalSepoliaLog } from './pulse-sepolia.mjs';
import { withSepoliaReadSource, requireRpcData, unavailableRpcData } from './pulse-sepolia-rpc.mjs';

const quantity = value => '0x' + BigInt(value).toString(16);
const mismatch = message => Object.assign(new Error(message), { code: 'OWNERSHIP_EVIDENCE_CONFLICT' });

/** A public, derived owner index. Only validated Transfer logs on a pinned
 * head can update it. The next pass rewinds to its finalized owner map, so a
 * reorg may replace the provisional suffix without rewriting final history. */
export async function observeSepoliaOwnership(context, binding, mints, previous, options = {}) {
  return withSepoliaReadSource(context, source => observeAtSource(source, binding, mints, previous), options);
}

async function observeAtSource(source, binding, mints, previous) {
  assert.ok(mints?.head && mints?.finalized && mints.mints instanceof Map);
  const collection = getAddress(binding.collection);
  const headNumber = BigInt(mints.head.number), finalNumber = BigInt(mints.finalized.number);
  const deployment = BigInt(binding.deployment.blockNumber);
  assert.ok(finalNumber <= headNumber && headNumber >= deployment);
  const priorFinal = previous ? BigInt(previous.finalized.number) : deployment - 1n;
  if (previous) {
    if (finalNumber < priorFinal) throw unavailableRpcData();
    const anchor = requireRpcData(await source.rpc('eth_getBlockByNumber', [previous.finalized.number, false]));
    if (anchor.hash !== previous.finalized.hash) throw mismatch('Finalized ownership checkpoint changed');
  }
  const owners = new Map(previous?.finalizedOwners ?? []);
  let finalizedOwners = new Map(owners), finalCaptured = false;
  const topic = encodeEventTopics({ abi: loadPulseArtifact().abi, eventName: 'Transfer' });
  const logs = [];
  for (let from = priorFinal + 1n > deployment ? priorFinal + 1n : deployment; from <= headNumber; from += 1000n) {
    const to = from + 999n < headNumber ? from + 999n : headNumber;
    const rows = await source.rpc('eth_getLogs', [{ address: collection, fromBlock: quantity(from), toBlock: quantity(to), topics: topic }]);
    assert.ok(Array.isArray(rows) && rows.length <= 10000);
    for (const entry of rows) {
      const log = canonicalSepoliaLog(entry);
      assert.equal(getAddress(log.address), collection);
      assert.equal(log.removed, false);
      assert.ok(BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to);
      logs.push(log);
    }
  }
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber))
    || Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex))
    || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  for (const log of logs) {
    if (!finalCaptured && BigInt(log.blockNumber) > finalNumber) {
      finalizedOwners = new Map(owners); finalCaptured = true;
    }
    const { args } = decodeEventLog({ abi: loadPulseArtifact().abi, ...log });
    const token = String(args.tokenId), from = getAddress(args.from), to = getAddress(args.to);
    const current = owners.get(token);
    if (!current && from !== '0x0000000000000000000000000000000000000000') throw mismatch('Transfer history has an unknown prior owner');
    if (current && current !== from) throw mismatch('Transfer history disagrees with prior owner');
    if (to === '0x0000000000000000000000000000000000000000') throw mismatch('A signature token was burned');
    owners.set(token, to);
  }
  if (!finalCaptured) finalizedOwners = new Map(owners);
  if (owners.size !== mints.mints.size || [...mints.mints.values()].some(mint => !owners.has(mint.tokenId)))
    throw unavailableRpcData();
  const [head, finalized] = await Promise.all([
    source.rpc('eth_getBlockByNumber', [mints.head.number, false]),
    source.rpc('eth_getBlockByNumber', [mints.finalized.number, false]),
  ]);
  if (requireRpcData(head).hash !== mints.head.hash || requireRpcData(finalized).hash !== mints.finalized.hash)
    throw unavailableRpcData();
  return { at: Date.now(), head: mints.head, finalized: mints.finalized, owners, finalizedOwners,
    readSource: source.readSource };
}
