import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenMintRepository, AdmissionBlockedError, type PersistenceNamespace } from "./repository.js";
import { ExclusiveWriter, PersistenceConflictError, WriterUnavailableError } from "./writer.js";
import { assessment, bytes, identity, namespace, receipt } from "./fixtures/data.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("isolated PostgreSQL open-mint transactions", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, owner: ExclusiveWriter, repo: OpenMintRepository, ns: PersistenceNamespace;
  const factory = () => new Client(cluster.config);
  async function provision(value: PersistenceNamespace, reservation = "100", maxExposure = "1000"): Promise<void> {
    await admin.query("INSERT INTO open_mint.namespaces(namespace_id, profile, provenance, policy_version) VALUES ($1, $2, $3, $4)", [value.id, value.profile, value.provenance, value.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id, profile_version, expected_model, generation_enabled,
      valid_until, max_total, max_daily, max_active, max_queued, reservation_usd_ticks, max_exposure_usd_ticks)
      VALUES ($1, 'fixture-profile-1', $2, true, '2099-01-01', 20, 10, 1, 100, $3, $4)`, [value.id, value.provenance === "grok" ? "grok-4.3" : "development-fixture-v1", reservation, maxExposure]);
  }
  async function start(handle = "alice"): Promise<string> {
    const admitted = await repo.admitInitial(handle);
    if (admitted.kind === "accepted") throw new Error("Unexpected existing result.");
    await repo.claimInitial(admitted.attemptId);
    return admitted.attemptId;
  }
  async function throughGrok(handle = "alice", xAmount?: string): Promise<string> {
    const id = await start(handle);
    await repo.beforeDispatch(id, "x-identity");
    await expect(admin.query("UPDATE open_mint.jobs SET state = 'queued', owner_epoch = NULL WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
    await repo.recordReceipt(id, bytes(receipt("x-identity", xAmount)));
    await repo.recordIdentity(id, bytes(identity(handle)));
    await repo.beforeDispatch(id, "grok");
    await repo.recordReceipt(id, bytes(receipt("grok")));
    return id;
  }
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
  }, 30000);
  beforeEach(async () => {
    ns = namespace(); await provision(ns); owner = await ExclusiveWriter.acquire(factory); repo = await OpenMintRepository.open(owner, ns);
  });
  afterEach(async () => { await owner?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("concurrent case variants create one attempt, reservation and job", async () => {
    const values = await Promise.all(Array.from({ length: 16 }, (_, index) => repo.admitInitial(index % 2 ? "@ALIce" : "alice")));
    expect(values.filter(value => value.kind === "created")).toHaveLength(1);
    expect(new Set(values.map(value => value.kind === "accepted" ? "" : value.attemptId)).size).toBe(1);
    for (const table of ["assessment_attempts", "budget_reservations", "jobs"]) {
      expect((await admin.query(`SELECT count(*)::int AS count FROM open_mint.${table} WHERE namespace_id = $1`, [ns.id])).rows[0].count).toBe(1);
    }
    await expect(repo.admitInitial("bob")).rejects.toThrow(AdmissionBlockedError);
  });
  it("pins durable commits even if the new client requests asynchronous commit", async () => {
    await owner.close(); owner = await ExclusiveWriter.acquire(() => new Client({ ...cluster.config, options: "-c synchronous_commit=off" }));
    const row = await owner.transaction(async tx => (await tx.query("SELECT current_setting('synchronous_commit') AS mode")).rows[0]);
    expect(row.mode).toBe("on");
  });
  it("rejects a real namespace with a zero reservation before initial admission or dispatch", async () => {
    ns = { ...namespace(), profile: "local-real", provenance: "grok" }; await provision(ns, "0", "0"); repo = await OpenMintRepository.open(owner, ns);
    await expect(repo.admitInitial("alice")).rejects.toThrow("positive exposure reservation");
    await expect(repo.beforeDispatch(randomUUID(), "x-identity")).rejects.toThrow("positive exposure reservation");
  });
  it("rolls all admission writes back when the final job insertion fails", async () => {
    await admin.query(`CREATE FUNCTION open_mint.test_fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected job failure'; END $$;
      CREATE TRIGGER test_fail_job BEFORE INSERT ON open_mint.jobs FOR EACH ROW EXECUTE FUNCTION open_mint.test_fail_job()`);
    try { await expect(repo.admitInitial("alice")).rejects.toThrow("injected job failure"); }
    finally { await admin.query("DROP TRIGGER test_fail_job ON open_mint.jobs; DROP FUNCTION open_mint.test_fail_job()"); }
    for (const table of ["handle_guards", "assessment_attempts", "budget_reservations", "jobs"]) {
      expect((await admin.query(`SELECT count(*)::int AS count FROM open_mint.${table} WHERE namespace_id = $1`, [ns.id])).rows[0].count).toBe(0);
    }
    expect((await repo.admitInitial("alice")).kind).toBe("created");
  });
  it("refuses the second writer, increments epoch on replacement and never resumes claimed jobs", async () => {
    const id = await start(), epoch = owner.epoch;
    await expect(ExclusiveWriter.acquire(factory)).rejects.toThrow(WriterUnavailableError);
    await repo.beforeDispatch(id, "x-identity");
    await owner.close(); owner = await ExclusiveWriter.acquire(factory); repo = await OpenMintRepository.open(owner, ns);
    expect(BigInt(owner.epoch)).toBeGreaterThan(BigInt(epoch));
    await expect(repo.claimInitial(id)).rejects.toThrow(PersistenceConflictError);
    await expect(repo.beforeDispatch(id, "x-identity")).rejects.toThrow(PersistenceConflictError);
    await expect(repo.recordReceipt(id, bytes(receipt("x-identity")))).rejects.toThrow(PersistenceConflictError);
    expect((await repo.admitInitial("alice")).kind).toBe("joined");
  });
  it("can claim a queued, undispatched original job after replacement", async () => {
    const admitted = await repo.admitInitial("alice"); if (admitted.kind === "accepted") throw new Error();
    await owner.close(); owner = await ExclusiveWriter.acquire(factory); repo = await OpenMintRepository.open(owner, ns);
    await expect(repo.claimInitial(admitted.attemptId)).resolves.toBeUndefined();
    await expect(repo.claimInitial(admitted.attemptId)).rejects.toThrow(PersistenceConflictError);
  });
  it("orders fences, receipts and identity before Grok and disallows repeat dispatch", async () => {
    const id = await start();
    await expect(repo.recordReceipt(id, bytes(receipt("x-identity")))).rejects.toThrow(PersistenceConflictError);
    await expect(repo.beforeDispatch(id, "grok")).rejects.toThrow(PersistenceConflictError);
    await repo.beforeDispatch(id, "x-identity");
    await expect(repo.beforeDispatch(id, "x-identity")).rejects.toThrow("retry forbidden");
    await expect(repo.recordIdentity(id, bytes(identity()))).rejects.toThrow(PersistenceConflictError);
    await repo.recordReceipt(id, bytes(receipt("x-identity")));
    await expect(repo.beforeDispatch(id, "grok")).rejects.toThrow(PersistenceConflictError);
    await repo.recordIdentity(id, bytes(identity()));
    await repo.beforeDispatch(id, "grok");
    await expect(repo.beforeDispatch(id, "grok")).rejects.toThrow("retry forbidden");
  });
  it("freezes exact receipts and identity bytes; conflict cannot replace earlier evidence", async () => {
    const id = await start(); await repo.beforeDispatch(id, "x-identity");
    const original = bytes(receipt("x-identity"));
    await repo.recordReceipt(id, original); await repo.recordReceipt(id, original);
    await expect(repo.recordReceipt(id, bytes(receipt("x-identity", "1")))).rejects.toThrow("Conflicting immutable");
    await repo.recordIdentity(id, bytes(identity())); await repo.recordIdentity(id, bytes(identity()));
    await expect(repo.recordIdentity(id, bytes({ ...identity(), userId: "456" }))).rejects.toThrow("Conflicting immutable");
    expect(await repo.getReceipt(id, "x-identity")).toEqual(receipt("x-identity"));
    for (const table of ["provider_receipts", "dispatch_fences", "verified_identities", "budget_reservations", "handle_guards", "namespaces"]) {
      await expect(admin.query(`DELETE FROM open_mint.${table} WHERE namespace_id = $1`, [ns.id])).rejects.toMatchObject({ code: "55000" });
    }
    await expect(admin.query("UPDATE open_mint.assessment_attempts SET handle = 'bob' WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
  });
  it("commits accepted result/link/render job together and preserves exact bytes through restart", async () => {
    const id = await throughGrok(), accepted = assessment(), original = Buffer.from(JSON.stringify(accepted, null, 2));
    await repo.acceptAssessment(id, original);
    await expect(repo.acceptAssessment(id, original)).resolves.toEqual(accepted);
    await expect(repo.acceptAssessment(id, bytes(assessment()))).rejects.toThrow("Conflicting immutable");
    const row = (await admin.query("SELECT payload FROM open_mint.assessments WHERE namespace_id = $1", [ns.id])).rows[0];
    expect(row.payload.equals(original)).toBe(true);
    expect((await admin.query("SELECT kind, state FROM open_mint.jobs WHERE namespace_id = $1 ORDER BY kind", [ns.id])).rows).toEqual([{ kind: "assessment", state: "complete" }, { kind: "render", state: "queued" }]);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled = false WHERE namespace_id = $1", [ns.id]);
    await owner.close(); owner = await ExclusiveWriter.acquire(factory); repo = await OpenMintRepository.open(owner, ns);
    expect(await repo.getAssessment("ALICE")).toEqual(accepted);
    expect((await repo.admitInitial("alice")).kind).toBe("accepted");
    await expect(repo.admitInitial("bob")).rejects.toThrow(AdmissionBlockedError);
    await expect(admin.query("UPDATE open_mint.assessments SET payload = $2 WHERE namespace_id = $1", [ns.id, bytes(assessment())])).rejects.toMatchObject({ code: "55000" });
  });
  it("reads accepted provenance by exact namespace/handle/digest with generation disabled and after restart", async () => {
    const id = await throughGrok(), accepted = assessment(), signal = new AbortController().signal;
    await repo.acceptAssessment(id, bytes(accepted));
    const other = namespace(); await provision(other);
    const otherRepo = await OpenMintRepository.open(owner, other);
    expect(await otherRepo.getAcceptedAssessment("alice", accepted.digest, signal)).toBeUndefined();
    expect(await repo.getAcceptedAssessment("bob", accepted.digest, signal)).toBeUndefined();
    expect(await repo.getAcceptedAssessment("alice", `0x${"12".repeat(32)}`, signal)).toBeUndefined();
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    const before = (await admin.query("SELECT * FROM open_mint.jobs WHERE namespace_id=$1 ORDER BY job_id", [ns.id])).rows;
    await owner.close(); owner = await ExclusiveWriter.acquire(factory); repo = await OpenMintRepository.open(owner, ns);
    expect(await repo.getAcceptedAssessment("alice", accepted.digest, signal)).toEqual(accepted);
    expect((await admin.query("SELECT * FROM open_mint.jobs WHERE namespace_id=$1 ORDER BY job_id", [ns.id])).rows).toEqual(before);
    expect((await admin.query("SELECT count(*)::int n FROM open_mint.dispatch_fences WHERE namespace_id=$1", [ns.id])).rows[0].n).toBe(2);
  });
  it("does not disclose a payload whose attempt is not accepted", async () => {
    const id = await start(), saved = assessment(), signal = new AbortController().signal;
    // Deliberately incomplete fixture: an operator inserted a payload, not an
    // accepted assessment. The read must check state, not just payload presence.
    await admin.query("INSERT INTO open_mint.assessments(namespace_id,handle,assessment_id,attempt_id,digest,payload) VALUES($1,$2,$3,$4,$5,$6)",
      [ns.id, saved.handle, saved.id, id, saved.digest, bytes(saved)]);
    expect(await repo.getAcceptedAssessment("alice", saved.digest, signal)).toBeUndefined();
  });
  it("rolls back result and accepted linkage if render-job insertion fails", async () => {
    const id = await throughGrok();
    await admin.query(`CREATE FUNCTION open_mint.test_fail_render() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind = 'render' THEN RAISE EXCEPTION 'injected render failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_render BEFORE INSERT ON open_mint.jobs FOR EACH ROW EXECUTE FUNCTION open_mint.test_fail_render()`);
    const value = assessment();
    try { await expect(repo.acceptAssessment(id, bytes(value))).rejects.toThrow("injected render failure"); }
    finally { await admin.query("DROP TRIGGER test_fail_render ON open_mint.jobs; DROP FUNCTION open_mint.test_fail_render()"); }
    expect(await repo.getAssessment("alice")).toBeUndefined();
    expect((await admin.query("SELECT state FROM open_mint.assessment_attempts WHERE namespace_id = $1", [ns.id])).rows[0].state).toBe("pending");
    await repo.acceptAssessment(id, bytes(value));
  });
  it("keeps namespace foreign keys, provenance and frozen verified identity bound", async () => {
    const id = await throughGrok();
    const other = namespace(); await provision(other); const otherRepo = await OpenMintRepository.open(owner, other);
    await expect(OpenMintRepository.open(owner, { ...ns, profile: "production" })).rejects.toThrow("Namespace");
    await expect(otherRepo.claimInitial(id)).rejects.toThrow(PersistenceConflictError);
    await expect(otherRepo.acceptAssessment(id, bytes(assessment()))).rejects.toThrow("Attempt not found");
    await expect(admin.query("INSERT INTO open_mint.jobs(namespace_id, job_id, attempt_id, kind) VALUES ($1, $2, $3, 'assessment')", [other.id, randomUUID(), id])).rejects.toMatchObject({ code: "23503" });
    await expect(repo.acceptAssessment(id, bytes(assessment("bob")))).rejects.toThrow("handle mismatch");
    await expect(repo.acceptAssessment(id, bytes(assessment("alice", { xIdentity: { ...identity(), userId: "999" } })))).rejects.toThrow("durable verified identity");
  });
  it("rechecks kill switch between X and Grok without deleting the original reservation", async () => {
    const id = await start(); await repo.beforeDispatch(id, "x-identity"); await repo.recordReceipt(id, bytes(receipt("x-identity")));
    await repo.recordIdentity(id, bytes(identity()));
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled = false WHERE namespace_id = $1", [ns.id]);
    await expect(repo.beforeDispatch(id, "grok")).rejects.toThrow(AdmissionBlockedError);
    expect((await admin.query("SELECT count(*)::int AS count FROM open_mint.budget_reservations WHERE namespace_id = $1", [ns.id])).rows[0].count).toBe(1);
  });
  it.each(["unknown", "estimated", "actual"] as const)("retains the real accounting gate for %s receipts while preserving saved-result reads", async costStatus => {
    ns = { ...namespace(), profile: "local-real", provenance: "grok" }; await provision(ns); repo = await OpenMintRepository.open(owner, ns);
    const id = await start(), snapshot = { ...identity(), provenance: "x-api" as const };
    await repo.beforeDispatch(id, "x-identity");
    const xReceipt = receipt("x-identity", costStatus === "unknown" ? undefined : "10");
    if (costStatus === "estimated") xReceipt.cost = { status: "estimated", amount: "10", pricingReference: "test-only", currency: "USD", scale: 10 };
    await repo.recordReceipt(id, bytes(xReceipt)); await repo.recordIdentity(id, bytes(snapshot));
    await repo.beforeDispatch(id, "grok"); await repo.recordReceipt(id, bytes(receipt("grok", "10")));
    const value = assessment("alice", { provenance: "grok", model: "grok-4.3", providerResponseId: "resp-1", sourceUrls: ["https://x.com/alice"], xIdentity: snapshot });
    await repo.acceptAssessment(id, bytes(value));
    expect((await repo.admitInitial("alice")).kind).toBe("accepted");
    if (costStatus === "actual") expect((await repo.admitInitial("bob")).kind).toBe("created");
    else await expect(repo.admitInitial("bob")).rejects.toThrow("operator reconciliation");
  });
  it("keeps yesterday's unresolved reservation in exposure and includes actual overruns", async () => {
    // Seed a historical accepted record through the same tested operations,
    // then change only its day via a test-only disabled immutability trigger.
    const id = await throughGrok("alice", "950"); await repo.acceptAssessment(id, bytes(assessment()));
    await admin.query("ALTER TABLE open_mint.budget_reservations DISABLE TRIGGER immutable_reservation");
    try { await admin.query("UPDATE open_mint.budget_reservations SET admitted_day = CURRENT_DATE - 1 WHERE namespace_id = $1", [ns.id]); }
    finally { await admin.query("ALTER TABLE open_mint.budget_reservations ENABLE TRIGGER immutable_reservation"); }
    await expect(repo.admitInitial("bob")).rejects.toThrow(AdmissionBlockedError);
    expect((await admin.query("SELECT reserved_usd_ticks::text FROM open_mint.budget_reservations WHERE namespace_id = $1", [ns.id])).rows[0].reserved_usd_ticks).toBe("100");
  });
  it("fails closed after server-side connection termination", async () => {
    const id = await start();
    const pid = (await admin.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1936152941 AND objid = 17 AND granted")).rows[0].pid;
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await expect(repo.beforeDispatch(id, "x-identity")).rejects.toThrow(WriterUnavailableError);
    expect(() => owner.assertHealthy()).toThrow(WriterUnavailableError);
    expect((await admin.query("SELECT count(*)::int AS count FROM open_mint.dispatch_fences WHERE namespace_id = $1", [ns.id])).rows[0].count).toBe(0);
  });
});
