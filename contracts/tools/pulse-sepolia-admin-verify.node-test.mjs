import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult,
  keccak256, stringToHex } from 'viem';
import { ROOT } from './pulse-candidate-lock.mjs';
import { loadPulseAdminArtifact, verifyPulseAdminCandidate } from './pulse-admin-candidate.mjs';
import { sepoliaAdminTestPlan } from './pulse-sepolia-admin-plan.mjs';
import { CORE, DEPLOYER, GENESIS, SEPOLIA } from './pulse-sepolia-plan.mjs';
import { adminSaleConfigHash, expectedPulseAdminRuntime,
  verifyPulseAdminDeploymentAtSource } from '../../scripts/pulse-sepolia-admin-verify.mjs';
import { verifyFinalizedAdminBinding } from '../../scripts/pulse-sepolia-admin-site.mjs';
import { checkNetwork } from '../../scripts/pulse-sepolia.mjs';
import { createSepoliaReadFailover, withSepoliaReadSource } from '../../scripts/pulse-sepolia-rpc.mjs';

const artifact = loadPulseAdminArtifact(), abi = artifact.abi;
const rendererArtifact = JSON.parse(readFileSync(resolve(ROOT,
  'contracts/out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json')));
const coreCode = readFileSync(resolve(ROOT, 'contracts/vendor/pulse-core-v1.0.0/PulseCoreV1.runtime.hex'), 'utf8').trim();
const coreHash = keccak256(coreCode), hash = byte => '0x' + byte.repeat(32);
const H = hash('ab'), B = hash('cd'), L = hash('ef'), F = hash('12');
const OTHER = '0x9999999999999999999999999999999999999999';
const encode = (types, values) => encodeAbiParameters(types.map(type => ({ type })), values);
const qty = value => '0x' + BigInt(value).toString(16);
const word = value => encode(['uint256'], [BigInt(value)]);
const shortWord = text => {
  const bytes = new Uint8Array(32); bytes.set(new TextEncoder().encode(text)); bytes[31] = text.length;
  return '0x' + Buffer.from(bytes).toString('hex');
};

// Independent immutable substitution keyed to the frozen compiler's semantic
// assignments, rather than reusing the verifier's byte-position table.
function fixtureRuntime(p, deployedAt) {
  const separator = keccak256(encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    keccak256(stringToHex('SignaturesPulseMintRC2')), keccak256(stringToHex('1')),
    BigInt(SEPOLIA), p.collection.address,
  ]));
  const saleHash = keccak256(encode(['string', 'uint256', 'address', 'address', 'bytes32', 'bytes32',
    'address', 'bytes32', 'uint256', 'uint256', 'uint64', 'uint256', 'uint256', 'uint256', 'uint256'], [
    'signatures.gallery/pulse-sale/v1-rc2', BigInt(SEPOLIA), p.collection.address, CORE, coreHash,
    p.renderer.identity, p.sale.treasury, p.sale.freeMintRoot, BigInt(p.sale.freeSlotCount),
    BigInt(p.sale.freeMintQuota), BigInt(p.sale.freeDeadline), ...Object.values(p.sale.pulse).map(BigInt),
  ]));
  const values = {
    4083: separator, 4085: word(SEPOLIA), 4087: word(p.collection.address),
    4089: keccak256(stringToHex('SignaturesPulseMintRC2')), 4091: keccak256(stringToHex('1')),
    4094: shortWord('SignaturesPulseMintRC2'), 4097: shortWord('1'),
    18192: word(p.renderer.address), 18194: p.renderer.identity, 18199: word(CORE),
    18202: word(SEPOLIA), 18205: word(p.sale.treasury), 18220: word(p.sale.freeDeadline),
    18223: word(deployedAt), 18226: saleHash, 18231: word(p.sale.pulse.k),
    18233: word(p.sale.pulse.genesisPrice), 18235: word(p.sale.pulse.genesisFloor), 18237: word(p.sale.pulse.pts),
  };
  assert.deepEqual(Object.keys(values).sort(), Object.keys(artifact.deployedBytecode.immutableReferences).sort());
  const bytes = Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex');
  for (const [id, refs] of Object.entries(artifact.deployedBytecode.immutableReferences)) {
    for (const { start, length } of refs) {
      assert.equal(length, 32); assert.deepEqual(bytes.subarray(start, start + 32), Buffer.alloc(32));
      Buffer.from(values[id].slice(2), 'hex').copy(bytes, start);
    }
  }
  return { runtime: '0x' + bytes.toString('hex'), saleHash, values };
}

