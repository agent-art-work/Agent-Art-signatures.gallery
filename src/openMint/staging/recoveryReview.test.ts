import { createHash, generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { createStagingRecoveryReview, type RecoveryApprovalTarget } from "./recoveryReview.js";

const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const target:RecoveryApprovalTarget={action:"retire-expired-unminted",recoveryId:"11111111-1111-4111-8111-111111111111",
  namespaceId:"22222222-2222-4222-8222-222222222222",deploymentId:"33333333-3333-4333-8333-333333333333",
  authorizationId:"44444444-4444-4444-8444-444444444444",authorizationDigest:`0x${"a".repeat(64)}`,
  snapshotHash:"b".repeat(64),operatorReference:"operator:r4",evidenceReference:"evidence:r4",writerEpoch:"1",
  databaseBinding:"c".repeat(64),activePolicyDigest:"d".repeat(64),operatingPlanSha256:"e".repeat(64),releaseLockSha256:"f".repeat(64)};
function fixture(version="sg-staging-recovery-review-v1") {
  const keys=generateKeyPairSync("ed25519");
  const now=Date.now();
  const body={version,target,validFrom:now-1000,validUntil:now+60_000};
  const payload=canonicalize(body)!;
  let current={payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString("hex")};
  const source={publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),
    publicKeySpkiSha256:sha(keys.publicKey.export({type:"spki",format:"der"})),revisionSha256:sha(payload),readCurrent:()=>current};
  return {now,source,setCurrent:(next:typeof current)=>{current=next;},
    replaceBody(next:unknown){const payload=canonicalize(next)!;current={payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString("hex")};source.revisionSha256=sha(payload);}};
}
describe("separate staging recovery approval",()=>{
  it("accepts only a current exact signed retirement target",()=>{
    const f=fixture(),review=createStagingRecoveryReview(f.source,target)!;
    expect(review.require(f.now)).toMatchObject({revisionSha256:f.source.revisionSha256});
    expect(()=>review.require(f.now+60_000)).toThrow();
  });
  it("refuses browser-review domain, copied target, forged signature and withdrawal",()=>{
    const browser=fixture("sg-staging-operation-review-v1");
    expect(()=>createStagingRecoveryReview(browser.source,target)!.require(browser.now)).toThrow();
    const f=fixture();
    expect(()=>createStagingRecoveryReview(f.source,{...target,authorizationId:"55555555-5555-4555-8555-555555555555"})!.require(f.now)).toThrow();
    const review=createStagingRecoveryReview(f.source,target)!;
    f.setCurrent({payload:"{}",signature:"0".repeat(128)});
    expect(()=>review.require(f.now)).toThrow();
    expect(()=>review.require(f.now)).toThrow();
  });
  it("pins the independent revision even if its caller changes the source object",()=>{
    const f=fixture(),review=createStagingRecoveryReview(f.source,target)!;
    const accepted=review.require(f.now)!;
    expect(Object.isFrozen(accepted.target)).toBe(true);
    f.replaceBody({version:"sg-staging-recovery-review-v1",target,validFrom:f.now-1000,validUntil:f.now+120_000});
    expect(()=>review.require(f.now)).toThrow();
  });
  it.each(["epoch","snapshot","action","key","window","extra-field"])("refuses changed %s",scenario=>{
    const f=fixture();let expected=target;
    if(scenario==="epoch")expected={...target,writerEpoch:"2"};
    if(scenario==="snapshot")expected={...target,snapshotHash:"9".repeat(64)};
    if(scenario==="action")expected={...target,action:"force" as never};
    if(scenario==="key")f.source.publicKeySpkiSha256="9".repeat(64);
    if(scenario==="window")f.replaceBody({version:"sg-staging-recovery-review-v1",target,validFrom:f.now-1000,validUntil:f.now+900_000});
    if(scenario==="extra-field")f.replaceBody({version:"sg-staging-recovery-review-v1",target,validFrom:f.now-1000,validUntil:f.now+1000,approved:true});
    expect(()=>createStagingRecoveryReview(f.source,expected)!.require(f.now)).toThrow();
  });
});
