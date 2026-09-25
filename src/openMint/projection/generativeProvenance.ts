import { isXSource, validateAssessment } from "../assessment.js";
import { verifyGenerativeInputs, type GenerativeInputs } from "../generativeInputs.js";
import type { AssessmentPageModel } from "../pages.js";

/** Server-supplied accepted-record reader, never a public assessment endpoint.
 * The artwork reader calls this only after verified canonical inclusion. */
export interface GenerativeProvenanceSource {
  readonly timeoutMs: number;
  loadAccepted(handle: string, digest: string, signal: AbortSignal): Promise<unknown>;
}
type PublicAssessment = Pick<AssessmentPageModel, "assessmentProvenance" | "assessmentModel" |
  "assessedAt" | "assessmentSourceUrls" | "verifiedXUserId" | "identityVerifiedAt">;

/** A local record matching a chain commitment is not a signature from Grok.
 * Recompute both commitments; copy only the existing public provenance fields.
 * No receipt, request/code, response ID, prompt or free-form reasoning escapes. */
export function generativeAssessmentProvenance(value: unknown, inputs: GenerativeInputs): PublicAssessment {
  const assessment = validateAssessment(structuredClone(value));
  verifyGenerativeInputs(inputs, assessment, inputs.rendererIdentity, inputs.profile);
  const sources = [...new Set(assessment.sourceUrls.filter(isXSource).map(source => {
    const url = new URL(source); url.search = ""; url.hash = ""; return url.href;
  }))].sort();
  return Object.freeze({ assessmentProvenance: assessment.provenance, assessmentModel: assessment.model,
    assessedAt: assessment.createdAt, assessmentSourceUrls: Object.freeze(sources),
    verifiedXUserId: assessment.xIdentity!.userId, identityVerifiedAt: assessment.xIdentity!.verifiedAt });
}
