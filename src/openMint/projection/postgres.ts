import { profileForRenderer } from "../generativeInputs.js";
import { ExclusiveWriter, type OwnershipConnection } from "../persistence/writer.js";
import { readProjectionObservation, type ProjectionChainCursor, type ProjectionObservation } from "./observer.js";
import { address, decodeCursor, encodeCursor, fields, hash, ProjectionConflictError, ProjectionCursorError, ProjectionSafetyHaltError, quantity, reference,
  stable, validateBatch, validateDeployment, validateEvent, validateFilter, validateLimit, ZERO_ADDRESS,
  type GalleryFilter, type Position, type ProjectionDeployment, type ValidatedBatch, type ValidatedBlock, type AnyValidatedMint, type ValidatedTransfer } from "./model.js";

type Transaction = Pick<OwnershipConnection, "query">;
interface Checkpoint { head_number: string | null; head_hash: string | null; promoted_number: string | null; promoted_hash: string | null; health: "unknown" | "available" | "safety-halted"; halt_reason: string | null }
interface BlockRow { number: string; hash: string; payload: Buffer }
interface MintRow { token_id: string; handle: string; mbti: string; original_recipient: string; block_number: string; block_hash: string; transaction_index: number; log_index: number; payload: Buffer; log_payload: Buffer | null; current_owner: string; availability: ArtifactAvailability }
export type ArtifactAvailability = "available" | "unavailable" | "quarantined";
export interface ProjectedMint {
  readonly tokenId: string; readonly availability: ArtifactAvailability;
  readonly mintState?: "confirming" | "minted";
  readonly handle?: string; readonly mbti?: string; readonly originalRecipient?: string; readonly currentOwner?: string;
  readonly assessmentDigest?: string; readonly artifactDigest?: string; readonly tokenURIHash?: string;
  readonly transactionHash?: string;
  readonly inputDigest?: string; readonly rendererIdentity?: string; readonly renderHandle?: string;
  readonly authorizationDigest?: string;
  readonly inclusion?: { readonly number: string; readonly hash: string };
}
export interface GalleryPage {
  readonly state: "confirmed" | "unknown" | "safety-halted";
  readonly snapshot?: { readonly number: string; readonly hash: string };
  readonly items: readonly ProjectedMint[]; readonly nextCursor?: string;
}
const bytes = (value: unknown): Buffer => Buffer.from(stable(value));
const fail = (message: string): never => { throw new ProjectionConflictError(message); };

/** Fenced projection store. append/promote are offline maintenance primitives;
 * public runtime composition must use applyObservation and its opaque witness. */
