import { profileForInputs } from "../generativeProfiles.js";
import { profileForRenderer } from "../generativeInputs.js";
import canonicalize from "canonicalize";
import { validateAssessment, type Assessment } from "../assessment.js";
import { prepareGenerativeInputs, verifyGenerativeInputs, GENERATIVE_INPUT_PROFILE, validateGenerativeRendererPin,
  type GenerativeInputs, type GenerativeRendererPin } from "../generativeInputs.js";
import { canonicalHandle, POLICY_VERSION } from "../identity.js";
import { ExclusiveWriter, PersistenceConflictError, type OwnershipConnection } from "./writer.js";

export interface PreparedGenerativeInputs extends GenerativeInputs { readonly assessment: Assessment }
type Transaction = Pick<OwnershipConnection, "query">;
export type GenerativeTransactionGuard = (tx: Transaction) => Promise<void>;
const json = (value: unknown) => Buffer.from(canonicalize(value)!);
interface Stored { handle: string; digest: string; payload: Buffer }

/** Insert-only, per deployment: immutable accepted assessment -> compact inputs.
 * No SVG generation or publication. No client-selected case, MBTI or renderer. */
export class PostgresGenerativeInputJournal {
  private constructor(readonly writer: ExclusiveWriter, readonly namespaceId: string, readonly deploymentId: string,
    readonly rendererPin: Readonly<GenerativeRendererPin>, private readonly guard?: GenerativeTransactionGuard) {}
  get profile() { return profileForRenderer(this.rendererPin); }
  static async open(writer: ExclusiveWriter, namespaceId: string, deploymentId: string): Promise<PostgresGenerativeInputJournal> {
    return this.#open(writer, namespaceId, deploymentId);
  }
  /** Trusted internal composition only. The ordinary opener stays local-only. */
  static async openGuardedStaging(writer: ExclusiveWriter, namespaceId: string, deploymentId: string, guard: GenerativeTransactionGuard) {
    if (typeof guard !== "function") throw new PersistenceConflictError("Staging input guard required.");
    return this.#open(writer, namespaceId, deploymentId, guard);
  }
  static async #open(writer: ExclusiveWriter, namespaceId: string, deploymentId: string, guard?: GenerativeTransactionGuard) {
    const pin = await writer.transaction(async tx => {
      await guard?.(tx);
      const row = (await tx.query<{ profile: string; namespace_profile: string; provenance: string; policy_version: string; chain_id: string;
        renderer_address: string; renderer_code_hash: `0x${string}`; renderer_identity: `0x${string}` }>(`SELECT p.*,n.profile AS namespace_profile,n.provenance,n.policy_version,r.chain_id::text
        FROM open_mint.generative_input_profiles p JOIN open_mint.namespaces n USING(namespace_id)
        JOIN open_mint.request_profiles r USING(namespace_id,deployment_id) WHERE namespace_id=$1 AND deployment_id=$2`, [namespaceId, deploymentId])).rows[0];
      if (!row || row.provenance !== "grok" || row.policy_version !== POLICY_VERSION || row.chain_id !== (guard ? "11155111" : "31337")
        || (guard && (row.namespace_profile !== "staging-testnet" || row.profile !== "sg-generative-inputs-v1-rc1"))) {
        throw new PersistenceConflictError("Generative input namespace/profile mismatch.");
      }
      const profile = profileForInputs(row.profile);
      await guard?.(tx);
      return validateGenerativeRendererPin({ address: row.renderer_address, runtimeCodeHash: row.renderer_code_hash, identity: row.renderer_identity,
        ...(profile.inputProfile === GENERATIVE_INPUT_PROFILE ? {} : { inputProfile: profile.inputProfile }) });
    });
    return new PostgresGenerativeInputJournal(writer, namespaceId, deploymentId, pin, guard);
  }
  async #accepted(tx: Transaction, assessment: Assessment): Promise<void> {
    const row = (await tx.query<{ payload: Buffer; digest: string; assessment_id: string; handle: string }>(`SELECT s.payload,s.digest,s.assessment_id,s.handle
      FROM open_mint.assessments s JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)
      WHERE s.namespace_id=$1 AND s.handle=$2 AND a.state='accepted'`, [this.namespaceId, assessment.handle])).rows[0];
    if (!row || row.digest !== assessment.digest || row.assessment_id !== assessment.id || row.handle !== assessment.handle
      || !json(validateAssessment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)))).equals(json(assessment))) {
      throw new PersistenceConflictError("Generative inputs require the exact accepted assessment.");
    }
  }
  async stage(input: Assessment): Promise<PreparedGenerativeInputs> {
    const assessment = validateAssessment(structuredClone(input));
    const artifact = { ...prepareGenerativeInputs(assessment, this.rendererPin.identity, this.profile.inputProfile), assessment }, payload = json(artifact);
    await this.writer.transaction(async tx => {
      await this.guard?.(tx);
      await this.#accepted(tx, assessment);
      await tx.query(`INSERT INTO open_mint.generative_inputs(namespace_id,deployment_id,handle,digest,payload) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(namespace_id,deployment_id,handle) DO NOTHING`, [this.namespaceId, this.deploymentId, assessment.handle, artifact.digest, payload]);
      const row = (await tx.query<Stored>("SELECT handle,digest,payload FROM open_mint.generative_inputs WHERE namespace_id=$1 AND deployment_id=$2 AND handle=$3", [this.namespaceId, this.deploymentId, assessment.handle])).rows[0];
      if (!row || row.digest !== artifact.digest || !row.payload.equals(payload)) throw new PersistenceConflictError("Conflicting immutable generative inputs.");
      await this.guard?.(tx);
    });
    return artifact;
  }
  async load(handle: string): Promise<PreparedGenerativeInputs | undefined> {
    const row = await this.writer.transaction(async tx => {
      await this.guard?.(tx);
      const saved = (await tx.query<Stored>("SELECT handle,digest,payload FROM open_mint.generative_inputs WHERE namespace_id=$1 AND deployment_id=$2 AND handle=$3", [this.namespaceId, this.deploymentId, canonicalHandle(handle)])).rows[0];
      if (!saved) return undefined;
      if (!Buffer.isBuffer(saved.payload) || saved.payload.length > 65536) throw new PersistenceConflictError("Invalid generative input size.");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.payload)) as PreparedGenerativeInputs;
      const { assessment, ...artifact } = value;
      verifyGenerativeInputs(artifact, assessment, this.rendererPin.identity, this.profile.inputProfile); await this.#accepted(tx, assessment);
      if (saved.digest !== artifact.digest || saved.handle !== artifact.canonicalHandle || !json(value).equals(saved.payload)) throw new PersistenceConflictError("Generative input row mismatch.");
      await this.guard?.(tx);
      return value;
    });
    this.writer.assertHealthy(); return row;
  }
}
