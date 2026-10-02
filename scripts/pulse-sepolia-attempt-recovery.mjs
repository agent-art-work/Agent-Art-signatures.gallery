import assert from 'node:assert/strict';
import { decodeEventLog, encodeEventTopics, decodeFunctionData, getAddress, keccak256, stringToHex } from 'viem';
import { loadPulseArtifact } from '../contracts/tools/pulse-candidate-lock.mjs';
import { INPUT_PROFILE } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';
import { pulseMintDigest } from '../src/openMint/pulseAuthorization.ts';
import { canonicalHandle, isMbti } from '../src/openMint/identity.ts';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { PublicError } from '../src/openMint/security.ts';
import { canonicalSepoliaLog, readContract, sharedReadBlock } from './pulse-sepolia.mjs';
import { readSources, withSepoliaReadSource, requireRpcData, unavailableRpcData, requireSepoliaIntegrity } from './pulse-sepolia-rpc.mjs';

/** The stored request, not user-provided expiry/nonce fields, identifies the
 * authorization whose ability to mint is being retired. */
export function savedMintAuthorization(binding, row) {
  assert.ok(row && typeof row.code === 'string' && row.code.length > 0);
  const transaction = row.transaction;
  assert.equal(transaction.chainId, '0xaa36a7');
  assert.equal(getAddress(transaction.from), getAddress(row.wallet));
  assert.equal(getAddress(transaction.to), getAddress(binding.collection));
  const decoded = decodeFunctionData({ abi: loadPulseArtifact().abi, data: transaction.data });
  assert.equal(decoded.functionName, row.mode === 'free' ? 'mintFree' : 'mintPaid');
  assert.ok(row.mode === 'free' || row.mode === 'paid');
  const [handle, mbti, authorization] = decoded.args;
  assert.equal(handle, row.renderHandle); assert.equal(mbti, row.mbti); assert.ok(isMbti(mbti));
  assert.equal(authorization.handleKey, openMintHandleKey(canonicalHandle(handle)));
  assert.equal(getAddress(authorization.recipient), getAddress(row.wallet));
  assert.equal(authorization.nonce, keccak256(stringToHex(row.code)));
  assert.equal(authorization.inputDigest, generativeInputDigest(handle, mbti, binding.renderer.identity, INPUT_PROFILE));
  assert.equal(authorization.deadline, BigInt(row.deadline));
  assert.ok(authorization.issuedAt > 0n && authorization.issuedAt < authorization.deadline);
  assert.ok(authorization.deadline - authorization.issuedAt <= 900n);
  assert.equal(authorization.mintMode, row.mode === 'free' ? 0 : 1);
  assert.equal(authorization.maxPrice, BigInt(row.cap));
  assert.equal(BigInt(transaction.value), BigInt(row.cap));
  return authorization;
}

/** A pasted hash is merely a pointer. Even a failed receipt must belong to
 * this exact authorization/payment before it is adopted as this attempt. */
export function validateRecoveryTransaction(row, binding, hash, transaction) {
  savedMintAuthorization(binding, row);
  if (!transaction) throw unavailableRpcData();
  let matches = false;
  try {
    matches = /^0x[a-f0-9]{64}$/i.test(hash) && transaction.hash.toLowerCase() === hash.toLowerCase()
      && getAddress(transaction.from) === getAddress(row.wallet)
      && getAddress(transaction.to) === getAddress(binding.collection)
      && typeof transaction.input === 'string' && transaction.input.toLowerCase() === row.transaction.data.toLowerCase()
      && BigInt(transaction.value) === BigInt(row.transaction.value)
      && (transaction.chainId === undefined || BigInt(transaction.chainId) === 11155111n);
  } catch {}
  if (!matches) throw new PublicError(409, 'RECOVERY_TRANSACTION_MISMATCH', 'This transaction does not match your previous mint. Check its hash in your wallet.');
  return transaction;
}

