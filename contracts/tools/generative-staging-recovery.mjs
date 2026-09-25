import assert from "node:assert/strict";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { createActiveStateObserver, readActiveStateObservation } from "./generative-active-state.mjs";
import { ROOT } from "./generative-release.mjs";
import { parseOperatingJson } from "../../src/openMint/staging/operatingPlan.ts";
import { StagingRecoveryChain } from "../../src/openMint/stagingRecoveryChain.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";

/** Trusted internal composition, no secret loading, CLI, provider, HTTP or
 * transaction sender. The active-state observer authenticates the configured
 * governance history before narrow exact-block eligibility checks. */
export function createStagingRecoveryChain({ operatingJson, transactions, transitions, historyLimits, sources,
  chainConfig, databaseReview, root = ROOT, now = Date.now }) {
  try {
    const { deploymentPlan:d, operatingPlan:p } = operatingPlan(operatingJson,root),s=p.settings;
    assert.equal(s.schema,"sg-sepolia-operating-settings-v2");
    assert.equal(s.database.schemaProfile,GENERATIVE_DATABASE_V2_LOCK.version);
    assert.equal(databaseReview.version,"sg-generative-runtime-db-review-v2");
    assert.equal(databaseReview.inspectorRole,s.database.roles.inspector.name);
    assert.equal(databaseReview.recoveryRole,s.database.roles.recovery.name);
    assert.equal(databaseReview.runtimeRole,s.database.roles.browser.name);
    assert.equal(databaseReview.ownerRole,s.database.roles.migrator.name);
    assert.equal(databaseReview.deploymentId,s.deploymentId);
    assert.equal(databaseReview.migrationManifestSha256,GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256);
    assert.equal(chainConfig.namespaceId,databaseReview.namespaceId);
    assert.equal(chainConfig.deploymentId,databaseReview.deploymentId);
    assert.equal(chainConfig.chainId,11155111n);
    assert.equal(chainConfig.contractProfile,"generative-v1-rc1");
    assert.equal(chainConfig.genesisHash,d.declaredGenesisHash);
    assert.equal(chainConfig.contract,d.collection.address);
    assert.equal(chainConfig.runtimeCodeHash,p.collectionRuntimeCodeHash);
    assert.equal(chainConfig.authorizer,d.principals.authorizer.address);
    assert.equal(chainConfig.generativeRenderer?.address,d.renderer.address);
    assert.equal(chainConfig.generativeRenderer?.runtimeCodeHash,d.renderer.runtimeCodeHash);
    assert.equal(chainConfig.generativeRenderer?.identity,d.renderer.identity);
    assert.equal(chainConfig.maxBlockAgeMs,s.rpc.maxHeadAgeMs);
    assert.equal(chainConfig.maxFutureSkewMs,s.rpc.maxFutureSkewMs);
    assert.equal(chainConfig.evidenceTtlMs,s.rpc.evidenceTtlMs);
    assert.ok(Number.isSafeInteger(chainConfig.observationTimeoutMs)&&chainConfig.observationTimeoutMs>0&&chainConfig.observationTimeoutMs<=s.rpc.timeoutMs);
    assert.deepEqual(Object.keys(historyLimits).sort(),["logBlockRange","maxHistorySpan","maxLogs","maxTransactions"]);
    assert.equal(sources.length,2);assert.notEqual(sources[0],sources[1]);assert.notEqual(sources[0].request,sources[1].request);
    for(let i=0;i<2;i++){
      assert.equal(sources[i].id,s.rpc.sources[i].id);
      assert.equal(sources[i].operatorReference,s.rpc.sources[i].operatorReference);
    }
    const bounded=sources.map(source=>({id:source.id,operatorReference:source.operatorReference,
      request:async(method,params,signal)=>{
        signal.throwIfAborted();const value=await source.request(method,params,signal);signal.throwIfAborted();
        const bytes=JSON.stringify(value);assert.ok(bytes&&Buffer.byteLength(bytes)<=s.rpc.jsonResponseBytes);return value;
      }}));
    const policy={timeoutMs:s.rpc.timeoutMs,maxHeadAgeMs:s.rpc.maxHeadAgeMs,maxFinalizedAgeMs:s.rpc.maxFinalizedAgeMs,
      maxFutureSkewMs:s.rpc.maxFutureSkewMs,validityMs:s.rpc.evidenceTtlMs,...historyLimits};
    const observer=createActiveStateObserver({config:parseOperatingJson(operatingJson).deployment,transactions,transitions,
      sources:bounded,policy,root,now});
    assert.equal(observer.plan.planSha256,d.planSha256);
    const active={observe:observer.observe.bind(observer),read(witness,time){
      const report=readActiveStateObservation(witness,{policySha256:observer.policySha256,now:time});
      assert.equal(report.planSha256,d.planSha256);assert.equal(report.releaseLockSha256,p.releaseLockSha256);
      assert.equal(report.state.authorizer,s.custody.authorizer.address);
      return report;
    }};
    const rpcs=bounded.map(source=>({id:source.id.replaceAll("/","-"),request:source.request}));
    return new StagingRecoveryChain(chainConfig,rpcs,active,{activePolicyDigest:observer.policySha256,
      planSha256:d.planSha256,releaseLockSha256:p.releaseLockSha256,
      operatingPlanSha256:p.operatingPlanSha256,databaseBinding:admissionDigest({lock:GENERATIVE_DATABASE_V2_LOCK,review:databaseReview}),
      maxFinalizedAgeMs:s.rpc.maxFinalizedAgeMs,maxHeadAgeMs:s.rpc.maxHeadAgeMs});
  }catch{throw Error("Staging recovery chain composition unavailable.");}
}
