import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { loadStagingInstallation } from "./generative-staging-installation.mjs";
import { checkStagingInstallation, readFileBounded } from "./generative-staging-bootstrap.mjs";
import { browserConnectionFactory, createMountedAuthorizer, createMountedProviders, createMountedRpcs } from "./generative-staging-adapters.mjs";
import { openMountedReview } from "./generative-staging-mounts.mjs";
import { createOwnerChallenge, attachOwnerReview, readOwnerAttachmentFd } from "./generative-staging-owner.mjs";
import { createActiveStagingHealth } from "./generative-staging-health.mjs";
import { createStagingAssessmentController } from "./generative-staging-assessment.mjs";
import { createInstalledStagingSite } from "./generative-staging-site.mjs";
import { ExclusiveWriter } from "../../src/openMint/persistence/writer.ts";
import { OpenMintRepository } from "../../src/openMint/persistence/repository.ts";
import { PostgresMintRequests } from "../../src/openMint/persistence/requests.ts";
import { PostgresWalletSessions } from "../../src/openMint/persistence/sessions.ts";
import { verifySelectedRuntimeDatabase } from "../../src/openMint/persistence/databaseCertification.ts";
import { createStagingOperationReview } from "../../src/openMint/staging/stagingReview.ts";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
import { POLICY_VERSION } from "../../src/openMint/identity.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";

const deny = () => { throw Error("Installed staging service unavailable."); };

/** The only installed active startup. No migration, restore, deployment,
 * secret discovery or retry. It remains behind a separate trusted proxy and
 * cannot mint until an independently signed epoch-bound review is attached. */
export async function startInstalledStagingService(check, root, emitScope = value => process.stdout.write(`${JSON.stringify(value)}\n`)) {
  // The static config pins the operation-review revision before the fresh
  // writer epoch exists. Do not execute this draft by importing its source:
  // the post-challenge revision authority needs a separate design review.
  throw Error("Installed staging owner handoff is not accepted.");
  let writer, site, health, mountedReview, preflight, controller, cert;
  try {
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(realpathSync(root), root);
    const checked = checkStagingInstallation(check, root), installation = loadStagingInstallation(check.configPath, check.configSha256, root);
    assert.equal(checked.configSha256, installation.configSha256);
    const { config, evidence, operating } = installation, s = operating.operatingPlan.settings;
    const connect = browserConnectionFactory(installation);
    // Authenticate/certify before acquiring a writer epoch or opening a port.
    preflight = connect(); await preflight.connect();
    try { cert = await verifySelectedRuntimeDatabase(preflight, evidence.databaseReview); }
    finally { await preflight.end(); preflight = undefined; }
    assert.equal(cert.databaseBindingSha256, admissionDigest({ lock: GENERATIVE_DATABASE_V2_LOCK, review: evidence.databaseReview }));
    // Provider credentials are not read before the fresh owner review attaches.
    const sources = createMountedRpcs(installation);
    writer = await ExclusiveWriter.acquire(connect);
    const namespace = { id: config.namespaceId, profile: "staging-testnet", provenance: "grok", policyVersion: POLICY_VERSION };
    const repository = await OpenMintRepository.open(writer, namespace), requests = await PostgresMintRequests.open(repository, config.deploymentId);
    const sessions = await PostgresWalletSessions.openStaging({ writer, namespaceId: config.namespaceId, origin: config.origin, chainId: config.chainId });
    mountedReview = openMountedReview(config.reviews.operation);
    const reviewSource = Object.freeze({ publicKeyPem: mountedReview.publicKeyPem, publicKeySpkiSha256: mountedReview.publicKeySpkiSha256,
      revisionSha256: mountedReview.revisionSha256, readCurrent: mountedReview.readCurrent });
    const operatingJson = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileBounded(config.operating.path, config.operating.maxBytes, config.operating.sha256));
    const input = { operatingJson, transactions: evidence.transactions, transitions: evidence.transitions,
      historyLimits: evidence.historyLimits, sources, requests, databaseReview: evidence.databaseReview,
      assessmentPolicy: evidence.assessmentPolicy, reviewSource };
    // The controller only derives the exact scope; it never dispatches an
    // effect here. The fresh writer epoch is already committed and locked.
    controller = createStagingAssessmentController(input, root);
    const scope = controller.scope; controller.halt(); controller = undefined;
    const challenge = createOwnerChallenge(installation, check.packageSha256, writer, scope);
    emitScope(Object.freeze({ kind: "unsigned-review-request", ...challenge }));
    await attachOwnerReview(challenge, config.reviews.operation.revisionSha256, readOwnerAttachmentFd, config.listener.attachmentWaitMs);
    const review = createStagingOperationReview(reviewSource, scope);
    review.requireReview(admissionDigest(scope), "read", Date.now());
    // A real provider is constructed only when reviewed generation is enabled.
    // The expired pilot pricing profile currently refuses this path closed.
    const providers = cert.generationEnabled ? createMountedProviders(installation) : { identityResolver: undefined, provider: undefined };
    const signer = createMountedAuthorizer(installation);
    site = await createInstalledStagingSite(check, input, { sessions, signer, ...providers }, root);
    await site.start(config.listener.publicPort);
    health = createActiveStagingHealth({ port: config.listener.healthPort, site, writer,
      assertReview: () => review.requireReview(admissionDigest(scope), "read", Date.now()) });
    await health.start();
    let closing;
    const close = () => closing ??= (async () => {
      const drained = await Promise.allSettled([health.close(), site.close()]);
      // A failed site drain may leave late effect work. Retain the owner.
      if (drained.some(result => result.status === "rejected")) return deny();
      review.halt(); mountedReview.halt(); await writer.close();
    })();
    return Object.freeze({ site, health, close });
  } catch {
    controller?.halt();
    try { await preflight?.end(); } catch { /* no further effects */ }
    try { await health?.close(); } catch { /* keep writer below if a drain failed */ }
    if (site) {
      try { await site.close(); } catch { return deny(); }
    }
    mountedReview?.halt();
    try { await writer?.close(); } catch { return deny(); }
    return deny();
  }
}
