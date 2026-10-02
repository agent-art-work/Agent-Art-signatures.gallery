/** Explicit RC2 acceptance for the disposable loopback site, not a mint runner.
 * Usage: node --import tsx scripts/pulse-sepolia-admin-web-check.mjs --prepare-only NEW_HANDLE
 * Signs one real SIWE message with the approved deployer keystore. Saves one
 * free authorization through HTTP and simulates it with eth_call. Never calls
 * begin/report/recover, signs a transaction, or broadcasts. Reservations stay.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeFunctionData, decodeFunctionResult, getAddress, keccak256, stringToHex, verifyTypedData } from 'viem';
import { DIR, loadAdminPlan, loadAdminJournal, operatorContext, readAdminPolicy } from './pulse-sepolia-admin.mjs';
import { verifyPulseAdminDeployment } from './pulse-sepolia-admin-verify.mjs';
import { readContract, sharedReadBlock } from './pulse-sepolia.mjs';
import { withSepoliaReadSource, requireRpcData, SEPOLIA_READ_POLICY } from './pulse-sepolia-rpc.mjs';
import { fixtureMbti } from './pulse-sepolia-site.mjs';
import { loadPulseAdminArtifact } from '../contracts/tools/pulse-admin-candidate.mjs';
import { verifyAllowlistArtifacts, verifySolidityProof, leafForSlot } from '../contracts/tools/pulse-allowlist.mjs';
import { DEPLOYER, INPUT_PROFILE, SEPOLIA } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { PULSE_ADMIN_PROFILE, pulseAdminMintTypedData } from '../src/openMint/pulseAdminAuthorization.ts';
import { canonicalHandle, preservedHandle } from '../src/openMint/identity.ts';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';

export const ADMIN_WEB_ORIGIN = 'http://127.0.0.1:3007';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sameAddress = (a, b) => assert.equal(getAddress(a), getAddress(b));

export function adminWebCheckArguments(args) {
  const [flag, handle, ...extra] = args;
  assert.equal(flag, '--prepare-only'); assert.equal(extra.length, 0);
  return preservedHandle(handle);
}

/** The HTTP allowlist itself makes accidental submission endpoints impossible.
 * Neither redirect destinations nor a caller-supplied host can broaden scope. */
