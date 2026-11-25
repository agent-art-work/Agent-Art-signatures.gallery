import { applyEdit, basePoints, CandidateError, checkedHandle, curveSvg, EDIT_POLICY, readProposal, sha256, WORK_DEFINITION,
  type Proposal } from "./curve.js";
import type { Attempt } from "./store.js";
import { readPosts, type CitedPost } from "./posts.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
export const DIGEST = /^[0-9a-f]{64}(?![\s\S])/;
export const AUTHORITY_POLICY = "signatures-local-study-authority/1";
export const RENDERER = "signatures-study-centerline-renderer/1";
export const WRITE_MS = 15 * 60 * 1000;
export const RECOVERY_MS = 24 * 60 * 60 * 1000;
export const RIGHTS = ["write", "recovery", "disclosure"] as const;
export type Right = (typeof RIGHTS)[number];
export const PUBLIC_FIELDS = ["candidate", "handle", "intention", "svg", "svgSha256", "acceptedAt"] as const;
const workPattern = /^urn:signatures:study-work:/;
export function canonicalTime(time: unknown): time is string {
  return typeof time === "string" && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
}

export type SignedRecord = { body: string; digest: string; proof: string };
export type CommitArchive = {
  putIfAbsent(binding: string, encounter: string, record: SignedRecord): Promise<void>;
  read(binding: string, encounter: string): Promise<SignedRecord | null>;
  inventory(binding: string): Promise<{ encounter: string; digest: string }[]>;
};
export type CommitCustody = {
  binding: string;
  key: CryptoKey;
  archive: CommitArchive;
};
export type CommitReceipt = {
  schema: "signatures-local-candidate-receipt/1" | "signatures-local-candidate-receipt/2";
  operation: string;
  work: string;
  encounter: string;
  candidate: string;
  draftDigest: string;
  svgSha256: string;
  approvedAt: string;
  acceptedAt: string;
};
type Envelope = {
  schema: "signatures-private-commit/1" | "signatures-private-commit/2";
  binding: string;
  work: string;
  encounter: string;
  candidate: string;
  operation: string;
  requestFingerprint: string;
  definition: typeof WORK_DEFINITION;
  policy: typeof EDIT_POLICY.version;
  renderer: typeof RENDERER;
  handle: string;
  handleKey: string;
  authority: {
    basis: typeof AUTHORITY_POLICY | "signatures-local-curator-submission/2";
    curator: string;
    agent: string;
    approvedDigest: string;
    approvedAt: string;
    writeUntil: string;
    recoverUntil: string;
  };
  original: { geometry: string; geometrySha256: string; svg: string; svgSha256: string };
  act: { format: "parsed-study-proposal/1" | "fixed-curator-proposal/2"; edit: Proposal["edit"]; intention: string; intentionSha256: string; posts?: CitedPost[] };
  final: { svg: string; svgSha256: string };
  publicFields: typeof PUBLIC_FIELDS;
  receipt: string;
};

const encoder = new TextEncoder();
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}
function macInput(domain: string, body: string, digest: string) {
  return encoder.encode(JSON.stringify([domain, digest, body]));
}

export async function sealRecord(key: CryptoKey, domain: string, body: string): Promise<SignedRecord> {
  const digest = await sha256(body);
  const proof = hex(await crypto.subtle.sign("HMAC", key, macInput(domain, body, digest)));
  return { body, digest, proof };
}

export async function openRecord(key: CryptoKey, domain: string, record: SignedRecord): Promise<unknown> {
  if (!record || typeof record.body !== "string" || typeof record.digest !== "string"
      || typeof record.proof !== "string" || !DIGEST.test(record.proof)) {
    throw new CandidateError("invalid_archive_record", 409);
  }
  if (!DIGEST.test(record.digest) || await sha256(record.body) !== record.digest) {
    throw new CandidateError("invalid_archive_digest", 409);
  }
  const proof = Uint8Array.from(record.proof.match(/../g)!, byte => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, proof, macInput(domain, record.body, record.digest))) {
    throw new CandidateError("untrusted_archive_record", 409);
  }
  try { return JSON.parse(record.body); }
  catch { throw new CandidateError("invalid_archive_record", 409); }
}

export async function draftDigest(row: Pick<Attempt, "definition" | "policy" | "work_instance" | "encounter" |
  "handle" | "handle_key" | "original_sha" | "original_points" | "candidate_format">, proposal: Proposal & { posts?: CitedPost[] }, svgSha: string) {
  return sha256(JSON.stringify({
    schema: `signatures-candidate-draft/${row.candidate_format}`, definition: row.definition, policy: row.policy,
    work: row.work_instance, encounter: row.encounter, handle: row.handle, handleKey: row.handle_key,
    originalSvgSha256: row.original_sha, originalGeometrySha256: await sha256(row.original_points),
    ...proposal, finalSvgSha256: svgSha,
  }));
}

function fingerprint(encounter: string, digest: string, operation: string, format: 1 | 2) {
  return sha256(JSON.stringify([`submit-signature/${format}`, encounter, digest, operation]));
}

function receiptFor(row: Attempt, operation: string, time: string): CommitReceipt {
  return {
    schema: `signatures-local-candidate-receipt/${row.candidate_format}`, operation, work: row.work_instance,
    encounter: row.encounter, candidate: row.encounter, draftDigest: row.draft_digest!, svgSha256: row.final_sha!,
    approvedAt: row.approved_at!, acceptedAt: time,
  };
}

