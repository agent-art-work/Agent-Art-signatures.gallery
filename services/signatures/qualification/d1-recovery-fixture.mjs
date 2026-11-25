// Local qualification adapter. Control, destination and archive are separate D1
// bindings. The controller provisions their trusted state in the test harness.
import { CandidateError } from "../../../.local/candidate-build/candidates/curve.js";
import { DIGEST } from "../../../.local/candidate-build/candidates/envelope.js";
import { restoreCandidates } from "../../../.local/candidate-build/candidates/restore.js";

export const GATE_DDL = [
  `CREATE TABLE recovery_gate (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    identity TEXT NOT NULL, generation INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('write', 'retired', 'closed', 'inspect')),
    cutoff_sha TEXT, authority_sha TEXT, restored_count INTEGER
  ) STRICT`,
  `CREATE TABLE recovery_guard (
    ok INTEGER NOT NULL CONSTRAINT gate_assertion CHECK (ok = 1)
  ) STRICT`,
];

export const COMMISSION_DDL = `CREATE TABLE recovery_commission (
  binding TEXT PRIMARY KEY,
  destination TEXT NOT NULL, generation INTEGER NOT NULL,
  cutoff_sha TEXT, authority_sha TEXT,
  source_retired INTEGER NOT NULL CHECK (source_retired IN (0, 1)),
  archive_retired INTEGER NOT NULL CHECK (archive_retired IN (0, 1))
) STRICT`;

const bind = (db, sql, ...parameters) => db.prepare(sql).bind(...parameters);
const statement = (sql, ...parameters) => ({ sql, parameters });

async function guardedBatch(db, predicate, parameters, effects) {
  const result = await db.batch([
    bind(db, "INSERT INTO recovery_guard(ok) SELECT CASE WHEN " + predicate + " THEN 1 ELSE 0 END", ...parameters),
    ...effects.map(({ sql, parameters: values }) => bind(db, sql, ...values)),
    db.prepare("DELETE FROM recovery_guard"),
  ]);
  return result.slice(1, -1);
}

export async function initializeGate(db, identity, generation, phase, cutoff = null, authority = null) {
  await db.batch([
    ...GATE_DDL.map(sql => db.prepare(sql)),
    bind(db, "INSERT INTO recovery_gate VALUES (1, ?, ?, ?, ?, ?, NULL)", identity, generation, phase, cutoff, authority),
  ]);
}

export async function retireGate(db, identity, generation) {
  return bind(db, `UPDATE recovery_gate SET phase = 'retired'
    WHERE slot = 1 AND identity = ? AND generation = ? AND phase = 'write'
    RETURNING identity, generation, phase`, identity, generation).first();
}

// Only the fixed, trusted SQL of the candidate and archive modules reaches this adapter.
// Fence authorization and mutation execute in one transaction on each binding.
export function qualifiedWriter(db, identity, generation) {
  return {
    prepare(sql) {
      if (/^SELECT\b/i.test(sql.trimStart())) return db.prepare(sql);
      if (!/^(?:INSERT INTO|UPDATE) curve_(?:attempts|outbox|restrictions|winners|commit_archive)\b/.test(sql.trimStart())) {
        throw new Error("Unexpected SQL for recovery qualification");
      }
      return { bind(...parameters) {
        const run = async () => (await guardedBatch(db, `EXISTS (
          SELECT 1 FROM recovery_gate WHERE slot = 1 AND identity = ? AND generation = ? AND phase = 'write'
        )`, [identity, generation], [{ sql, parameters }]))[0];
        return { first: async () => (await run()).results[0] ?? null, all: run };
      } };
    },
  };
}

async function currentCommission(control, binding, identity, generation) {
  const row = await bind(control, `SELECT cutoff_sha, authority_sha FROM recovery_commission
    WHERE binding = ? AND destination = ? AND generation = ? AND source_retired = 1 AND archive_retired = 1`,
  binding, identity, generation).first();
  return row && DIGEST.test(row.cutoff_sha ?? "") && DIGEST.test(row.authority_sha ?? "") ? row : null;
}

