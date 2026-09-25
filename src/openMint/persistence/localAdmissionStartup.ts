import { performance } from "node:perf_hooks";
import { admissionDigest, captureAdmissionScope, type AdmissionOperation } from "../staging/admission.js";
import { openLocalReviewFile, type LocalReviewFileConfig } from "../staging/localReviewFile.js";
import { observeLocalAssessmentBinding } from "./assessmentAdmission.js";
import { observeLocalMintBinding } from "./mintAdmission.js";
import { LocalAdmissionRuntime } from "./localAdmissionRuntime.js";
import type { PostgresMintRequests } from "./requests.js";

const unavailable = (): never => { throw new Error("Local admission startup unavailable."); };
const check = (ok: unknown): void => { if (!ok) unavailable(); };
const assessmentOps = ["reuse", "assessment-x", "assessment-grok"] as const;
const mintOps = ["reuse", "sign", "wallet-submit"] as const;

/** Explicit local-only factory after acquiring the exclusive writer. Preflight
 * reads/audits; it does not initialize a DB, grant roles, create reviews, start
 * listening, load signer/provider credentials, enable switches or spend.
 * Call recheck() again immediately before handing the runtime to a listener.
 * This is not public database/custody certification or a serialized approval. */
export async function prepareLocalAdmissionStartup(input: {
  requests: PostgresMintRequests; expectedRole: string;
  assessment: LocalReviewFileConfig; mint: LocalReviewFileConfig;
}, signal = new AbortController().signal) {
  let files: ReturnType<typeof openLocalReviewFile>[] = [], admission: LocalAdmissionRuntime | undefined, halted = false;
  const halt = () => { halted = true; for (const file of files) file.halt(); admission?.halt(); };
  try {
    const { requests, expectedRole } = input, writer = requests.repository.writer;
    check(process.env.NODE_ENV !== "production" && requests.repository.namespace.profile === "local-real"
      && requests.repository.namespace.provenance === "grok" && requests.profile.chain_id === "31337");
    const assessment = captureAdmissionScope(input.assessment.scope), mint = captureAdmissionScope(input.mint.scope);
    const common = (s: typeof assessment) => { const { databaseBindingSha256: _db, reviewRevisionSha256: _review, ...rest } = s; return rest; };
    check(assessment.writerEpoch === writer.epoch && admissionDigest(common(assessment)) === admissionDigest(common(mint)));
    signal.throwIfAborted(); writer.assertHealthy();
    const a = openLocalReviewFile({ ...input.assessment, scope: assessment }); files.push(a);
    const m = openLocalReviewFile({ ...input.mint, scope: mint }); files.push(m);
    const reviews = () => {
      check(!halted); writer.assertHealthy();
      const now = Date.now();
      for (const op of assessmentOps) a.requireReview(admissionDigest(assessment), op, now);
      for (const op of mintOps) m.requireReview(admissionDigest(mint), op, now);
    };
    const recheck = async (s = new AbortController().signal): Promise<void> => {
      let closed = false, timer: ReturnType<typeof setTimeout> | undefined, rejectStop!: () => void;
      const wall = Date.now(), mono = performance.now();
      const stopped = new Promise<never>((_, reject) => { rejectStop = () => { closed = true; reject(new Error("startup stopped")); }; });
      const live = () => { check(!closed && !halted && !s.aborted && Date.now() >= wall
        && Date.now() - wall < assessment.timeoutMs && performance.now() - mono < assessment.timeoutMs); writer.assertHealthy(); };
      s.addEventListener("abort", rejectStop, { once: true }); timer = setTimeout(rejectStop, assessment.timeoutMs);
      try {
        await Promise.race([(async () => {
          live(); reviews();
          check(await observeLocalAssessmentBinding(requests, expectedRole) === assessment.databaseBindingSha256); live(); reviews();
          check(await observeLocalMintBinding(requests, expectedRole) === mint.databaseBindingSha256); live(); reviews();
        })(), stopped]);
      } catch { halt(); unavailable(); }
      finally { closed = true; clearTimeout(timer); s.removeEventListener("abort", rejectStop); }
    };
    await recheck(signal);
    const binding = (f: typeof a) => ({ scope: f.scope, requireReview: (digest: string, op: AdmissionOperation, now: number) => {
      try { check(!halted); f.requireReview(digest, op, now); } catch { halt(); unavailable(); }
    } });
    admission = new LocalAdmissionRuntime(requests, { expectedRole, assessment: binding(a), mint: binding(m) });
    return Object.freeze({ admission, recheck, halt });
  } catch { halt(); return unavailable(); }
}
