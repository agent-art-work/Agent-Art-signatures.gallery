import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import canonicalize from "canonicalize";
import { captureAdmissionScope } from "../../src/openMint/staging/admission.ts";

const deny = () => { throw Error("Staging owner handoff unavailable."); };
const hash = value => typeof value === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(value);
const digest = value => createHash("sha256").update(canonicalize(value)).digest("hex");
const exact = (v, keys) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(v).sort(), [...keys].sort());
};

/** Called strictly after ExclusiveWriter.acquire. This unsigned request is a
 * scope for an independent reviewer, never permission in its own right. */
export function createOwnerChallenge(installation, packageSha256, writer, operationScope) {
  try {
    const { config, configSha256, operating, evidence } = installation;
    writer.assertHealthy();
    assert.ok(/^[1-9][0-9]{0,19}$/.test(writer.epoch) && hash(packageSha256) && hash(configSha256));
    const reviewedScope = captureAdmissionScope(operationScope);
    assert.equal(reviewedScope.writerEpoch, writer.epoch);
    assert.equal(reviewedScope.reviewRevisionSha256, config.reviews.operation.revisionSha256);
    assert.equal(reviewedScope.operatingPlanSha256, operating.operatingPlan.operatingPlanSha256);
    const ownerNonce = randomBytes(32).toString("hex");
    const scope = Object.freeze({ schema: "sg-staging-owner-scope-v1", installationId: config.installationId,
      packageSha256, configSha256, operatingPlanSha256: operating.operatingPlan.operatingPlanSha256,
      deploymentPlanSha256: operating.deploymentPlan.planSha256, databaseReviewRevisionSha256: evidence.databaseReview.reviewRevisionSha256,
      reviewRevisionSha256: config.reviews.operation.revisionSha256, deploymentId: config.deploymentId, namespaceId: config.namespaceId,
      origin: config.origin, chainId: config.chainId, writerEpoch: writer.epoch, ownerNonce, operationScope: reviewedScope });
    for (const key of ["operatingPlanSha256", "deploymentPlanSha256", "databaseReviewRevisionSha256", "reviewRevisionSha256"]) assert.ok(hash(scope[key]));
    return Object.freeze({ scope, scopeSha256: digest(scope) });
  } catch { return deny(); }
}

/** The input is a one-shot local descriptor, not an HTTP request or a review
 * issuer. The separately signed review is still checked by the runtime. */
export async function attachOwnerReview(challenge, revisionSha256, reader, waitMs) {
  let timer;
  try {
    assert.ok(typeof reader === "function" && Number.isSafeInteger(waitMs) && waitMs >= 1 && waitMs <= 900000);
    const controller = new AbortController();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("Timeout")); }, waitMs); });
    const bytes = await Promise.race([reader(controller.signal), timeout]);
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4096);
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\n$/, "");
    const value = JSON.parse(raw);
    assert.equal(canonicalize(value), raw);
    exact(value, ["schema", "scopeSha256", "ownerNonce", "writerEpoch", "reviewRevisionSha256"]);
    assert.equal(value.schema, "sg-staging-owner-attachment-v1");
    assert.equal(value.scopeSha256, challenge.scopeSha256);
    assert.equal(value.ownerNonce, challenge.scope.ownerNonce);
    assert.equal(value.writerEpoch, challenge.scope.writerEpoch);
    assert.equal(value.reviewRevisionSha256, revisionSha256);
    assert.equal(value.reviewRevisionSha256, challenge.scope.reviewRevisionSha256);
    return Object.freeze({ attached: true, scopeSha256: challenge.scopeSha256 });
  } catch { return deny(); }
  finally { clearTimeout(timer); }
}

/** Fixed fd 3 supplied by a local supervisor. Never accepts a path, network
 * location, credential, signer or a user-selected descriptor on the CLI. */
export async function readOwnerAttachmentFd(signal) {
  try {
    const stream = createReadStream(null, { fd: 3, autoClose: true, highWaterMark: 4097, signal });
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 4096) { stream.destroy(); return deny(); }
      chunks.push(chunk);
    }
    assert.ok(size > 0);
    return Buffer.concat(chunks);
  } catch { return deny(); }
}
