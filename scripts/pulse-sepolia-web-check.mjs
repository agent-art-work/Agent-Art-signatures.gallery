/** Explicit live HTTP check for the disposable loopback test site.
 * Signs only its SIWE message, prepares one saved test authorization, and uses
 * eth_call on both Sepolia sources. Never begins, signs or broadcasts a tx.
 * Run with a new <=15-character test handle; do not erase old reservations.
 */
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeFunctionResult, getAddress } from 'viem';
import { context, loadPlan, readContract, sharedReadBlock } from './pulse-sepolia.mjs';
import { loadPulseArtifact } from '../contracts/tools/pulse-candidate-lock.mjs';
import { verifyPulseSignature, PULSE_PAID_SLOT } from '../src/openMint/pulseAuthorization.ts';
import { canonicalHandle } from '../src/openMint/identity.ts';
import { openMintHandleKey } from '../src/openMint/authorization.ts';

let checkpoint = 'arguments';
async function main() {
  const [flag, handle, ...extra] = process.argv.slice(2);
  assert.equal(flag, '--prepare-only'); assert.equal(extra.length, 0); canonicalHandle(handle);
  const origin = 'http://127.0.0.1:3004', p = loadPlan(), c = context(), abi = loadPulseArtifact().abi;
  let cookie, csrf;
  async function api(path, body, override = {}) {
    checkpoint = path;
    assert.ok(path.startsWith('/api/test/') || path === '/health' || path === '/me');
    const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(90000),
      method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), ...override },
      body: body ? JSON.stringify(body) : undefined });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.text(); return { status: response.status, value: path === '/me' ? value : JSON.parse(value) };
  }
  assert.equal((await api('/health')).value.observerHealthy, true);
  csrf = (await api('/api/test/session')).value.csrf;
  assert.equal((await api('/api/test/options')).status, 409, 'Unauthenticated quotes must be refused');
  const signer = c.unlock();
  assert.equal((await api('/api/test/challenge', { address: signer.address }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const challenge = await api('/api/test/challenge', { address: signer.address }); assert.equal(challenge.status, 200);
  assert.ok(challenge.value.message.startsWith('127.0.0.1:3004 wants you to sign in with your Ethereum account:'));
  assert.ok(challenge.value.message.includes('\nChain ID: 11155111\n'));
  const signature = await signer.signMessage({ message: challenge.value.message });
  const proof = { challengeId: challenge.value.challengeId, signature };
  const verified = await api('/api/test/verify', proof); assert.equal(verified.status, 200); assert.equal(verified.value.wallet, signer.address);
  assert.equal((await api('/api/test/verify', proof)).status, 409, 'SIWE proof replay must fail');
  const quote = await api('/api/test/options'); assert.equal(quote.status, 200); assert.equal(quote.value.free, false); assert.equal(quote.value.paid, true);
  const consent = { handle, mode: 'paid', maximumETH: '0.0001' };
  assert.equal((await api('/api/test/prepare', { ...consent, mbti: 'INTJ' })).status, 400, 'User MBTI injection must fail');
  const prepared = await api('/api/test/prepare', consent); assert.equal(prepared.status, 200, 'Preparation failed; private request remains unchanged');
  checkpoint = 'prepared transaction and authority validation';
  const tx = prepared.value.transaction;
  assert.equal(tx.from, signer.address); assert.equal(getAddress(tx.to), p.collection.address); assert.equal(tx.chainId, '0xaa36a7');
  assert.equal(BigInt(tx.value), 100000000000000n); assert.equal(Object.hasOwn(tx, 'nonce'), false);
  const decoded = decodeFunctionData({ abi, data: tx.data }); assert.equal(decoded.functionName, 'mintPaid');
  const [renderHandle, , authorization, mintSignature] = decoded.args;
  assert.equal(renderHandle, handle); assert.equal(authorization.recipient, signer.address);
  assert.equal(authorization.handleKey, openMintHandleKey(canonicalHandle(handle))); assert.equal(authorization.mintMode, 1);
  assert.equal(authorization.slotId, PULSE_PAID_SLOT); assert.equal(authorization.maxPrice, BigInt(tx.value));
  await verifyPulseSignature({ chainId: 11155111, verifyingContract: p.collection.address }, authorization, mintSignature, p.authorities.authorizer);
  const again = await api('/api/test/prepare', consent); assert.equal(again.status, 200); assert.deepEqual(again.value, prepared.value, 'Identical retry must reuse authority');
  const head = await sharedReadBlock(c);
  checkpoint = 'two-source eth_call simulation';
  const results = await Promise.all([c.rpc, c.second].map(async rpc => {
    const raw = await rpc('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas }, head.number]);
    const token = decodeFunctionResult({ abi, functionName: 'mintPaid', data: raw });
    assert.equal(token, BigInt(authorization.handleKey));
    assert.equal(await readContract(rpc, p.collection.address, 'mintedHandle', [authorization.handleKey], head.number), false);
    assert.equal((await rpc('eth_getBlockByNumber', [head.number, false])).hash, head.hash);
    return String(token);
  }));
  assert.equal(results[0], results[1]);
  const mine = await api('/me'); assert.equal(mine.status, 200);
  for (const h of ['SGSepoliaFree01', 'SGSepoliaFree02', 'SGSepoliaPaid01']) assert.ok(mine.value.includes(h));
  assert.equal((await api('/api/test/logout', {})).status, 200);
  assert.equal((await api('/api/test/options')).status, 409);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin, chainId: 11155111, collection: p.collection.address,
    handle, walletProof: 'real SIWE', rejected: ['missing proof', 'wrong CSRF', 'proof replay', 'user MBTI'],
    paidQuote: true, authorizerSignatureVerified: true, exactPreparedReuse: true, currentOwnerCollection: 3,
    simulationSources: 2, simulationBlock: String(BigInt(head.number)), gasLimit: String(BigInt(tx.gas)),
    submissionStarted: false, broadcast: false, providerCalls: 0, savedReservation: 'prepared; retained for traceability' }, null, 2));
}
main().catch(() => { console.error(`Sepolia HTTP acceptance stopped at ${checkpoint}. No transaction was broadcast. Inspect the saved test request without clearing it.`); process.exitCode = 1; });
