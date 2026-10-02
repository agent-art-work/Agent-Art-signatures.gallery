import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, getAddress } from 'viem';
import { createSepoliaReadFailover, withSepoliaReadSource, requireRpcData, unavailableRpcData, readSources, SEPOLIA_READ_POLICY } from '../../scripts/pulse-sepolia-rpc.mjs';
import { sharedReadBlock, checkNetwork, verifyDeploymentAtSource } from '../../scripts/pulse-sepolia.mjs';
import { checkWalletSupport } from '../../scripts/pulse-sepolia-errors.mjs';
import { sepoliaTestPlan, DEPLOYER, CORE, SEPOLIA, GENESIS, INPUT_PROFILE } from './pulse-sepolia-plan.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';
import { expectedPulseRuntime } from './pulse-integration.mjs';

const transient = () => Object.assign(Error('Private transport failure'), { retryableRead: true, httpStatus: 503 });
const head = { number: '0x123', hash: '0x' + '11'.repeat(32), timestamp: '0x7d0' };
function fixture({ primary = async () => 'primary', secondary = async () => 'secondary', validate = async () => undefined } = {}) {
  const calls = [], validations = []; let time = 100000;
  const rpc = label => async (...args) => { calls.push([label, ...args]); return (label === 'primary' ? primary : secondary)(...args); };
  const context = createSepoliaReadFailover({ rpc: rpc('primary'), second: rpc('secondary') }, async source => {
    validations.push(source.readSource); await validate(source);
  }, { now: () => time });
  return { context, calls, validations, advance: delta => { time += delta; } };
}
test('healthy primary alone suffices: fallback is not a mandatory witness or a fake quorum', async () => {
  const f = fixture({ secondary: async () => { throw Error('Must not be called'); } });
  assert.equal(await f.context.rpc('eth_chainId'), 'primary');
  await withSepoliaReadSource(f.context, async source => {
    assert.equal(source.readPolicy, SEPOLIA_READ_POLICY); assert.equal(source.readSource, 'primary');
    assert.equal(readSources(source).length, 1); assert.equal(source.second, undefined);
  });
  assert.deepEqual(f.validations, ['primary']); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.context.readStatus(), { policy: SEPOLIA_READ_POLICY, activeSource: 'primary', failovers: 0, evidenceConflict: false, unavailableSources: [] });
});
test('read priority and abort budgets propagate through validation, semantic and nested reads', async () => {
  const f = fixture({ validate: async source => { await source.rpc('eth_getCode'); } });
  const controller = new AbortController();
  await withSepoliaReadSource(f.context, async source => {
    assert.equal(source.readPriority, 'background');
    await withSepoliaReadSource(source, nested => nested.rpc('eth_getLogs'));
  }, { signal: controller.signal, readPriority: 'background' });
  await f.context.rpc('eth_call');
  await f.context.rpc('eth_getBalance', [], { readPriority: 'background' });
  assert.deepEqual(f.calls.map(([, method, , options]) => [method, options.readPriority]),
    [['eth_getCode', 'background'], ['eth_getLogs', 'background'], ['eth_call', 'action'], ['eth_getBalance', 'background']]);
  assert.ok(f.calls.every(([, , , options]) => options.signal instanceof AbortSignal));
  await assert.rejects(withSepoliaReadSource(f.context, source => source.rpc('eth_call'), { readPriority: 'invalid' }), /Invalid read priority/);
});
test('raw audit contexts preserve two witnesses while inheriting read priority and cancellation', async () => {
  const calls = [], controller = new AbortController();
  const raw = { rpc: async (...args) => { calls.push(args); return 'one'; }, second: async (...args) => { calls.push(args); return 'two'; } };
  assert.deepEqual(await withSepoliaReadSource(raw, async source => Promise.all(readSources(source).map(rpc => rpc('eth_call', ['preserved-params'], { requestOption: 'preserved' }))),
    { signal: controller.signal, readPriority: 'background' }), ['one', 'two']);
  assert.ok(calls.every(([, params, options]) => params[0] === 'preserved-params' && options.requestOption === 'preserved'
    && options.signal === controller.signal && options.readPriority === 'background'));
  controller.abort(Error('Read cancelled'));
  assert.throws(() => withSepoliaReadSource(raw, () => undefined, { signal: controller.signal }), /Read cancelled/);
});
test('fallback validation and reads keep the semantic operation priority', async () => {
  const f = fixture({ primary: async () => { throw transient(); }, validate: async source => { await source.rpc('eth_getCode'); } });
  assert.equal(await withSepoliaReadSource(f.context, source => source.rpc('eth_call'), { readPriority: 'background' }), 'secondary');
  assert.deepEqual(f.validations, ['primary', 'secondary']);
  assert.ok(f.calls.every(([, , , options]) => options.readPriority === 'background'));
  assert.equal(f.context.readStatus().activeSource, 'secondary');
});
test('an unavailable primary fails over to a separately validated secondary and cools down', async () => {
  const f = fixture({ primary: async () => { throw transient(); } });
  assert.equal(await f.context.rpc('eth_chainId'), 'secondary');
  assert.deepEqual(f.validations, ['primary', 'secondary']);
  assert.equal(await f.context.rpc('eth_chainId'), 'secondary');
  assert.equal(f.calls.filter(([source]) => source === 'primary').length, 1);
  assert.equal(f.context.readStatus().activeSource, 'secondary');
  assert.deepEqual(f.context.readStatus().unavailableSources, ['primary']);
  assert.equal(f.context.readStatus().failovers, 1);
});
test('a slow primary gets its own deadline so a healthy secondary can finish', async () => {
  let releasePrimary;
  const f = fixture({ primary: async () => new Promise(resolve => { releasePrimary = resolve; }), secondary: async () => 'healthy' });
  const result = withSepoliaReadSource(f.context, source => source.rpc('eth_chainId'), { sourceTimeoutMs: 10 });
  assert.equal(await result, 'healthy');
  releasePrimary('late-primary');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.readStatus().activeSource, 'secondary');
  assert.equal(f.context.readStatus().failovers, 1);
});
test('primary recovery is automatic after bounded cooldown, without signing or broadcasting', async () => {
  let working = false;
  const f = fixture({ primary: async () => { if (!working) throw transient(); return 'recovered'; } });
  await f.context.rpc('eth_chainId'); working = true;
  f.advance(29999); assert.equal(await f.context.rpc('eth_chainId'), 'secondary');
  f.advance(1); assert.equal(await f.context.rpc('eth_chainId'), 'recovered');
  assert.deepEqual(f.validations, ['primary', 'secondary', 'primary']);
  assert.equal(f.context.readStatus().activeSource, 'primary');
  assert.ok(f.calls.every(([, method]) => method === 'eth_chainId'));
});
test('both unavailable sources refuse the operation and cannot manufacture a healthy result', async () => {
  const f = fixture({ primary: async () => { throw transient(); }, secondary: async () => { throw transient(); } });
  await assert.rejects(f.context.rpc('eth_chainId'));
  assert.equal(f.calls.length, 2); assert.equal(f.context.readStatus().activeSource, undefined);
  assert.deepEqual(f.context.readStatus().unavailableSources, ['primary', 'secondary']);
});
test('wrong chain, wrong contract, contradictions and EVM reverts never choose a more agreeable source', async () => {
  for (const failure of [Object.assign(Error('Wrong network'), { code: 'MINT_EVIDENCE_CONFLICT', retryableRead: true }),
    Error('execution reverted'), new assert.AssertionError({ message: 'Wrong runtime' })]) {
    const f = fixture({ primary: async () => { throw failure; } });
    await assert.rejects(f.context.rpc('eth_call'), error => error === failure);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.validations, ['primary']);
  }
  const f = fixture({ validate: async source => { assert.equal(source.readSource, 'secondary', 'Wrong chain'); } });
  await assert.rejects(f.context.rpc('eth_chainId'), /Wrong chain/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.validations, ['primary']);
});
test('fallback validation failure refuses data before that provider can support the site', async () => {
  const f = fixture({ primary: async () => { throw transient(); }, validate: async source => {
    if (source.readSource === 'secondary') throw new assert.AssertionError({ message: 'Wrong contract' });
  } });
  await assert.rejects(f.context.rpc('eth_call'), /Wrong contract/);
  assert.equal(f.calls.length, 1); assert.equal(f.context.readStatus().activeSource, undefined);
});
test('a genuine evidence conflict latches: timeout, cooldown and reset cannot silently restore mint authority', async () => {
  let contradictory = true;
  const failure = Object.assign(Error('Conflicting finalized evidence'), { code: 'MINT_EVIDENCE_CONFLICT' });
  const f = fixture({ primary: async () => { if (contradictory) throw failure; return 'healthy'; } });
  await assert.rejects(f.context.rpc('eth_call'), error => error === failure);
  contradictory = false; f.advance(60000); f.context.resetValidation();
  await assert.rejects(f.context.rpc('eth_call'), error => error === failure);
  assert.equal(f.calls.length, 1); assert.equal(f.context.readStatus().evidenceConflict, true);
});
test('one semantic operation restarts at fallback rather than mixing partial evidence', async () => {
  const f = fixture({ primary: async method => { if (method === 'eth_getLogs') throw transient(); return 'primary-block'; },
    secondary: async method => method === 'eth_getLogs' ? ['secondary-log'] : 'secondary-block' });
  const result = await withSepoliaReadSource(f.context, async source => ({
    block: await source.rpc('eth_getBlockByNumber'), logs: await source.rpc('eth_getLogs'),
  }));
  assert.deepEqual(result, { block: 'secondary-block', logs: ['secondary-log'] });
  assert.deepEqual(f.calls.map(([label, method]) => [label, method]), [['primary', 'eth_getBlockByNumber'], ['primary', 'eth_getLogs'],
    ['secondary', 'eth_getBlockByNumber'], ['secondary', 'eth_getLogs']]);
});
test('a null known deployment receipt is incomplete data, so fallback can supply it', async () => {
  const f = fixture({ primary: async () => null, secondary: async () => ({ status: '0x1' }) });
  const result = await withSepoliaReadSource(f.context, async source => requireRpcData(await source.rpc('eth_getTransactionReceipt')));
  assert.deepEqual(result, { status: '0x1' }); assert.equal(f.context.readStatus().activeSource, 'secondary');
});
test('explicit mint-receipt index lag tries fallback without cooling down or revalidating healthy sources', async () => {
  const f = fixture({ primary: async () => null, secondary: async () => null });
  const read = source => source.rpc('eth_getTransactionReceipt').then(receipt => {
    if (receipt === null) throw Object.assign(unavailableRpcData(), { missingMintReceipt: true });
    return receipt;
  });
  for (let index = 0; index < 3; index++) {
    await assert.rejects(withSepoliaReadSource(f.context, read), { code: 'RPC_DATA_UNAVAILABLE', missingMintReceipt: true });
    assert.deepEqual(f.context.readStatus().unavailableSources, []);
  }
  assert.deepEqual(f.validations, ['primary', 'secondary']);
  assert.deepEqual(f.calls.map(([source]) => source), ['primary', 'secondary', 'primary', 'secondary', 'primary', 'secondary']);
});
test('secondary mint inclusion resolves primary index lag while later primary reads still reuse validation', async () => {
  const f = fixture({ primary: async method => method === 'eth_getTransactionReceipt' ? null : 'primary',
    secondary: async () => ({ status: '0x1' }) });
  const receipt = await withSepoliaReadSource(f.context, async source => {
    const value = await source.rpc('eth_getTransactionReceipt');
    if (!value) throw Object.assign(unavailableRpcData(), { missingMintReceipt: true });
    return value;
  });
  assert.deepEqual(receipt, { status: '0x1' });
  assert.equal(f.context.readStatus().activeSource, 'secondary');
  assert.deepEqual(f.context.readStatus().unavailableSources, []);
  assert.equal(await f.context.rpc('eth_call'), 'primary');
  assert.deepEqual(f.validations, ['primary', 'secondary']);
});
test('a receipt-absence marker cannot suppress real transport failures or integrity contradictions', async () => {
  for (const marker of ['missingMintReceipt', 'incompleteMintHistory']) {
    const transport = fixture({ primary: async () => { throw Object.assign(transient(), { [marker]: true }); } });
    await transport.context.rpc('eth_call');
    assert.deepEqual(transport.context.readStatus().unavailableSources, ['primary']);
    const failure = Object.assign(Error('Conflicting receipt/history'), { code: 'MINT_EVIDENCE_CONFLICT', [marker]: true, retryableRead: true });
    const conflict = fixture({ primary: async () => { throw failure; } });
    await assert.rejects(conflict.context.rpc('eth_getTransactionReceipt'), error => error === failure);
    assert.equal(conflict.context.readStatus().evidenceConflict, true);
    assert.deepEqual(conflict.validations, ['primary']);
  }
});
test('missing required RPC results trigger fallback without confusing valid empty code, zero or absent transactions', async () => {
  for (const method of ['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas']) {
    const f = fixture({ primary: async () => null, secondary: async () => '0x0' });
    assert.equal(await f.context.rpc(method), '0x0'); assert.equal(f.context.readStatus().activeSource, 'secondary');
  }
  const f = fixture({ primary: async method => method === 'eth_getCode' ? '0x' : null });
  assert.equal(await f.context.rpc('eth_getCode'), '0x');
  assert.equal(await f.context.rpc('eth_getTransactionReceipt'), null);
  assert.equal(await f.context.rpc('eth_getTransactionByHash'), null);
  assert.ok(f.calls.every(([label]) => label === 'primary'));
});
test('missing and stale current heads fall back, while a malformed or conflicting head fails closed', async () => {
  for (const primary of [async () => null, async () => ({ ...head, timestamp: '0x1' })]) {
    const f = fixture({ primary, secondary: async () => head });
    assert.deepEqual(await sharedReadBlock(f.context, 'latest', 2000000), head);
    assert.equal(f.context.readStatus().activeSource, 'secondary');
  }
  const f = fixture({ primary: async () => ({ ...head, hash: 'malformed' }), secondary: async () => head });
  await assert.rejects(sharedReadBlock(f.context, 'latest', 2000000));
  assert.equal(f.calls.length, 1);
});
test('validation expires, refreshes after contract binding, and is shared across concurrent reads', async () => {
  let release;
  const f = fixture({ validate: async () => new Promise(resolve => { release = resolve; }) });
  const requests = [f.context.rpc('eth_chainId'), f.context.rpc('eth_getCode')];
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.validations, ['primary']);
  release(); await Promise.all(requests);
  f.advance(59999); await f.context.rpc('eth_call'); assert.equal(f.validations.length, 1);
  f.advance(1); const expired = f.context.rpc('eth_call'); await new Promise(resolve => setImmediate(resolve));
  release(); await expired; assert.equal(f.validations.length, 2);
  f.context.resetValidation(); const rebound = f.context.rpc('eth_call'); await new Promise(resolve => setImmediate(resolve));
  release(); await rebound; assert.equal(f.validations.length, 3);
});
test('failover cannot submit transactions, sign, or retry effectful methods, even inside a callback', async () => {
  const f = fixture();
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'wallet_switchEthereumChain']) {
    assert.throws(() => f.context.rpc(method));
    await assert.rejects(withSepoliaReadSource(f.context, source => source.rpc(method)));
  }
  assert.equal(f.calls.length, 0);
});
test('contract binding reset during in-flight validation cannot let old validation authorize a read', async () => {
  const releases = [];
  const f = fixture({ validate: async () => new Promise(resolve => releases.push(resolve)) });
  const request = f.context.rpc('eth_call');
  await new Promise(resolve => setImmediate(resolve));
  f.context.resetValidation(); releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.validations.length, 2); assert.equal(f.calls.length, 0);
  releases.shift()(); assert.equal(await request, 'primary'); assert.equal(f.calls.length, 1);
});
test('an in-flight successful read cannot escape a conflict detected by a concurrent read', async () => {
  let release;
  const failure = Object.assign(Error('Conflicting finalized evidence'), { code: 'MINT_EVIDENCE_CONFLICT' });
  const f = fixture({ primary: async method => {
    if (method === 'eth_call') return new Promise(resolve => { release = resolve; });
    throw failure;
  } });
  const pending = f.context.rpc('eth_call');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.context.rpc('eth_getLogs'), error => error === failure);
  release('apparently healthy');
  await assert.rejects(pending, error => error === failure);
  assert.equal(f.context.readStatus().evidenceConflict, true);
  assert.ok(f.calls.every(([label]) => label === 'primary'));
});
test('wallet admission can use fallback while unsupported delegation still refuses without trying another answer', async () => {
  const address = '0x0000000000000000000000000000000000000001';
  const good = async method => method === 'eth_getCode' ? '0x' : head;
  const f = fixture({ primary: async () => { throw transient(); }, secondary: good });
  assert.equal(await checkWalletSupport(f.context, address, head), address);
  assert.equal(f.context.readStatus().activeSource, 'secondary');
  const delegated = fixture({ primary: async method => method === 'eth_getCode' ? '0xef0100' + '11'.repeat(20) : head, secondary: good });
  await assert.rejects(checkWalletSupport(delegated.context, address, head), { code: 'DELEGATED_WALLET_UNSUPPORTED' });
  assert.ok(delegated.calls.every(([label]) => label === 'primary'));
});
test('read-status diagnostics expose labels, not endpoint URLs or private error bodies', async () => {
  const f = fixture({ primary: async () => { throw Object.assign(transient(), { message: 'https://private.example/SECRET' }); } });
  await f.context.rpc('eth_chainId');
  assert.doesNotMatch(JSON.stringify(f.context.readStatus()), /private|SECRET|https|transport/);
  assert.throws(() => requireRpcData(null), { code: 'RPC_DATA_UNAVAILABLE' });
  assert.equal(requireRpcData('0x'), '0x');
  assert.equal(unavailableRpcData().retryableRead, true);
});

