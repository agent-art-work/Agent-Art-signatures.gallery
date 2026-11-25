import { canonicalTime, DIGEST, UUID, verifyEnvelope } from "../../../.local/candidate-build/candidates/envelope.js";

// The test controller owns current access and witness rows outside either target.
// A non-null digest is an affirmative observation of a still-pending operation.
export const UNSEALED_OPERATION_DDL = `CREATE TABLE recovery_unsealed_operation (
  binding TEXT NOT NULL REFERENCES recovery_commission(binding),
  operation TEXT NOT NULL,
  encounter TEXT NOT NULL,
  curator TEXT NOT NULL,
  recover_from TEXT NOT NULL,
  recover_until TEXT NOT NULL,
  pending_envelope_sha TEXT,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  CHECK (recover_from < recover_until),
  PRIMARY KEY (binding, operation)
) STRICT`;

export async function privateUnsealedStatus({ control, identity, generation, custody, actor, operation, now }) {
  if (actor?.role !== "curator" || !actor.curatorId || typeof operation !== "string" || !UUID.test(operation)) return null;
  async function current(time) {
    if (!canonicalTime(time)) return null;
    try {
      return await control.prepare(`SELECT op.encounter, op.recover_from, op.recover_until, op.pending_envelope_sha
        FROM recovery_unsealed_operation op JOIN recovery_commission commission ON commission.binding = op.binding
        WHERE op.binding = ? AND op.operation = ? AND op.curator = ? AND op.revoked = 0
          AND op.recover_from <= ? AND ? < op.recover_until
          AND commission.destination = ? AND commission.generation = ?
          AND commission.cutoff_sha IS NULL AND commission.authority_sha IS NULL
          AND commission.source_retired = 1 AND commission.archive_retired = 1`)
        .bind(custody.binding, operation, actor.curatorId, time, time, identity, generation).first();
    } catch {
      return null;
    }
  }

  const startedAt = now();
  const witness = await current(startedAt);
  if (!witness) return null;
  let pending = false;
  if (DIGEST.test(witness.pending_envelope_sha ?? "")) {
    try {
      const record = await custody.archive.read(custody.binding, witness.encounter);
      if (record?.digest === witness.pending_envelope_sha) {
        const envelope = await verifyEnvelope(custody, record);
        pending = envelope.curator === actor.curatorId && envelope.encounter === witness.encounter
          && envelope.operation_id === operation && envelope.approved_at === witness.recover_from
          && envelope.recover_until === witness.recover_until;
      }
    } catch {
      // Archive outage or failed verification leaves the disposition unknown.
    }
  }

  const finishedAt = now();
  if (finishedAt < startedAt) return null;
  const latest = await current(finishedAt);
  if (!latest) return null;
  const witnessed = pending && latest.encounter === witness.encounter && latest.recover_from === witness.recover_from
    && latest.recover_until === witness.recover_until
    && latest.pending_envelope_sha === witness.pending_envelope_sha;
  return { operation, status: witnessed ? "pending" : "unknown" };
}
