import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, encodeFunctionData,
  decodeFunctionResult, encodeErrorResult, keccak256, stringToHex, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildAllowlist } from './pulse-allowlist.mjs';
import { PULSE_MINT_CANDIDATE, PULSE_AUTHORIZATION_TYPES } from '../../src/openMint/pulseCandidate.ts';
import { expectedPulseRuntime } from './pulse-integration.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const artifact = name => json(`../out/${name}.sol/${name}.json`);
const galleryArtifact = artifact('SignaturesPulseMintV1RC1');
const rendererArtifact = artifact('SignatureRendererV1RC1');
const treasuryArtifact = json('../out/SignaturesPulseMintV1RC1.t.sol/TogglePulseTreasury.json');
const coreAbi = json('../vendor/pulse-core-v1.0.0/IPulseCore.abi.json');
const coreCreation = read('../vendor/pulse-core-v1.0.0/PulseCoreV1.creation.hex').trim();
const vectors = json('../vendor/pulse-core-v1.0.0/vectors.json');
const big = value => Object.fromEntries(Object.entries(value).map(([key, number]) => [key, BigInt(number)]));
const decimals = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));
const key = n => privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`);
const signer = key(1), buyer = key(2), other = key(3), operator = key(4);
const PAID_SLOT = (1n << 256n) - 1n;

test('C5 released-core vectors, production Merkle proofs, receipts and payment atomicity on disposable Anvil',
  { timeout: 120000 }, async t => {
  // The RPC destination and public test keys cannot be supplied by environment,
  // CLI or a saved deployment. Every write targets this new loopback child.
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--hardfork', 'prague', '--timestamp', '1800000000', '--gas-limit', '30000000', '--silent'], { stdio: 'ignore' });
  let startupError; child.on('error', error => { startupError = error; });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: 'Disposable Pulse C5',
    nativeCurrency: { name: 'Test ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const transport = http(url, { retryCount: 0, timeout: 5000 });
  const client = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 20 });
  const wallet = account => createWalletClient({ chain, transport, account });
  const rpc = (method, params = []) => client.request({ method, params }, { retryCount: 0 });
  const gas = {};
  async function send(account, to, data, value = 0n, gasPrice = 1000000000n) {
    return wallet(account).sendTransaction({ to, data, value, gas: 12000000n, gasPrice,
      nonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) });
  }
  const receipt = hash => client.waitForTransactionReceipt({ hash, timeout: 10000, pollingInterval: 20 });
  async function deploy(code, abi = [], args = [], label) {
    const result = await receipt(await send(operator, undefined, encodeDeployData({ abi, bytecode: code, args })));
    assert.equal(result.status, 'success'); assert.ok(result.contractAddress);
    if (label) gas[label] = String(result.gasUsed);
    if(abi === galleryArtifact.abi) {
      const at=result.contractAddress;
      const [renderer,core,coreRuntimeCodeHash,treasury,root,slotCount,freeDeadline,deployedAt,saleConfigHash,config,rendererIdentity]=await Promise.all(
        ['renderer','pulseCore','coreRuntimeCodeHash','treasury','freeMintRoot','freeSlotCount','freeDeadline','deployedAt','saleConfigHash','getPulseConfig','rendererIdentity'].map(name=>readGallery(at,name)));
      const sale={core,coreRuntimeCodeHash,treasury,root,slotCount:String(slotCount),freeDeadline:String(freeDeadline),deployedAt:String(deployedAt),saleConfigHash,
        config:Object.fromEntries(Object.entries(config).map(([k,v])=>[k,String(v)]))};
      assert.equal(await client.getCode({address:at}),expectedPulseRuntime({chainId:31337,contract:at,renderer:{address:renderer,identity:rendererIdentity},sale},galleryArtifact),'C6 exact runtime/immutable binding');
    }
    return result.contractAddress;
  }
  const readGallery = (address, functionName, args = []) => client.readContract({ address, abi: galleryArtifact.abi, functionName, args });
  async function writeGallery(address, account, functionName, args = [], value = 0n) {
    return receipt(await send(account, address, encodeFunctionData({ abi: galleryArtifact.abi, functionName, args }), value));
  }
  let sequence = 0;
  async function authority(address, handle, mode, slot, cap, account) {
    const timestamp = (await client.getBlock()).timestamp;
    const issuedAt = timestamp;
    const freeDeadline = BigInt(await readGallery(address, 'freeDeadline'));
    const deadline = mode === 0 && timestamp + 900n > freeDeadline ? freeDeadline : timestamp + 900n;
    const a = { handleKey: await readGallery(address, 'handleKey', [handle]),
      assessmentDigest: keccak256(stringToHex('PUBLIC OFFLINE C5 FIXTURE')),
      inputDigest: await readGallery(address, 'inputDigest', [handle, 'INTJ']), recipient: account.address,
      nonce: keccak256(stringToHex(`C5 fixture nonce ${sequence++}`)), issuedAt, deadline,
      mintMode: mode, slotId: BigInt(slot), maxPrice: cap };
    const signature = await signer.signTypedData({ domain: { name: PULSE_MINT_CANDIDATE.domainName,
      version: PULSE_MINT_CANDIDATE.domainVersion, chainId: 31337, verifyingContract: address },
    types: PULSE_AUTHORIZATION_TYPES, primaryType: 'PulseMintAuthorization', message: a });
    return { a, signature };
  }
  async function mintFree(address, allowlist, slot, handle, account = buyer, expected = 'success') {
    const { a, signature } = await authority(address, handle, 0, slot, 0n, account);
    const result = await writeGallery(address, account, 'mintFree', [handle, 'INTJ', a, signature, allowlist.proofs[slot].siblings]);
    assert.equal(result.status, expected);
    assert.equal(await readGallery(address, 'usedNonces', [a.nonce]), expected === 'success');
    if (expected === 'reverted') assert.deepEqual(result.logs, []);
    return result;
  }
  try {
    let ready = false;
    for (let i = 0; i < 80; ++i) {
      if (startupError) throw startupError;
      assert.equal(child.exitCode, null, 'disposable Anvil exited during startup');
      try { assert.equal(await client.getChainId(), 31337); ready = true; break; } catch { await sleep(50); }
    }
    assert.ok(ready, 'disposable Anvil startup timed out');
    for (const account of [operator, buyer, other]) await rpc('anvil_setBalance', [account.address, '0x56bc75e2d63100000']);
    const core = await deploy(coreCreation, [], [], 'coreDeployment');
    assert.equal(keccak256(await client.getCode({ address: core })), PULSE_MINT_CANDIDATE.pulseRuntimeCodeHash);
    // All published success and exact revert-data vectors run against released bytecode.
    for (const vector of vectors.cases) {
      const config = big(typeof vector.config === 'string' ? vectors.configs[vector.config] : vector.config);
      const state = vector.state === undefined ? undefined : big(typeof vector.state === 'string' ? vectors.states[vector.state] : vector.state);
      const time = BigInt(vector.startTime ?? vector.timestamp);
      const data = encodeFunctionData({ abi: coreAbi, functionName: vector.method,
        args: vector.method === 'initialize' ? [config, time] : [config, state, time] });
      const raw = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: core, data }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(result => result.json());
      if (vector.error) assert.equal(raw.error?.data, encodeErrorResult({ abi: coreAbi,
        errorName: vector.error.name, args: vector.error.args.map(BigInt) }), vector.id);
      else {
        assert.equal(raw.error, undefined, vector.id);
        const decoded = decodeFunctionResult({ abi: coreAbi, functionName: vector.method, data: raw.result });
        const result = vector.method === 'advance' ? { ask: decoded[0], nextState: decoded[1] } : decoded;
        // viem decodes uint64 as bigint, uint8/enum as number; the core has only uint64/uint256.
        assert.deepEqual(decimals(result), vector.expected, vector.id);
      }
    }
    const renderer = await deploy(rendererArtifact.bytecode.object, rendererArtifact.abi, [], 'rendererDeployment');
    const treasury = await deploy(treasuryArtifact.bytecode.object, treasuryArtifact.abi);
    const deadline = (await client.getBlock()).timestamp + 7200n;
    const wallets = Array.from({ length: 1025 }, (_, i) => i === 255 ? other.address : buyer.address);
    const large = buildAllowlist(wallets), smaller = buildAllowlist(wallets.slice(0, 1024));
    const roles = { adminDelay: 172800, admin: operator.address, manager: operator.address,
      pauser: operator.address, revoker: operator.address, authorizer: signer.address };
    async function collection(list, until = deadline, label) {
      const sale = { freeMintRoot: list.manifest.root, freeSlotCount: BigInt(list.manifest.slotCount),
        freeDeadline: until, treasury, pulse: { k: 600n, genesisPrice: 1000n, genesisFloor: 900n, pts: 1n } };
      const address = await deploy(galleryArtifact.bytecode.object, galleryArtifact.abi,
        [renderer, { chainId: 31337n, core }, sale, roles], label);
      assert.equal(await readGallery(address, 'paused'), true);
      assert.equal((await writeGallery(address, operator, 'unpauseMinting')).status, 'success');
      return address;
    }
    const short = await collection(smaller, deadline, 'collection1024Deployment');
    const long = await collection(smaller);
    gas.freeFirstShort1024 = String((await mintFree(short, smaller, 0, 'a')).gasUsed);
    gas.freeFirstLong1024 = String((await mintFree(long, smaller, 0, 'abcdefghijklmno')).gasUsed);
    const gallery = await collection(large, deadline, 'collection1025Deployment');
    await mintFree(gallery, large, 0, 'Stolen', other, 'reverted');
    assert.equal(await readGallery(gallery, 'freeMinted'), 0n);
    for (const [slot, handle, account, label] of [
      [0, 'a', buyer, 'freeFirst1025'], [1, 'b', buyer, 'freeReusedWord1025'],
      [255, 'BitmapEdge', other, 'freeSlot255'], [256, 'NewWord', buyer, 'freeSlot256'],
      [257, 'ReuseWord', buyer, 'freeSlot257'], [1024, 'LastSlot', buyer, 'freeLastSlot1025'],
    ]) {
      gas[label] = String((await mintFree(gallery, large, slot, handle, account)).gasUsed);
      assert.equal(await readGallery(gallery, 'isFreeSlotClaimed', [BigInt(slot)]), true);
    }
    assert.equal(await readGallery(gallery, 'freeMinted'), 6n);
    assert.equal(await readGallery(gallery, 'isFreeSlotClaimed', [254n]), false);
    assert.equal(await readGallery(gallery, 'isFreeSlotClaimed', [1023n]), false);
    await mintFree(gallery, large, 2, 'A', buyer, 'reverted');
    assert.equal(await readGallery(gallery, 'isFreeSlotClaimed', [2n]), false);

    // Timeout transition: a reverted receipt has no logs and pays only gas.
    await rpc('evm_setNextBlockTimestamp', [Number(deadline)]); await rpc('evm_mine');
    const intent = await authority(gallery, 'Paid', 1, PAID_SLOT, 1200n, buyer);
    const beforeFailure = await client.getBalance({ address: buyer.address });
    const rejected = await writeGallery(gallery, buyer, 'mintPaid', ['Paid', 'INTJ', intent.a, intent.signature], 1200n);
    assert.equal(rejected.status, 'reverted'); assert.deepEqual(rejected.logs, []);
    assert.equal(beforeFailure - await client.getBalance({ address: buyer.address }), rejected.gasUsed * rejected.effectiveGasPrice);
    assert.equal(await client.getBalance({ address: treasury }), 0n);
    assert.equal(await readGallery(gallery, 'usedNonces', [intent.a.nonce]), false);
    assert.equal((await readGallery(gallery, 'getPulseState')).epochIndex, 0n);
    assert.equal((await readGallery(gallery, 'saleStatus')).lastPaidMintBlock, 0n);
    const allowed = await receipt(await send(operator, treasury, encodeFunctionData({ abi: treasuryArtifact.abi, functionName: 'allow' })));
    assert.equal(allowed.status, 'success');
    await rpc('evm_setNextBlockTimestamp', [Number(deadline + 10n)]);
    const beforeSuccess = await client.getBalance({ address: buyer.address });
    const accepted = await writeGallery(gallery, buyer, 'mintPaid', ['Paid', 'INTJ', intent.a, intent.signature], 1200n);
    assert.equal(accepted.status, 'success'); gas.paidFirstAfterDeadline = String(accepted.gasUsed);
    assert.equal(await client.getBalance({ address: treasury }), 937n);
    assert.equal(beforeSuccess - await client.getBalance({ address: buyer.address }), 937n + accepted.gasUsed * accepted.effectiveGasPrice);
    assert.equal(await client.getBalance({ address: gallery }), 0n);
    const decodedLogs = accepted.logs.filter(log => log.address.toLowerCase() === gallery.toLowerCase())
      .map(log => decodeEventLog({ abi: galleryArtifact.abi, topics: log.topics, data: log.data }));
    assert.equal(decodedLogs.filter(log => log.eventName === 'PaidPhaseStarted').length, 1);
    const sale = decodedLogs.find(log => log.eventName === 'Sale').args;
    assert.equal(sale.price, 937n); assert.equal(sale.epochIndex, 1n);

    // Include two fully signed transactions in one real local block.
    const first = await authority(gallery, 'RaceOne', 1, PAID_SLOT, 2000n, buyer);
    const second = await authority(gallery, 'RaceTwo', 1, PAID_SLOT, 2000n, other);
    await rpc('evm_setAutomine', [false]);
    let firstHash, secondHash;
    try {
      firstHash = await send(buyer, gallery, encodeFunctionData({ abi: galleryArtifact.abi, functionName: 'mintPaid',
        args: ['RaceOne', 'INTJ', first.a, first.signature] }), 2000n, 2000000000n);
      secondHash = await send(other, gallery, encodeFunctionData({ abi: galleryArtifact.abi, functionName: 'mintPaid',
        args: ['RaceTwo', 'INTJ', second.a, second.signature] }), 2000n);
      await rpc('evm_setNextBlockTimestamp', [Number(deadline + 11n)]); await rpc('evm_mine');
    } finally { await rpc('evm_setAutomine', [true]); }
    const [won, lost] = await Promise.all([receipt(firstHash), receipt(secondHash)]);
    assert.equal(won.blockHash, lost.blockHash); assert.equal(won.status, 'success'); assert.equal(lost.status, 'reverted');
    assert.deepEqual(lost.logs, []); assert.equal(await readGallery(gallery, 'usedNonces', [second.a.nonce]), false);
    assert.equal((await readGallery(gallery, 'getPulseState')).epochIndex, 2n);
    gas.paidSubsequent = String(won.gasUsed);

    const oneSlot = buildAllowlist([buyer.address]);
    const exhausted = await collection(oneSlot, (await client.getBlock()).timestamp + 3600n);
    gas.freeFinalExhaustion = String((await mintFree(exhausted, oneSlot, 0, 'EndFree')).gasUsed);
    assert.equal((await readGallery(exhausted, 'saleStatus')).endReason, 1);
    const paid = await authority(exhausted, 'FirstPaid', 1, PAID_SLOT, 1200n, buyer);
    const paidReceipt = await writeGallery(exhausted, buyer, 'mintPaid', ['FirstPaid', 'INTJ', paid.a, paid.signature], 1200n);
    assert.equal(paidReceipt.status, 'success'); gas.paidFirstAfterExhaustion = String(paidReceipt.gasUsed);
    t.diagnostic(JSON.stringify({ localOnly: true, coreVectors: vectors.cases.length, allowlistSlots: 1025,
      failedReceiptsHaveNoLogs: true, sameBlockPaidSuccesses: 1, gasUsed: gas }));
  } finally {
    if (child.exitCode === null && !startupError) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
});
