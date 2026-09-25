import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { encodeFunctionData, getAddress, hashTypedData, type Hex } from "viem";
import { validateAssessment } from "../assessment.js";
import { openMintHandleKey } from "../authorization.js";
import { GENERATIVE_MINT_ABI, stagingGenerativeMintTypedData, normalizeGenerativeAuthorization } from "../generativeAuthorization.js";
import { generativeInputDigest, verifyGenerativeInputs } from "../generativeInputs.js";
import { verifyReservedSignature, type AuthorizationReservation } from "./generativeAuthorizations.js";
import { readStagingRecoveryEvidence, StagingRecoveryChain, type StagingRecoveryEvidence } from "../stagingRecoveryChain.js";
import { createStagingRecoveryReview, type RecoveryApprovalTarget, type RecoveryReviewSource } from "../staging/recoveryReview.js";
import { requireStagingRecoveryRole, type RoleAuditConnection } from "./roleAudit.js";
import { verifyGenerativeV2Database, type DatabaseV2Review } from "./databaseCertification.js";
import { ExclusiveWriter, type OwnershipConnection } from "./writer.js";

type Tx = Pick<OwnershipConnection,"query">;
export class StagingRecoveryBlockedError extends Error {
  constructor() { super("Staging retirement blocked; keep issuance disabled and inspect the exact recovery ID."); this.name="StagingRecoveryBlockedError"; }
}
const fail = (): never => { throw new StagingRecoveryBlockedError(); };
const json = (v:unknown) => Buffer.from(canonicalize(v)!);
const sha = (v:unknown) => createHash("sha256").update(json(v)).digest("hex");
const uuid = (v:unknown):v is string => typeof v==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const decode = (raw:Buffer,requireCanonical=true) => {
  if (!Buffer.isBuffer(raw) || raw.length<2 || raw.length>131072) fail();
  const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));
  if (requireCanonical && !json(value).equals(raw)) fail(); return value;
};
export interface StagingRecoveryPlan {
  readonly action:"retire-expired-unminted";readonly recoveryId:string;readonly authorizationId:string;
  readonly handle:string;readonly deadline:string;readonly snapshotHash:string;
  readonly submission:"not-started"|"unknown"|"rejected"|"submitted";
  readonly transactionHash:string|null;readonly walletNonce:string|null;
  readonly approvalTarget:RecoveryApprovalTarget;
}
interface Snapshot { readonly reservation:AuthorizationReservation;readonly fingerprint:string;
  readonly walletNonce:string|null;readonly submission:StagingRecoveryPlan["submission"];readonly transactionHash:string|null;
  readonly requestId:string;readonly planCount:number }

/** Operator-only, not an HTTP route. Certifies the browser catalog before
 * acquiring a fresh, restricted recovery writer, then rechecks the policy. */