function fixture() {
  const now = Math.floor(Date.now() / 1000), deployedAt = now - 60;
  const p = sepoliaAdminTestPlan({ deployer: DEPLOYER, authorizer: '0x8888888888888888888888888888888888888888',
    nonce: 90, createdAt: deployedAt });
  const j = { planDigest: p.digest, transactions: { collection: { hash: H } } };
  const independent = fixtureRuntime(p, deployedAt);
  const heads = {
    '0x0': { number: '0x0', hash: GENESIS, timestamp: '0x0' },
    '0x100': { number: '0x100', hash: B, timestamp: qty(deployedAt) },
    '0x101': { number: '0x101', hash: F, timestamp: qty(now - 12) },
    '0x102': { number: '0x102', hash: L, timestamp: qty(now) },
  };
  const freeHash = keccak256(encode(['bytes32', 'uint256', 'uint256', 'uint64'],
    [p.sale.freeMintRoot, 2n, 2n, 1n]));
  const eventRows = [
    ['CoreBound', { core: CORE, chainId: BigInt(SEPOLIA), runtimeCodeHash: coreHash }],
    ['SaleConfigured', { saleConfigHash: independent.saleHash, freeMintRoot: p.sale.freeMintRoot,
      freeSlotCount: 2n, freeDeadline: BigInt(p.sale.freeDeadline), treasury: DEPLOYER, deployedAt: BigInt(deployedAt) }],
    ['FreeMintConfigured', { configHash: freeHash, root: p.sale.freeMintRoot, slotCount: 2n, quota: 2n, revision: 1n }],
    ['Paused', { account: DEPLOYER }],
    ...['AUTHORIZER_MANAGER_ROLE', 'PAUSER_ROLE', 'NONCE_REVOKER_ROLE'].map(role =>
      ['RoleGranted', { role: keccak256(stringToHex(role)), account: DEPLOYER, sender: DEPLOYER }]),
  ];
  const logFor = ([eventName, args], index) => {
    const fields = abi.find(row => row.type === 'event' && row.name === eventName).inputs.filter(input => !input.indexed);
    return { address: p.collection.address, topics: encodeEventTopics({ abi, eventName, args }),
      data: encodeAbiParameters(fields, fields.map(field => args[field.name])), removed: false,
      blockHash: B, blockNumber: '0x100', transactionHash: H, transactionIndex: '0x0', logIndex: qty(index) };
  };
  const receipt = { type: '0x2', status: '0x1', transactionHash: H, transactionIndex: '0x0',
    blockHash: B, blockNumber: '0x100', from: DEPLOYER, to: null, contractAddress: p.collection.address,
    cumulativeGasUsed: '0x1000', gasUsed: '0x1000', effectiveGasPrice: '0x10',
    logsBloom: '0x' + '00'.repeat(256), logs: eventRows.map(logFor) };
  const tx = { hash: H, from: DEPLOYER, to: null, nonce: qty(p.collection.nonce), value: '0x0',
    chainId: qty(SEPOLIA), input: p.collection.data, blockHash: B, blockNumber: '0x100', transactionIndex: '0x0' };
  const getters = { trustedAuthorizer: p.authorities.authorizer, defaultAdmin: DEPLOYER,
    defaultAdminDelay: BigInt(p.authorities.adminDelay), saleConfigHash: independent.saleHash,
    eip712Domain: ['0x0f', 'SignaturesPulseMintRC2', '1', BigInt(SEPOLIA), p.collection.address, hash('00'), []],
    saleStatus: { phase: 0, paused: true, freeMinted: 0n, freeSlotCount: 2n,
      freeDeadline: BigInt(p.sale.freeDeadline), paidStartTime: 0n, endReason: 0, lastPaidMintBlock: 0n,
      freeMintQuota: 2n, freeConfigRevision: 1n },
    freeMintRoot: p.sale.freeMintRoot, getPulseConfig: Object.fromEntries(Object.entries(p.sale.pulse).map(([key, value]) => [key, BigInt(value)])),
    hasRole: true,
  };
  const audit = [];
  function source({ runtime = independent.runtime, rendererCode = rendererArtifact.deployedBytecode.object,
    txPatch = {}, receiptPatch = {}, getterPatch = {}, blockPatch = {}, label = 'source' } = {}) {
    return async (method, params = []) => {
      audit.push({ label, method, params });
      if (method === 'eth_chainId') return qty(SEPOLIA);
      if (method === 'eth_getBlockByNumber') {
        const key = params[0] === 'latest' ? '0x102' : params[0] === 'finalized' ? '0x101' : params[0];
        assert.ok(heads[key], 'Unexpected block read ' + key); return { ...heads[key], ...(blockPatch[key] ?? {}) };
      }
      if (method === 'eth_getCode') {
        if (params[0].toLowerCase() === CORE.toLowerCase()) return coreCode;
        if (params[0].toLowerCase() === p.renderer.address.toLowerCase()) return rendererCode;
        assert.equal(params[0], p.collection.address); return runtime;
      }
      if (method === 'eth_getTransactionReceipt') { assert.equal(params[0], H); return { ...receipt, ...receiptPatch }; }
      if (method === 'eth_getTransactionByHash') { assert.equal(params[0], H); return { ...tx, ...txPatch }; }
      if (method === 'eth_call') {
        assert.equal(params[0].to, p.collection.address); assert.equal(params[1], '0x102');
        const { functionName } = decodeFunctionData({ abi, data: params[0].data });
        assert.ok(Object.hasOwn(getters, functionName), 'Unexpected contract read ' + functionName);
        const result = Object.hasOwn(getterPatch, functionName) ? getterPatch[functionName] : getters[functionName];
        return encodeFunctionResult({ abi, functionName, result });
      }
      throw Error('Mock forbids writes or unexpected methods: ' + method);
    };
  }
  return { p, j, deployedAt, receipt, eventRows, logFor, getters, independent, audit, source };
}

