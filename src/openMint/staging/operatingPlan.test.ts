import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { GENERATIVE_READ_LIMITS } from "../generativeReadLimits.js";
import { OperatingPlanError, OPERATING_PRINCIPALS, OPERATING_PLAN_MAX_BYTES, parseOperatingJson, validateOperatingSettings, type CandidateOperatingBinding } from "./operatingPlan.js";
import { operatingSettingsFixture } from "./fixtures/operatingPlan.js";

const binding: CandidateOperatingBinding = { planSha256: "1".repeat(64), releaseLockSha256: "2".repeat(64), collectionRuntimeCodeHash: `0x${"3".repeat(64)}`,
  principals: Object.fromEntries(OPERATING_PRINCIPALS.map((name, i) => [name, { address: `0x${String(i + 1).repeat(40)}`, ownerReference: `custodian/${name.toLowerCase()}` }])) as CandidateOperatingBinding["principals"] };
const fixture = () => operatingSettingsFixture(binding);
const validate = (input: unknown) => validateOperatingSettings(input, binding);
function set(c: any, path: string, value: unknown) { const keys = path.split("."), key = keys.pop()!; for (const k of keys) c = c[k]; c[key] = value; }

describe("offline operating settings", () => {
  it("is deterministic, detached, deeply frozen and never grants any authority", () => {
    const input = fixture(), result = validate(input), { operatingPlanSha256, ...body } = result;
    expect(result).toEqual(validate(parseOperatingJson(JSON.stringify(input))));
    expect(operatingPlanSha256).toBe(createHash("sha256").update(canonicalize(body)!).digest("hex"));
    expect(result.readLimits).toEqual(GENERATIVE_READ_LIMITS);
    for (const k of ["observedDeployment", "evidenceVerified", "custodyVerified", "providerIndependenceVerified", "paidDispatchAllowed", "signingAllowed", "publicBroadcastAllowed", "runtimeAdmissionAllowed", "activationAllowed"] as const) expect(result[k]).toBe(false);
    input.rpc.sources[0]!.operatorReference = "owner:changed/operator";
    expect(result.settings.rpc.sources[0]!.operatorReference).toBe("owner:rpc/alpha");
    expect(Object.isFrozen(result.settings.rpc.sources[0])).toBe(true);
    expect(() => { (result.settings.rpc.sources[0] as any).id = "changed"; }).toThrow();
  });
  it("permits direct TLS only with zero proxy hops", () => {
    const c = fixture(); c.hosting.tlsMode = "direct"; c.hosting.trustedProxyHops = 0; expect(validate(c).settings.hosting.tlsMode).toBe("direct");
    c.hosting.trustedProxyHops = 1; expect(() => validate(c)).toThrow(OperatingPlanError);
  });
  it("includes changed valid choices in the digest without treating declared evidence as verified", () => {
    const c = fixture(), before = validate(c); c.operations.supportReference = "service:gallery/support-team";
    expect(validate(c).operatingPlanSha256).not.toBe(before.operatingPlanSha256);
    expect(validate(c).evidenceVerified).toBe(false);
    c.assessment.validFrom = "2020-01-01T00:00:00.000Z"; c.assessment.validUntil = "2020-01-02T00:00:00.000Z";
    expect(validate(c).paidDispatchAllowed).toBe(false); // Offline structural check, not a live time/approval check.
  });
  for (const [path, value] of [
    ["schema", "sg-runtime-approved-v1"], ["namespace", "local-real"], ["origin", "http://staging.signatures.gallery"],
    ["origin", "https://signatures.gallery"], ["origin", "https://staging.signatures.gallery/"], ["deploymentId", "local-deployment"],
    ["deploymentPlanSha256", "0".repeat(64)], ["deploymentPlanSha256", "4".repeat(64)], ["ownerReference", "owner:todo/steward"],
    ["ownerReference", "owner:gallery//steward"], ["ownerReference", "owner:gallery/"], ["ownerReference", "owner:gallery/steward\n"],
    ["session.origin", "http://127.0.0.1:3020"], ["session.chainId", 31337], ["session.chainId", "11155111"], ["session.cookieName", "sg"],
    ["session.secure", false], ["session.sameSite", "none"], ["session.csrfRequired", false],
    ["hosting.tlsMode", "http"], ["hosting.trustedProxyHops", true], ["hosting.trustedProxyHops", 2], ["hosting.maxRequestBytes", 65537],
    ["hosting.maxRequestBytes", 1.5], ["hosting.requestTimeoutMs", 30001], ["hosting.drainTimeoutMs", 29999],
    ["database.exclusiveWriter", false], ["database.migrateOnStartup", true], ["database.initialIssuanceEnabled", true], ["database.initialGenerationEnabled", true],
    ["database.roles.browser.name", "postgres"], ["database.roles.browser.name", "sg_browser;DROP"], ["database.roles.browser.name", "sg_migrator"],
    ["database.roles.browser.connectionSecretReference", "postgres://user:password@host/db"], ["database.roles.browser.connectionSecretReference", "secret:gallery/database/migrator"],
    ["rpc.sources", []], ["rpc.sources.1.id", "service:rpc/alpha"], ["rpc.sources.1.operatorReference", "owner:rpc/alpha"],
    ["rpc.sources.1.accountReference", "account:rpc/alpha"], ["rpc.sources.1.endpointSecretReference", "secret:rpc/alpha"],
    ["rpc.sources.0.endpointSecretReference", "https://rpc.invalid/API_SECRET"], ["rpc.sources.0.endpointSecretReference", "secret:gallery/database/browser"],
    ["rpc.readLimitsVersion", "unbounded"], ["rpc.jsonResponseBytes", 131072], ["rpc.jsonResponseBytes", 1048577],
    ["rpc.timeoutMs", 30001], ["rpc.maxHeadAgeMs", 300001], ["rpc.maxFinalizedAgeMs", 119999], ["rpc.maxFinalizedAgeMs", 3600001],
    ["rpc.maxFutureSkewMs", -1], ["rpc.evidenceTtlMs", 0], ["rpc.evidenceTtlMs", 30001],
    ["custody.authorizer.address", `0x${"9".repeat(40)}`], ["custody.authorizer.ownerReference", "custodian/pauser"],
    ["custody.authorizer.signerSecretReference", `0x${"7".repeat(64)}`], ["custody.authorizer.signerSecretReference", "secret:custody/pauser"],
    ["assessment.xaiCredentialReference", "xai-secret-raw-key"], ["assessment.xaiCredentialReference", "secret:gallery/x"],
    ["assessment.profileSha256", "0".repeat(64)], ["assessment.profileSha256", "7".repeat(65)],
    ["assessment.validFrom", "not-a-date"], ["assessment.validFrom", "2026-02-30T00:00:00.000Z"], ["assessment.validFrom", "2026-09-22T25:00:00.000Z"],
    ["assessment.validUntil", "2026-09-22T00:00:00.000Z"], ["assessment.validUntil", "2027-01-01T00:00:00.000Z"],
    ["assessment.dailyAttempts", 0], ["assessment.dailyAttempts", 1001], ["assessment.dailyAttempts", 2],
    ["assessment.totalAttempts", 1000001], ["assessment.maxActive", 2], ["assessment.maxQueued", 2], ["assessment.maxQueued", -1],
    ["assessment.reservationUsdTicks", "0"], ["assessment.reservationUsdTicks", "01"], ["assessment.reservationUsdTicks", "1e10"],
    ["assessment.maxExposureUsdTicks", "9999999999"], ["assessment.maxExposureUsdTicks", "1".repeat(16)],
    ["assessment.automaticRetries", 1], ["assessment.preserveUnknownExposure", false],
    ["operations.reveal", "submission"], ["operations.gallery", "included"], ["operations.staleEvidence", "retry"], ["operations.signerCompromise", "restore-after-900s"],
  ] as const) it(`rejects ${path}: ${String(value).slice(0, 24)}`, () => {
    const c = fixture(); set(c, path, value); expect(() => validate(c)).toThrow(OperatingPlanError);
  });
  // Exact fields at every object boundary, including each source/principal/role.
  const paths = ["", "session", "hosting", "database", "database.roles", ...["migrator", "browser", "projection", "recovery"].map(k => `database.roles.${k}`),
    "rpc", "rpc.sources.0", "rpc.sources.1", "custody", ...OPERATING_PRINCIPALS.map(k => `custody.${k}`), "assessment", "operations"];
  for (const path of paths) for (const kind of ["extra", "missing", "getter", "prototype", "symbol", "hidden"] as const) it(`rejects ${kind} at ${path || "root"}`, () => {
    const c = fixture(); let target: any = c; for (const key of path.split(".").filter(Boolean)) target = target[key];
    const key = Object.keys(target)[0]!;
    if (kind === "extra") target.approved = true;
    else if (kind === "missing") delete target[key];
    else if (kind === "prototype") Object.setPrototypeOf(target, { approved: true });
    else if (kind === "symbol") target[Symbol("approval")] = true;
    else if (kind === "hidden") Object.defineProperty(target, key, { enumerable: false });
    else Object.defineProperty(target, key, { get() { throw Error("must not execute getter"); } });
    expect(() => validate(c)).toThrow(OperatingPlanError);
  });
  it("rejects exotic arrays, sparse members and non-object settings without invoking getters", () => {
    for (const value of [null, [], true, 1, "text"]) expect(() => validate(value)).toThrow(OperatingPlanError);
    for (const alter of [
      (a: any) => { a.approved = true; }, (a: any) => { delete a[1]; },
      (a: any) => { Object.defineProperty(a, "0", { get() { throw Error("must not read"); } }); },
      (a: any) => { delete a[1]; a.extra = true; },
    ]) { const c = fixture(); alter(c.rpc.sources); expect(() => validate(c)).toThrow(OperatingPlanError); }
  });
  it("bounds JSON by UTF-8 bytes and redacts parse errors", () => {
    const rawSecret = "NEVER_PRINT_THIS_SECRET";
    for (const s of [`{"secret":"${rawSecret}"`, " ".repeat(OPERATING_PLAN_MAX_BYTES + 1), `"${"爱".repeat(12000)}"`]) {
      try { parseOperatingJson(s); throw Error("accepted"); } catch (e) { expect(e).toBeInstanceOf(OperatingPlanError); expect(String(e)).not.toContain(rawSecret); }
    }
    expect(parseOperatingJson(" ".repeat(OPERATING_PLAN_MAX_BYTES - 2) + "{}" )).toEqual({});
  });
});
