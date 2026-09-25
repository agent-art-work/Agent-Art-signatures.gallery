import type { RoleAuditConnection } from "./roleAudit.js";
import { requireStagingInspectorRole } from "./stagingOperatorRole.js";

export type InspectionReference = Readonly<{ kind: "attempt" | "authorization" | "recovery"; id: string }>;
export interface StagingInspectionTarget { readonly namespaceId: string; readonly deploymentId: string }
export class StagingInspectionError extends Error {
  constructor() { super("Staging inspection unavailable or incomplete."); this.name = "StagingInspectionError"; }
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const fail = (): never => { throw new StagingInspectionError(); };
const one = (rows: Record<string, unknown>[]) => rows.length === 1 ? rows[0] : fail();
const date = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : fail();
const str = (value: unknown) => typeof value === "string" && value.length < 256 ? value : fail();
const opt = (value: unknown) => value === null ? null : str(value);
const exact = (value: unknown) => typeof value === "string" && /^\d{1,40}$/.test(value) ? value : fail();
const enumerated = (value: unknown, allowed: readonly string[]) => typeof value === "string" && allowed.includes(value) ? value : fail();
const dispatchNumber = (value: unknown): number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : fail();

/** Dedicated read-only client, no writer, signer, chain, provider or ambient DB
 * discovery. The caller owns and closes the connection on timeout/cancellation;
 * do not put a cancelled connection back into a pool until it is drained. */
export async function inspectStagingOperation(connection: RoleAuditConnection, target: StagingInspectionTarget,
  reference: InspectionReference, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
  if (!uuid(target.namespaceId) || !uuid(target.deploymentId) || !uuid(reference.id)
    || !["attempt", "authorization", "recovery"].includes(reference.kind) || signal.aborted) fail();
  let started = false;
  const live = () => { if (signal.aborted) fail(); };
  const query = async (sql: string, args: unknown[] = []) => { live(); const result = await connection.query(sql, args); live(); return result.rows; };
  try {
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); started = true;
    await connection.query("SET LOCAL statement_timeout = '5s'");
    await connection.query("SET LOCAL search_path = pg_catalog");
    await requireStagingInspectorRole(connection);
    const namespace = one(await query("SELECT profile,provenance FROM open_mint.namespaces WHERE namespace_id=$1", [target.namespaceId]));
    if (namespace.profile !== "staging-testnet" || namespace.provenance !== "grok") fail();
    const deployment = one(await query(`SELECT chain_id::text AS chain_id FROM open_mint.request_profiles
      WHERE namespace_id=$1 AND deployment_id=$2`, [target.namespaceId,target.deploymentId]));
    if (deployment.chain_id !== "11155111") fail();
    let attemptId: string;
    if (reference.kind === "attempt") attemptId = reference.id;
    else {
      const authId = reference.kind === "authorization" ? reference.id :
        one(await query(`SELECT authorization_id FROM open_mint.staging_generative_recoveries
          WHERE namespace_id=$1 AND deployment_id=$2 AND recovery_id=$3`, [target.namespaceId, target.deploymentId, reference.id])).authorization_id;
      if (!uuid(authId)) fail();
      const linked = one(await query(`SELECT COALESCE(r.attempt_id,a.attempt_id) AS attempt_id
        FROM open_mint.generative_authorizations g
        JOIN open_mint.requests r ON r.namespace_id=g.namespace_id AND r.request_id=g.request_id
        LEFT JOIN open_mint.assessments a ON a.namespace_id=r.namespace_id AND a.assessment_id=r.assessment_id
        WHERE g.namespace_id=$1 AND g.deployment_id=$2 AND g.authorization_id=$3`, [target.namespaceId,target.deploymentId,authId]));
      if (!uuid(linked.attempt_id)) fail();
      attemptId = linked.attempt_id as string;
    }
    const attempt = one(await query(`SELECT attempt_id,handle,admitted_at,state FROM open_mint.assessment_attempts
      WHERE namespace_id=$1 AND attempt_id=$2`, [target.namespaceId,attemptId]));
    const handle = str(attempt.handle);
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) fail();
    const jobs = await query(`SELECT kind,state FROM open_mint.jobs WHERE namespace_id=$1 AND attempt_id=$2 ORDER BY kind LIMIT 3`, [target.namespaceId,attemptId]);
    if (jobs.length > 2) fail();
    const legs = await query(`SELECT d.leg,d.dispatched_at,p.cost_status,p.cost_usd_ticks::text AS cost
      FROM open_mint.dispatch_fences d LEFT JOIN open_mint.provider_receipts p USING(namespace_id,attempt_id,leg)
      WHERE d.namespace_id=$1 AND d.attempt_id=$2 ORDER BY d.leg LIMIT 3`, [target.namespaceId,attemptId]);
    if (legs.length > 2) fail();
    const terminals = await query(`SELECT kind,reason,phase,recorded_at FROM open_mint.assessment_terminals
      WHERE namespace_id=$1 AND attempt_id=$2 LIMIT 2`, [target.namespaceId,attemptId]);
    if (terminals.length > 1) fail();
    const assessments = await query(`SELECT assessment_id,digest FROM open_mint.assessments
      WHERE namespace_id=$1 AND attempt_id=$2 LIMIT 2`, [target.namespaceId,attemptId]);
    if (assessments.length > 1) fail();
    const exposure = await query(`SELECT reserved_usd_ticks::text AS amount FROM open_mint.budget_reservations
      WHERE namespace_id=$1 AND attempt_id=$2 LIMIT 2`, [target.namespaceId,attemptId]);
    if (exposure.length > 1) fail();
    const requests = await query(`SELECT request_id,assessment_id FROM open_mint.requests
      WHERE namespace_id=$1 AND deployment_id=$2 AND handle=$3 AND
      (attempt_id=$4 OR assessment_id=$5) ORDER BY request_id LIMIT 33`,
      [target.namespaceId,target.deploymentId,handle,attemptId,assessments[0]?.assessment_id ?? null]);
    if (requests.length > 32) fail();
    const requestIds = requests.map(r => { if (!uuid(r.request_id)) fail(); return r.request_id; });
    const authorizations = requestIds.length ? await query(`SELECT g.authorization_id,g.request_id,g.assessment_id,g.recipient,g.authorization_digest,g.deadline::text,g.state,
      h.authorization_id IS NOT NULL AS active,p.wallet_nonce::text,p.nonce_active
      FROM open_mint.generative_authorizations g
      LEFT JOIN open_mint.generative_authorization_heads h ON h.namespace_id=g.namespace_id AND h.deployment_id=g.deployment_id AND h.authorization_id=g.authorization_id
      LEFT JOIN open_mint.wallet_mint_plans p ON p.namespace_id=g.namespace_id AND p.authorization_id=g.authorization_id
      WHERE g.namespace_id=$1 AND g.deployment_id=$2 AND g.request_id=ANY($3::uuid[])
      ORDER BY g.authorization_id LIMIT 33`,[target.namespaceId,target.deploymentId,requestIds]) : [];
    if (authorizations.length > 32) fail();
    const authorizationsById = authorizations.map(a => {
      if (!uuid(a.authorization_id) || !uuid(a.request_id) || !uuid(a.assessment_id)
        || !["reserved","signing","unknown","signed"].includes(a.state as string)
        || typeof a.active !== "boolean" || (a.nonce_active !== null && typeof a.nonce_active !== "boolean")) fail();
      return Object.freeze({ id: a.authorization_id, requestId: a.request_id, assessmentId: a.assessment_id,
        recipient: str(a.recipient), digest: str(a.authorization_digest), deadline: exact(a.deadline), state: a.state,
        active: a.active, walletNonce: a.wallet_nonce === null ? null : exact(a.wallet_nonce), nonceActive: a.nonce_active });
    });
    if (reference.kind === "authorization" && !authorizationsById.some(a => a.id === reference.id)) fail();
    const dispatches = requestIds.length ? await query(`SELECT d.request_id,d.attempt,d.dispatched_at,r.outcome,r.transaction_hash,r.recorded_at
      FROM open_mint.wallet_mint_dispatches d LEFT JOIN open_mint.wallet_mint_reports r USING(namespace_id,request_id,attempt)
      WHERE d.namespace_id=$1 AND d.request_id=ANY($2::uuid[]) ORDER BY d.request_id,d.attempt LIMIT 161`,
      [target.namespaceId,requestIds]) : [];
    if (dispatches.length > 160) fail();
    const recoveryRows = authorizations.length ? await query(`SELECT recovery_id,authorization_id,recorded_at
      FROM open_mint.staging_generative_recoveries WHERE namespace_id=$1 AND deployment_id=$2
      AND authorization_id=ANY($3::uuid[]) ORDER BY recovery_id LIMIT 33`,
      [target.namespaceId,target.deploymentId,authorizations.map(a => a.authorization_id)]) : [];
    if (recoveryRows.length > 32 || (reference.kind === "recovery" && !recoveryRows.some(r => r.recovery_id === reference.id))) fail();
    if(recoveryRows.some(r=>!authorizationsById.some(a=>a.id===r.authorization_id&&!a.active&&a.nonceActive!==true)))fail();
    const input = await query(`SELECT digest FROM open_mint.generative_inputs WHERE namespace_id=$1 AND deployment_id=$2 AND handle=$3 LIMIT 2`,
      [target.namespaceId,target.deploymentId,handle]);
    if (input.length > 1) fail();
    const projection = await query(`SELECT health,halt_reason FROM open_mint.projection_checkpoints WHERE deployment_id=$1 LIMIT 2`, [target.deploymentId]);
    if (projection.length > 1) fail();
    const observed = one(await query("SELECT clock_timestamp() AS observed_at"));
    const report = Object.freeze({ version: "sg-staging-inspection-v1", reference: Object.freeze({ kind: reference.kind, id: reference.id }),
      namespaceId: target.namespaceId, deploymentId: target.deploymentId, observedAt: date(observed.observed_at),
      chainVerification: "not-performed", handle,
      attempt: Object.freeze({ id: attemptId, state: enumerated(attempt.state,["pending","accepted","closed"]), admittedAt: date(attempt.admitted_at),
        jobs: jobs.map(j => ({ kind: enumerated(j.kind,["assessment","render"]), state: enumerated(j.state,["queued","running","complete"]) })),
        terminal: terminals[0] ? { kind: enumerated(terminals[0].kind,["abstained","invalid","uncertain","blocked-before-dispatch"]),
          reason: terminals[0].reason===null?null:enumerated(terminals[0].reason,["insufficient-evidence","subject-unavailable","provider-refusal"]),
          phase: enumerated(terminals[0].phase,["before-dispatch","x-identity","grok"]), recordedAt: date(terminals[0].recorded_at) } : null,
        exposure: exposure[0] ? exact(exposure[0].amount) : null,
        legs: legs.map(l => ({ leg: enumerated(l.leg,["x-identity","grok"]), dispatchedAt: date(l.dispatched_at), receipt: l.cost_status === null ? "missing" : "present",
          costStatus: l.cost_status===null?null:enumerated(l.cost_status,["actual","estimated","unknown"]),
          costUsdTicks: l.cost === null ? null : exact(l.cost) })) }),
      assessment: assessments[0] ? { id: str(assessments[0].assessment_id), digest: str(assessments[0].digest) } : null,
      inputCommitment: input[0] ? str(input[0].digest) : null,
      authorizations: authorizationsById,
      dispatches: dispatches.map(d => ({ requestId: str(d.request_id), attempt: dispatchNumber(d.attempt),
        dispatchedAt: date(d.dispatched_at), outcome: d.outcome===null?null:enumerated(d.outcome,["submitted","rejected"]),
        transactionHash: opt(d.transaction_hash), reportRecordedAt: d.recorded_at === null ? null : date(d.recorded_at) })),
      recoveries: recoveryRows.map(r => ({ id: str(r.recovery_id), authorizationId: str(r.authorization_id), recordedAt: date(r.recorded_at) })),
      savedProjection: projection[0] ? { health: enumerated(projection[0].health,["unknown","available","safety-halted"]),
        haltReason: projection[0].halt_reason===null?null:"saved-projection-halt" } : null,
      nextAction: projection[0]?.health==="safety-halted" ? "operator-reconciliation-required"
        : reference.kind==="recovery" ? "already-retired" : authorizationsById.some(a => a.active) ? "review-expiry" : recoveryRows.length ? "already-retired"
        : terminals.length || legs.some(l => l.cost_status === null || l.cost_status === "unknown") ? "operator-reconciliation-required" : "wait-for-observation",
    });
    if (Buffer.byteLength(JSON.stringify(report)) > 65536) fail();
    await connection.query("COMMIT"); started = false;live();
    return report;
  } catch { throw new StagingInspectionError(); }
  finally { if (started) { try { await connection.query("ROLLBACK"); } catch { /* caller must close an uncertain connection */ } } }
}

