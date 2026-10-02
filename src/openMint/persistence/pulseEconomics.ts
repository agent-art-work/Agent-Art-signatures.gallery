import canonicalize from "canonicalize";
import { getAddress, type Hex } from "viem";
import { exactObject } from "../assessment.js";
import { PULSE_PAID_SLOT, pulseUint } from "../pulseAuthorization.js";
import { validatePulseDeployment, verifyPulseProof, type PulseDeploymentPin } from "../pulseEconomics.js";
import type { PublicChainEvidence } from "../publicChain.js";
import { PublicError } from "../security.js";
import { PersistenceConflictError, type ExclusiveWriter, type OwnershipConnection } from "./writer.js";
import { inspectPulseLocalSchema, PULSE_LOCAL_SCHEMA_SHA256 } from "./pulseDatabaseCertification.js";

type Tx = Pick<OwnershipConnection, "query">;
const json = (v: unknown) => Buffer.from(canonicalize(v)!);
const fail = (code: string, message: string): never => { throw new PublicError(409, code, message); };
export interface PulseConsent { mode: "free" | "paid"; maxPriceWei: string; slotId?: string }
export interface PulseSlot { slotId: string; wallet: string; proof: readonly Hex[] }
export interface PulsePipelineBinding { version: "sg-pulse-pipeline-v1"; candidateLockSha256: string; deployment: PulseDeploymentPin; slots: readonly PulseSlot[] }
export interface SavedPulseIntent {
  version: "sg-pulse-intent-v1"; requestId: string; wallet: string; generation: string; sessionHash: string; handle: string;
  mintMode: 0 | 1; slotId: string; maxPrice: string; saleConfigHash: Hex; proof: readonly Hex[];
  quote: { block: string; hash: Hex; timestamp: string; price: string };
}

/** Pulse economics shares the existing writer/request/provider/signing fences.
 * This object must be supplied at request composition; legacy openers refuse
 * deployments with a Pulse profile. No runtime migration or chain mutation. */