export function adminWebHttpClient({ request = fetch, checkpoint = () => {} } = {}) {
  let cookie, csrf;
  const get = new Set(['/health/ready', '/api/test/capabilities', '/api/test/session', '/api/test/options', '/me']);
  const post = new Set(['/api/test/challenge', '/api/test/verify', '/api/test/prepare', '/api/test/logout']);
  return {
    setCsrf(value) { assert.match(value, /^[A-Za-z0-9_-]+$/); csrf = value; },
    async api(path, body, overrideCsrf, { signal } = {}) {
      const method = body === undefined ? 'GET' : 'POST';
      assert.ok(method === 'POST' ? post.has(path) : get.has(path)
        || /^\/api\/test\/status\?handle=[a-z0-9_]{1,15}$/.test(path)
        || /^\/signatures\/[a-z0-9_]{1,15}$/.test(path), 'Endpoint outside prepare-only scope');
      checkpoint(path);
      const response = await request(ADMIN_WEB_ORIGIN + path, {
        redirect: 'error', signal: signal ?? AbortSignal.timeout(90000), method,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? {
          Origin: ADMIN_WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': overrideCsrf ?? csrf,
        } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const newCookie = response.headers.get('set-cookie');
      if (newCookie) cookie = newCookie.split(';')[0];
      const text = await response.text(), html = path === '/me' || path.startsWith('/signatures/');
      return { status: response.status, value: html ? text : JSON.parse(text) };
    },
  };
}

/** Readiness has a short lease, not a permanent boot verdict. The capability
 * read wakes relay demand; diagnostic health reads alone do not refresh it.
 * Poll only these GETs within one bounded budget, before any wallet signing. */
export async function waitForAdminWebReady(api, p, {
  now = Date.now, wait = sleep, timeoutMs = 90000, pollIntervalMs = 5000,
} = {}) {
  assert.equal(p.contractProfile, PULSE_ADMIN_PROFILE);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 90000);
  assert.ok(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0 && pollIntervalMs <= 5000);
  const deadline = now() + timeoutMs, signal = AbortSignal.timeout(timeoutMs);
  function budget() {
    signal.throwIfAborted(); assert.ok(now() < deadline, 'Read-only readiness deadline reached');
  }
  function check(response, status) {
    assert.ok(status.includes(response.status), 'Unexpected readiness HTTP status');
    const value = response.value;
    assert.equal(value.chainId, SEPOLIA); assert.equal(value.testOnly, true); assert.equal(value.frontendOnly, false);
    sameAddress(value.collection, p.collection.address);
    // Current health responses do not publish a profile. Exact collection was
    // independently verified as RC2; never accept a contrary declared profile.
    if (Object.hasOwn(value, 'contractProfile')) assert.equal(value.contractProfile, PULSE_ADMIN_PROFILE);
    assert.equal(value.safetyHalted, false, 'Readiness polling cannot bypass an integrity halt');
    assert.equal(typeof value.mintReady, 'boolean');
    return value;
  }
  while (true) {
    budget(); check(await api('/api/test/capabilities', undefined, undefined, { signal }), [200]);
    budget();
    const response = await api('/health/ready', undefined, undefined, { signal });
    const health = check(response, [200, 503]); budget();
    if (response.status === 200 && health.mintReady) return health;
    assert.equal(health.mintReady, false, 'Ready capability cannot have HTTP 503');
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())), undefined, { signal });
  }
}

export function assertCurrentFreeConfiguration(p, policy, config) {
  assert.equal(config.schema, 'sg-pulse-free-configuration/v1');
  assert.equal(config.planDigest, p.digest); sameAddress(config.contract, p.collection.address);
  assert.equal(config.revision, policy.revision); assert.equal(config.root, policy.root);
  assert.equal(config.slotCount, policy.slotCount); assert.equal(config.quota, policy.quota);
  verifyAllowlistArtifacts(config.allowlist);
  assert.equal(config.allowlist.manifest.root, policy.root);
  assert.equal(String(config.allowlist.manifest.slotCount), policy.slotCount);
  assert.equal(policy.phase, 0); assert.equal(policy.paused, false);
  assert.ok(BigInt(policy.freeMinted) < BigInt(policy.quota));
  assert.ok(BigInt(policy.timestamp) < BigInt(policy.freeDeadline));
}