export class OpenMintProjection {
  readonly #deployment: ProjectionDeployment;
  private constructor(readonly writer: ExclusiveWriter, deployment: ProjectionDeployment) { this.#deployment = deployment; }
  static async open(writer: ExclusiveWriter, input: ProjectionDeployment): Promise<OpenMintProjection> {
    const deployment = validateDeployment(input), payload = bytes(deployment);
    await writer.transaction(async tx => {
      const version = (await tx.query<{ version: number }>("SELECT version FROM open_mint.projection_schema_version")).rows;
      if (version.length !== 1 || ![2, 3].includes(version[0].version) || (deployment.generativeRenderer && version[0].version !== 3)) fail("Unsupported projection schema.");
      await tx.query("INSERT INTO open_mint.projection_deployments(deployment_id, namespace_id, configuration) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [deployment.id, deployment.namespaceId, payload]);
      const saved = (await tx.query<{ configuration: Buffer }>("SELECT configuration FROM open_mint.projection_deployments WHERE deployment_id=$1", [deployment.id])).rows[0];
      if (!saved?.configuration.equals(payload)) fail("Immutable projection deployment mismatch.");
      await tx.query("INSERT INTO open_mint.projection_checkpoints(deployment_id) VALUES($1) ON CONFLICT DO NOTHING", [deployment.id]);
    });
    return new OpenMintProjection(writer, deployment);
  }
  /** Installed staging must not provision projection state while serving.
   * An absent checkpoint/deployment is an installation error, not an invitation
   * to create a new chain history at startup. */
  static async openExisting(writer: ExclusiveWriter, input: ProjectionDeployment): Promise<OpenMintProjection> {
    const deployment = validateDeployment(input), payload = bytes(deployment);
    await writer.transaction(async tx => {
      const version = (await tx.query<{ version: number }>("SELECT version FROM open_mint.projection_schema_version")).rows;
      if (version.length !== 1 || version[0].version !== 3 || !deployment.generativeRenderer) fail("Unsupported installed projection schema.");
      const saved = (await tx.query<{ configuration: Buffer }>("SELECT configuration FROM open_mint.projection_deployments WHERE deployment_id=$1", [deployment.id])).rows;
      if (saved.length !== 1 || !saved[0].configuration.equals(payload)) fail("Missing or mismatched installed projection deployment.");
      const checkpoints = (await tx.query<{ health: string; halt_reason: string | null }>(
        "SELECT health, halt_reason FROM open_mint.projection_checkpoints WHERE deployment_id=$1", [deployment.id])).rows;
      if (checkpoints.length !== 1 || checkpoints[0].health === "safety-halted" || checkpoints[0].halt_reason !== null)
        fail("Installed projection unavailable.");
    });
    return new OpenMintProjection(writer, deployment);
  }
  #state(tx: Transaction): Promise<Checkpoint> {
    return tx.query<Checkpoint>("SELECT head_number::text, head_hash, promoted_number::text, promoted_hash, health, halt_reason FROM open_mint.projection_checkpoints WHERE deployment_id=$1 FOR UPDATE", [this.#deployment.id]).then(result => result.rows[0] ?? fail("Missing projection checkpoint."));
  }
  async #halt(tx: Transaction, reason: string): Promise<"safety-halted"> {
    await tx.query("UPDATE open_mint.projection_checkpoints SET health='safety-halted', halt_reason=$2 WHERE deployment_id=$1", [this.#deployment.id, reason]);
    return "safety-halted";
  }
  /** Reports an unavailable read without deleting saved history or claiming absence. */
  unavailable(): Promise<void> {
    return this.writer.transaction(async tx => {
      await tx.query("UPDATE open_mint.projection_checkpoints SET health='unknown' WHERE deployment_id=$1 AND health <> 'safety-halted'", [this.#deployment.id]);
    });
  }
  checkpoint(): Promise<Readonly<Checkpoint> & { freshChainVerified: false }> {
    return this.writer.transaction(async tx => ({ ...await this.#state(tx), freshChainVerified: false }));
  }
  async #cursor(tx: Transaction): Promise<ProjectionChainCursor> {
    const state = await this.#state(tx);
    if (state.health === "safety-halted") throw new ProjectionSafetyHaltError("Projection is safety-halted.");
    const tail = (await tx.query<{ number: string; hash: string }>(`SELECT number::text,hash FROM open_mint.projection_blocks
      WHERE deployment_id=$1 AND canonical ORDER BY projection_blocks.number DESC LIMIT $2`, [this.#deployment.id, this.#deployment.policy.rollbackBlocks + 1])).rows.reverse();
    return { head: state.head_number === null ? null : { number: state.head_number, hash: state.head_hash! },
      promoted: state.promoted_number === null ? null : { number: state.promoted_number, hash: state.promoted_hash! }, tail };
  }
  chainCursor(): Promise<ProjectionChainCursor> { return this.writer.transaction(tx => this.#cursor(tx)); }
  /** The witness and database clock are checked before AND after mutation, in
   * the same transaction as append + promotion. A timeout rolls everything back.
   * A serialized record or previously persisted batch cannot assert freshness. */
  applyObservation(witness: ProjectionObservation): Promise<"observed" | "safety-halted"> {
    return this.writer.transaction(async tx => {
      const now = async () => (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
      const evidence = readProjectionObservation(witness, this.#deployment, await now());
      if (stable(evidence.cursor) !== stable(await this.#cursor(tx))) fail("Projection changed during chain observation.");
      if (evidence.halt) {
        const halted = await this.#halt(tx, "canonical-contradiction");
        readProjectionObservation(witness, this.#deployment, await now());
        return halted;
      }
      const result = await this.#append(tx, evidence.batch!);
      if (result === "observed" && evidence.promotion) await this.#promote(tx, { ...evidence.promotion,
        policyId: this.#deployment.policy.id, evidenceReference: `ethereum-finalized:${evidence.promotion.hash}` });
      readProjectionObservation(witness, this.#deployment, await now());
      return result;
    });
  }
  async #fresh(tx: Transaction, witness: ProjectionObservation): Promise<void> {
    const time = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
    const e = readProjectionObservation(witness, this.#deployment, time), state = await this.#state(tx);
    const tip = e.batch?.blocks.at(-1), promoted = e.promotion ?? e.cursor.promoted;
    if (e.halt || !tip || tip.number !== e.head.number || tip.hash !== e.head.hash || state.health !== "available"
      || state.head_number !== tip.number || state.head_hash !== tip.hash
      || state.promoted_number !== (promoted?.number ?? null) || state.promoted_hash !== (promoted?.hash ?? null)) fail("Projection has no current caught-up observation.");
  }

  append(input: ValidatedBatch): Promise<"observed" | "safety-halted"> {
    const batch = validateBatch(input, this.#deployment);
    return this.writer.transaction(tx => this.#append(tx, batch));
  }
  async #append(tx: Transaction, batch: ValidatedBatch): Promise<"observed" | "safety-halted"> {
      const id = this.#deployment.id;
      const state = await this.#state(tx);
      if (state.health === "safety-halted") return "safety-halted";
      const first = batch.blocks[0], last = batch.blocks[batch.blocks.length - 1];
      if (state.head_number === null && first.number !== this.#deployment.deploymentBlock) fail("Backfill must start at the exact deployment block.");
      if (state.head_number !== null && BigInt(first.number) > BigInt(state.head_number) + 1n) fail("Projection block gap.");
      if (first.number === this.#deployment.deploymentBlock && first.hash !== this.#deployment.deploymentBlockHash) return this.#halt(tx, "deployment-contradiction");
      if (first.number !== this.#deployment.deploymentBlock) {
        const parent = (await tx.query<{ hash: string }>("SELECT hash FROM open_mint.projection_blocks WHERE deployment_id=$1 AND number=$2 AND canonical", [id, String(BigInt(first.number) - 1n)])).rows[0];
        if (parent?.hash !== first.parentHash) fail("Batch has no known canonical parent; supply the common ancestor.");
      }
      const old = (await tx.query<BlockRow>("SELECT number::text,hash,payload FROM open_mint.projection_blocks WHERE deployment_id=$1 AND canonical AND number BETWEEN $2 AND $3 ORDER BY number", [id, first.number, last.number])).rows;
      const heights = new Map(old.map(block => [block.number, block]));
      let replacement: string | undefined;
      for (const block of batch.blocks) {
        const prior = heights.get(block.number);
        if (prior?.hash === block.hash && !prior.payload.equals(bytes(block))) return this.#halt(tx, "immutable-block-contradiction");
        if (prior && prior.hash !== block.hash && replacement === undefined) replacement = block.number;
        const stored = (await tx.query<BlockRow>("SELECT number::text,hash,payload FROM open_mint.projection_blocks WHERE deployment_id=$1 AND hash=$2", [id, block.hash])).rows[0];
        if (stored && (stored.number !== block.number || !stored.payload.equals(bytes(block)))) return this.#halt(tx, "immutable-block-contradiction");
      }
      if (replacement !== undefined) {
        if ((state.promoted_number !== null && BigInt(replacement) <= BigInt(state.promoted_number))
          || BigInt(state.head_number!) - BigInt(replacement) + 1n > BigInt(this.#deployment.policy.rollbackBlocks)) return this.#halt(tx, "canonical-contradiction");
        const ancestor = String(BigInt(replacement) - 1n);
        await tx.query("DELETE FROM open_mint.projection_ownership WHERE deployment_id=$1 AND start_block>$2", [id, ancestor]);
        await tx.query("UPDATE open_mint.projection_ownership SET end_block=NULL,end_transaction=NULL,end_log=NULL WHERE deployment_id=$1 AND end_block>$2", [id, ancestor]);
        await tx.query("DELETE FROM open_mint.projection_mints WHERE deployment_id=$1 AND block_number>$2", [id, ancestor]);
        await tx.query("UPDATE open_mint.projection_blocks SET canonical=false WHERE deployment_id=$1 AND canonical AND number>$2", [id, ancestor]);
      }
      for (const block of batch.blocks) {
        if (heights.get(block.number)?.hash === block.hash && (replacement === undefined || BigInt(block.number) < BigInt(replacement))) continue;
        await tx.query(`INSERT INTO open_mint.projection_blocks(deployment_id,number,hash,parent_hash,canonical,payload) VALUES($1,$2,$3,$4,true,$5)
          ON CONFLICT(deployment_id,hash) DO UPDATE SET canonical=true`, [id, block.number, block.hash, block.parentHash, bytes(block)]);
        await this.#events(tx, block);
      }
      const head = replacement !== undefined || state.head_number === null || BigInt(last.number) > BigInt(state.head_number) ? last : { number: state.head_number, hash: state.head_hash };
      await tx.query("UPDATE open_mint.projection_checkpoints SET head_number=$2,head_hash=$3,health='available' WHERE deployment_id=$1", [id, head.number, head.hash]);
      return "observed";
  }
  async #events(tx: Transaction, block: ValidatedBlock): Promise<void> {
    const id = this.#deployment.id, mintTransfers = new Map<string, ValidatedTransfer>();
    for (const event of block.events) {
      await tx.query(`INSERT INTO open_mint.projection_logs(deployment_id,block_hash,transaction_hash,transaction_index,log_index,kind,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [id, block.hash, event.transactionHash, event.transactionIndex, event.logIndex, event.kind, bytes(event)]);
      if (event.kind === "Transfer" && event.from === ZERO_ADDRESS) {
        if (mintTransfers.has(event.tokenId)) fail("Duplicate mint Transfer.");
        mintTransfers.set(event.tokenId, event); continue;
      }
      if (event.kind !== "Transfer") {
        const transfer = mintTransfers.get(event.tokenId);
        if (!transfer || transfer.to !== event.recipient || transfer.transactionHash !== event.transactionHash || transfer.transactionIndex !== event.transactionIndex) fail("Mint lacks matching zero-address Transfer.");
        mintTransfers.delete(event.tokenId);
        await tx.query(`INSERT INTO open_mint.projection_mints(deployment_id,token_id,handle,mbti,nonce,original_recipient,block_number,block_hash,transaction_index,log_index,payload,availability)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, event.tokenId, event.handle, event.mbti, event.nonce, event.recipient, block.number, block.hash, event.transactionIndex, event.logIndex, bytes(event),
            event.kind === "GenerativeSignatureMinted" ? "available" : "unavailable"]);
        await tx.query(`INSERT INTO open_mint.projection_ownership(deployment_id,token_id,owner,start_block,start_transaction,start_log,mint_block,mint_transaction,mint_log)
          VALUES($1,$2,$3,$4,$5,$6,$4,$5,$6)`, [id, event.tokenId, event.recipient, block.number, event.transactionIndex, event.logIndex]);
      } else {
        const current = (await tx.query<{ owner: string; mint_block: string; mint_transaction: number; mint_log: number }>(
          "SELECT owner,mint_block::text,mint_transaction,mint_log FROM open_mint.projection_ownership WHERE deployment_id=$1 AND token_id=$2 AND end_block IS NULL FOR UPDATE", [id, event.tokenId])).rows[0];
        if (!current || current.owner !== event.from) fail("Transfer contradicts the projected owner.");
        await tx.query("UPDATE open_mint.projection_ownership SET end_block=$3,end_transaction=$4,end_log=$5 WHERE deployment_id=$1 AND token_id=$2 AND end_block IS NULL", [id, event.tokenId, block.number, event.transactionIndex, event.logIndex]);
        await tx.query(`INSERT INTO open_mint.projection_ownership(deployment_id,token_id,owner,start_block,start_transaction,start_log,mint_block,mint_transaction,mint_log)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, event.tokenId, event.to, block.number, event.transactionIndex, event.logIndex, current.mint_block, current.mint_transaction, current.mint_log]);
      }
    }
    if (mintTransfers.size) fail("Unmatched mint Transfer.");
  }
  /** The trusted coordinator supplies reviewed finality evidence; this method
   * does NOT infer finality from a count or authenticate an RPC assertion. */
  promote(input: { number: string; hash: string; policyId: string; evidenceReference: string }): Promise<void> {
    const value = structuredClone(input); fields(value, ["number", "hash", "policyId", "evidenceReference"]);
    quantity(value.number, 63); hash(value.hash); reference(value.policyId); reference(value.evidenceReference);
    if (value.policyId !== this.#deployment.policy.id) throw new Error("Projection finality policy mismatch.");
    return this.writer.transaction(tx => this.#promote(tx, value));
  }
  async #promote(tx: Transaction, value: { number: string; hash: string; policyId: string; evidenceReference: string }): Promise<void> {
      const state = await this.#state(tx), id = this.#deployment.id;
      if (state.health !== "available" || state.head_number === null || BigInt(value.number) > BigInt(state.head_number)
        || (state.promoted_number !== null && BigInt(value.number) < BigInt(state.promoted_number))) fail("Projection cannot promote this boundary.");
      const block = (await tx.query<{ hash: string }>("SELECT hash FROM open_mint.projection_blocks WHERE deployment_id=$1 AND number=$2 AND canonical", [id, value.number])).rows[0];
      if (block?.hash !== value.hash) fail("Promotion block is not canonical.");
      await tx.query("INSERT INTO open_mint.projection_promotions(deployment_id,number,hash,policy_id,evidence_reference) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [id, value.number, value.hash, value.policyId, value.evidenceReference]);
      const saved = (await tx.query<{ hash: string; policy_id: string; evidence_reference: string }>("SELECT hash,policy_id,evidence_reference FROM open_mint.projection_promotions WHERE deployment_id=$1 AND number=$2", [id, value.number])).rows[0];
      if (saved.hash !== value.hash || saved.policy_id !== value.policyId || saved.evidence_reference !== value.evidenceReference) fail("Conflicting finality evidence.");
      await tx.query("UPDATE open_mint.projection_checkpoints SET promoted_number=$2,promoted_hash=$3 WHERE deployment_id=$1", [id, value.number, value.hash]);
  }
  setArtifactAvailability(input: { tokenId: string; artifactDigest: string; availability: ArtifactAvailability }): Promise<void> {
    const { tokenId, artifactDigest, availability } = input;
    fields(input, ["tokenId", "artifactDigest", "availability"]); quantity(tokenId, 256, true); hash(artifactDigest);
    if (!["available", "unavailable", "quarantined"].includes(availability)) throw new Error("Invalid artifact availability.");
    return this.writer.transaction(async tx => {
      const saved = (await tx.query<{ payload: Buffer }>("SELECT payload FROM open_mint.projection_mints WHERE deployment_id=$1 AND token_id=$2 FOR UPDATE", [this.#deployment.id, tokenId])).rows[0];
      if (!saved) fail("Unknown projected token.");
      const mint = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.payload)) as AnyValidatedMint; validateEvent(mint, this.#deployment.generativeRenderer ? profileForRenderer(this.#deployment.generativeRenderer).inputProfile : undefined);
      if (mint.kind !== "OpenSignatureMinted" || mint.artifactDigest !== artifactDigest) fail("Artifact availability binding changed.");
      const result = await tx.query("UPDATE open_mint.projection_mints SET availability=$3 WHERE deployment_id=$1 AND token_id=$2", [this.#deployment.id, tokenId, availability]);
      if (result.rowCount !== 1) fail("Unknown projected token.");
    });
  }
  #item(row: MintRow): ProjectedMint {
    try {
      if (!row.log_payload || !row.payload.equals(row.log_payload)) throw new Error();
      const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)) as AnyValidatedMint; validateEvent(event, this.#deployment.generativeRenderer ? profileForRenderer(this.#deployment.generativeRenderer).inputProfile : undefined);
      address(row.current_owner);
      if (!["OpenSignatureMinted", "GenerativeSignatureMinted"].includes(event.kind) || event.tokenId !== row.token_id || event.handle !== row.handle || event.mbti !== row.mbti
        || event.recipient !== row.original_recipient || event.transactionIndex !== row.transaction_index || event.logIndex !== row.log_index) throw new Error();
      if ((event.kind === "GenerativeSignatureMinted") !== !!this.#deployment.generativeRenderer) throw new Error();
      if (event.kind === "GenerativeSignatureMinted") {
        hash(row.block_hash); quantity(row.block_number, 63);
        if (event.rendererIdentity !== this.#deployment.generativeRenderer!.identity) throw new Error();
        return { tokenId: row.token_id, availability: row.availability, handle: event.handle, renderHandle: event.renderHandle, mbti: event.mbti,
          originalRecipient: event.recipient, currentOwner: row.current_owner, assessmentDigest: event.assessmentDigest,
          inputDigest: event.inputDigest, rendererIdentity: event.rendererIdentity, authorizationDigest: event.authorizationDigest, transactionHash: event.transactionHash,
          inclusion: { number: row.block_number, hash: row.block_hash } };
      }
      return { tokenId: row.token_id, availability: row.availability, handle: event.handle, mbti: event.mbti,
        originalRecipient: event.recipient, currentOwner: row.current_owner, assessmentDigest: event.assessmentDigest,
        artifactDigest: event.artifactDigest, tokenURIHash: event.tokenURIHash, transactionHash: event.transactionHash };
    } catch { return { tokenId: row.token_id, availability: "quarantined" }; }
  }
  gallery(input: { filter: GalleryFilter; limit: number; cursor?: string; includeConfirming?: boolean }, witness?: ProjectionObservation): Promise<GalleryPage> {
    const filter = validateFilter(input.filter), limit = input.limit; validateLimit(limit);
    if (input.includeConfirming !== undefined && typeof input.includeConfirming !== "boolean") throw new Error("Invalid gallery confidence policy.");
    const included = input.includeConfirming === true;
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, this.#deployment.id, filter, limit, included);
    return this.writer.transaction(async tx => {
      if (witness) await this.#fresh(tx, witness);
      const state = await this.#state(tx), id = this.#deployment.id;
      if (state.health === "safety-halted") return { state: "safety-halted", items: [] };
      // Inclusion views require a fresh authenticated RPC witness. Stored
      // checkpoints alone never grant early reveal authority after a restart.
      const horizon = included ? state.head_number : state.promoted_number;
      if (state.health !== "available" || horizon === null || (included && !witness)) return { state: "unknown", items: [] };
      const snapshot = cursor?.snapshot ?? { number: horizon, hash: (included ? state.head_hash : state.promoted_hash)! };
      const saved = (await tx.query<{ hash: string }>(included
        ? "SELECT hash FROM open_mint.projection_blocks WHERE deployment_id=$1 AND number=$2 AND canonical"
        : `SELECT p.hash FROM open_mint.projection_promotions p JOIN open_mint.projection_blocks b
          ON b.deployment_id=p.deployment_id AND b.hash=p.hash WHERE p.deployment_id=$1 AND p.number=$2 AND b.canonical`, [id, snapshot.number])).rows[0];
      if (saved?.hash !== snapshot.hash || BigInt(snapshot.number) > BigInt(horizon)
        || BigInt(horizon) - BigInt(snapshot.number) > BigInt(this.#deployment.policy.snapshotRetentionBlocks)) throw new ProjectionCursorError("Expired or noncanonical gallery snapshot; restart pagination.");
      const params: unknown[] = [id, snapshot.number], conditions = ["m.deployment_id=$1", "m.block_number<=$2", "o.start_block<=$2", "(o.end_block IS NULL OR o.end_block>$2)"];
      if (filter.kind !== "home") { params.push(filter.value); conditions.push(`${filter.kind === "mbti" ? "m.mbti" : "o.owner"}=$${params.length}`); }
      if (cursor) {
        const start = params.length + 1; params.push(cursor.last.block, cursor.last.transaction, cursor.last.log, cursor.last.token);
        conditions.push(`(m.block_number,m.transaction_index,m.log_index,m.token_id)<($${start}::bigint,$${start + 1}::integer,$${start + 2}::integer,$${start + 3}::numeric)`);
      }
      params.push(limit + 1);
      const rows = (await tx.query<MintRow>(`SELECT m.token_id::text,m.handle,m.mbti,m.original_recipient,m.block_number::text,m.block_hash,m.transaction_index,m.log_index,m.payload,l.payload AS log_payload,m.availability,o.owner AS current_owner
        FROM open_mint.projection_mints m JOIN open_mint.projection_ownership o USING(deployment_id,token_id)
        LEFT JOIN open_mint.projection_logs l ON l.deployment_id=m.deployment_id AND l.block_hash=m.block_hash AND l.log_index=m.log_index
        WHERE ${conditions.join(" AND ")} ORDER BY m.block_number DESC,m.transaction_index DESC,m.log_index DESC,m.token_id DESC LIMIT $${params.length}`, params)).rows;
      const selected = rows.slice(0, limit), last = selected[selected.length - 1];
      const position: Position | undefined = last && { block: last.block_number, transaction: last.transaction_index, log: last.log_index, token: last.token_id };
      if (witness) await this.#fresh(tx, witness);
      return { state: "confirmed", snapshot, items: selected.map(row => ({ ...this.#item(row), ...(included ? {
        mintState: state.promoted_number !== null && BigInt(row.block_number) <= BigInt(state.promoted_number) ? "minted" as const : "confirming" as const,
      } : {}) })), ...(rows.length > limit && position ? {
        nextCursor: encodeCursor({ version: 1, deployment: id, filter, limit, snapshot, last: position, ...(included ? { includeConfirming: true as const } : {}) }),
      } : {}) };
    });
  }
  /** A missing item is UNKNOWN, not proof of an unminted handle or mint authority. */
  lookup(handle: string, witness?: ProjectionObservation): Promise<{ state: "confirmed" | "confirming" | "pending" | "unknown" | "safety-halted"; item?: ProjectedMint }> {
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid canonical handle.");
    return this.writer.transaction(async tx => {
      if (witness) await this.#fresh(tx, witness);
      const state = await this.#state(tx);
      if (state.health !== "available") return { state: state.health === "safety-halted" ? "safety-halted" : "unknown" };
      const row = (await tx.query<{ block_number: string }>("SELECT block_number::text FROM open_mint.projection_mints WHERE deployment_id=$1 AND handle=$2", [this.#deployment.id, handle])).rows[0];
      if (!row) return { state: "unknown" };
      const provisional = state.promoted_number === null || BigInt(row.block_number) > BigInt(state.promoted_number);
      if (provisional && !witness) return { state: "pending" };
      const saved = (await tx.query<MintRow>(`SELECT m.token_id::text,m.handle,m.mbti,m.original_recipient,m.block_number::text,m.block_hash,m.transaction_index,m.log_index,m.payload,l.payload AS log_payload,m.availability,o.owner AS current_owner
        FROM open_mint.projection_mints m JOIN open_mint.projection_ownership o USING(deployment_id,token_id)
        LEFT JOIN open_mint.projection_logs l ON l.deployment_id=m.deployment_id AND l.block_hash=m.block_hash AND l.log_index=m.log_index
        WHERE m.deployment_id=$1 AND m.handle=$2 AND o.start_block<=$3 AND (o.end_block IS NULL OR o.end_block>$3)`, [this.#deployment.id, handle, provisional ? state.head_number : state.promoted_number])).rows[0];
      if (!saved) return { state: "unknown" };
      const item = this.#item(saved);
      if (witness) await this.#fresh(tx, witness);
      return item.availability === "quarantined" ? { state: "unknown", item } : { state: provisional ? "confirming" : "confirmed", item };
    });
  }
}
