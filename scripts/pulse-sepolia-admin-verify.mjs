import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeAbiParameters, decodeEventLog, getAddress, keccak256, stringToHex } from 'viem';
import { ROOT } from '../contracts/tools/pulse-candidate-lock.mjs';
import { loadPulseAdminArtifact, verifyPulseAdminCandidate } from '../contracts/tools/pulse-admin-candidate.mjs';
import { SEPOLIA, CORE, DEPLOYER, INPUT_PROFILE } from '../contracts/tools/pulse-sepolia-plan.mjs';
import { checkNetwork, sharedReadBlock, readContract, canonicalSepoliaReceipt } from './pulse-sepolia.mjs';
import { readSources, withSepoliaReadSource, requireRpcData, requireSepoliaIntegrity } from './pulse-sepolia-rpc.mjs';

const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const short = value => '0x' + Buffer.from(value).toString('hex').padEnd(62, '0') + Buffer.byteLength(value).toString(16).padStart(2, '0');
const address = (a, b) => assert.equal(getAddress(a), getAddress(b));

export function adminSaleConfigHash(p) {
  const types = ['string', 'uint256', 'address', 'address', 'bytes32', 'bytes32', 'address',
    'bytes32', 'uint256', 'uint256', 'uint64', 'uint256', 'uint256', 'uint256', 'uint256'];
  const coreHash = JSON.parse(readFileSync(resolve(ROOT, 'contracts/vendor/pulse-core-v1.0.0/consumer-lock.json'))).runtimeCodeHash;
  return keccak256(encodeAbiParameters(types.map(type => ({ type })), [
    'signatures.gallery/pulse-sale/v1-rc2', BigInt(SEPOLIA), p.collection.address, CORE, coreHash,
    p.renderer.identity, p.sale.treasury, p.sale.freeMintRoot, BigInt(p.sale.freeSlotCount),
    BigInt(p.sale.freeMintQuota), BigInt(p.sale.freeDeadline), ...['k', 'genesisPrice', 'genesisFloor', 'pts'].map(k => BigInt(p.sale.pulse[k])),
  ]));
}

/** Exact substitution for the frozen RC2 artifact. No masked or ignored code.
 * Groups were checked against compiler IR constructor assignments; incidental
 * AST IDs are not part of the identity, byte positions and full bytes are. */