export async function assertPreparedAdminFreeMint({ p, policy, config, handle, wallet, prepared, abi }) {
  assertCurrentFreeConfiguration(p, policy, config);
  assert.deepEqual(Object.keys(prepared).sort(), ['code', 'handle', 'transaction']);
  assert.match(prepared.code, /^[A-Za-z0-9_-]+$/); assert.equal(prepared.handle, canonicalHandle(handle));
  const tx = prepared.transaction;
  assert.deepEqual(Object.keys(tx).sort(), ['chainId', 'data', 'from', 'gas', 'to', 'value']);
  sameAddress(tx.from, wallet); sameAddress(tx.to, p.collection.address);
  assert.equal(tx.chainId, '0xaa36a7'); assert.equal(tx.value, '0x0');
  assert.ok(BigInt(tx.gas) > 0n && BigInt(tx.gas) <= BigInt(p.fees.maxGasPerTransaction));
  const decoded = decodeFunctionData({ abi, data: tx.data }); assert.equal(decoded.functionName, 'mintFree');
  const [renderHandle, mbti, a, signature, siblings] = decoded.args;
  assert.equal(renderHandle, handle); assert.equal(mbti, fixtureMbti(handle));
  sameAddress(a.recipient, wallet); assert.equal(a.handleKey, openMintHandleKey(canonicalHandle(handle)));
  assert.equal(a.mintMode, 0); assert.equal(a.maxPrice, 0n);
  assert.equal(a.freeConfigRevision, BigInt(policy.revision));
  assert.equal(a.nonce, keccak256(stringToHex(prepared.code)));
  assert.equal(a.assessmentDigest, keccak256(stringToHex('SEPOLIA FIXTURE NOT GROK:' + p.digest + ':' + canonicalHandle(handle))));
  assert.equal(a.inputDigest, generativeInputDigest(handle, mbti, p.renderer.identity, INPUT_PROFILE));
  assert.ok(a.deadline > a.issuedAt && a.deadline - a.issuedAt <= 900n);
  assert.ok(a.deadline <= BigInt(policy.freeDeadline));
  const proof = config.allowlist.proofs.find(row => BigInt(row.slotId) === a.slotId && getAddress(row.wallet) === getAddress(wallet));
  assert.ok(proof, 'Authorization must use a current allowlisted wallet slot');
  assert.deepEqual(siblings, proof.siblings);
  assert.equal(verifySolidityProof(policy.root, leafForSlot(proof.slotId, wallet), siblings), true);
  assert.equal(await verifyTypedData({ address: p.authorities.authorizer,
    ...pulseAdminMintTypedData({ chainId: SEPOLIA, verifyingContract: p.collection.address }, a), signature }), true);
  return { transaction: tx, authorization: a, slot: String(a.slotId), tokenId: String(BigInt(a.handleKey)) };
}

/** One complete block-pinned read/simulation per selected validated source.
 * Secondary unavailability never vetoes a healthy primary. Transport fallback
 * restarts the operation; it cannot combine state from different providers. */