async function describeEnvelope(binding: string, row: Attempt, operation: string, time: string) {
  const receipt = JSON.stringify(receiptFor(row, operation, time));
  const envelope: Envelope = {
    schema: `signatures-private-commit/${row.candidate_format}`, binding,
    work: row.work_instance, encounter: row.encounter, candidate: row.encounter, operation,
    requestFingerprint: await fingerprint(row.encounter, row.draft_digest!, operation, row.candidate_format),
    definition: WORK_DEFINITION, policy: EDIT_POLICY.version, renderer: RENDERER,
    handle: row.handle, handleKey: row.handle_key,
    authority: {
      basis: row.candidate_format === 1 ? AUTHORITY_POLICY : "signatures-local-curator-submission/2", curator: row.curator, agent: row.agent,
      approvedDigest: row.approved_digest!, approvedAt: row.approved_at!,
      writeUntil: row.write_until!, recoverUntil: row.recover_until!,
    },
    original: {
      geometry: row.original_points, geometrySha256: await sha256(row.original_points),
      svg: row.original_svg, svgSha256: row.original_sha,
    },
    act: {
      format: row.candidate_format === 1 ? "parsed-study-proposal/1" : "fixed-curator-proposal/2", edit: JSON.parse(row.edit_json!), intention: row.intention!,
      intentionSha256: await sha256(row.intention!),
      ...(row.candidate_format === 2 ? { posts: JSON.parse(row.posts_json!) } : {}),
    },
    final: { svg: row.final_svg!, svgSha256: row.final_sha! },
    publicFields: PUBLIC_FIELDS, receipt,
  };
  return envelope;
}

export async function makeEnvelope(custody: CommitCustody, row: Attempt, operation: string, time: string) {
  const envelope = await describeEnvelope(custody.binding, row, operation, time);
  return {
    record: await sealRecord(custody.key, `signatures-commit-envelope/${row.candidate_format}`, JSON.stringify(envelope)),
    receipt: envelope.receipt,
  };
}

export async function verifyEnvelope(custody: CommitCustody, record: SignedRecord): Promise<Attempt> {
  let format: 1 | 2;
  try {
    const schema = JSON.parse(record.body).schema;
    if (schema !== "signatures-private-commit/1" && schema !== "signatures-private-commit/2") throw Error();
    format = schema === "signatures-private-commit/1" ? 1 : 2;
  } catch { throw new CandidateError("invalid_commit_envelope", 409); }
  const raw = await openRecord(custody.key, `signatures-commit-envelope/${format}`, record);
  try {
    const envelope = raw as Envelope;
    const { work, encounter, operation, authority, original, act, final } = envelope;
    const handle = checkedHandle(envelope.handle);
    if (envelope.binding !== custody.binding || !UUID.test(encounter) || !UUID.test(operation)
        || !workPattern.test(work) || !UUID.test(work.replace(workPattern, ""))
        || envelope.definition !== WORK_DEFINITION || envelope.policy !== EDIT_POLICY.version
        || envelope.renderer !== RENDERER || !canonicalTime(authority.approvedAt)) throw Error();
    const acceptedAt = (JSON.parse(envelope.receipt) as CommitReceipt).acceptedAt;
    if (!canonicalTime(acceptedAt) || authority.approvedAt > acceptedAt || acceptedAt >= authority.writeUntil
        || new Date(Date.parse(authority.approvedAt) + WRITE_MS).toISOString() !== authority.writeUntil
        || new Date(Date.parse(authority.approvedAt) + RECOVERY_MS).toISOString() !== authority.recoverUntil
        || typeof authority.curator !== "string" || !authority.curator || typeof authority.agent !== "string" || !authority.agent) {
      throw Error();
    }
    const points = basePoints(handle);
    const proposal = { ...readProposal({ edit: act.edit, intention: act.intention }),
      ...(format === 2 ? { posts: readPosts(act.posts, handle) } : {}) };
    if (JSON.stringify(points) !== original.geometry || curveSvg(handle, points) !== original.svg
        || curveSvg(handle, applyEdit(points, proposal.edit)) !== final.svg) throw Error();
    const row: Attempt = {
      encounter, work_instance: work, definition: WORK_DEFINITION, policy: EDIT_POLICY.version,
      curator: authority.curator, agent: authority.agent, handle, handle_key: handle.toLowerCase(),
      original_svg: original.svg, original_sha: await sha256(original.svg), original_points: original.geometry,
      candidate_format: format, posts_json: format === 2 ? JSON.stringify(proposal.posts) : null, local_state: "open",
      draft_digest: null, edit_json: JSON.stringify(proposal.edit), intention: proposal.intention,
      final_svg: final.svg, final_sha: await sha256(final.svg), approved_digest: authority.approvedDigest,
      approved_at: authority.approvedAt, write_until: authority.writeUntil, recover_until: authority.recoverUntil,
      operation_id: operation, receipt_json: envelope.receipt, accepted_at: acceptedAt,
      envelope_json: JSON.stringify(record), envelope_sha: record.digest,
    };
    row.draft_digest = await draftDigest(row, proposal, row.final_sha!);
    if (row.draft_digest !== row.approved_digest || row.final_sha === row.original_sha) throw Error();
    const expected = await describeEnvelope(custody.binding, row, operation, acceptedAt);
    if (JSON.stringify(expected) !== record.body) throw Error();
    return row;
  } catch {
    throw new CandidateError("invalid_commit_envelope", 409);
  }
}
