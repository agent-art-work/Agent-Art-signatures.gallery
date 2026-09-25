import { keccak256 } from "viem";
import { deploymentPlan, loadReleaseArtifacts, ROOT } from "./generative-release.mjs";
import { expectedCollectionRuntime, SEPOLIA_GENESIS } from "./generative-deployment.mjs";
import { OperatingPlanError, parseOperatingJson, validateOperatingSettings } from "../../src/openMint/staging/operatingPlan.ts";

/** The only release-aware adapter. Input is bounded JSON, never environment
 * variables, RPC callbacks, a saved observation or an admission flag. */
export function operatingPlan(json, root = ROOT) {
  const input = parseOperatingJson(json);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "deployment,settings") throw new OperatingPlanError("input fields");
  let deployment, collectionRuntimeCodeHash;
  try {
    if (input.deployment?.genesisHash !== SEPOLIA_GENESIS) throw Error("genesis");
    deployment = deploymentPlan(input.deployment, root);
    // The signed-transaction observer represents transaction nonce as a safe
    // JS integer. A broader uint64 constructor plan is not admissible here.
    if (BigInt(deployment.collection.nonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("nonce observation range");
    // Also reject obvious rehearsal/placeholder owner labels here. A denylist
    // cannot prove arbitrary addresses are not test material or keys are safe.
    for (const principal of Object.values(deployment.principals)) {
      if (/(^|[._/-])(test|fixture|synthetic|unverified|local|example|todo|unknown|placeholder)([._/-]|$)/.test(principal.ownerReference)) throw Error("owner");
    }
    collectionRuntimeCodeHash = keccak256(expectedCollectionRuntime(deployment, loadReleaseArtifacts(root).GenerativeSignaturesV1RC1));
  } catch {
    // Existing release assertions can include actual values. Never echo those
    // when an operator accidentally passes a secret or the wrong file.
    throw new OperatingPlanError("locked deployment configuration");
  }
  const plan = validateOperatingSettings(input.settings, { planSha256: deployment.planSha256,
    releaseLockSha256: deployment.releaseLockSha256, collectionRuntimeCodeHash, principals: deployment.principals });
  const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  // The operating digest commits deployment.planSha256; both independently
  // reproducible plans are shown, with no mutable alias back to caller input.
  return freeze({ deploymentPlan: deployment, operatingPlan: plan });
}