export async function simulatePreparedAdminFreeMint(c, p, config, prepared, abi) {
  return withSepoliaReadSource(c, async source => {
    assert.equal(source.readPolicy, SEPOLIA_READ_POLICY); assert.equal(source.second, undefined);
    const head = await sharedReadBlock(source), at = p.collection.address;
    const [sale, root] = await Promise.all([
      readContract(source.rpc, at, 'saleStatus', [], head.number, abi),
      readContract(source.rpc, at, 'freeMintRoot', [], head.number, abi),
    ]);
    const policy = { phase: sale.phase, paused: sale.paused, freeMinted: String(sale.freeMinted),
      slotCount: String(sale.freeSlotCount), quota: String(sale.freeMintQuota), revision: String(sale.freeConfigRevision),
      root, timestamp: String(BigInt(head.timestamp)), freeDeadline: String(sale.freeDeadline) };
    const validated = await assertPreparedAdminFreeMint({ p, policy, config, handle: prepared.renderHandle,
      wallet: DEPLOYER, prepared: prepared.value, abi });
    const { transaction: tx, authorization: a } = validated;
    assert.ok(a.issuedAt <= BigInt(head.timestamp) && BigInt(head.timestamp) < a.deadline);
    const state = async block => ({
      minted: await readContract(source.rpc, at, 'mintedHandle', [a.handleKey], block, abi),
      slotClaimed: await readContract(source.rpc, at, 'isFreeSlotClaimed', [a.slotId], block, abi),
      nonceUsed: await readContract(source.rpc, at, 'usedNonces', [a.nonce], block, abi),
      nonceRevoked: await readContract(source.rpc, at, 'revokedNonces', [a.nonce], block, abi),
      freeMinted: String((await readContract(source.rpc, at, 'saleStatus', [], block, abi)).freeMinted),
    });
    const before = await state(head.number);
    assert.deepEqual(before, { minted: false, slotClaimed: false, nonceUsed: false, nonceRevoked: false, freeMinted: policy.freeMinted });
    const raw = requireRpcData(await source.rpc('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas }, head.number]));
    assert.equal(String(decodeFunctionResult({ abi, functionName: 'mintFree', data: raw })), validated.tokenId);
    assert.deepEqual(await state(head.number), before, 'eth_call must not consume mint state');
    assert.equal(requireRpcData(await source.rpc('eth_getBlockByNumber', [head.number, false])).hash, head.hash);
    const afterHead = await sharedReadBlock(source);
    assert.deepEqual(await state(afterHead.number), before, 'Prepare-only acceptance must not mint or consume a slot');
    assert.equal(requireRpcData(await source.rpc('eth_getBlockByNumber', [afterHead.number, false])).hash, afterHead.hash);
    return { tokenId: validated.tokenId, slot: validated.slot, freeConfigRevision: policy.revision,
      simulationBlock: String(BigInt(head.number)), readSource: source.readSource, readPolicy: source.readPolicy,
      gasLimit: String(BigInt(tx.gas)), chainStateUnchanged: true };
  }, { sourceTimeoutMs: 60000, signal: AbortSignal.timeout(125000) });
}

export async function runAdminWebCheck(args, { checkpoint = () => {} } = {}) {
  const handle = adminWebCheckArguments(args), p = loadAdminPlan(), j = loadAdminJournal(DIR, p);
  assert.equal(p.contractProfile, PULSE_ADMIN_PROFILE); assert.equal(p.chainId, SEPOLIA);
  const c = operatorContext(), abi = loadPulseAdminArtifact().abi;
  checkpoint('RC2 deployment and current policy');
  const { binding } = await withSepoliaReadSource(c.readContext,
    source => verifyPulseAdminDeployment(source, p, j),
    { sourceTimeoutMs: 45000, signal: AbortSignal.timeout(95000) });
  assert.equal(binding.contractProfile, PULSE_ADMIN_PROFILE); sameAddress(binding.collection, p.collection.address);
  assert.equal(binding.deployment.finalized, true);
  const policy = await readAdminPolicy(c, p), config = read(resolve(DIR, 'free-config.json'));
  assertCurrentFreeConfiguration(p, policy, config);
  const http = adminWebHttpClient({ checkpoint }), api = http.api;
  await waitForAdminWebReady(api, p);
  const session = await api('/api/test/session'); assert.equal(session.status, 200); http.setCsrf(session.value.csrf);
  const statusPath = '/api/test/status?handle=' + canonicalHandle(handle);
  const initial = await api(statusPath); assert.equal(initial.status, 200);
  assert.equal(initial.value.state, 'not-submitted'); assert.equal(initial.value.submissionStage, 'none', 'Use a fresh handle; retained reservations are never erased');
  assert.equal((await api('/api/test/options')).status, 409, 'Missing wallet proof must be refused');
  checkpoint('approved deployer SIWE signing');
  const signer = c.unlock(); sameAddress(signer.address, DEPLOYER);
  assert.equal((await api('/api/test/challenge', { address: signer.address }, 'wrong')).status, 403);
  const challenge = await api('/api/test/challenge', { address: signer.address }); assert.equal(challenge.status, 200);
  const message = challenge.value.message;
  assert.ok(message.startsWith('127.0.0.1:3007 wants you to sign in with your Ethereum account:\n' + signer.address + '\n'));
  assert.ok(message.includes('\nURI: ' + ADMIN_WEB_ORIGIN + '\n')); assert.ok(message.includes('\nChain ID: 11155111\n'));
  const proof = { challengeId: challenge.value.challengeId, signature: await signer.signMessage({ message }) };
  const verified = await api('/api/test/verify', proof); assert.equal(verified.status, 200); sameAddress(verified.value.wallet, signer.address);
  assert.equal((await api('/api/test/verify', proof)).status, 409, 'SIWE replay must be refused');
  const quote = await api('/api/test/options'); assert.equal(quote.status, 200);
  assert.equal(quote.value.free, true); assert.equal(quote.value.paid, false); assert.equal(quote.value.priceWei, '0');
  const consent = { handle, mode: 'free', maximumETH: '0' };
  assert.equal((await api('/api/test/prepare', consent, 'wrong')).status, 403, 'Wrong prepare CSRF must be refused');
  assert.equal((await api('/api/test/prepare', { ...consent, mbti: 'INTJ' })).status, 400, 'User MBTI injection must be refused');
  const prepared = await api('/api/test/prepare', consent); assert.equal(prepared.status, 200);
  checkpoint('RC2 calldata, signature, current revision and proof');
  const validated = await assertPreparedAdminFreeMint({ p, policy, config, handle, wallet: signer.address, prepared: prepared.value, abi });
  assert.equal(validated.slot, String(quote.value.slot));
  const again = await api('/api/test/prepare', consent); assert.equal(again.status, 200);
  assert.deepEqual(again.value, prepared.value, 'Identical prepare must reuse the exact saved authorization');
  checkpoint('validated primary/fallback eth_call; no submission');
  const simulation = await simulatePreparedAdminFreeMint(c.readContext, p, config, { renderHandle: handle, value: prepared.value }, abi);
  const tracking = await api(statusPath); assert.equal(tracking.status, 200);
  assert.equal(tracking.value.state, 'not-submitted'); assert.equal(tracking.value.submissionStage, 'prepared');
  assert.equal(tracking.value.transactionHash, undefined); assert.equal(tracking.value.html, undefined);
  // The already-minted fixture is operator acceptance evidence, not visitor copy.
  const smoke = read(resolve(DIR, 'smoke.json'));
  assert.equal(smoke.schema, 'sg-pulse-sepolia-admin-smoke/v1'); assert.equal(smoke.planDigest, p.digest);
  sameAddress(smoke.contract ?? smoke.collection, p.collection.address); assert.equal(smoke.contractProfile, PULSE_ADMIN_PROFILE);
  assert.ok(smoke.results.length > 0);
  const mine = await api('/me'); assert.equal(mine.status, 200);
  for (const fixture of smoke.results) {
    assert.equal(fixture.provider, 'fixture-not-grok'); assert.equal(fixture.realProviderCalls, 0);
    assert.ok(mine.value.includes(fixture.handle), 'Verified fixture must appear in the deployer collection');
    const detail = await api('/signatures/' + canonicalHandle(fixture.handle)); assert.equal(detail.status, 200);
    assert.ok(detail.value.includes(fixture.handle)); assert.ok(detail.value.includes('/test-art/' + canonicalHandle(fixture.handle) + '.svg'));
  }
  assert.equal((await api('/api/test/logout', {})).status, 200);
  assert.equal((await api('/api/test/options')).status, 409, 'Logout must revoke wallet proof');
  return { checkedAt: new Date().toISOString(), origin: ADMIN_WEB_ORIGIN, chainId: SEPOLIA,
    contractProfile: PULSE_ADMIN_PROFILE, collection: p.collection.address, handle,
    walletProof: 'real SIWE with approved deployer', freeQuote: true, paidQuote: false, mintValueWei: '0',
    rejected: ['missing proof', 'wrong challenge/prepare CSRF', 'SIWE replay', 'user MBTI'],
    authorizerSignatureVerified: true, currentMerkleProofVerified: true, exactPreparedReuse: true,
    ...simulation, currentOwnerCollection: smoke.results.length,
    submissionStarted: false, transactionSigned: false, broadcast: false, realProviderCalls: 0,
    savedReservation: 'prepared; retained for traceability' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let checkpoint = 'arguments';
  runAdminWebCheck(process.argv.slice(2), { checkpoint: value => { checkpoint = value; } })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(() => { console.error(`RC2 HTTP acceptance stopped at ${checkpoint}. No transaction was signed or broadcast. Saved requests are retained.`); process.exitCode = 1; });
}
