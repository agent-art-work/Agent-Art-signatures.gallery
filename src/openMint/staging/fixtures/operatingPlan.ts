import { OPERATING_PRINCIPALS, type CandidateOperatingBinding, type OperatingSettings } from "../operatingPlan.js";

/** Entirely fabricated offline declarations. These references have no accounts,
 * evidence or custody behind them. No operational configuration is supplied. */
export function operatingSettingsFixture(binding: CandidateOperatingBinding): OperatingSettings {
  return {
    schema: "sg-sepolia-operating-settings-v1", deploymentPlanSha256: binding.planSha256, namespace: "sepolia-staging",
    deploymentId: "ba911503-81c4-41c8-8209-e9589b94bdb0", ownerReference: "owner:gallery/steward", origin: "https://staging.signatures.gallery",
    session: { origin: "https://staging.signatures.gallery", chainId: 11155111, cookieName: "__Host-sg-staging", secure: true, sameSite: "strict", csrfRequired: true },
    hosting: { accountReference: "account:gallery/hosting", serviceReference: "service:gallery/web", tlsMode: "trusted-proxy", trustedProxyHops: 1,
      ingressPolicyReference: "policy:gallery/ingress", maxRequestBytes: 16384, requestTimeoutMs: 30000, drainTimeoutMs: 120000 },
    database: { resourceReference: "resource:gallery/database", migrationPlanReference: "policy:gallery/migrations", backupEvidenceReference: "evidence:gallery/restore",
      roles: { migrator: { name: "sg_migrator", connectionSecretReference: "secret:gallery/database/migrator" },
        browser: { name: "sg_browser", connectionSecretReference: "secret:gallery/database/browser" },
        projection: { name: "sg_projection", connectionSecretReference: "secret:gallery/database/projection" },
        recovery: { name: "sg_recovery", connectionSecretReference: "secret:gallery/database/recovery" } },
      exclusiveWriter: true, migrateOnStartup: false, initialIssuanceEnabled: false, initialGenerationEnabled: false },
    rpc: { sources: ["alpha", "beta"].map(id => ({ id: `service:rpc/${id}`, operatorReference: `owner:rpc/${id}`, accountReference: `account:rpc/${id}`,
      endpointSecretReference: `secret:rpc/${id}`, acceptanceEvidenceReference: `evidence:rpc/${id}/limits` })),
      readLimitsVersion: "sg-generative-read-limits-v1", jsonResponseBytes: 262144, timeoutMs: 10000, maxHeadAgeMs: 120000,
      maxFinalizedAgeMs: 1800000, maxFutureSkewMs: 5000, evidenceTtlMs: 15000 },
    custody: Object.fromEntries(OPERATING_PRINCIPALS.map(name => [name, { ...binding.principals[name],
      custodyPolicyReference: `policy:custody/${name.toLowerCase()}`, signerSecretReference: `secret:custody/${name.toLowerCase()}` }])) as OperatingSettings["custody"],
    assessment: { profileReference: "policy:grok/assessment", profileSha256: "7".repeat(64), xCredentialReference: "secret:gallery/x", xaiCredentialReference: "secret:gallery/xai",
      pricingReviewReference: "evidence:grok/pricing", spendingPolicyReference: "policy:grok/spending", validFrom: "2026-09-22T00:00:00.000Z", validUntil: "2026-09-23T00:00:00.000Z",
      dailyAttempts: 1, totalAttempts: 1, maxActive: 1, maxQueued: 1, reservationUsdTicks: "10000000000", maxExposureUsdTicks: "10000000000", automaticRetries: 0, preserveUnknownExposure: true },
    operations: { supportReference: "service:gallery/support", incidentPolicyReference: "policy:gallery/incidents", securityReviewReference: "evidence:gallery/security",
      compatibilityEvidenceReference: "evidence:gallery/wallets", finalityPolicyReference: "policy:gallery/finality", reveal: "canonical-inclusion-confirming", gallery: "finalized-only",
      staleEvidence: "stop-new-effects", signerCompromise: "never-restore" },
  };
}