export class PostgresPulseEconomics {
  private constructor(readonly writer: ExclusiveWriter, readonly namespaceId: string, readonly deploymentId: string,
    readonly binding: Readonly<PulsePipelineBinding>) {}
  static async open(writer: ExclusiveWriter, namespaceId: string, deploymentId: string) {
    const binding = await writer.transaction(async tx => {
      const owner = (await tx.query<{owner:string}>("SELECT nspowner::regrole::text AS owner FROM pg_catalog.pg_namespace WHERE nspname='open_mint'")).rows[0]?.owner;
      if (!owner || (await inspectPulseLocalSchema(tx,owner,namespaceId,deploymentId)).schemaSha256 !== PULSE_LOCAL_SCHEMA_SHA256) throw new PersistenceConflictError("Pulse local database schema does not match its certified installation.");
      const row = (await tx.query<{ payload: Buffer; candidate_lock_sha256: string; sale_config_hash: Hex; chain_id: string; contract_address: string; renderer_identity: Hex; profile: string }>(`SELECT p.*,r.chain_id::text,r.contract_address,i.renderer_identity,i.profile
        FROM open_mint.pulse_profiles p JOIN open_mint.request_profiles r USING(namespace_id,deployment_id)
        JOIN open_mint.generative_input_profiles i USING(namespace_id,deployment_id) WHERE namespace_id=$1 AND deployment_id=$2`, [namespaceId, deploymentId])).rows[0];
      if (!row || row.profile !== "sg-generative-pulse-inputs-v1-rc1" || row.chain_id !== "31337") throw new PersistenceConflictError("Explicit isolated Pulse profile required.");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)) as PulsePipelineBinding;
      exactObject(value, ["version", "candidateLockSha256", "deployment", "slots"], "Pulse pipeline binding");
      if (!json(value).equals(row.payload) || value.version !== "sg-pulse-pipeline-v1" || value.candidateLockSha256 !== row.candidate_lock_sha256
        || value.candidateLockSha256 !== "029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8"
        || value.deployment.saleConfigHash !== row.sale_config_hash || !Array.isArray(value.slots)
        || BigInt(value.slots.length) !== BigInt(value.deployment.slotCount)) throw new PersistenceConflictError("Pulse candidate binding mismatch.");
      const deployment = validatePulseDeployment(value.deployment, BigInt(row.chain_id), row.contract_address, row.renderer_identity);
      const slots = value.slots.map((slot, index) => {
        exactObject(slot, ["slotId", "wallet", "proof"], "Pulse slot");
        if (slot.slotId !== String(index) || slot.wallet !== getAddress(slot.wallet) || /^0x0{40}$/i.test(slot.wallet)) throw new PersistenceConflictError("Noncanonical Pulse slot manifest.");
        verifyPulseProof(deployment.root, slot.slotId, slot.wallet, slot.proof);
        return Object.freeze({ ...slot, proof: Object.freeze([...slot.proof]) });
      });
      return Object.freeze({ ...value, deployment, slots: Object.freeze(slots) });
    });
    return new PostgresPulseEconomics(writer, namespaceId, deploymentId, binding);
  }
  slotIds(wallet: string) { return this.binding.slots.filter(s => s.wallet === getAddress(wallet)).map(s => s.slotId); }
  #evidence(e: PublicChainEvidence, now: number) {
    if (e.contractProfile !== "generative-pulse-v1-rc1" || e.namespaceId !== this.namespaceId || e.deploymentId !== this.deploymentId
      || now < e.observedAt || now >= e.validUntil || !e.pulse || !json(e.pulse.deployment).equals(json(this.binding.deployment))) fail("CHAIN_UNAVAILABLE", "Fresh Pulse eligibility is required.");
    return e.pulse!;
  }
  async reserve(tx: Tx, input: { requestId: string; wallet: string; handle: string; generation: string; sessionHash: string; consent: unknown; evidence: PublicChainEvidence; now: number }) {
    const consent = input.consent as PulseConsent;
    exactObject(consent, ["mode", "maxPriceWei", ...(consent?.slotId === undefined ? [] : ["slotId"])], "Pulse consent");
    if (consent.mode !== "free" && consent.mode !== "paid") fail("CONSENT_REQUIRED", "Choose a free or paid mint explicitly.");
    const maxPrice = pulseUint(consent.maxPriceWei).toString(), e = this.#evidence(input.evidence, input.now);
    if (consent.mode === "free" ? maxPrice !== "0" || e.phase !== 0 || BigInt(input.now) >= BigInt(e.deployment.freeDeadline) * 1000n
      : e.phase !== 1 || BigInt(e.price) > BigInt(maxPrice) || consent.slotId !== undefined) fail("PHASE_CONSENT_REQUIRED", "The mint phase or price changed. Review it before continuing.");
    const active = (await tx.query(`SELECT i.request_id FROM open_mint.pulse_intents i JOIN open_mint.requests r USING(namespace_id,request_id)
      WHERE i.namespace_id=$1 AND i.deployment_id=$2 AND r.handle=$3 AND NOT EXISTS(SELECT 1 FROM open_mint.pulse_intent_releases x WHERE x.namespace_id=i.namespace_id AND x.request_id=i.request_id)`,
    [this.namespaceId, this.deploymentId, input.handle])).rows;
    // Explicit paid consent can reuse an accepted free result ONLY if it has
    // never entered signing. A head/unknown send survives expiry and rejection.
    for (const old of active) {
      const accepted = (await tx.query(`SELECT 1 FROM open_mint.assessments WHERE namespace_id=$1 AND handle=$2`, [this.namespaceId, input.handle])).rows.length;
      const authority = (await tx.query("SELECT 1 FROM open_mint.generative_authorizations WHERE namespace_id=$1 AND request_id=$2", [this.namespaceId, old.request_id])).rows.length;
      const owner = (await tx.query<{ session_hash: string; wallet: string; session_generation: string }>("SELECT session_hash,wallet,session_generation::text FROM open_mint.requests WHERE namespace_id=$1 AND request_id=$2", [this.namespaceId, old.request_id])).rows[0];
      if (consent.mode !== "paid" || !accepted || authority || owner.session_hash !== input.sessionHash || owner.wallet !== input.wallet || owner.session_generation !== input.generation)
        fail("MINT_RESERVED", "An existing request must be resolved before creating another mint.");
      await this.#release(tx, old.request_id, "accepted-phase-change");
    }
    let slotId = PULSE_PAID_SLOT.toString(), proof: readonly Hex[] = [];
    if (consent.mode === "free") {
      const owned = this.binding.slots.filter(s => s.wallet === input.wallet && (consent.slotId === undefined || s.slotId === String(pulseUint(consent.slotId))));
      for (const slot of owned) {
        if (!e.slots.some(s => s.slotId === slot.slotId && !s.claimed)) continue;
        const occupied = await tx.query("SELECT 1 FROM open_mint.pulse_slot_heads WHERE namespace_id=$1 AND deployment_id=$2 AND slot_id=$3", [this.namespaceId, this.deploymentId, slot.slotId]);
        if (!occupied.rows.length) { slotId = slot.slotId; proof = slot.proof; break; }
      }
      if (slotId === PULSE_PAID_SLOT.toString()) fail("FREE_SLOT_UNAVAILABLE", "No unused free mint slot is available for this wallet.");
    }
    const value: SavedPulseIntent = { version: "sg-pulse-intent-v1", requestId: input.requestId, wallet: input.wallet, generation: input.generation, sessionHash: input.sessionHash,
      handle: input.handle, mintMode: consent.mode === "free" ? 0 : 1, slotId, maxPrice, saleConfigHash: e.deployment.saleConfigHash, proof,
      quote: { block: String(input.evidence.block.number), hash: input.evidence.block.hash, timestamp: String(input.evidence.block.timestamp), price: e.price } };
    await tx.query("INSERT INTO open_mint.pulse_intents(namespace_id,deployment_id,request_id,mint_mode,slot_id,max_price,payload) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [this.namespaceId, this.deploymentId, input.requestId, value.mintMode, slotId, maxPrice, json(value)]);
    if (value.mintMode === 0) await tx.query("INSERT INTO open_mint.pulse_slot_heads VALUES($1,$2,$3,$4)", [this.namespaceId, this.deploymentId, slotId, input.requestId]);
    return value;
  }
  async load(tx: Tx, requestId: string): Promise<SavedPulseIntent> {
    const row = (await tx.query<{ payload: Buffer; mint_mode: number; slot_id: string; max_price: string; wallet: string; session_hash: string; session_generation: string; handle: string; released: boolean }>(`SELECT i.payload,i.mint_mode,i.slot_id::text,i.max_price::text,r.wallet,r.session_hash,r.session_generation::text,r.handle,
      EXISTS(SELECT 1 FROM open_mint.pulse_intent_releases x WHERE x.namespace_id=i.namespace_id AND x.request_id=i.request_id) AS released
      FROM open_mint.pulse_intents i JOIN open_mint.requests r USING(namespace_id,request_id) WHERE i.namespace_id=$1 AND i.deployment_id=$2 AND i.request_id=$3`, [this.namespaceId, this.deploymentId, requestId])).rows[0];
    if (!row || row.released) fail("REQUEST_RETIRED", "This mint intent was retired. Saved assessments are preserved.");
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)) as SavedPulseIntent;
    exactObject(v, ["version", "requestId", "wallet", "generation", "sessionHash", "handle", "mintMode", "slotId", "maxPrice", "saleConfigHash", "proof", "quote"], "saved Pulse intent");
    exactObject(v.quote, ["block", "hash", "timestamp", "price"], "saved Pulse quote");
    for (const n of [v.slotId, v.maxPrice, v.quote.block, v.quote.timestamp, v.quote.price]) pulseUint(n);
    if (!/^0x[0-9a-f]{64}$/.test(v.quote.hash)) throw new PersistenceConflictError("Saved Pulse quote changed.");
    if (!json(v).equals(row.payload) || v.version !== "sg-pulse-intent-v1" || v.requestId !== requestId || v.wallet !== row.wallet || v.generation !== row.session_generation
      || v.sessionHash !== row.session_hash || v.handle !== row.handle || v.mintMode !== row.mint_mode || v.slotId !== row.slot_id || v.maxPrice !== row.max_price
      || v.saleConfigHash !== this.binding.deployment.saleConfigHash) throw new PersistenceConflictError("Saved Pulse intent changed.");
    if (v.mintMode === 0) {
      const s = this.binding.slots.find(s => s.slotId === v.slotId && s.wallet === v.wallet);
      if (!s || !json(s.proof).equals(json(v.proof)) || v.maxPrice !== "0") throw new PersistenceConflictError("Saved free slot changed.");
      const head = await tx.query("SELECT 1 FROM open_mint.pulse_slot_heads WHERE namespace_id=$1 AND deployment_id=$2 AND slot_id=$3 AND request_id=$4", [this.namespaceId, this.deploymentId, v.slotId, requestId]);
      if (!head.rows.length) fail("MINT_RESERVED", "The reserved free slot is unavailable.");
    } else if (v.mintMode !== 1 || v.slotId !== PULSE_PAID_SLOT.toString() || v.proof.length) throw new PersistenceConflictError("Saved paid intent changed.");
    return v;
  }
  async check(tx: Tx, requestId: string, evidence: PublicChainEvidence, now: number, leg?: "x-identity" | "grok", attemptId?: string) {
    const v = await this.load(tx, requestId), e = this.#evidence(evidence, now);
    if (evidence.handle !== v.handle || evidence.recipient !== v.wallet) fail("CHAIN_UNAVAILABLE", "Pulse request binding changed.");
    if (v.mintMode === 0 ? e.phase !== 0 || BigInt(now) >= BigInt(e.deployment.freeDeadline) * 1000n
      || !e.slots.some(s => s.slotId === v.slotId && !s.claimed) : e.phase !== 1 || BigInt(e.price) > BigInt(v.maxPrice))
      fail("PHASE_CONSENT_REQUIRED", "The mint phase or price changed. Saved work is preserved; review a new intent.");
    if (leg && v.mintMode === 0) {
      if (!attemptId) throw new PersistenceConflictError("Missing sponsored attempt.");
      const sponsor = (await tx.query<{ request_id: string; attempt_id: string }>("SELECT request_id,attempt_id FROM open_mint.pulse_sponsorships WHERE namespace_id=$1 AND deployment_id=$2 AND slot_id=$3", [this.namespaceId, this.deploymentId, v.slotId])).rows[0];
      if (sponsor && (sponsor.request_id !== requestId || sponsor.attempt_id !== attemptId)) fail("SPONSORSHIP_CONSUMED", "This slot's assessment attempt was already used.");
      if (!sponsor) await tx.query("INSERT INTO open_mint.pulse_sponsorships(namespace_id,deployment_id,slot_id,request_id,attempt_id) VALUES($1,$2,$3,$4,$5)", [this.namespaceId, this.deploymentId, v.slotId, requestId, attemptId]);
    }
    return v;
  }
  async #release(tx: Tx, requestId: string, reason: string) {
    await tx.query("INSERT INTO open_mint.pulse_intent_releases(namespace_id,request_id,reason) VALUES($1,$2,$3)", [this.namespaceId, requestId, reason]);
    await tx.query("DELETE FROM open_mint.pulse_slot_heads WHERE namespace_id=$1 AND request_id=$2", [this.namespaceId, requestId]);
  }
  /** Offline recovery calls this inside the same transaction that saved its
   * finalized-expiry evidence and retired authority. SQL also enforces it. */
  async retireAfterRecovery(tx: Tx, requestId: string) {
    await this.load(tx, requestId);
    await this.#release(tx, requestId, "finalized-authority-retired");
  }
  /** Caller must authenticate the request through PostgresMintRequests first. */
  async cancelBeforeDispatch(requestId: string, sessionHash: string, generation: string) {
    return this.writer.transaction(async tx => {
      const v = await this.load(tx, requestId);
      if (v.sessionHash !== sessionHash || v.generation !== generation) fail("SESSION_REQUIRED", "The original wallet session is required.");
      const effects = await tx.query(`SELECT 1 FROM open_mint.requests r WHERE r.namespace_id=$1 AND r.request_id=$2 AND
        (EXISTS(SELECT 1 FROM open_mint.dispatch_fences d WHERE d.namespace_id=r.namespace_id AND d.attempt_id=r.attempt_id)
        OR EXISTS(SELECT 1 FROM open_mint.generative_authorizations a WHERE a.namespace_id=r.namespace_id AND a.request_id=r.request_id))`, [this.namespaceId, requestId]);
      if (effects.rows.length) fail("SUBMISSION_UNRESOLVED", "Started assessment or mint authority must be preserved.");
      await this.#release(tx, requestId, "cancelled-before-dispatch");
    });
  }
}