export async function restoredInspectionAllowed(control, destination, binding, identity, generation) {
  const head = await currentCommission(control, binding, identity, generation);
  if (!head) return false;
  const row = await bind(destination, `SELECT 1 AS allowed FROM recovery_gate
    WHERE slot = 1 AND identity = ? AND generation = ? AND phase = 'inspect'
    AND cutoff_sha = ? AND authority_sha = ?`, identity, generation, head.cutoff_sha, head.authority_sha).first();
  return row?.allowed === 1;
}

const fieldNames = [
  "encounter", "work_instance", "definition", "policy", "curator", "agent", "handle", "handle_key",
  "original_svg", "original_sha", "original_points", "draft_digest", "edit_json", "intention", "final_svg", "final_sha",
  "approved_digest", "approved_at", "write_until", "recover_until", "candidate_format", "posts_json", "local_state",
];
const insertCandidate = `INSERT INTO curve_attempts (${fieldNames.join(", ")}) VALUES (${fieldNames.map(() => "?").join(", ")})`;

export async function restoreD1Fixture({ control, destination, identity, generation, custody, authorityKey, cutoff, authority }) {
  const head = await currentCommission(control, custody.binding, identity, generation);
  if (!head || cutoff?.digest !== head.cutoff_sha || authority?.digest !== head.authority_sha) {
    throw new CandidateError("restore_authority_required", 409);
  }

  let staged;
  const count = await restoreCandidates({
    custody, authorityKey, cutoff, authority, expectedCutoffDigest: head.cutoff_sha, latestAuthorityDigest: head.authority_sha,
    async hasExclusiveRestoreAuthority() {
      const current = await currentCommission(control, custody.binding, identity, generation);
      return current?.cutoff_sha === head.cutoff_sha && current?.authority_sha === head.authority_sha;
    },
    importAtomically(rows, revocations, asOf) {
      // The verifier hands off staged bytes. Only the D1 batch below imports them.
      staged = { rows, revocations, asOf };
    },
  });

  const effects = [];
  for (const row of staged.rows) {
    effects.push(statement(insertCandidate, ...fieldNames.map(field => row[field])));
    effects.push(statement(`UPDATE curve_attempts
      SET operation_id = ?, receipt_json = ?, accepted_at = ?, envelope_json = ?, envelope_sha = ? WHERE encounter = ?`,
    row.operation_id, row.receipt_json, row.accepted_at, row.envelope_json, row.envelope_sha, row.encounter));
  }
  for (const revoked of staged.revocations) {
    effects.push(statement("INSERT INTO curve_restrictions VALUES (?, ?, ?)",
      revoked.encounter, revoked.right, revoked.revokedAt));
  }
  effects.push(statement("UPDATE curve_outbox SET published_at = ?", staged.asOf));
  effects.push(statement(`DELETE FROM curve_gallery WHERE candidate_id IN (
    SELECT encounter FROM curve_restrictions WHERE right_name = 'disclosure'
  )`));
  effects.push(statement("UPDATE recovery_gate SET phase = 'inspect', restored_count = ? WHERE slot = 1", count));

  const match = `slot = 1 AND identity = ? AND generation = ? AND cutoff_sha = ? AND authority_sha = ?`;
  const parameters = [identity, generation, head.cutoff_sha, head.authority_sha];
  try {
    await guardedBatch(destination, `EXISTS (SELECT 1 FROM recovery_gate WHERE ${match} AND phase = 'closed')
      AND NOT EXISTS (SELECT 1 FROM curve_attempts) AND NOT EXISTS (SELECT 1 FROM curve_outbox)
      AND NOT EXISTS (SELECT 1 FROM curve_gallery) AND NOT EXISTS (SELECT 1 FROM curve_restrictions)
      AND NOT EXISTS (SELECT 1 FROM curve_winners)`, parameters, effects);
  } catch (error) {
    // Only the marker committed with this exact import can acknowledge a lost response.
    const previous = await bind(destination, `SELECT restored_count FROM recovery_gate
      WHERE ${match} AND phase = 'inspect'`, ...parameters).first();
    if (previous?.restored_count !== count) throw error;
  }
  if (!await restoredInspectionAllowed(control, destination, custody.binding, identity, generation)) {
    throw new CandidateError("restore_authority_required", 409);
  }
  return count;
}