test('RC2 frozen candidate and independent immutable substitution cover every compiler reference', () => {
  const f = fixture();
  assert.equal(verifyPulseAdminCandidate().contractProfile, 'generative-pulse-v1-rc2');
  assert.equal(adminSaleConfigHash(f.p), f.independent.saleHash);
  assert.equal(expectedPulseAdminRuntime(f.p, BigInt(f.deployedAt)), f.independent.runtime);
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences)) for (const { start } of refs)
    assert.notEqual(f.independent.runtime.slice(2 + start * 2, 2 + (start + 32) * 2), '0'.repeat(64));
  const drift = structuredClone(artifact); Object.values(drift.deployedBytecode.immutableReferences)[0][0].start++;
  assert.throws(() => expectedPulseAdminRuntime(f.p, BigInt(f.deployedAt), drift), /immutable layout drift/);
});

test('complete mocked CREATE receipt, RC2 events, domain and current getters produce a usable verified binding', async () => {
  const f = fixture(), result = await verifyPulseAdminDeploymentAtSource({ rpc: f.source(), second: f.source() }, f.p, f.j);
  assert.deepEqual(result.binding, result.verification);
  assert.equal(result.binding.contractProfile, 'generative-pulse-v1-rc2'); assert.equal(result.binding.collection, f.p.collection.address);
  assert.equal(result.binding.runtimeCodeHash, keccak256(f.independent.runtime));
  assert.equal(result.binding.deployment.finalized, true); assert.equal(result.binding.startedPaused, true);
  assert.equal(result.binding.sale.freeMintQuota, '2'); assert.equal(result.binding.sourceCount, 2);
  assert.ok(f.audit.some(row => row.method === 'eth_call'));
  assert.ok(f.audit.every(row => !/send|sign|personal_|wallet_/i.test(row.method)));
});