function deploymentFixture() {
  // Frozen build plus synthetic public-chain evidence. No environment, real
  // journal, key, signing, save(), listener or network is involved in this test.
  const createdAt = Math.floor(Date.now() / 1000) - 1000;
  const plan = sepoliaTestPlan({ deployer: DEPLOYER, authorizer: '0x' + '11'.repeat(20), createdAt, nonce: 0 });
  const abi = loadPulseArtifact().abi;
  const coreRuntime = readFileSync(new URL('../vendor/pulse-core-v1.0.0/PulseCoreV1.runtime.hex', import.meta.url), 'utf8').trim();
  const coreLock = JSON.parse(readFileSync(new URL('../vendor/pulse-core-v1.0.0/consumer-lock.json', import.meta.url)));
  const renderer = JSON.parse(readFileSync(new URL('../out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json', import.meta.url)));
  const txHash = '0x' + 'aa'.repeat(32), rendererHash = '0x' + 'bb'.repeat(32), blockHash = '0x' + 'cc'.repeat(32);
  const block = { number: '0x1', hash: blockHash, timestamp: '0x' + createdAt.toString(16) };
  const current = { number: '0x2', hash: '0x' + 'dd'.repeat(32), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
  const saleConfigHash = keccak256(encodeAbiParameters([
    { type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' },
    { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  ], ['signatures.gallery/pulse-sale/v1-rc1', BigInt(SEPOLIA), getAddress(plan.collection.address), CORE,
    coreLock.runtimeCodeHash, plan.renderer.identity, DEPLOYER, plan.sale.freeMintRoot, 2n,
    BigInt(plan.sale.freeDeadline), BigInt(plan.sale.pulse.k), BigInt(plan.sale.pulse.genesisPrice),
    BigInt(plan.sale.pulse.genesisFloor), BigInt(plan.sale.pulse.pts)]));
  const sale = { core: CORE, coreRuntimeCodeHash: coreLock.runtimeCodeHash, treasury: DEPLOYER,
    root: plan.sale.freeMintRoot, slotCount: '2', freeDeadline: plan.sale.freeDeadline,
    deployedAt: String(createdAt), config: plan.sale.pulse, saleConfigHash };
  const runtime = expectedPulseRuntime({ chainId: SEPOLIA, contract: plan.collection.address, renderer: plan.renderer, sale }, loadPulseArtifact());
  const logs = [];
  function emit(name, args) {
    const event = abi.find(entry => entry.type === 'event' && entry.name === name), index = logs.length;
    logs.push({ address: plan.collection.address, removed: false, blockHash, blockNumber: block.number,
      transactionHash: txHash, transactionIndex: '0x0', logIndex: '0x' + index.toString(16),
      topics: encodeEventTopics({ abi, eventName: name, args }),
      data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => args[input.name])) });
  }
  emit('CoreBound', { core: CORE, chainId: BigInt(SEPOLIA), runtimeCodeHash: coreLock.runtimeCodeHash });
  emit('SaleConfigured', { saleConfigHash, freeMintRoot: plan.sale.freeMintRoot, freeSlotCount: 2n,
    freeDeadline: BigInt(plan.sale.freeDeadline), treasury: DEPLOYER, deployedAt: BigInt(createdAt) });
  for (const role of ['AUTHORIZER_MANAGER_ROLE', 'PAUSER_ROLE', 'NONCE_REVOKER_ROLE']) {
    emit('RoleGranted', { role: keccak256(stringToHex(role)), account: DEPLOYER, sender: DEPLOYER });
  }
  emit('Paused', { account: DEPLOYER });
  const receipt = { type: '0x2', status: '0x1', transactionHash: txHash, transactionIndex: '0x0',
    blockHash, blockNumber: block.number, from: DEPLOYER, to: null, contractAddress: plan.collection.address,
    cumulativeGasUsed: '0x1000', gasUsed: '0x1000', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256), logs };
  const journal = { transactions: { renderer: { hash: rendererHash, status: 'confirmed' }, collection: { hash: txHash, status: 'confirmed' } } };
  const calls = [];
  function source(label, { absent = false, wrongChain = false, wrongCore = false, wrongRuntime = false, wrongAuthorizer = false, wrongCreation = false, wrongFinalBlock = false } = {}) {
    return async (method, params) => {
      calls.push({ label, method, params });
      if (method === 'eth_chainId') return wrongChain ? '0x1' : '0xaa36a7';
      if (method === 'eth_getBlockByNumber') return params[0] === '0x0' ? { hash: GENESIS }
        : params[0] === block.number ? { ...block, ...(wrongFinalBlock ? { hash: current.hash } : {}) } : current;
      if (method === 'eth_getTransactionReceipt') return absent ? null : receipt;
      if (method === 'eth_getCode') {
        const address = getAddress(params[0]);
        if (address === CORE) return wrongCore ? '0x6000' : coreRuntime;
        return address === getAddress(plan.renderer.address) ? renderer.deployedBytecode.object : wrongRuntime ? '0x6000' : runtime;
      }
      if (method === 'eth_getTransactionByHash') {
        const step = params[0] === rendererHash ? 'renderer' : 'collection';
        return { input: wrongCreation ? '0x6000' : plan[step].data, to: null, from: DEPLOYER,
          nonce: '0x' + plan[step].nonce.toString(16), value: '0x0', chainId: '0xaa36a7' };
      }
      assert.equal(method, 'eth_call'); assert.equal(params[1], current.number);
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      const result = functionName === 'trustedAuthorizer' ? wrongAuthorizer ? DEPLOYER : plan.authorities.authorizer
        : functionName === 'defaultAdmin' ? DEPLOYER : functionName === 'defaultAdminDelay' ? BigInt(plan.authorities.adminDelay) : true;
      return encodeFunctionResult({ abi, functionName, result });
    };
  }
  return { plan, journal, source, calls };
}
test('full frozen deployment verification works through a fallback receipt without changing code, constructor or authority checks', async () => {
  const f = deploymentFixture();
  const c = createSepoliaReadFailover({ rpc: f.source('primary', { absent: true }), second: f.source('secondary') }, checkNetwork);
  const result = await withSepoliaReadSource(c, source => verifyDeploymentAtSource(source, f.plan, f.journal));
  assert.equal(result.collection, f.plan.collection.address); assert.equal(result.deployment.finalized, true);
  assert.equal(result.sourceCount, 1); assert.equal(result.readSource, 'secondary'); assert.equal(result.readPolicy, SEPOLIA_READ_POLICY);
  assert.match(result.sourceIndependence, /no quorum/); assert.equal(result.renderer.inputProfile, INPUT_PROFILE);
  assert.ok(f.calls.every(call => call.method !== 'eth_sendRawTransaction'));
});
test('deployment failover refuses wrong chain, core, runtime, authority, creation input or canonical deployment block', async () => {
  const f = deploymentFixture();
  for (const patch of [{ wrongChain: true }, { wrongCore: true }, { wrongRuntime: true }, { wrongAuthorizer: true },
    { wrongCreation: true }, { wrongFinalBlock: true }]) {
    f.calls.length = 0;
    const c = createSepoliaReadFailover({ rpc: f.source('primary', patch), second: f.source('secondary') }, checkNetwork);
    await assert.rejects(withSepoliaReadSource(c, source => verifyDeploymentAtSource(source, f.plan, f.journal)));
    assert.ok(f.calls.every(call => call.label === 'primary'), 'Contradiction must not be overridden by a different RPC');
  }
});