export class PostgresStagingGenerativeRecovery {
  readonly #plans=new WeakMap<StagingRecoveryPlan,Snapshot>();
  readonly #busy=new WeakSet<StagingRecoveryPlan>();
  private constructor(readonly writer:ExclusiveWriter,readonly browserCatalog:RoleAuditConnection,
    readonly databaseReview:DatabaseV2Review,readonly chain:StagingRecoveryChain,
    readonly reviewSource:RecoveryReviewSource,readonly operatingPlanSha256:string,readonly releaseLockSha256:string) {}
  static async open(config:{acquireWriter:()=>Promise<ExclusiveWriter>;browserCatalog:RoleAuditConnection;databaseReview:DatabaseV2Review;
    chain:StagingRecoveryChain;reviewSource:RecoveryReviewSource;operatingPlanSha256:string;releaseLockSha256:string}) {
    let writer:ExclusiveWriter|undefined;
    try {
      const databaseReview=Object.freeze({...config.databaseReview});
      if(databaseReview.version!=="sg-generative-runtime-db-review-v2"
        || !/^[0-9a-f]{64}$/.test(config.operatingPlanSha256) || !/^[0-9a-f]{64}$/.test(config.releaseLockSha256))fail();
      const result=await verifyGenerativeV2Database(config.browserCatalog,databaseReview);
      if(result.generationEnabled || result.issuanceEnabled)fail();
      if(config.chain.config.namespaceId!==databaseReview.namespaceId || config.chain.config.deploymentId!==databaseReview.deploymentId
        || config.chain.databaseBinding!==result.databaseBindingSha256
        || config.chain.operatingPlanSha256!==config.operatingPlanSha256 || config.chain.releaseLockSha256!==config.releaseLockSha256)fail();
      writer=await config.acquireWriter();
      const instance=new PostgresStagingGenerativeRecovery(writer,config.browserCatalog,databaseReview,
        config.chain,config.reviewSource,config.operatingPlanSha256,config.releaseLockSha256);
      await writer.transaction(async tx=>{
        const identity=(await tx.query("SELECT current_database() AS database,current_user AS role")).rows[0];
        if(identity?.database!==instance.databaseReview.database||identity.role!==instance.databaseReview.recoveryRole)fail();
        await requireStagingRecoveryRole(tx);await instance.#disabled(tx);
      });
      return instance;
    } catch { await writer?.close().catch(()=>{}); fail(); }
  }
  get namespaceId(){return this.databaseReview.namespaceId;}
  get deploymentId(){return this.databaseReview.deploymentId;}
  async #disabled(tx:Tx) {
    const rows=(await tx.query<{generation_enabled:boolean;issuance_enabled:boolean}>(`SELECT b.generation_enabled,i.enabled AS issuance_enabled
      FROM open_mint.budget_policies b JOIN open_mint.generative_issuance_profiles i USING(namespace_id)
      JOIN open_mint.namespaces n USING(namespace_id)
      JOIN open_mint.request_profiles r USING(namespace_id,deployment_id)
      WHERE b.namespace_id=$1 AND i.deployment_id=$2 AND n.profile='staging-testnet' AND n.provenance='grok'
      AND r.chain_id=11155111 FOR SHARE OF b,i`,[this.namespaceId,this.deploymentId])).rows;
    if(rows.length!==1||rows[0].generation_enabled||rows[0].issuance_enabled)fail();
  }
  async #snapshot(tx:Tx,id:string):Promise<Snapshot> {
    await this.#disabled(tx);
    const rows=(await tx.query<any>(`SELECT g.*,g.session_generation::text AS generation_text,g.issued_at::text AS issued_text,
      g.deadline::text AS deadline_text,p.contract_address,p.authorizer,p.chain_id::text AS chain_text,
      i.profile AS input_profile,i.renderer_identity
      FROM open_mint.generative_authorizations g
      JOIN open_mint.generative_authorization_heads h USING(namespace_id,deployment_id,handle,authorization_id)
      JOIN open_mint.request_profiles p USING(namespace_id,deployment_id)
      JOIN open_mint.generative_input_profiles i USING(namespace_id,deployment_id)
      WHERE g.namespace_id=$1 AND g.deployment_id=$2 AND g.authorization_id=$3`,[this.namespaceId,this.deploymentId,id])).rows;
    if(rows.length!==1)fail();const row=rows[0],r=decode(row.payload) as AuthorizationReservation;
    const fields=["version","id","namespaceId","deploymentId","requestId","sessionHash","generation","handle","assessmentId","renderHandle","mbti","rendererIdentity","authorizer","domain","authorization","digest","typedData"];
    if(Object.keys(r).sort().join()!==fields.sort().join() || r.version!=="sg-generative-authorization-v1-rc1"
      || r.id!==id||r.namespaceId!==this.namespaceId||r.deploymentId!==this.deploymentId||r.requestId!==row.request_id
      || r.sessionHash!==row.session_hash||r.generation!==row.generation_text||r.handle!==row.handle||r.assessmentId!==row.assessment_id
      || r.domain.chainId!=="11155111"||r.domain.chainId!==row.chain_text
      || getAddress(r.domain.verifyingContract)!==getAddress(row.contract_address)||getAddress(r.authorizer)!==getAddress(row.authorizer)
      || r.rendererIdentity!==row.renderer_identity||row.input_profile!=="sg-generative-inputs-v1-rc1")fail();
    const a=normalizeGenerativeAuthorization(r.authorization);
    const typed=stagingGenerativeMintTypedData(r.domain,r.authorization,row.input_profile);
    if(a.handleKey!==openMintHandleKey(r.handle)||a.inputDigest!==row.input_digest||a.nonce!==row.nonce
      || a.recipient!==getAddress(row.recipient)||a.issuedAt.toString()!==row.issued_text||a.deadline.toString()!==row.deadline_text
      || r.digest!==row.authorization_digest||r.digest!==hashTypedData(typed)
      || !json(r.typedData).equals(json(JSON.parse(JSON.stringify(typed,(_k,v)=>typeof v==="bigint"?v.toString():v))))
      || a.inputDigest!==generativeInputDigest(r.renderHandle,r.mbti as never,r.rendererIdentity,row.input_profile))fail();
    const inputRows=(await tx.query<any>(`SELECT payload,digest FROM open_mint.generative_inputs
      WHERE namespace_id=$1 AND deployment_id=$2 AND handle=$3`,[this.namespaceId,this.deploymentId,r.handle])).rows;
    const assessmentRows=(await tx.query<any>(`SELECT s.payload,s.digest,s.assessment_id,a.state
      FROM open_mint.assessments s JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)
      WHERE s.namespace_id=$1 AND s.assessment_id=$2`,[this.namespaceId,r.assessmentId])).rows;
    if(inputRows.length!==1||assessmentRows.length!==1||assessmentRows[0].state!=="accepted")fail();
    const assessment=validateAssessment(decode(assessmentRows[0].payload,false));
    const input=decode(inputRows[0].payload,false),{assessment: embedded,...artifact}=input;
    verifyGenerativeInputs(artifact,assessment,r.rendererIdentity,row.input_profile);
    if(!json(embedded).equals(json(assessment))||r.assessmentId!==assessment.id||r.authorization.assessmentDigest!==assessment.digest
      || assessmentRows[0].digest!==assessment.digest||inputRows[0].digest!==artifact.digest
      || r.authorization.inputDigest!==artifact.digest||r.renderHandle!==artifact.renderHandle||r.mbti!==artifact.mbti)fail();
    const signatures=(await tx.query<{signature:string}>(`SELECT signature FROM open_mint.generative_authorization_signatures
      WHERE namespace_id=$1 AND authorization_id=$2`,[this.namespaceId,id])).rows;
    if(signatures.length>1||!!signatures.length!==(row.state==="signed")) {
      // A signature can durably exist while state remains signing/unknown.
      if(signatures.length>1||(row.state==="signed"&&!signatures.length))fail();
    }
    if(signatures[0]&&!await verifyReservedSignature(r,signatures[0].signature))fail();
    const plans=(await tx.query<any>(`SELECT request_id,authorization_id,recipient,wallet_nonce::text,payload,nonce_active
      FROM open_mint.wallet_mint_plans WHERE namespace_id=$1 AND (authorization_id=$2 OR request_id=$3)
      ORDER BY request_id LIMIT 2`,[this.namespaceId,id,r.requestId])).rows;
    if(plans.length>1||plans.some(p=>p.authorization_id!==id||p.request_id!==r.requestId||!p.nonce_active||getAddress(p.recipient)!==a.recipient))fail();
    if(plans[0]) {
      if(!signatures[0] || !/^(?:0|[1-9]\d{0,15})$/.test(plans[0].wallet_nonce)
        || BigInt(plans[0].wallet_nonce)>BigInt(Number.MAX_SAFE_INTEGER))fail();
      const expected={expiresAt:new Date(Number(a.deadline)*1000).toISOString(),transaction:{from:a.recipient,
        to:getAddress(r.domain.verifyingContract),chainId:"0xaa36a7",value:"0x0",nonce:`0x${BigInt(plans[0].wallet_nonce).toString(16)}`,
        data:encodeFunctionData({abi:GENERATIVE_MINT_ABI,functionName:"mint",args:[r.renderHandle,r.mbti,a,signatures[0].signature as Hex]})}};
      if(!json(expected).equals(plans[0].payload))fail();
    }
    const dispatches=(await tx.query<any>(`SELECT d.attempt,d.permit_hash,d.owner_epoch::text,r.outcome,r.transaction_hash
      FROM open_mint.wallet_mint_dispatches d LEFT JOIN open_mint.wallet_mint_reports r USING(namespace_id,request_id,attempt)
      WHERE d.namespace_id=$1 AND d.request_id=$2 ORDER BY d.attempt LIMIT 6`,[this.namespaceId,r.requestId])).rows;
    if(dispatches.length>5||(dispatches.length&&!plans.length))fail();
    const projection=(await tx.query<{health:string;halt_reason:string|null}>(`SELECT health,halt_reason FROM open_mint.projection_checkpoints
      WHERE deployment_id=$1`,[this.deploymentId])).rows;
    if(projection.length!==1||projection[0].health!=="available"||projection[0].halt_reason!==null)fail();
    const last=dispatches.at(-1);
    return {reservation:r,fingerprint:sha({authorization:row.payload.toString("hex"),state:row.state,signingEpoch:row.signing_epoch,
      input:inputRows[0].payload.toString("hex"),assessment:assessmentRows[0].payload.toString("hex"),
      plans:plans.map(p=>({...p,payload:p.payload.toString("hex")})),signatures,dispatches,projection}),
      walletNonce:plans[0]?.wallet_nonce??null,submission:last?.outcome??(last?"unknown":"not-started"),
      transactionHash:last?.transaction_hash??null,requestId:r.requestId,planCount:plans.length};
  }
  async plan(authorizationId:string,reasonCode:string,operatorReference:string,evidenceReference:string,
    signal=new AbortController().signal):Promise<StagingRecoveryPlan> {
    try {
      if(!uuid(authorizationId)||!/^expired-unminted$/.test(reasonCode)
        || ![operatorReference,evidenceReference].every(v=>/^[a-z][a-z0-9:/._-]{2,127}$/.test(v)))fail();
      const before=await this.writer.transaction(tx=>this.#snapshot(tx,authorizationId));
      await this.chain.observe(before.reservation,signal);
      const current=await this.writer.transaction(tx=>this.#snapshot(tx,authorizationId));
      if(current.fingerprint!==before.fingerprint)fail();
      const certified=await verifyGenerativeV2Database(this.browserCatalog,this.databaseReview,signal);
      if(certified.generationEnabled||certified.issuanceEnabled)fail();
      const recoveryId=randomUUID();
      const approvalTarget:RecoveryApprovalTarget=Object.freeze({action:"retire-expired-unminted",recoveryId,
        namespaceId:this.namespaceId,deploymentId:this.deploymentId,authorizationId,authorizationDigest:current.reservation.digest,
        snapshotHash:current.fingerprint,operatorReference,evidenceReference,writerEpoch:this.writer.epoch,
        databaseBinding:certified.databaseBindingSha256,activePolicyDigest:this.chain.policyDigest,
        operatingPlanSha256:this.operatingPlanSha256,releaseLockSha256:this.releaseLockSha256});
      const plan:StagingRecoveryPlan=Object.freeze({action:"retire-expired-unminted",recoveryId,authorizationId,
        handle:current.reservation.handle,deadline:current.reservation.authorization.deadline,snapshotHash:current.fingerprint,
        submission:current.submission,transactionHash:current.transactionHash,walletNonce:current.walletNonce,approvalTarget});
      this.#plans.set(plan,current);return plan;
    }catch{throw new StagingRecoveryBlockedError();}
  }
  async apply(plan:StagingRecoveryPlan,signal=new AbortController().signal):Promise<StagingRecoveryPlan> {
    const saved=plan&&typeof plan==="object"?this.#plans.get(plan):undefined;
    if(!saved||this.#busy.has(plan)||plan.approvalTarget.writerEpoch!==this.writer.epoch)throw new StagingRecoveryBlockedError();
    this.#busy.add(plan);
    try {
      const review=createStagingRecoveryReview(this.reviewSource,plan.approvalTarget)!;
      review.require(Date.now());signal.throwIfAborted();
      const db=await verifyGenerativeV2Database(this.browserCatalog,this.databaseReview,signal);
      if(db.generationEnabled||db.issuanceEnabled||db.databaseBindingSha256!==plan.approvalTarget.databaseBinding)fail();
      const witness=await this.chain.observe(saved.reservation,signal);
      review.require(Date.now());
      await this.writer.transaction(async tx=>{
        await requireStagingRecoveryRole(tx);
        await this.#disabled(tx);
        const current=await this.#snapshot(tx,plan.authorizationId);
        if(current.fingerprint!==saved.fingerprint||current.fingerprint!==plan.snapshotHash)fail();
        const now=(await tx.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
        const e:StagingRecoveryEvidence=readStagingRecoveryEvidence(witness,current.reservation,now);
        if(e.activePolicyDigest!==plan.approvalTarget.activePolicyDigest
          || now-Number(e.finalized.timestamp)*1000>=e.maxFinalizedAgeMs
          || now-Number(e.latest.timestamp)*1000>=e.maxHeadAgeMs)fail();
        const approved=review.require(Math.max(now,Date.now()))!;signal.throwIfAborted();
        const evidence=json({version:e.version,plan,finalized:e.finalized,latest:e.latest,sources:e.sources,
          activeObservationDigest:e.activeObservationDigest,observedAt:e.observedAt,validUntil:e.validUntil,approvalValidUntil:approved.validUntil});
        if(evidence.length>16384)fail();
        await tx.query(`INSERT INTO open_mint.staging_generative_recoveries(namespace_id,recovery_id,deployment_id,authorization_id,request_id,
          authorization_digest,snapshot_hash,approval_revision,target_digest,database_binding,active_policy_digest,operator_reference,
          evidence_reference,finalized_number,finalized_hash,finalized_timestamp,latest_number,latest_hash,latest_timestamp,
          source_ids,observed_at,valid_until,evidence,owner_epoch)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
          [this.namespaceId,plan.recoveryId,this.deploymentId,plan.authorizationId,current.requestId,
            current.reservation.digest,plan.snapshotHash,approved.revisionSha256,sha(plan.approvalTarget),
            db.databaseBindingSha256,e.activePolicyDigest,plan.approvalTarget.operatorReference,plan.approvalTarget.evidenceReference,
            e.finalized.number,e.finalized.hash,e.finalized.timestamp,e.latest.number,e.latest.hash,e.latest.timestamp,
            e.sources,new Date(e.observedAt),new Date(Math.min(e.validUntil,approved.validUntil)),evidence,this.writer.epoch]);
        const lease=await tx.query(`UPDATE open_mint.wallet_mint_plans SET nonce_active=false
          WHERE namespace_id=$1 AND request_id=$2 AND authorization_id=$3 AND nonce_active RETURNING request_id`,
          [this.namespaceId,current.requestId,plan.authorizationId]);
        if(lease.rows.length!==current.planCount)fail();
        const head=await tx.query(`DELETE FROM open_mint.generative_authorization_heads
          WHERE namespace_id=$1 AND deployment_id=$2 AND authorization_id=$3 RETURNING handle`,
          [this.namespaceId,this.deploymentId,plan.authorizationId]);
        if(head.rows.length!==1||head.rows[0].handle!==plan.handle)fail();
        await this.#disabled(tx);
        const completed=(await tx.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
        readStagingRecoveryEvidence(witness,current.reservation,Math.max(completed,Date.now()));
        review.require(Math.max(completed,Date.now()));signal.throwIfAborted();
      });
      this.#plans.delete(plan);return plan;
    }catch{throw new StagingRecoveryBlockedError();}finally{this.#busy.delete(plan);}
  }
  async close(){await this.writer.close();}
}
