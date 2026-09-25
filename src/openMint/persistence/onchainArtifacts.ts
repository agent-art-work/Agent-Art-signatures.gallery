import canonicalize from "canonicalize";
import { validateAssessment, type Assessment } from "../assessment.js";
import { prepareOnchainArtifact, verifyOnchainArtifact, ONCHAIN_ARTIFACT_DOMAIN, type OnchainArtifact } from "../onchainArtifact.js";
import { canonicalHandle, POLICY_VERSION } from "../identity.js";
import { ExclusiveWriter, PersistenceConflictError, type OwnershipConnection } from "./writer.js";

export interface PreparedOnchainArtifact extends OnchainArtifact { readonly assessment: Assessment }
type Transaction = Pick<OwnershipConnection, "query">;
const json = (value: unknown) => Buffer.from(canonicalize(value)!);
interface Stored { handle: string; digest: string; payload: Buffer }

/** Private pre-mint bytes, not a remote publication. Insert-only and bound to
 * the already accepted assessment in the same namespace. Frozen data is needed
 * for safe issuance/retry; minted artwork can be recovered from chain without it. */
export class PostgresOnchainArtifactJournal {
  private constructor(readonly writer: ExclusiveWriter, readonly namespaceId: string) {}
  static async open(writer: ExclusiveWriter, namespaceId: string): Promise<PostgresOnchainArtifactJournal> {
    await writer.transaction(async tx => {
      const row = (await tx.query<{ profile: string; provenance: string; policy_version: string }>(`SELECT p.profile,n.provenance,n.policy_version
        FROM open_mint.onchain_artifact_profiles p JOIN open_mint.namespaces n USING(namespace_id) WHERE namespace_id=$1`, [namespaceId])).rows[0];
      if (!row || row.profile !== ONCHAIN_ARTIFACT_DOMAIN || row.provenance !== "grok" || row.policy_version !== POLICY_VERSION) {
        throw new PersistenceConflictError("On-chain artifact namespace/profile mismatch.");
      }
    });
    return new PostgresOnchainArtifactJournal(writer, namespaceId);
  }
  async #accepted(tx: Transaction, assessment: Assessment): Promise<void> {
    const row = (await tx.query<{ payload: Buffer; digest: string; assessment_id: string; handle: string }>(`SELECT s.payload,s.digest,s.assessment_id,s.handle
      FROM open_mint.assessments s JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)
      WHERE s.namespace_id=$1 AND s.handle=$2 AND a.state='accepted'`, [this.namespaceId, assessment.handle])).rows[0];
    if (!row || row.digest !== assessment.digest || row.assessment_id !== assessment.id || row.handle !== assessment.handle
      || !json(validateAssessment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)))).equals(json(assessment))) {
      throw new PersistenceConflictError("On-chain artifact requires the exact accepted assessment.");
    }
  }
  async stage(input: Assessment): Promise<PreparedOnchainArtifact> {
    const assessment = validateAssessment(structuredClone(input));
    const artifact = { ...prepareOnchainArtifact(assessment), assessment }, payload = json(artifact);
    await this.writer.transaction(async tx => {
      await this.#accepted(tx, assessment);
      await tx.query(`INSERT INTO open_mint.onchain_artifacts(namespace_id,handle,digest,payload) VALUES($1,$2,$3,$4)
        ON CONFLICT(namespace_id,handle) DO NOTHING`, [this.namespaceId, assessment.handle, artifact.digest, payload]);
      const row = (await tx.query<Stored>("SELECT handle,digest,payload FROM open_mint.onchain_artifacts WHERE namespace_id=$1 AND handle=$2", [this.namespaceId, assessment.handle])).rows[0];
      if (!row || row.digest !== artifact.digest || !row.payload.equals(payload)) throw new PersistenceConflictError("Conflicting immutable on-chain artifact.");
    });
    return artifact;
  }
  async load(handle: string): Promise<PreparedOnchainArtifact | undefined> {
    const row = await this.writer.transaction(async tx => {
      const saved = (await tx.query<Stored>("SELECT handle,digest,payload FROM open_mint.onchain_artifacts WHERE namespace_id=$1 AND handle=$2", [this.namespaceId, canonicalHandle(handle)])).rows[0];
      if (!saved) return undefined;
      if (!Buffer.isBuffer(saved.payload) || saved.payload.length > 131072) throw new PersistenceConflictError("Invalid on-chain artifact size.");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.payload)) as PreparedOnchainArtifact;
      const { assessment, ...artifact } = value;
      verifyOnchainArtifact(artifact, assessment); await this.#accepted(tx, assessment);
      if (saved.digest !== artifact.digest || saved.handle !== artifact.canonicalHandle || !json(value).equals(saved.payload)) throw new PersistenceConflictError("On-chain artifact row mismatch.");
      return value;
    });
    this.writer.assertHealthy(); return row;
  }
}
