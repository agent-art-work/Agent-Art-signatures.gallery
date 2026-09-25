import { timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { GENERATIVE_MINT_ABI, normalizeGenerativeAuthorization } from "../generativeAuthorization.js";
import { isCode, opaqueCode, PublicError } from "../security.js";
import type { WalletChainContext } from "../walletChain.js";
import type { AuthorizationReservation, PostgresGenerativeAuthorizationIssuer, IssuanceIntent } from "./generativeAuthorizations.js";
import { admissionDigest } from "../staging/admission.js";
import type { LocalMintOperation } from "./mintAdmission.js";
import type { PostgresMintRequests } from "./requests.js";
import type { RuntimeIntent } from "./runtimeService.js";
import { capabilityHash } from "./sessions.js";
import type { OwnershipConnection } from "./writer.js";
import type { GenerativeTransactionGuard } from "./generativeInputs.js";

type Tx = Pick<OwnershipConnection, "query">;
export interface WalletMintPlan { expiresAt: string; transaction: { from: string; to: string; chainId: string; data: Hex; value: string; nonce: Hex } }
interface Row { request_id: string; wallet: string; handle: string; generation: string; request_generation: string; csrf: string; expires_at: Date; request_expiry: Date;
  revoked: boolean; proof_wallet: string | null; proof_code_hash: string | null; proof_expires_at: Date | null; active_challenge_hash: string | null }
interface Dispatch { attempt: number; permit_hash: string; outcome: "submitted" | "rejected" | null; transaction_hash: Hex | null }
const json = (v: unknown) => Buffer.from(canonicalize(v)!);
function blocked(code = "SUBMISSION_UNRESOLVED", message = "A wallet submission is already started or uncertain. Check its progress; do not send another mint."): never { throw new PublicError(409, code, message); }
const stagingConstruction = Symbol("internal guarded staging wallet");

/** Durable browser dispatch guard, NOT a broadcaster or chain observer.
 * The same exact transaction/nonce survives rejection and process restart.
 * Unknown dispatches have no TTL/reset. Reported rejection is untrusted: it
 * permits only bounded explicit resends at that SAME nonce, never a new mint.
 */
export class PostgresWalletSubmissions {
  constructor(readonly requests: PostgresMintRequests, private readonly guard?: GenerativeTransactionGuard, key?: symbol) {
    if (guard ? key !== stagingConstruction || requests.profile.chain_id !== "11155111" || requests.repository.namespace.profile !== "staging-testnet"
      || requests.profile.session_chain_id !== "11155111" || requests.profile.origin !== "https://staging.signatures.gallery"
      : requests.profile.chain_id !== "31337" || requests.repository.namespace.profile !== "local-real") blocked();
    if (requests.repository.namespace.provenance !== "grok") blocked();
  }
  /** Internal guarded factory. Ordinary construction remains local-only. */
  static guardedStaging(requests: PostgresMintRequests, guard: GenerativeTransactionGuard) {
    if (typeof guard !== "function") blocked();
    return new PostgresWalletSubmissions(requests, guard, stagingConstruction);
  }
  get writer() { return this.requests.repository.writer; }
  get namespaceId() { return this.requests.repository.namespace.id; }
  async #context(tx: Tx, code: string, intent: RuntimeIntent, fresh: boolean) {
    await this.guard?.(tx);
    if (!isCode(code)) blocked("NOT_FOUND", "Signature request not found.");
    const codeHash = capabilityHash(code), sessionHash = capabilityHash(intent.session.id);
    const row = (await tx.query<Row>(`SELECT r.request_id,r.wallet,r.handle,r.session_generation::text AS request_generation,r.expires_at AS request_expiry,
      s.generation::text,s.csrf,s.expires_at,s.revoked,s.proof_wallet,s.proof_code_hash,s.proof_expires_at,s.active_challenge_hash
      FROM open_mint.requests r JOIN open_mint.sessions s USING(namespace_id,session_hash)
      WHERE r.namespace_id=$1 AND r.deployment_id=$2 AND r.code_hash=$3 AND r.session_hash=$4 AND s.wallet=r.wallet`,
    [this.namespaceId, this.requests.profile.deployment_id, codeHash, sessionHash])).rows[0];
    const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
    if (!row || row.revoked || row.expires_at.getTime() <= now || intent.origin !== this.requests.profile.origin || !isCode(intent.csrf)
      || !timingSafeEqual(Buffer.from(intent.csrf), Buffer.from(row.csrf))) blocked("SESSION_REQUIRED", "Restore the original session and wallet to continue.");
    if (fresh && (row.generation !== intent.session.generation || row.proof_wallet !== row.wallet
      || !row.proof_expires_at || row.proof_expires_at.getTime() <= now || row.active_challenge_hash
      || (row.proof_code_hash !== null && row.proof_code_hash !== codeHash))) blocked("WALLET_PROOF_REQUIRED", "The original wallet proof is required. Saved work is preserved.");
    if (fresh && row.request_expiry.getTime() <= now) blocked("REQUEST_EXPIRED", "This mint request expired. Saved work is preserved.");
    return { row, now, sessionHash };
  }
  async #dispatch(tx: Tx, id: string): Promise<Dispatch | undefined> {
    return (await tx.query<Dispatch>(`SELECT d.attempt,d.permit_hash,r.outcome,r.transaction_hash FROM open_mint.wallet_mint_dispatches d
      LEFT JOIN open_mint.wallet_mint_reports r USING(namespace_id,request_id,attempt)
      WHERE d.namespace_id=$1 AND d.request_id=$2 ORDER BY d.attempt DESC LIMIT 1`, [this.namespaceId, id])).rows[0];
  }
  /** Exact saved server authorization only; no browser-supplied transaction. */
  async stage(code: string, intent: RuntimeIntent, issued: Omit<WalletMintPlan, "transaction"> & { transaction: Omit<WalletMintPlan["transaction"], "nonce"> }, network: WalletChainContext) {
    const input = structuredClone(issued), chain = structuredClone(network);
    return this.writer.transaction(async tx => {
      const { row, now, sessionHash } = await this.#context(tx, code, intent, true);
      const dispatch = await this.#dispatch(tx, row.request_id);
      if (dispatch && dispatch.outcome !== "rejected") blocked();
      if (!chain.nonce || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(chain.nonce) || BigInt(chain.nonce) > BigInt(Number.MAX_SAFE_INTEGER)) blocked();
      const signed = (await tx.query<{ authorization_id: string; payload: Buffer; signature: Hex }>(`SELECT a.authorization_id,a.payload,s.signature
        FROM open_mint.generative_authorizations a JOIN open_mint.generative_authorization_signatures s USING(namespace_id,authorization_id)
        JOIN open_mint.generative_authorization_heads h USING(namespace_id,deployment_id,handle,authorization_id)
        WHERE a.namespace_id=$1 AND a.deployment_id=$2 AND a.request_id=$3 AND a.session_hash=$4 AND a.state='signed'`,
      [this.namespaceId, this.requests.profile.deployment_id, row.request_id, sessionHash])).rows[0];
      if (!signed) blocked("NOT_READY", "A saved mint authorization is required.");
      const r = JSON.parse(signed.payload.toString("utf8")) as AuthorizationReservation, a = normalizeGenerativeAuthorization(r.authorization);
      const exact = { from: getAddress(row.wallet), to: getAddress(this.requests.profile.contract_address), chainId: `0x${BigInt(this.requests.profile.chain_id).toString(16)}`, value: "0x0",
        data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: [r.renderHandle, r.mbti, a, signed.signature] }) };
      if (r.requestId !== row.request_id || r.generation !== row.generation || r.sessionHash !== sessionHash || a.recipient !== exact.from
        || r.domain.chainId !== this.requests.profile.chain_id || getAddress(r.domain.verifyingContract) !== exact.to || !json(input.transaction).equals(json(exact))
        || chain.chainId !== exact.chainId || getAddress(chain.contract) !== exact.to || input.expiresAt !== new Date(Number(a.deadline) * 1000).toISOString()
        || Number(a.deadline) * 1000 <= now) blocked("AUTHORIZATION_EXPIRED", "The saved mint authorization cannot be used. Operator review is required.");
      const plan: WalletMintPlan = { expiresAt: input.expiresAt, transaction: { ...exact, nonce: chain.nonce } }, payload = json(plan);
      const saved = (await tx.query<{ payload: Buffer; nonce_active: boolean }>("SELECT payload,nonce_active FROM open_mint.wallet_mint_plans WHERE namespace_id=$1 AND request_id=$2", [this.namespaceId, row.request_id])).rows[0];
      if (saved) {
        if (!saved.nonce_active) blocked("REQUEST_RETIRED", "This request was retired by an operator. Start a new request; the accepted assessment is preserved.");
        if (!saved.payload.equals(payload)) blocked("WALLET_NONCE_CHANGED", "The wallet nonce changed. This saved transaction needs operator review; no replacement was created.");
      }
      else {
        const inserted = await tx.query(`INSERT INTO open_mint.wallet_mint_plans(namespace_id,deployment_id,request_id,authorization_id,recipient,wallet_nonce,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING request_id`,
        [this.namespaceId, this.requests.profile.deployment_id, row.request_id, signed.authorization_id, exact.from, BigInt(chain.nonce).toString(), payload]);
        if (!inserted.rows.length) blocked("WALLET_NONCE_RESERVED", "Another saved mint uses this wallet nonce. Finish that mint first.");
      }
      const end = await this.#context(tx, code, intent, true);
      if (Number(a.deadline) * 1000 <= end.now) blocked("AUTHORIZATION_EXPIRED", "The saved authorization expired before preparation completed.");
      return plan;
    });
  }
  async begin(code: string, intent: RuntimeIntent, expected: WalletMintPlan) {
    if (this.guard) blocked("SUBMISSION_UNRESOLVED", "Staging submission requires admission.");
    const bytes = json(expected), expiresAt = Date.parse(expected.expiresAt);
    return this.writer.transaction(tx => this.#begin(tx, code, intent, bytes, expiresAt));
  }
  async #ready(tx: Tx, code: string, intent: RuntimeIntent, bytes: Buffer, expiresAt: number) {
      const { row, now } = await this.#context(tx, code, intent, true), last = await this.#dispatch(tx, row.request_id);
      if (last && (last.outcome !== "rejected" || last.attempt >= 5)) blocked();
      const plan = (await tx.query<{ payload: Buffer }>("SELECT payload FROM open_mint.wallet_mint_plans WHERE namespace_id=$1 AND request_id=$2 AND nonce_active", [this.namespaceId, row.request_id])).rows[0];
      if (!plan || !plan.payload.equals(bytes) || !Number.isFinite(expiresAt) || expiresAt <= now) blocked();
      return { row, now, attempt: (last?.attempt ?? 0) + 1 };
  }
  async #begin(tx: Tx, code: string, intent: RuntimeIntent, bytes: Buffer, expiresAt: number) {
      const { row, attempt } = await this.#ready(tx, code, intent, bytes, expiresAt);
      const permit = opaqueCode();
      await tx.query("INSERT INTO open_mint.wallet_mint_dispatches(namespace_id,request_id,attempt,permit_hash,owner_epoch) VALUES($1,$2,$3,$4,$5)",
        [this.namespaceId, row.request_id, attempt, capabilityHash(permit), this.writer.epoch]);
      if (expiresAt <= (await this.#context(tx, code, intent, true)).now) blocked("AUTHORIZATION_EXPIRED", "The saved authorization expired before submission started.");
      return { permit };
  }
  /** Internal release of a saved wallet plan, not a broadcaster. Requires a
   * fresh exact authorization witness; no selected preview or replacement nonce. */
  async prepareSubmissionAdmission(issuer: PostgresGenerativeAuthorizationIssuer, value: IssuanceIntent, intent: RuntimeIntent,
    expected: WalletMintPlan): Promise<LocalMintOperation<{ permit: string }>> {
    if (issuer.requests !== this.requests || value.code === undefined || value.sessionToken !== intent.session.id
      || value.sessionGeneration !== intent.session.generation || value.origin !== intent.origin || value.csrf !== intent.csrf) blocked();
    const code = value.code, input = structuredClone(intent), plan = structuredClone(expected), bytes = json(plan), expiresAt = Date.parse(plan.expiresAt);
    const signed = await issuer.prepareSignedInspection(value), r = signed.reservation;
    const readiness = async (tx: Tx) => {
      const current = await signed.inspect(tx), ready = await this.#ready(tx, code, input, bytes, expiresAt);
      const exact = { from: r.authorization.recipient, to: r.domain.verifyingContract, chainId: `0x${BigInt(this.requests.profile.chain_id).toString(16)}`, value: "0x0",
        data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: [r.renderHandle, r.mbti, normalizeGenerativeAuthorization(r.authorization), current.signature] }),
        nonce: plan.transaction.nonce };
      if (ready.row.request_id !== r.requestId || expiresAt !== Number(r.authorization.deadline) * 1000 || !json(plan.transaction).equals(json(exact))) blocked();
      return { observedAt: current.observedAt, validUntil: Math.min(current.validUntil, expiresAt), attempt: ready.attempt };
    };
    const initial = await this.writer.transaction(readiness);
    const inspect = async (tx: Tx) => { const current = await readiness(tx); if (current.attempt !== initial.attempt) blocked(); return current; };
    let permit: string | undefined, executed = false;
    return Object.freeze({ requests: this.requests, intent: Object.freeze({ operation: "wallet-submit" as const, requestId: r.requestId,
      payloadSha256: admissionDigest({ version: "local-generative-wallet-intent-v1", plan, authorization: r.id, attempt: initial.attempt }) }), inspect,
      fence: async (tx: Tx) => {
        if (permit) blocked(); await inspect(tx);
        permit = (await this.#begin(tx, code, input, bytes, expiresAt)).permit;
        await signed.inspect(tx);
      },
      effect: async (_signal: AbortSignal, guard: () => void) => {
        if (!permit || executed) blocked(); executed = true; guard();
        await this.writer.transaction(async tx => {
          const { row } = await this.#context(tx, code, input, true), last = await this.#dispatch(tx, row.request_id);
          if (!last || last.attempt !== initial.attempt || last.outcome !== null || last.permit_hash !== capabilityHash(permit!)) blocked();
          await signed.inspect(tx); guard();
        });
        guard(); return { permit };
      },
    });
  }
  /** Readable after request/proof expiry; active session+same wallet still required. */
  async state(code: string, sessionToken: string) {
    const request = await this.requests.get(code, sessionToken);
    return this.writer.transaction(async tx => {
      const d = await this.#dispatch(tx, request.id);
      return { blocked: !!d && (d.outcome !== "rejected" || d.attempt >= 5),
        ...(d?.transaction_hash ? { transactionHash: d.transaction_hash } : {}) };
    });
  }
  async report(code: string, intent: RuntimeIntent, permit: unknown, outcome: "submitted" | "rejected", transactionHash?: unknown) {
    if (!isCode(permit) || !["submitted", "rejected"].includes(outcome) || (outcome === "submitted"
      ? typeof transactionHash !== "string" || !/^0x[0-9a-f]{64}$/.test(transactionHash) || /^0x0{64}$/.test(transactionHash)
      : transactionHash !== undefined)) blocked("INVALID_REPORT", "Invalid wallet response.");
    return this.writer.transaction(async tx => {
      const { row } = await this.#context(tx, code, intent, false), last = await this.#dispatch(tx, row.request_id);
      if (!last || !timingSafeEqual(Buffer.from(last.permit_hash), Buffer.from(capabilityHash(permit)))) blocked("INVALID_REPORT", "This wallet response does not match its submission.");
      if (last.outcome) {
        if (last.outcome !== outcome || last.transaction_hash !== (transactionHash ?? null)) blocked("INVALID_REPORT", "The saved wallet response cannot be replaced.");
      } else await tx.query("INSERT INTO open_mint.wallet_mint_reports(namespace_id,request_id,attempt,outcome,transaction_hash) VALUES($1,$2,$3,$4,$5)",
        [this.namespaceId, row.request_id, last.attempt, outcome, transactionHash ?? null]);
      return { ok: true };
    });
  }
}
