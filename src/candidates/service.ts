import {
  applyEdit, basePoints, CandidateError, checkedHandle, curveSvg, EDIT_POLICY, isShape, readProposal, sha256, WORK_DEFINITION,
} from "./curve.js";
import { candidateStore, type Actor, type Attempt, type CandidateDatabase } from "./store.js";
import { DIGEST, draftDigest, makeEnvelope, RECOVERY_MS, RIGHTS, UUID, verifyEnvelope, WRITE_MS,
  type CommitCustody, type CommitReceipt, type Right, type SignedRecord } from "./envelope.js";
import { readPosts } from "./posts.js";

export { DIGEST, UUID } from "./envelope.js";

function editDraft(row: Attempt) {
  if (!row.draft_digest) throw new CandidateError("draft_not_found", 404);
  return {
    work: row.work_instance, encounter: row.encounter, handle: row.handle, digest: row.draft_digest,
    original: { svg: row.original_svg, sha256: row.original_sha },
    edit: JSON.parse(row.edit_json!),
    intention: row.intention!,
    svg: row.final_svg!,
    svgSha256: row.final_sha!,
    approved: row.approved_digest === row.draft_digest,
    ...(row.candidate_format === 2 ? {
      format: 2 as const, posts: readPosts(JSON.parse(row.posts_json!), row.handle), localState: row.local_state,
      definition: row.definition, editPolicy: EDIT_POLICY, originalPoints: JSON.parse(row.original_points),
      operation: row.encounter,
    } : {}),
  };
}

function requireRole(actor: Actor, role: Actor["role"]) {
  if (!["curator", "agent"].includes(role) || actor.role !== role || !actor.curatorId || (role === "agent" && !actor.agentId)) {
    throw new CandidateError("role_not_permitted", 403);
  }
}

