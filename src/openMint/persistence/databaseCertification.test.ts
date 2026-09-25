import { describe, expect, it, vi } from "vitest";
import { GENERATIVE_DATABASE_LOCK } from "./databaseSchemaLock.js";
import { observeGenerativeDatabase, verifyGenerativeDatabaseCertification, observeGenerativeRuntimeDatabase, verifyGenerativeRuntimeDatabase,
  verifySelectedRuntimeDatabase, verifySelectedPausedDatabase, readCertifiedDatabaseProfiles, type DatabaseCertificationReview } from "./databaseCertification.js";

const target = { database: "staging_db", ownerRole: "migration_owner", runtimeRole: "runtime_user",
  namespaceId: "11111111-1111-4111-8111-111111111111", deploymentId: "22222222-2222-4222-8222-222222222222" };
const review: DatabaseCertificationReview = { ...target, profilesSha256: "a".repeat(64), migrationReceiptSha256: "b".repeat(64),
  reviewRevisionSha256: "c".repeat(64), migrationManifestSha256: GENERATIVE_DATABASE_LOCK.migrationManifestSha256 };
describe("explicit database profile selection", () => {
  const connection={query:vi.fn(async()=>{throw Error("offline selector fixture");})};
  it("routes each named runtime profile and refuses every unknown version",async()=>{
    await expect(verifySelectedRuntimeDatabase(connection,{...review,version:"sg-generative-runtime-db-review-v1"})).rejects.toThrow();
    await expect(verifySelectedRuntimeDatabase(connection,{...review,version:"sg-generative-runtime-db-review-v2"} as never)).rejects.toThrow();
    await expect(verifySelectedRuntimeDatabase(connection,{...review,version:"other"} as never)).rejects.toThrow();
  });
  it("routes legacy and explicit paused v2 profiles but no other version",async()=>{
    await expect(verifySelectedPausedDatabase(connection,review)).rejects.toThrow();
    await expect(verifySelectedPausedDatabase(connection,{...review,version:"sg-generative-paused-db-review-v2"} as never)).rejects.toThrow();
    await expect(verifySelectedPausedDatabase(connection,{...review,version:"other"} as never)).rejects.toThrow();
  });
});
function fixture() {
  const probe: Record<string, unknown> = { version: "160004", path: "pg_catalog", timeout: "3000ms" };
  const identity: Record<string, unknown> = { ...probe, database: target.database, ownerRole: target.ownerRole, databaseOwner: target.ownerRole,
    runtimeRole: target.runtimeRole, sessionRole: target.runtimeRole, encoding: "UTF8", timezone: "UTC", replication: "origin",
    fsync: "on", commit: "on", strings: "on", rowSecurity: "on" };
  const audit = Object.fromEntries(["postgresVersion", "identity", "restrictedRoles", "noRoleDelegation", "noOwnership", "noCreation",
    "noSecurityDefiner", "noParameterEscalation", "foundationLayout", "requiredPrivileges", "noExtraPrivileges", "noGrantOptions"].map(k => [k, true]));
  const row: Record<string, unknown> = { schema: "[]", grants: "[]", profiles: "[]", audit: JSON.stringify(audit), identity: JSON.stringify(identity), supported: true, staged: true };
  const connection = { query: vi.fn(async () => ({ rows: [connection.query.mock.calls.length === 1 ? probe : row] })) };
  return { probe, identity, audit, row, connection };
}
describe("read-only database certification boundary", () => {
  it("runtime observation returns both live switches separately, still without authority", async () => {
    const f = fixture(); Object.assign(f.row, { generation_enabled: true, issuance_enabled: false });
    const observed = await observeGenerativeRuntimeDatabase(f.connection, target);
    expect(observed).toMatchObject({ kind: "generative-runtime-database-observation-v1", generationEnabled: true, issuanceEnabled: false, approved: false, publicStartup: false });
    expect(() => readCertifiedDatabaseProfiles(observed)).toThrow();
  });
  it.each([null, {}, { ...target, namespaceId: "bad" }])("rejects malformed runtime targets (%#)", async value => {
    await expect(observeGenerativeRuntimeDatabase(fixture().connection, value as never)).rejects.toThrow();
  });
  it.each([null, {}, { ...review }, { ...review, version: "wrong" },
    { ...review, version: "sg-generative-runtime-db-review-v1", migrationReceiptSha256: "bad" },
    { ...review, version: "sg-generative-runtime-db-review-v1", migrationManifestSha256: "f".repeat(64) }])("refuses unsafe runtime review (%#)", async value => {
    const f = fixture(); await expect(verifyGenerativeRuntimeDatabase(f.connection, value as never)).rejects.toThrow(); expect(f.connection.query).not.toHaveBeenCalled();
  });
  it.each([{ generation_enabled: "true", issuance_enabled: false }, { generation_enabled: true, issuance_enabled: null }])("rejects malformed live controls (%#)", async flags => {
    const f = fixture(); Object.assign(f.row, flags); await expect(observeGenerativeRuntimeDatabase(f.connection, target)).rejects.toThrow();
  });
  it("cannot self-pin runtime certification from mismatched structure", async () => {
    const f = fixture(); Object.assign(f.row, { generation_enabled: true, issuance_enabled: true });
    await expect(verifyGenerativeRuntimeDatabase(f.connection, { ...review, version: "sg-generative-runtime-db-review-v1" })).rejects.toThrow();
  });
  it.each([undefined, null, 1, "value", {}])("rejects forged profile readers (%#)", value => {
    expect(() => readCertifiedDatabaseProfiles(value)).toThrow();
  });
  it("does not claim that inspection approves schema, migrations or public startup", async () => {
    const f = fixture(); const result = await observeGenerativeDatabase(f.connection, target);
    expect(result).toMatchObject({ kind: "generative-database-observation-v1", approved: false, publicStartup: false });
    expect(Object.isFrozen(result.target)).toBe(true); expect(result.target).not.toBe(target);
    expect(f.connection.query).toHaveBeenCalledTimes(2);
  });
  it("cannot self-certify hashes captured from the same mismatched database", async () => {
    const f = fixture(), observed = await observeGenerativeDatabase(f.connection, target);
    await expect(verifyGenerativeDatabaseCertification(fixture().connection, { ...review, profilesSha256: observed.profilesSha256 })).rejects.toThrow();
  });
  it.each([
    null, [], {}, { ...target, extra: true }, { ...target, database: "" }, { ...target, database: "pg_catalog" },
    { ...target, ownerRole: "public" }, { ...target, runtimeRole: target.ownerRole }, { ...target, runtimeRole: "BadRole" },
    { ...target, namespaceId: "00000000-0000-0000-0000-000000000000" }, { ...target, deploymentId: "not-uuid" },
    Object.assign(Object.create({ inherited: true }), target),
  ])("rejects malformed targets before querying (%#)", async input => {
    const f = fixture(); await expect(observeGenerativeDatabase(f.connection, input as typeof target)).rejects.toThrow();
    expect(f.connection.query).not.toHaveBeenCalled();
  });
  it.each([
    null, {}, { ...review, approved: true }, { ...review, profilesSha256: "0".repeat(64) },
    { ...review, migrationManifestSha256: "f".repeat(64) }, { ...review, migrationReceiptSha256: "bad" },
    { ...review, reviewRevisionSha256: 7 }, { ...review, profilesSha256: "A".repeat(64) },
  ])("rejects missing or unpinned reviews before querying (%#)", async input => {
    const f = fixture(); await expect(verifyGenerativeDatabaseCertification(f.connection, input as DatabaseCertificationReview)).rejects.toThrow();
    expect(f.connection.query).not.toHaveBeenCalled();
  });
  it.each([0, -1, 10001, NaN, 1.5])("rejects unsafe deadline %s", async timeout => {
    const f = fixture(); await expect(observeGenerativeDatabase(f.connection, target, undefined, timeout)).rejects.toThrow();
    expect(f.connection.query).not.toHaveBeenCalled();
  });
  it.each([
    ["version", "150000"], ["version", 160000], ["path", '"$user", public'], ["timeout", "0"], ["timeout", "6000ms"],
    ["timeout", "6s"], ["timeout", "1min"], ["timeout", 1000], ["timeout", "9007199254740993"],
  ])("rejects unsafe probe %s=%s before resolving schema objects", async (key, value) => {
    const f = fixture(); f.probe[key] = value;
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow(); expect(f.connection.query).toHaveBeenCalledTimes(1);
  });
  it.each(["1", "3000ms", "5s"])("accepts bounded timeout syntax %s", async timeout => {
    const f = fixture(); f.probe.timeout = timeout;
    await expect(observeGenerativeDatabase(f.connection, target)).resolves.toHaveProperty("approved", false);
  });
  it.each([[], [{}, {}], [null], [{ version: "160004", path: "pg_catalog" }]].map(rows => ({ rows })))("refuses malformed probe rows (%#)", async ({ rows }) => {
    const f = fixture(); f.connection.query.mockResolvedValueOnce({ rows } as never);
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow(); expect(f.connection.query).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["supported", false], ["supported", "true"], ["staged", false], ["audit", "{}"], ["audit", "not json"], ["audit", "null"],
    ["identity", "{}"], ["identity", "not json"], ["schema", null], ["schema", ""], ["schema", "x".repeat(1048577)],
    ["grants", "x".repeat(524289)], ["profiles", "é".repeat(32769)], ["identity", "x".repeat(4097)],
  ])("refuses malformed/big observation %s (%#)", async (key, value) => {
    const f = fixture(); f.row[key as string] = value;
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow();
  });
  it.each([
    ["database", "another_database"], ["runtimeRole", "other_role"], ["sessionRole", "other_role"], ["ownerRole", "other_role"],
    ["databaseOwner", "other_role"], ["encoding", "LATIN1"], ["timezone", "Asia/Shanghai"], ["replication", "replica"],
    ["fsync", "off"], ["commit", "off"], ["strings", "off"], ["rowSecurity", "off"], ["path", "public"], ["timeout", "0"],
  ])("refuses connection/settings drift %s", async (key, value) => {
    const f = fixture(); f.identity[key] = value; f.row.identity = JSON.stringify(f.identity);
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow();
  });
  it("supports synchronous remote_apply without weakening the durability check", async () => {
    const f = fixture(); f.identity.commit = "remote_apply"; f.row.identity = JSON.stringify(f.identity);
    await expect(observeGenerativeDatabase(f.connection, target)).resolves.toHaveProperty("approved", false);
  });
  it.each([false, "true", null])("refuses a failed/non-boolean role audit %s", async value => {
    const f = fixture(); f.row.audit = JSON.stringify({ ...f.audit, noExtraPrivileges: value });
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow();
  });
  it.each([[], [{}, {}], [null]].map(rows => ({ rows })))("refuses malformed result rows (%#)", async ({ rows }) => {
    const f = fixture(); f.connection.query.mockResolvedValueOnce({ rows: [f.probe] }).mockResolvedValueOnce({ rows } as never);
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow();
  });
  it.each(["probe", "catalog"])("sanitizes %s errors and performs no retry", async phase => {
    const f = fixture(); if (phase === "catalog") f.connection.query.mockResolvedValueOnce({ rows: [f.probe] });
    f.connection.query.mockRejectedValueOnce(new Error("private connection/SQL material"));
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow(/^Database certification unavailable or mismatched\.$/);
    expect(f.connection.query).toHaveBeenCalledTimes(phase === "probe" ? 1 : 2);
  });
  it("refuses unexpected result fields", async () => {
    const f = fixture(); f.row.approved = true;
    await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow();
  });
  it("refuses already cancelled work before querying", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    await expect(observeGenerativeDatabase(f.connection, target, abort.signal)).rejects.toThrow(); expect(f.connection.query).not.toHaveBeenCalled();
  });
  it.each(["probe", "catalog"])("cancels pending %s and ignores its late result", async phase => {
    const f = fixture(), abort = new AbortController(); let resolve!: (v: { rows: Record<string, unknown>[] }) => void;
    if (phase === "catalog") f.connection.query.mockResolvedValueOnce({ rows: [f.probe] });
    f.connection.query.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const work = observeGenerativeDatabase(f.connection, target, abort.signal); await Promise.resolve(); abort.abort();
    await expect(work).rejects.toThrow(); resolve({ rows: [phase === "probe" ? f.probe : f.row] }); await new Promise(done => setImmediate(done));
    expect(f.connection.query).toHaveBeenCalledTimes(phase === "probe" ? 1 : 2);
  });
  it("times out an unresponsive transport without producing a late observation", async () => {
    const f = fixture(); f.connection.query.mockImplementationOnce(() => new Promise(() => {}));
    await expect(observeGenerativeDatabase(f.connection, target, undefined, 5)).rejects.toThrow(); expect(f.connection.query).toHaveBeenCalledOnce();
  });
  it("rejects backwards wall-clock changes", async () => {
    const f = fixture(), clock = vi.spyOn(Date, "now").mockReturnValueOnce(10000).mockReturnValue(9000);
    try { await expect(observeGenerativeDatabase(f.connection, target)).rejects.toThrow(); }
    finally { clock.mockRestore(); }
  });
  it("detaches target before asynchronous reads", async () => {
    const f = fixture(), input = { ...target }, work = observeGenerativeDatabase(f.connection, input);
    input.database = "changed";
    expect((await work).target.database).toBe(target.database);
  });
  it("captures a target accessor exactly once before validating it", async () => {
    const f = fixture(); let reads = 0;
    const input = { ...target, get database() { return ++reads === 1 ? target.database : "unexpected"; } };
    expect((await observeGenerativeDatabase(f.connection, input)).target.database).toBe(target.database); expect(reads).toBe(1);
  });
});