/** Lost-COMMIT reconciliation uses only the inspector credential. Absence is
 * not evidence that an earlier transaction has rolled back. */
export async function inspectStagingRetirementOutcome(connection: RoleAuditConnection,target:StagingInspectionTarget,
  recoveryId:string,signal:AbortSignal):Promise<Readonly<{status:"retired"|"not-recorded"|"unknown";recoveryId:string}>> {
  if(!uuid(target.namespaceId)||!uuid(target.deploymentId)||!uuid(recoveryId)||signal.aborted)fail();
  let started=false;
  try {
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");started=true;
    await connection.query("SET LOCAL statement_timeout = '5s'");
    await connection.query("SET LOCAL search_path = pg_catalog");
    await requireStagingInspectorRole(connection);if(signal.aborted)fail();
    const targetRows=(await connection.query(`SELECT n.profile,n.provenance,r.chain_id::text FROM open_mint.namespaces n
      JOIN open_mint.request_profiles r USING(namespace_id) WHERE n.namespace_id=$1 AND r.deployment_id=$2`,
      [target.namespaceId,target.deploymentId])).rows;
    if(targetRows.length!==1||targetRows[0].profile!=="staging-testnet"||targetRows[0].provenance!=="grok"||targetRows[0].chain_id!=="11155111"||signal.aborted)fail();
    const rows=(await connection.query(`SELECT e.authorization_id,e.request_id,
      EXISTS(SELECT 1 FROM open_mint.generative_authorizations a WHERE a.namespace_id=e.namespace_id
        AND a.deployment_id=e.deployment_id AND a.authorization_id=e.authorization_id
        AND a.request_id=e.request_id AND a.authorization_digest=e.authorization_digest) AS valid_authorization,
      EXISTS(SELECT 1 FROM open_mint.generative_authorization_heads h
        WHERE h.namespace_id=e.namespace_id AND h.deployment_id=e.deployment_id AND h.authorization_id=e.authorization_id) AS active_head,
      (SELECT count(*)::int FROM open_mint.wallet_mint_plans p
        WHERE p.namespace_id=e.namespace_id AND p.authorization_id=e.authorization_id AND p.request_id=e.request_id AND p.nonce_active) AS active_lease,
      (SELECT count(*)::int FROM open_mint.wallet_mint_plans p
        WHERE p.namespace_id=e.namespace_id AND p.authorization_id=e.authorization_id AND p.request_id<>e.request_id) AS alien_lease
      FROM open_mint.staging_generative_recoveries e
      WHERE e.namespace_id=$1 AND e.deployment_id=$2 AND e.recovery_id=$3`,[target.namespaceId,target.deploymentId,recoveryId])).rows;
    if(signal.aborted||rows.length>1)fail();
    const row=rows[0];
    const status=row===undefined?"not-recorded":row.valid_authorization===true&&row.active_head===false&&row.active_lease===0&&row.alien_lease===0?"retired":"unknown";
    await connection.query("COMMIT");started=false;if(signal.aborted)fail();
    return Object.freeze({status,recoveryId});
  }catch{throw new StagingInspectionError();}
  finally{if(started){try{await connection.query("ROLLBACK");}catch{/* caller closes uncertain connection */}}}
}
