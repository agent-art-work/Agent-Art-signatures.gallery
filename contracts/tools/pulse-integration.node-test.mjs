import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ROOT} from './pulse-candidate-lock.mjs';
import {pulseIntegrationInventory,PULSE_INTEGRATION_FILES,expectedPulseRuntime} from './pulse-integration.mjs';
import {pulseFixturePin} from '../../src/openMint/fixtures/pulse.ts';
test('C6 inventory binds raw integration/migration bytes without authorizing public startup',()=>{
  const inventory=pulseIntegrationInventory();
  assert.equal(inventory.publicStartupApproved,false);
  assert.equal(inventory.candidateLockSha256,'029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8');
  assert.equal(new Set(PULSE_INTEGRATION_FILES).size,PULSE_INTEGRATION_FILES.length);
  for(const f of inventory.files) assert.equal(f.sha256,createHash('sha256').update(readFileSync(`${ROOT}/${f.path}`)).digest('hex'));
  assert.deepEqual(pulseIntegrationInventory(),inventory);
});
test('C6 runtime verifier rejects altered immutable layouts and sale configuration',()=>{
  const artifact=JSON.parse(readFileSync(`${ROOT}/contracts/out/SignaturesPulseMintV1RC1.sol/SignaturesPulseMintV1RC1.json`));
  const contract='0x1111111111111111111111111111111111111111',identity='0x'+'22'.repeat(32);
  const sale=pulseFixturePin(contract,identity,[contract],100).pin;
  const binding={chainId:'31337',contract,renderer:{address:contract,identity},sale};
  assert.equal((expectedPulseRuntime(binding,artifact).length-2)/2,23819);
  assert.throws(()=>expectedPulseRuntime({...binding,sale:{...sale,treasury:'0x2222222222222222222222222222222222222222'}},artifact));
  const crossed=structuredClone(artifact); Object.values(crossed.deployedBytecode.immutableReferences)[0][0].start++;
  assert.throws(()=>expectedPulseRuntime(binding,crossed));
});
