import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeAbiParameters, getAddress, keccak256, stringToHex } from 'viem';
import { ROOT, verifyPulseCandidate, jsonDigest } from './pulse-candidate-lock.mjs';
import { validatePulseDeployment } from '../../src/openMint/pulseEconomics.ts';
import { PULSE_MINT_CANDIDATE } from '../../src/openMint/pulseCandidate.ts';

const word=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');
const short=v=>'0x'+Buffer.from(v).toString('hex').padEnd(62,'0')+Buffer.byteLength(v).toString(16).padStart(2,'0');
/** Exact C5 immutable substitution. No ignored/masked deployed bytes.
 * Positions checked against the candidate lock; AST IDs are not an identity. */
export function expectedPulseRuntime(binding, artifact) {
  const { chainId, contract, renderer, sale }=binding;
  validatePulseDeployment(sale,BigInt(chainId),contract,renderer.identity);
  const name=PULSE_MINT_CANDIDATE.domainName,version='1';
  const separator=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'address'}],
    [keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),keccak256(stringToHex(name)),keccak256(stringToHex(version)),BigInt(chainId),getAddress(contract)]));
  const groups=[
    [[2675,5852,8488,8685],word(renderer.address)], [[3261,8880,9078],renderer.identity],
    [[1812,4921,6250,9799,13095],word(sale.core)], [[1475,10730],word(chainId)], [[2172,6844],word(sale.treasury)],
    [[3011,4704],sale.root], [[1379,4882,7343,10183],word(sale.slotCount)],
    [[3410,4406,4535,6536,10054,10229,10296,13012,13216],word(sale.freeDeadline)],
    [[3700],word(sale.deployedAt)], [[2960],sale.saleConfigHash],
    [[8315],word(sale.config.k)], [[8353],word(sale.config.genesisPrice)], [[8391],word(sale.config.genesisFloor)], [[8429],word(sale.config.pts)],
    [[16446],separator], [[16404],word(chainId)], [[16362],word(contract)],
    [[16527],keccak256(stringToHex(name))], [[16567],keccak256(stringToHex(version))], [[13605],short(name)], [[13650],short(version)],
  ];
  const actual=Object.values(artifact.deployedBytecode.immutableReferences).map(refs=>refs.map(r=>{assert.equal(r.length,32);return r.start;}).sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);
  assert.deepEqual(actual,groups.map(([positions])=>positions).sort((a,b)=>a[0]-b[0]));
  const bytes=Buffer.from(artifact.deployedBytecode.object.slice(2),'hex');
  for(const [positions,value] of groups) {
    assert.match(value,/^0x[0-9a-f]{64}$/);
    for(const start of positions) {assert.deepEqual(bytes.subarray(start,start+32),Buffer.alloc(32));Buffer.from(value.slice(2),'hex').copy(bytes,start);}
  }
  return '0x'+bytes.toString('hex');
}
export const PULSE_INTEGRATION_FILES=Object.freeze([
  'contracts/releases/generative-pulse-v1-rc1.json','contracts/releases/generative-pulse-v1-rc1.abi.json',
  'src/openMint/pulseCandidate.ts','src/openMint/pulseAuthorization.ts','src/openMint/pulseEconomics.ts',
  'src/openMint/generativeProfiles.ts','src/openMint/publicChain.ts','src/openMint/generativeReads.ts','src/openMint/generativeRecoveryChain.ts',
  'src/openMint/persistence/pulse-schema.sql','src/openMint/persistence/pulseEconomics.ts','src/openMint/persistence/reservedTransaction.ts',
  'src/openMint/persistence/requests.ts','src/openMint/persistence/assessmentWorker.ts','src/openMint/persistence/generativeAuthorizations.ts',
  'src/openMint/persistence/walletSubmissions.ts','src/openMint/persistence/runtimeService.ts','src/openMint/persistence/generativeBrowser.ts',
  'src/openMint/persistence/generativeRecovery.ts','src/openMint/persistence/runtimeRole.ts','src/openMint/persistence/roleAudit.ts',
  'src/openMint/persistence/pulseDatabaseCertification.ts','src/openMint/persistence/databaseCatalog.ts',
  'src/openMint/persistence/schema.sql','src/openMint/persistence/requests-schema.sql','src/openMint/persistence/generative-input-schema.sql',
  'src/openMint/persistence/generative-release-profile-schema.sql','src/openMint/persistence/generative-authorization-schema.sql',
  'src/openMint/persistence/wallet-submission-schema.sql','src/openMint/persistence/generative-recovery-schema.sql',
  'src/openMint/projection/projection-schema.sql','src/openMint/projection/projection-v2.sql','src/openMint/projection/projection-v3.sql',
  'src/openMint/persistence/generativeStartup.ts','src/openMint/persistence/generativeSitePages.ts','src/openMint/generativeInputs.ts',
  'src/openMint/projection/pulseDecode.ts','src/openMint/projection/generativeDecode.ts','src/openMint/projection/observer.ts',
  'src/openMint/projection/model.ts','src/openMint/projection/decode.ts','src/openMint/pages.ts','src/openMint/clientScript.ts','src/openMint/persistence/http.ts',
  'contracts/tools/pulse-integration.mjs',
]);
/** Inventory, not a hosted package or permission to deploy. Historical release
 * certificates cannot certify this candidate or these new migration bytes. */
export function pulseIntegrationInventory(root=ROOT) {
  const candidate=verifyPulseCandidate(root);
  const files=PULSE_INTEGRATION_FILES.map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')}));
  const payload={version:'sg-pulse-local-integration-inventory-v1',candidateLockSha256:candidate.lockSha256,publicStartupApproved:false,files};
  return {...payload,digest:jsonDigest(payload)};
}