test('single-source finalized bootstrap retains transport-spacing headroom inside the 45-second source budget', async () => {
  const f = fixture(); f.j.transactions.collection.receipt = f.receipt;
  const c = createSepoliaReadFailover({ rpc: f.source({ label: 'primary' }), second: f.source({ label: 'secondary' }) }, checkNetwork);
  const binding = await withSepoliaReadSource(c, source => verifyFinalizedAdminBinding(source, f.p, f.j), { sourceTimeoutMs: 45000 });
  assert.equal(binding.deployment.finalized, true);
  assert.ok(f.audit.every(row => row.label === 'primary'), 'A healthy single source must suffice for bootstrap');
  // Every physical request consumes at least one second of source spacing.
  // Detect future verifier growth that consumes its complete source budget
  // before transport latency/retries even have a chance to run.
  assert.equal(f.audit.length, 30);
  assert.ok((f.audit.length - 1) * 1000 + 10000 < 45000,
    'Full verification must leave at least ten seconds beyond scheduling alone');
  assert.ok(f.audit.every(row => !/send|sign|personal_|wallet_/i.test(row.method)));
});

test('every immutable reference byte and non-immutable code are compared, never masked or silently ignored', async () => {
  const f = fixture(), starts = Object.values(artifact.deployedBytecode.immutableReferences).flat().map(ref => ref.start);
  for (const start of [0, ...starts]) {
    const bytes = Buffer.from(f.independent.runtime.slice(2), 'hex'); bytes[start] ^= 1;
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ runtime: '0x' + bytes.toString('hex') }) }, f.p, f.j),
      error => error.code === 'MINT_EVIDENCE_CONFLICT' && error.integrityCheck === 'COLLECTION_CODE', String(start));
  }
  await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ rendererCode: '0x00' }) }, f.p, f.j),
    error => error.code === 'MINT_EVIDENCE_CONFLICT' && error.integrityCheck === 'RENDERER_CODE');
});

test('deployment calldata, custody, payment, nonce and chain are all bound to the approved plan', async () => {
  const f = fixture();
  for (const txPatch of [{ input: f.p.collection.data + '00' }, { to: OTHER }, { from: OTHER },
    { nonce: qty(f.p.collection.nonce + 1) }, { value: '0x1' }, { chainId: '0x1' }])
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ txPatch }) }, f.p, f.j));
  const badPlan = structuredClone(f.p); badPlan.contractProfile = 'generative-pulse-v1-rc1';
  await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source() }, badPlan, f.j));
  await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source() }, f.p, { ...f.j, planDigest: 'other' }));
});

test('the deployment transaction lookup must identify the exact canonical included CREATE receipt', async () => {
  const f = fixture();
  for (const txPatch of [{ hash: hash('34') }, { blockHash: hash('56') }, { blockNumber: '0x101' },
    { transactionIndex: '0x1' }, { hash: undefined }, { blockHash: null }, { blockNumber: null }, { transactionIndex: null }])
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ txPatch }) }, f.p, f.j),
      'Mismatched CREATE transaction pointer: ' + Object.keys(txPatch)[0]);
});

test('constructor event logs must be canonical, not removed or associated with another receipt', async () => {
  const f = fixture();
  for (const logPatch of [{ removed: true }, { blockHash: hash('34') }, { blockNumber: '0x101' },
    { transactionHash: hash('56') }, { transactionIndex: '0x1' }]) {
    const logs = f.receipt.logs.map((log, index) => index === 0 ? { ...log, ...logPatch } : log);
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ receiptPatch: { logs } }) }, f.p, f.j),
      'Mismatched constructor event pointer: ' + Object.keys(logPatch)[0]);
  }
});