/** Locate a lost wallet report by this authorization's indexed mint event,
 * not by the handle alone. Each query is capped at 1,000 blocks. If the
 * attempt is old, binary-search the expiry boundary rather than scanning
 * every block since deployment. A found hash is still only a pointer:
 * receiptStatus must validate its receipt and artwork before revealing. */
async function findAuthorizationMint(source, binding, row, authorization, finalized) {
  const abi = loadPulseArtifact().abi, sources = readSources(source), deployment = BigInt(binding.deployment.blockNumber);
  const topics = encodeEventTopics({ abi, eventName: 'GenerativeSignatureMinted', args: {
    handleKey: authorization.handleKey, nonce: authorization.nonce, recipient: authorization.recipient,
  } });
  const quantity = value => '0x' + value.toString(16);
  const header = async number => {
    const blocks = await Promise.all(sources.map(rpc => rpc('eth_getBlockByNumber', [quantity(number), false])));
    const first = requireRpcData(blocks[0]); assert.equal(BigInt(first.number), number);
    for (const block of blocks) requireSepoliaIntegrity(requireRpcData(block).hash === first.hash
      && block.number === first.number && block.timestamp === first.timestamp, 'RECOVERY_EVENT_ANCHOR');
    return first;
  };
  let end = BigInt(finalized.number);
  assert.ok(end - deployment < 10000000n, 'Recovery event range exceeded');
  while (end >= deployment) {
    const start = end - deployment >= 999n ? end - 999n : deployment, block = await header(start);
    if (BigInt(block.timestamp) >= authorization.deadline) {
      // This whole page is after expiry. Find the last block before expiry.
      let low = deployment, high = start - 1n, found;
      while (low <= high) {
        const middle = (low + high) / 2n, candidate = await header(middle);
        if (BigInt(candidate.timestamp) < authorization.deadline) { found = middle; low = middle + 1n; }
        else high = middle - 1n;
      }
      if (found === undefined) return undefined;
      end = found; continue;
    }
    const filter = { address: binding.collection, fromBlock: quantity(start), toBlock: quantity(end), topics };
    const pairs = await Promise.all(sources.map(rpc => rpc('eth_getLogs', [filter])));
    assert.ok(pairs.every(logs => Array.isArray(logs) && logs.length <= 1));
    const canonical = pairs.map(logs => logs.map(canonicalSepoliaLog));
    for (const logs of canonical) assert.deepEqual(logs, canonical[0]);
    for (const log of canonical[0]) {
      const { args } = decodeEventLog({ abi, ...log });
      requireSepoliaIntegrity(!log.removed && getAddress(log.address) === getAddress(binding.collection)
        && BigInt(log.blockNumber) >= start && BigInt(log.blockNumber) <= end
        && args.handleKey === authorization.handleKey && args.nonce === authorization.nonce
        && getAddress(args.recipient) === getAddress(row.wallet) && args.renderHandle === row.renderHandle
        && args.mbti === row.mbti && args.tokenId === BigInt(authorization.handleKey)
        && args.assessmentDigest === authorization.assessmentDigest && args.inputDigest === authorization.inputDigest
        && args.authorizationDigest === pulseMintDigest({ chainId: 11155111, verifyingContract: binding.collection }, authorization),
      'RECOVERY_MINT_EVENT');
      const included = await header(BigInt(log.blockNumber));
      requireSepoliaIntegrity(included.hash === log.blockHash && BigInt(included.timestamp) >= authorization.issuedAt
        && BigInt(included.timestamp) < authorization.deadline, 'RECOVERY_MINT_BLOCK');
      for (const rpc of sources) validateRecoveryTransaction(row, binding, log.transactionHash,
        await rpc('eth_getTransactionByHash', [log.transactionHash]));
      const finalAnchor = await header(BigInt(finalized.number));
      requireSepoliaIntegrity(finalAnchor.hash === finalized.hash && finalAnchor.timestamp === finalized.timestamp, 'RECOVERY_ANCHOR');
      return log.transactionHash;
    }
    if (BigInt(block.timestamp) <= authorization.issuedAt) return undefined;
    end = start - 1n;
  }
}