export function expectedPulseAdminRuntime(p, deployedAt, artifact = loadPulseAdminArtifact()) {
  const name = 'SignaturesPulseMintRC2', version = '1';
  const separator = keccak256(encodeAbiParameters(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'].map(type => ({ type })),
    [keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
      keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(SEPOLIA), p.collection.address]));
  const groups = [
    [[17154], separator], [[17112], word(SEPOLIA)], [[17070], word(p.collection.address)],
    [[17235], keccak256(stringToHex(name))], [[17275], keccak256(stringToHex(version))],
    [[14226], short(name)], [[14271], short(version)],
    [[2761, 4633, 8391, 8588], word(p.renderer.address)], [[3317, 8783, 8981], p.renderer.identity],
    [[1829, 5889, 9702, 12622, 13548], word(CORE)], [[1533, 11086], word(SEPOLIA)],
    [[2232, 6483], word(p.sale.treasury)],
    [[3466, 4862, 4991, 6175, 6904, 9973, 10118, 10185, 13465, 13669], word(p.sale.freeDeadline)],
    [[3756], word(deployedAt)], [[3046], adminSaleConfigHash(p)],
    [[8218], word(p.sale.pulse.k)], [[8256], word(p.sale.pulse.genesisPrice)],
    [[8294], word(p.sale.pulse.genesisFloor)], [[8332], word(p.sale.pulse.pts)],
  ];
  const actual = Object.values(artifact.deployedBytecode.immutableReferences).map(refs => refs.map(ref => {
    assert.equal(ref.length, 32); return ref.start;
  }).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(actual, groups.map(([positions]) => positions).sort((a, b) => a[0] - b[0]), 'RC2 immutable layout drift');
  const bytes = Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex');
  for (const [positions, value] of groups) {
    assert.match(value, /^0x[0-9a-f]{64}$/);
    for (const start of positions) {
      assert.deepEqual(bytes.subarray(start, start + 32), Buffer.alloc(32));
      Buffer.from(value.slice(2), 'hex').copy(bytes, start);
    }
  }
  return '0x' + bytes.toString('hex');
}

export async function verifyPulseAdminDeployment(c, p, j) {
  return withSepoliaReadSource(c, source => verifyPulseAdminDeploymentAtSource(source, p, j));
}
export async function verifyPulseAdminDeploymentAtSource(c, p, j) {
  const candidate = verifyPulseAdminCandidate(), artifact = loadPulseAdminArtifact(), abi = artifact.abi;
  assert.equal(p.contractProfile, candidate.contractProfile); assert.equal(p.candidateLockSha256, candidate.lockSha256);
  assert.equal(p.chainId, SEPOLIA); assert.equal(j.planDigest, p.digest);
  await checkNetwork(c);
  const receipt = canonicalSepoliaReceipt(requireRpcData(await c.rpc('eth_getTransactionReceipt', [j.transactions.collection.hash])));
  assert.equal(receipt.status, '0x1'); address(receipt.contractAddress, p.collection.address); address(receipt.from, DEPLOYER);
  assert.equal(receipt.to, null); assert.equal(receipt.transactionHash, j.transactions.collection.hash);
  const created = requireRpcData(await c.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]));
  assert.equal(created.hash, receipt.blockHash); assert.equal(BigInt(created.number), BigInt(receipt.blockNumber));
  for (const log of receipt.logs) {
    assert.equal(log.removed, false); assert.equal(log.transactionHash, receipt.transactionHash);
    assert.equal(BigInt(log.transactionIndex), BigInt(receipt.transactionIndex));
    assert.equal(log.blockHash, receipt.blockHash); assert.equal(BigInt(log.blockNumber), BigInt(receipt.blockNumber));
  }
  const events = receipt.logs.filter(l => getAddress(l.address) === getAddress(p.collection.address)).map(l => {
    try { return decodeEventLog({ abi, ...l }); } catch { return null; }
  });
  const configured = events.find(e => e?.eventName === 'SaleConfigured');
  const free = events.find(e => e?.eventName === 'FreeMintConfigured');
  const core = events.find(e => e?.eventName === 'CoreBound');
  assert.ok(configured && free && core && events.some(e => e?.eventName === 'Paused'));
  address(core.args.core, CORE); assert.equal(core.args.chainId, BigInt(SEPOLIA));
  const coreHash = JSON.parse(readFileSync(resolve(ROOT, 'contracts/vendor/pulse-core-v1.0.0/consumer-lock.json'))).runtimeCodeHash;
  assert.equal(core.args.runtimeCodeHash, coreHash); assert.equal(configured.args.saleConfigHash, adminSaleConfigHash(p));
  assert.equal(configured.args.freeMintRoot, p.sale.freeMintRoot); assert.equal(configured.args.freeSlotCount, BigInt(p.sale.freeSlotCount));
  assert.equal(configured.args.freeDeadline, BigInt(p.sale.freeDeadline)); address(configured.args.treasury, p.sale.treasury);
  assert.equal(configured.args.deployedAt, BigInt(created.timestamp));
  assert.equal(free.args.root, p.sale.freeMintRoot); assert.equal(free.args.slotCount, BigInt(p.sale.freeSlotCount));
  assert.equal(free.args.quota, BigInt(p.sale.freeMintQuota)); assert.equal(free.args.revision, 1n);
  assert.equal(free.args.configHash, keccak256(encodeAbiParameters(
    ['bytes32', 'uint256', 'uint256', 'uint64'].map(type => ({ type })), [p.sale.freeMintRoot, BigInt(p.sale.freeSlotCount), BigInt(p.sale.freeMintQuota), 1n])));
  const expected = expectedPulseAdminRuntime(p, BigInt(created.timestamp), artifact), anchor = await sharedReadBlock(c);
  const sources = readSources(c);
  await Promise.all(sources.map(async rpc => {
    const [block, canonicalReceipt, rendererCode, code, tx] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getTransactionReceipt', [receipt.transactionHash]),
      rpc('eth_getCode', [p.renderer.address, anchor.number]), rpc('eth_getCode', [p.collection.address, anchor.number]),
      rpc('eth_getTransactionByHash', [receipt.transactionHash]),
    ]);
    assert.equal(requireRpcData(block).hash, receipt.blockHash);
    assert.deepEqual(canonicalSepoliaReceipt(requireRpcData(canonicalReceipt)), receipt);
    const rendererArtifact = JSON.parse(readFileSync(resolve(ROOT, 'contracts/out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json')));
    requireSepoliaIntegrity(rendererCode === rendererArtifact.deployedBytecode.object, 'RENDERER_CODE');
    requireSepoliaIntegrity(code === expected, 'COLLECTION_CODE');
    requireRpcData(tx); assert.equal(tx.input, p.collection.data); assert.equal(tx.to, null); address(tx.from, DEPLOYER);
    assert.equal(tx.hash, receipt.transactionHash); assert.equal(tx.blockHash, receipt.blockHash);
    assert.equal(BigInt(requireRpcData(tx.blockNumber)), BigInt(receipt.blockNumber));
    assert.equal(BigInt(requireRpcData(tx.transactionIndex)), BigInt(receipt.transactionIndex));
    assert.equal(BigInt(tx.nonce), BigInt(p.collection.nonce)); assert.equal(BigInt(tx.value), 0n); assert.equal(BigInt(tx.chainId), BigInt(SEPOLIA));
    const call = (name, args = []) => readContract(rpc, p.collection.address, name, args, anchor.number, abi);
    const [authorizer, admin, delay, configHash, domain, sale, root, pulse] = await Promise.all([
      call('trustedAuthorizer'), call('defaultAdmin'), call('defaultAdminDelay'), call('saleConfigHash'),
      call('eip712Domain'), call('saleStatus'), call('freeMintRoot'), call('getPulseConfig'),
    ]);
    requireSepoliaIntegrity(getAddress(authorizer) === getAddress(p.authorities.authorizer), 'AUTHORIZER');
    address(admin, DEPLOYER); assert.equal(BigInt(delay), BigInt(p.authorities.adminDelay)); assert.equal(configHash, adminSaleConfigHash(p));
    assert.equal(domain[1], 'SignaturesPulseMintRC2'); assert.equal(domain[2], '1'); assert.equal(domain[3], BigInt(SEPOLIA)); address(domain[4], p.collection.address);
    assert.equal(sale.freeDeadline, BigInt(p.sale.freeDeadline)); assert.ok(sale.freeSlotCount >= BigInt(p.sale.freeSlotCount));
    assert.ok(sale.freeMinted <= sale.freeMintQuota && sale.freeMintQuota <= sale.freeSlotCount && sale.freeConfigRevision >= 1n);
    assert.match(root, /^0x[0-9a-f]{64}$/); assert.notEqual(root, '0x' + '0'.repeat(64));
    for (const key of ['k', 'genesisPrice', 'genesisFloor', 'pts']) assert.equal(pulse[key], BigInt(p.sale.pulse[key]));
    await Promise.all(['AUTHORIZER_MANAGER_ROLE', 'PAUSER_ROLE', 'NONCE_REVOKER_ROLE'].map(async role => {
      const id = keccak256(stringToHex(role));
      assert.ok(events.some(e => e?.eventName === 'RoleGranted' && e.args.role === id && getAddress(e.args.account) === DEPLOYER));
      assert.equal(await call('hasRole', [id, DEPLOYER]), true);
    }));
    assert.equal(requireRpcData(await rpc('eth_getBlockByNumber', [anchor.number, false])).hash, anchor.hash);
  }));
  const finalized = await sharedReadBlock(c, 'finalized');
  const verification = { schema: 'sg-pulse-sepolia-admin-deployment/v1', contractProfile: candidate.contractProfile,
    testOnly: true, productionApproved: false, chainId: SEPOLIA, checkedAt: new Date().toISOString(),
    planDigest: p.digest, candidateLockSha256: candidate.lockSha256, core: CORE, renderer: p.renderer,
    collection: p.collection.address, authorizer: p.authorities.authorizer, runtimeCodeHash: keccak256(expected),
    sale: { ...p.sale, deployedAt: String(BigInt(created.timestamp)), saleConfigHash: adminSaleConfigHash(p) },
    deployment: { transactionHash: receipt.transactionHash, blockNumber: String(BigInt(receipt.blockNumber)),
      blockHash: receipt.blockHash, finalized: BigInt(finalized.number) >= BigInt(receipt.blockNumber) },
    startedPaused: true, sourceCount: sources.length, readPolicy: c.readPolicy ?? 'two-source-audit',
    readBlock: { number: String(BigInt(anchor.number)), hash: anchor.hash }, historicalStateRequired: false };
  return { verification, binding: verification };
}