test('RC2 domain, initial sale commitment and current authorizer cannot be substituted', async () => {
  const f = fixture();
  for (const [index, replacement] of [[1, 'SignaturesPulseMintRC1'], [2, '2'], [3, 1n], [4, OTHER]]) {
    const domain = structuredClone(f.getters.eip712Domain); domain[index] = replacement;
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ getterPatch: { eip712Domain: domain } }) }, f.p, f.j));
  }
  for (const getterPatch of [{ saleConfigHash: hash('34') }, { defaultAdmin: OTHER }, { defaultAdminDelay: 0n },
    { trustedAuthorizer: OTHER }, { hasRole: false }, { getPulseConfig: { ...f.getters.getPulseConfig, pts: 1n } }])
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ getterPatch }) }, f.p, f.j));
});

test('constructor free root, quota, revision and initial-sale logs must retain their exact ABI commitments', async () => {
  const f = fixture();
  for (const [eventName, patch] of [['SaleConfigured', { saleConfigHash: hash('34') }],
    ['SaleConfigured', { deployedAt: BigInt(f.deployedAt + 1) }], ['FreeMintConfigured', { quota: 1n }],
    ['FreeMintConfigured', { revision: 2n }], ['FreeMintConfigured', { configHash: hash('56') }],
    ['CoreBound', { runtimeCodeHash: hash('78') }]]) {
    const rows = f.eventRows.map(([name, args]) => [name, name === eventName ? { ...args, ...patch } : args]);
    const receiptPatch = { logs: rows.map(f.logFor) };
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ receiptPatch }) }, f.p, f.j), eventName);
  }
  for (const absent of ['SaleConfigured', 'FreeMintConfigured', 'CoreBound', 'Paused', 'RoleGranted']) {
    const receiptPatch = { logs: f.eventRows.filter(([name]) => name !== absent).map(f.logFor) };
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ receiptPatch }) }, f.p, f.j), absent);
  }
});

test('legitimate mutable free policy and unpaused/paid state do not invalidate immutable deployment identity', async () => {
  const f = fixture();
  for (const salePatch of [
    { paused: false }, { freeSlotCount: 4n, freeMintQuota: 4n, freeConfigRevision: 2n },
    { freeSlotCount: 4n, freeMintQuota: 1n, freeMinted: 1n, freeConfigRevision: 3n },
    { phase: 1, paused: false, freeMinted: 2n, paidStartTime: BigInt(f.deployedAt + 1), endReason: 1 },
  ]) {
    const result = await verifyPulseAdminDeploymentAtSource({ rpc: f.source({ getterPatch: {
      saleStatus: { ...f.getters.saleStatus, ...salePatch }, freeMintRoot: hash('90'),
    } }) }, f.p, f.j);
    assert.equal(result.binding.runtimeCodeHash, keccak256(f.independent.runtime));
    assert.equal(result.binding.sale.freeMintRoot, f.p.sale.freeMintRoot, 'Initial identity is not relocked to mutable policy');
  }
  for (const salePatch of [{ freeSlotCount: 1n }, { freeMintQuota: 3n }, { freeMinted: 3n },
    { freeConfigRevision: 0n }, { freeDeadline: BigInt(f.p.sale.freeDeadline) + 1n }])
    await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source({ getterPatch: {
      saleStatus: { ...f.getters.saleStatus, ...salePatch },
    } }) }, f.p, f.j));
});

test('explicit two-source audit rejects a contradictory source, canonical receipt or anchored block', async () => {
  const f = fixture();
  await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source(),
    second: f.source({ receiptPatch: { gasUsed: '0x1001' } }) }, f.p, f.j));
  await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source(),
    second: f.source({ blockPatch: { '0x100': { hash: hash('34') } } }) }, f.p, f.j));
  await assert.rejects(verifyPulseAdminDeploymentAtSource({ rpc: f.source(),
    second: f.source({ getterPatch: { trustedAuthorizer: OTHER } }) }, f.p, f.j));
});