/** Expiry alone is not absence. At an anchored finalized block, prove the
 * authorization was unused AND its handle unminted. The contract rejects
 * every later use at timestamp >= deadline; an old queued transaction can
 * still spend gas and revert, but can never produce another signature. */
export async function inspectSepoliaAttempt(c, binding, row, { transactionHash, signal } = {}) {
  const authorization = savedMintAuthorization(binding, row);
  const hash = transactionHash ?? row.transactionHash;
  if (hash !== undefined && !/^0x[a-f0-9]{64}$/i.test(hash))
    throw new PublicError(400, 'INVALID_TRANSACTION_HASH', 'Enter the transaction hash from your wallet.');
  return withSepoliaReadSource(c, async source => {
    const finalized = await sharedReadBlock(source, 'finalized');
    assert.ok(BigInt(finalized.number) >= BigInt(binding.deployment.blockNumber));
    assert.match(finalized.timestamp, /^0x[0-9a-f]+$/i);
    const facts = await Promise.all(readSources(source).map(async rpc => {
      const [nonceUsed, handleMinted] = await Promise.all([
        readContract(rpc, binding.collection, 'usedNonces', [authorization.nonce], finalized.number),
        readContract(rpc, binding.collection, 'mintedHandle', [authorization.handleKey], finalized.number),
      ]);
      const anchor = requireRpcData(await rpc('eth_getBlockByNumber', [finalized.number, false]));
      requireSepoliaIntegrity(anchor.number === finalized.number && anchor.hash === finalized.hash
        && anchor.timestamp === finalized.timestamp, 'RECOVERY_ANCHOR');
      return { nonceUsed, handleMinted };
    }));
    for (const fact of facts) assert.deepEqual(fact, facts[0]);
    const expiredUnused = BigInt(finalized.timestamp) >= authorization.deadline && !facts[0].nonceUsed && !facts[0].handleMinted;
    // A dropped saved transaction need not remain queryable forever. Finalized
    // expiry/unused/unminted proof is sufficient to retire its authorization.
    // A newly pasted hash, however, must still match before it is adopted.
    if (hash && (transactionHash !== undefined || !expiredUnused)) {
      const transactions = await Promise.all(readSources(source).map(rpc => rpc('eth_getTransactionByHash', [hash])));
      for (const transaction of transactions) validateRecoveryTransaction(row, binding, hash, transaction);
    }
    if (!hash && facts[0].nonceUsed && facts[0].handleMinted) {
      const discovered = await findAuthorizationMint(source, binding, row, authorization, finalized);
      if (discovered) return { state: 'submission-unknown', submissionStage: row.stage, transactionHash: discovered };
      // A consumed nonce belongs to a successful mint; this provider may not
      // have indexed its event yet. Try the fallback without clearing the
      // lock or inventing a transaction/result. Revocations use a separate map.
      throw Object.assign(unavailableRpcData(), { incompleteMintHistory: true });
    }
    if (!expiredUnused)
      return { state: 'submission-unknown', submissionStage: row.stage, ...(hash ? { transactionHash: hash } : {}) };
    return { state: 'retry-allowed', submissionStage: 'expired', ...(hash ? { transactionHash: hash } : {}),
      proof: { number: finalized.number, hash: finalized.hash, timestamp: finalized.timestamp,
        nonce: authorization.nonce, handleKey: authorization.handleKey } };
  }, { signal });
}

export function requireExpiredAttemptProof(binding, row) {
  const authorization = savedMintAuthorization(binding, row), proof = row.recovery?.proof;
  assert.equal(row.stage, 'expired'); assert.equal(row.recovery?.kind, 'finalized-expired-unused');
  assert.equal(proof.nonce, authorization.nonce); assert.equal(proof.handleKey, authorization.handleKey);
  assert.match(proof.hash, /^0x[a-f0-9]{64}$/i); assert.match(proof.number, /^0x[0-9a-f]+$/i);
  assert.ok(BigInt(proof.number) >= BigInt(binding.deployment.blockNumber));
  assert.ok(BigInt(proof.timestamp) >= authorization.deadline);
  return proof;
}