export function curveCandidates(db: CandidateDatabase, custody: CommitCustody, clock = () => new Date().toISOString(),
  format: 1 | 2 = 2) {
  if (!custody?.archive || !custody.binding || !custody.key) throw Error("commit custody is required");
  const store = candidateStore(db);
  const now = () => new Date(clock()).toISOString();

  function recoveryAuthority(row: Attempt, revoked: boolean) {
    if (!row.recover_until || !row.approved_at) throw new CandidateError("receipt_not_found", 404);
    const time = now();
    if (time < row.approved_at || time >= row.recover_until) throw new CandidateError("recovery_expired", 403);
    if (revoked) throw new CandidateError("recovery_revoked", 403);
  }

  const pending = (row: Attempt) => ({
    status: "pending_archive" as const, encounter: row.encounter, operation: row.operation_id!,
  });

  async function outcome(row: Attempt): Promise<CommitReceipt | ReturnType<typeof pending>> {
    const state = await store.exportState(row.encounter);
    recoveryAuthority(row, state?.recovery_revoked === 1);
    if (!state || state.quarantined) throw new CandidateError("archive_conflict", 409);
    return state.published_at ? JSON.parse(row.receipt_json!) : pending(row);
  }

  async function finishExport(row: Attempt) {
    const current = await outcome(row);
    if (!("status" in current)) return current;
    const record: SignedRecord = JSON.parse(row.envelope_json!);
    let retained;
    try {
      await custody.archive.putIfAbsent(custody.binding, row.encounter, record);
      retained = await custody.archive.read(custody.binding, row.encounter);
    } catch {
      return outcome(row);
    }
    if (!retained) return outcome(row);
    try {
      if (retained.digest !== row.envelope_sha || retained.digest !== record.digest
          || retained.proof !== record.proof || retained.body !== record.body) throw Error();
      const verified = await verifyEnvelope(custody, retained);
      if (verified.receipt_json !== row.receipt_json) throw Error();
    } catch {
      await store.quarantine(row.encounter, record.digest);
      throw new CandidateError("archive_conflict", 409);
    }
    try { await store.publish(row.encounter, retained.digest, now()); }
    catch { return outcome(row); }
    return outcome(row);
  }
  return {
    format,
    async start(actor: Actor, input: unknown) {
      requireRole(actor, "agent");
      if (!isShape(input, ["handle"])) throw new CandidateError("invalid_start");
      const handle = checkedHandle(input.handle);
      const points = basePoints(handle);
      const svg = curveSvg(handle, points);
      const digest = await sha256(svg);
      const [encounter, work] = [crypto.randomUUID(), `urn:signatures:study-work:${crypto.randomUUID()}`];
      await store.start({
        encounter, work_instance: work, definition: WORK_DEFINITION, policy: EDIT_POLICY.version, curator: actor.curatorId,
        agent: actor.agentId!, handle, handle_key: handle.toLowerCase(), original_svg: svg, original_sha: digest,
        original_points: JSON.stringify(points),
        candidate_format: format,
      });
      return { work, definition: WORK_DEFINITION, encounter, handle, editPolicy: EDIT_POLICY, original: { points, svg, sha256: digest } };
    },
    async propose(actor: Actor, input: unknown) {
      requireRole(actor, "agent");
      if (!isShape(input, ["encounter", "previousDigest", "edit", "intention"], ["posts"])
          || typeof input.encounter !== "string" || !UUID.test(input.encounter)
          || (input.previousDigest !== null && (typeof input.previousDigest !== "string" || !DIGEST.test(input.previousDigest)))) {
        throw new CandidateError("invalid_proposal");
      }
      const row = await store.owned(actor, input.encounter);
      if (row.receipt_json) throw new CandidateError("attempt_already_committed", 409);
      if (row.local_state === "declined") throw new CandidateError("encounter_declined", 409);
      if (row.candidate_format === 2 && input.previousDigest !== null) throw new CandidateError("proposal_is_fixed", 409);
      if (row.candidate_format === 1 && Object.hasOwn(input, "posts")) throw new CandidateError("invalid_proposal");
      const proposal = { ...readProposal({ edit: input.edit, intention: input.intention }),
        ...(row.candidate_format === 2 ? { posts: readPosts(input.posts, row.handle) } : {}) };
      if (row.policy !== EDIT_POLICY.version || row.definition !== WORK_DEFINITION) throw new CandidateError("policy_unavailable", 409);
      const points = JSON.parse(row.original_points);
      const svg = curveSvg(row.handle, applyEdit(points, proposal.edit));
      const svgSha = await sha256(svg);
      if (svgSha === row.original_sha) throw new CandidateError("edit_does_not_change_art");
      const digest = await draftDigest(row, proposal, svgSha);
      if (row.draft_digest !== digest) {
        const updated = await store.propose(actor, row.encounter, input.previousDigest as string | null,
          { digest, edit: JSON.stringify(proposal.edit), intention: proposal.intention, svg, svgSha,
            posts: row.candidate_format === 2 ? JSON.stringify(proposal.posts) : null });
        if (updated) return editDraft(updated);
      }
      const current = await store.owned(actor, row.encounter);
      if (current.receipt_json) throw new CandidateError("attempt_already_committed", 409);
      if (current.draft_digest === digest) return editDraft(current);
      throw new CandidateError(row.candidate_format === 2 ? "proposal_is_fixed" : "draft_changed_or_locked", 409);
    },
    async review(actor: Actor, encounter: string) {
      requireRole(actor, actor.role);
      const row = await store.owned(actor, encounter);
      if (row.receipt_json) recoveryAuthority(row, Boolean(await store.restriction(encounter, "recovery")));
      return editDraft(row);
    },
    async encounter(actor: Actor, encounter: string) {
      requireRole(actor, "curator");
      const row = await store.owned(actor, encounter);
      return { encounter, handle: row.handle, digest: row.draft_digest, localState: row.local_state };
    },
    async approve(actor: Actor, encounter: string, digest: string) {
      requireRole(actor, "curator");
      if ((await store.owned(actor, encounter)).candidate_format === 2) throw new CandidateError("explicit_submission_required", 409);
      if (!DIGEST.test(digest)) throw new CandidateError("invalid_draft_digest");
      const approvedAt = now();
      const row = await store.approve(actor, encounter, digest, approvedAt,
        new Date(Date.parse(approvedAt) + WRITE_MS).toISOString(), new Date(Date.parse(approvedAt) + RECOVERY_MS).toISOString());
      return { encounter, digest, approvedAt: row.approved_at, writeUntil: row.write_until, recoverUntil: row.recover_until };
    },
    async leaveLocal(actor: Actor, encounter: string, digest: string | null, state: "saved" | "declined") {
      requireRole(actor, "curator");
      if (state !== "saved" && state !== "declined") throw new CandidateError("invalid_local_decision");
      await store.owned(actor, encounter);
      const row = await store.leaveLocal(actor, encounter, digest, state);
      return { encounter, status: row.local_state };
    },
    async revoke(actor: Actor, encounter: string, right: Right) {
      requireRole(actor, "curator");
      if (!RIGHTS.includes(right)) throw new CandidateError("invalid_right");
      await store.owned(actor, encounter);
      await store.restrict(encounter, right, now());
    },
    async submit(actor: Actor, input: unknown) {
      requireRole(actor, actor.role);
      if (!isShape(input, ["encounter", "digest", "operation"]) || typeof input.encounter !== "string" || !UUID.test(input.encounter)
          || typeof input.digest !== "string" || !DIGEST.test(input.digest)
          || typeof input.operation !== "string" || !UUID.test(input.operation)) throw new CandidateError("invalid_submission");
      let row = await store.owned(actor, input.encounter);
      requireRole(actor, row.candidate_format === 2 ? "curator" : "agent");
      if (row.candidate_format === 2 && input.operation !== row.encounter) throw new CandidateError("exact_operation_required", 409);
      if (row.receipt_json) {
        if (row.operation_id !== input.operation || row.draft_digest !== input.digest) {
          await outcome(row);
          throw new CandidateError("attempt_already_accepted", 409);
        }
        return finishExport(row);
      }
      if (row.local_state === "declined") throw new CandidateError("encounter_declined", 409);
      if (row.candidate_format === 2 && row.draft_digest === input.digest && row.approved_digest === null) {
        const approvedAt = now();
        try {
          row = await store.approve(actor, row.encounter, input.digest, approvedAt,
            new Date(Date.parse(approvedAt) + WRITE_MS).toISOString(), new Date(Date.parse(approvedAt) + RECOVERY_MS).toISOString());
        } catch (error) {
          const concurrent = await store.owned(actor, row.encounter);
          if (concurrent.receipt_json && concurrent.operation_id === input.operation && concurrent.draft_digest === input.digest) {
            return finishExport(concurrent);
          }
          throw error;
        }
      }
      if (row.draft_digest !== input.digest || row.approved_digest !== input.digest) throw new CandidateError("exact_approval_required", 409);
      const time = now();
      if (!row.approved_at || !row.write_until || time < row.approved_at || time >= row.write_until) {
        throw new CandidateError("write_expired", 403);
      }
      const { record, receipt } = await makeEnvelope(custody, row, input.operation, time);
      // Detect stored content substitution before creating a receipt or outbox entry.
      await verifyEnvelope(custody, record);
      const saved = await store.commit(actor, row.encounter, input.digest, input.operation, receipt, time, now(), record);
      return finishExport(saved);
    },
    async receipt(actor: Actor, encounter: string) {
      requireRole(actor, actor.role);
      const row = await store.owned(actor, encounter);
      if (!row.receipt_json) throw new CandidateError("receipt_not_found", 404);
      return outcome(row);
    },
    gallery: store.gallery,
    artwork: store.artwork,
    observeMint: store.observeMint,
  };
}

export type CandidateService = ReturnType<typeof curveCandidates>;
