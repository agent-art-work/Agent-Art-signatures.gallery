import { CandidateError, isShape } from "./curve.js";
import { canonicalTime, DIGEST, openRecord, RIGHTS, UUID, verifyEnvelope, type CommitCustody, type Right,
  type SignedRecord } from "./envelope.js";
import type { Attempt } from "./store.js";

export const CUTOFF_DOMAIN = "signatures-archive-cutoff/1";
export const RIGHTS_DOMAIN = "signatures-restore-authority/1";
export type ArchiveCutoff = {
  schema: typeof CUTOFF_DOMAIN;
  binding: string;
  profile: "unminted-study/1";
  cutoffAt: string;
  entries: { encounter: string; digest: string }[];
};
export type Revocation = { encounter: string; right: Right; revokedAt: string };
export type RestoreAuthority = {
  schema: typeof RIGHTS_DOMAIN;
  binding: string;
  cutoffDigest: string;
  asOf: string;
  revocations: Revocation[];
};

const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function inventoryKey(entries: ArchiveCutoff["entries"]) {
  return JSON.stringify(entries.map(({ encounter, digest }) => [encounter, digest]).sort(([a], [b]) => ordered(a, b)));
}

export async function restoreCandidates({
  custody, authorityKey, cutoff, authority, expectedCutoffDigest, latestAuthorityDigest,
  hasExclusiveRestoreAuthority, importAtomically,
}: {
  custody: CommitCustody;
  authorityKey: CryptoKey;
  cutoff: SignedRecord;
  authority: SignedRecord;
  expectedCutoffDigest: string;
  latestAuthorityDigest: string;
  hasExclusiveRestoreAuthority: () => Promise<boolean>;
  importAtomically: (rows: Attempt[], revocations: Revocation[], asOf: string) => void;
}) {
  if (!await hasExclusiveRestoreAuthority() || cutoff.digest !== expectedCutoffDigest || authority.digest !== latestAuthorityDigest) {
    throw new CandidateError("restore_authority_required", 409);
  }
  const plan = await openRecord(authorityKey, CUTOFF_DOMAIN, cutoff) as ArchiveCutoff;
  const rights = await openRecord(authorityKey, RIGHTS_DOMAIN, authority) as RestoreAuthority;
  if (!isShape(plan, ["schema", "binding", "profile", "cutoffAt", "entries"]) || plan.schema !== CUTOFF_DOMAIN || plan.profile !== "unminted-study/1"
      || plan.binding !== custody.binding || !canonicalTime(plan.cutoffAt) || !Array.isArray(plan.entries) || !plan.entries.length
      || !isShape(rights, ["schema", "binding", "cutoffDigest", "asOf", "revocations"]) || rights.schema !== RIGHTS_DOMAIN
      || rights.binding !== custody.binding || rights.cutoffDigest !== cutoff.digest || !canonicalTime(rights.asOf)
      || rights.asOf < plan.cutoffAt || !Array.isArray(rights.revocations)) {
    throw new CandidateError("restore_checkpoint_invalid", 409);
  }
  const identifiers = new Set<string>();
  for (const entry of plan.entries) {
    if (!isShape(entry, ["encounter", "digest"]) || typeof entry.encounter !== "string" || !UUID.test(entry.encounter)
        || typeof entry.digest !== "string" || !DIGEST.test(entry.digest)
        || identifiers.has(entry.encounter)) throw new CandidateError("restore_checkpoint_invalid", 409);
    identifiers.add(entry.encounter);
  }
  const want = inventoryKey(plan.entries);
  const inventory = () => custody.archive.inventory(custody.binding);
  if (want !== inventoryKey(await inventory())) throw new CandidateError("restore_archive_incomplete_or_conflicting", 409);
  const rows = [];
  const workInstances = new Set<string>();
  for (const entry of plan.entries) {
    const record = await custody.archive.read(custody.binding, entry.encounter);
    if (!record || record.digest !== entry.digest) throw new CandidateError("restore_archive_incomplete_or_conflicting", 409);
    const row = await verifyEnvelope(custody, record);
    if (row.encounter !== entry.encounter || row.accepted_at! > plan.cutoffAt || workInstances.has(row.work_instance)) {
      throw new CandidateError("restore_scope_conflict", 409);
    }
    workInstances.add(row.work_instance);
    rows.push(row);
  }
  const byId = new Map(rows.map(row => [row.encounter, row]));
  const revoked = new Set<string>();
  for (const item of rights.revocations) {
    const row = item && byId.get(item.encounter);
    if (!isShape(item, ["encounter", "right", "revokedAt"]) || !row || !RIGHTS.includes(item.right)
        || !canonicalTime(item.revokedAt) || item.revokedAt > rights.asOf
        || ((item.right === "write" || item.right === "recovery") && item.revokedAt < row.accepted_at!)
        || revoked.has(item.encounter + "/" + item.right)) throw new CandidateError("restore_authority_conflict", 409);
    revoked.add(item.encounter + "/" + item.right);
  }
  if (want !== inventoryKey(await inventory()) || !await hasExclusiveRestoreAuthority()) {
    throw new CandidateError("restore_scope_changed", 409);
  }
  rows.sort((a, b) => ordered(a.accepted_at!, b.accepted_at!) || ordered(a.encounter, b.encounter));
  importAtomically(rows, rights.revocations, rights.asOf);
  return rows.length;
}
