import { CandidateError } from "./curve.js";
import type { Right, SignedRecord } from "./envelope.js";

type Value = string | number | null;
export interface CandidateDatabase {
  prepare(sql: string): {
    bind(...values: Value[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

export type Actor = { role: "curator" | "agent"; curatorId: string; agentId?: string };
export type Attempt = {
  encounter: string; work_instance: string; definition: string; policy: string;
  curator: string; agent: string; handle: string; handle_key: string;
  original_svg: string; original_sha: string; original_points: string;
  candidate_format: 1 | 2; posts_json: string | null; local_state: "open" | "saved" | "declined";
  draft_digest: string | null; edit_json: string | null; intention: string | null; final_svg: string | null;
  final_sha: string | null; approved_digest: string | null; approved_at: string | null;
  write_until: string | null; recover_until: string | null;
  operation_id: string | null; receipt_json: string | null; accepted_at: string | null;
  envelope_json: string | null; envelope_sha: string | null;
};
export type GalleryRow = {
  sequence: number; candidate_id: string; handle: string; handle_key: string; intention: string;
  svg_sha: string; accepted_at: string; winner: string | null; winning_token: string | null;
};
type ExportState = { published_at: string | null; quarantined: 0 | 1; recovery_revoked: 0 | 1 };
type Winner = { candidate_id: string; token_id: string; transaction_hash: string; finalized_block: string };
export type FinalityObservation = {
  state: "pending" | "reorged" | "finalized";
  candidateId: string; draftDigest: string; tokenId: string; transactionHash: string; block: string;
};

export function candidateStore(db: CandidateDatabase) {
  const statement = (sql: string, ...args: Value[]) => db.prepare(sql).bind(...args);
  const find = (actor: Actor, encounter: string) => statement(
    `SELECT * FROM curve_attempts WHERE encounter = ? AND curator = ? AND (? = 'curator' OR agent = ?)`,
    encounter, actor.curatorId, actor.role, actor.agentId ?? null,
  ).first<Attempt>();

  async function owned(actor: Actor, encounter: string): Promise<Attempt> {
    const row = await find(actor, encounter);
    if (!row) throw new CandidateError("attempt_not_found", 404);
    return row;
  }

  return {
    owned,
    async start(fields: Pick<Attempt, "encounter" | "work_instance" | "definition" | "policy" | "curator" | "agent" |
      "handle" | "handle_key" | "original_svg" | "original_sha" | "original_points" | "candidate_format">) {
      return statement(`INSERT INTO curve_attempts (
        encounter, work_instance, definition, policy, curator, agent, handle, handle_key, original_svg, original_sha, original_points, candidate_format
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING encounter`,
      fields.encounter, fields.work_instance, fields.definition, fields.policy, fields.curator, fields.agent,
      fields.handle, fields.handle_key, fields.original_svg, fields.original_sha, fields.original_points, fields.candidate_format).first<{ encounter: string }>();
    },
    propose(actor: Actor, id: string, previous: string | null, draft: {
      digest: string; edit: string; intention: string; svg: string; svgSha: string; posts: string | null;
    }) {
      return statement(`UPDATE curve_attempts SET draft_digest = ?, edit_json = ?, intention = ?, final_svg = ?, final_sha = ?, posts_json = ?
        WHERE encounter = ? AND curator = ? AND agent = ? AND draft_digest IS ? AND approved_digest IS NULL
        AND local_state != 'declined' AND (candidate_format = 1 OR draft_digest IS NULL)
        RETURNING *`, draft.digest, draft.edit, draft.intention, draft.svg, draft.svgSha, draft.posts,
      id, actor.curatorId, actor.agentId ?? null, previous).first<Attempt>();
    },
    async approve(actor: Actor, id: string, digest: string, time: string, writeUntil: string, recoverUntil: string) {
      const approved = await statement(`UPDATE curve_attempts
        SET approved_digest = ?, approved_at = ?, write_until = ?, recover_until = ?
        WHERE encounter = ? AND curator = ? AND draft_digest = ? AND approved_digest IS NULL AND local_state != 'declined' RETURNING *`,
      digest, time, writeUntil, recoverUntil, id, actor.curatorId, digest).first<Attempt>();
      if (approved) return approved;
      const row = await owned(actor, id);
      if (row.receipt_json) throw new CandidateError("attempt_already_committed", 409);
      if (row.local_state === "declined") throw new CandidateError("encounter_declined", 409);
      if (row.approved_digest === digest && row.approved_at) return row;
      throw new CandidateError("draft_changed", 409);
    },
    async leaveLocal(actor: Actor, id: string, digest: string | null, state: "saved" | "declined") {
      const row = await statement(`UPDATE curve_attempts SET local_state = ?
        WHERE encounter = ? AND curator = ? AND candidate_format = 2 AND draft_digest IS ?
        AND receipt_json IS NULL AND approved_digest IS NULL AND local_state != 'declined' RETURNING *`,
      state, id, actor.curatorId, digest).first<Attempt>();
      if (row) return row;
      throw new CandidateError("local_decision_unavailable", 409);
    },
    restriction(id: string, right: Right) {
      return statement(`SELECT revoked_at FROM curve_restrictions WHERE encounter = ? AND right_name = ?`, id, right)
        .first<{ revoked_at: string }>();
    },
    restrict(id: string, right: Right, time: string) {
      return statement(`INSERT INTO curve_restrictions(encounter, right_name, revoked_at) VALUES (?, ?, ?)
        ON CONFLICT DO NOTHING RETURNING revoked_at`, id, right, time).first<{ revoked_at: string }>();
    },
    async commit(actor: Actor, id: string, digest: string, operation: string, receipt: string, time: string,
      checkedAt: string, record: SignedRecord): Promise<Attempt> {
      const committed = await statement(`UPDATE curve_attempts
        SET operation_id = ?, receipt_json = ?, accepted_at = ?, envelope_json = ?, envelope_sha = ?
        WHERE encounter = ? AND curator = ? AND (? = 'curator' OR agent = ?) AND draft_digest = ? AND approved_digest = ?
        AND local_state != 'declined'
        AND receipt_json IS NULL AND approved_at <= ? AND ? < write_until
        AND NOT EXISTS (SELECT 1 FROM curve_restrictions WHERE encounter = ? AND right_name IN ('write', 'recovery'))
        RETURNING *`, operation, receipt, time, JSON.stringify(record), record.digest,
      id, actor.curatorId, actor.role, actor.agentId ?? null, digest, digest, checkedAt, checkedAt, id).first<Attempt>();
      if (committed) return committed;
      const previous = await owned(actor, id);
      if (previous.receipt_json) {
        if (previous.operation_id === operation && previous.draft_digest === digest) return previous;
        throw new CandidateError("attempt_already_accepted", 409);
      }
      throw new CandidateError("write_authority_changed", 409);
    },
    exportState(id: string) {
      return statement(`SELECT published_at, quarantined, EXISTS (SELECT 1 FROM curve_restrictions
        WHERE encounter = candidate_id AND right_name = 'recovery') AS recovery_revoked
        FROM curve_outbox WHERE candidate_id = ?`, id).first<ExportState>();
    },
    quarantine(id: string, digest: string) {
      return statement(`UPDATE curve_outbox SET quarantined = 1
        WHERE candidate_id = ? AND envelope_sha = ? AND published_at IS NULL RETURNING quarantined`, id, digest).first();
    },
    async publish(id: string, digest: string, time: string) {
      const result = await statement(`UPDATE curve_outbox SET published_at = ?
        WHERE candidate_id = ? AND envelope_sha = ? AND published_at IS NULL AND quarantined = 0
        AND EXISTS (SELECT 1 FROM curve_attempts WHERE encounter = ? AND ? < recover_until AND approved_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM curve_restrictions WHERE encounter = ? AND right_name = 'recovery')
        RETURNING published_at`, time, id, digest, id, time, time, id).first<{ published_at: string }>();
      return result !== null;
    },
    async gallery(handleKey: string | null, before: number, limit: number) {
      const filter = handleKey !== null ? "g.handle_key = ? AND" : "";
      const result = await statement(`SELECT g.sequence, g.candidate_id, g.handle, g.handle_key, g.intention, g.svg_sha, g.accepted_at,
        w.candidate_id AS winner, w.token_id AS winning_token FROM curve_gallery g
        LEFT JOIN curve_winners w ON w.handle_key = g.handle_key WHERE ${filter} g.sequence < ?
        AND NOT EXISTS (SELECT 1 FROM curve_restrictions r WHERE r.encounter = g.candidate_id AND r.right_name = 'disclosure')
        ORDER BY g.sequence DESC LIMIT ?`, ...(handleKey !== null ? [handleKey] : []), before, limit).all<GalleryRow>();
      return result.results;
    },
    artwork(id: string, digest: string) {
      return statement(`SELECT svg FROM curve_gallery g WHERE candidate_id = ? AND svg_sha = ?
        AND NOT EXISTS (SELECT 1 FROM curve_restrictions r WHERE r.encounter = g.candidate_id AND r.right_name = 'disclosure')`, id, digest).first<{ svg: string }>();
    },
    // Offline model for the trusted projector. Call only after verifying the designated contract and chain finality.
    async observeMint(observation: FinalityObservation): Promise<"ignored" | "canonical"> {
      if (observation.state !== "finalized") return "ignored";
      const { candidateId, draftDigest, tokenId, transactionHash, block } = observation;
      if (!/^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(tokenId)
          || !/^[1-9][0-9]{0,77}(?![\s\S])/.test(block) || !/^0x[0-9a-f]{64}(?![\s\S])/.test(transactionHash)) {
        throw new CandidateError("invalid_finalized_observation");
      }
      const created = await statement(`INSERT INTO curve_winners(handle_key, candidate_id, token_id, transaction_hash, finalized_block)
        SELECT handle_key, candidate_id, ?, ?, ? FROM curve_gallery WHERE candidate_id = ? AND draft_digest = ?
        ON CONFLICT DO NOTHING RETURNING candidate_id`,
      tokenId, transactionHash, block, candidateId, draftDigest).first<{ candidate_id: string }>();
      if (created) return "canonical";
      const row = await statement(`SELECT w.candidate_id, w.token_id, w.transaction_hash, w.finalized_block
        FROM curve_gallery g LEFT JOIN curve_winners w ON w.handle_key = g.handle_key
        WHERE g.candidate_id = ? AND g.draft_digest = ?`, candidateId, draftDigest).first<Winner>();
      if (row?.candidate_id === candidateId && row.token_id === tokenId
          && row.transaction_hash === transactionHash && row.finalized_block === block) return "canonical";
      throw new CandidateError(row ? "finality_conflict" : "candidate_commitment_not_found", 409);
    },
  };
}
