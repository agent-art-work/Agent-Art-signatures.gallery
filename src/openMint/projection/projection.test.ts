import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openMintHandleKey } from "../authorization.js";
import { ExclusiveWriter, WriterUnavailableError } from "../persistence/writer.js";
import { disposablePostgres, installSchema } from "../persistence/fixtures/postgres.js";
import { OpenMintProjection } from "./postgres.js";
import { decodeCursor, encodeCursor, ProjectionCursorError, validateBatch, validateDeployment, validateEvent, validateFilter, validateLimit,
  ZERO_ADDRESS, type GalleryFilter, type ProjectionDeployment, type ValidatedBatch, type ValidatedBlock, type ValidatedEvent, type ValidatedMint } from "./model.js";

const h = (number: number): string => `0x${number.toString(16).padStart(64, "0")}`;
const a = (number: number): string => `0x${number.toString(16).padStart(40, "0")}`;
const tid = (number: number): string => BigInt(openMintHandleKey(`user${number}`)).toString();
function deployment(): ProjectionDeployment {
  return { id: randomUUID(), namespaceId: randomUUID(), chainId: "31337", contractAddress: a(100), manifestHash: h(100), deploymentBlock: "10", deploymentBlockHash: h(10),
    policy: { id: "synthetic-finality-policy", rollbackBlocks: 4, snapshotRetentionBlocks: 4 } };
}
function mint(token = 1, handle = `user${token}`, recipient = a(1), transactionIndex = token - 1, mbti = "INTJ"): ValidatedEvent[] {
  const common = { tokenId: BigInt(openMintHandleKey(handle)).toString(), transactionHash: h(1000 + token), transactionIndex };
  return [{ ...common, kind: "Transfer", logIndex: transactionIndex * 2, from: ZERO_ADDRESS, to: recipient },
    { ...common, kind: "OpenSignatureMinted", logIndex: transactionIndex * 2 + 1, handle, handleKey: openMintHandleKey(handle), recipient,
      assessmentDigest: h(2000 + token), artifactDigest: h(3000 + token), tokenURIHash: h(4000 + token), nonce: h(5000 + token), authorizationDigest: h(6000 + token), mbti,
      evidenceReference: `synthetic-validated-authority-${token}` }];
}
const block = (number: number, events: readonly ValidatedEvent[] = [], hash = h(number), parentHash = h(number - 1)): ValidatedBlock => ({ number: String(number), hash, parentHash, events });
const batch = (config: ProjectionDeployment, ...blocks: ValidatedBlock[]): ValidatedBatch => ({ chainId: config.chainId, contractAddress: config.contractAddress, manifestHash: config.manifestHash, blocks });

describe("bounded projection input/cursor contracts", () => {
  it("validates a complete synthetic batch without mutating caller data", () => {
    const config = deployment(), input = batch(config, block(10, mint()));
    expect(validateDeployment(config)).toEqual(config); expect(validateBatch(input, config)).toEqual(input);
    expect(validateBatch(input, config)).not.toBe(input);
  });
  it.each([
    (c: ProjectionDeployment) => { Object.assign(c, { chainId: 31337 }); },
    (c: ProjectionDeployment) => { Object.assign(c, { contractAddress: ZERO_ADDRESS }); },
    (c: ProjectionDeployment) => { Object.assign(c, { manifestHash: h(0) }); },
    (c: ProjectionDeployment) => { Object.assign(c.policy, { rollbackBlocks: 0 }); },
    (c: ProjectionDeployment) => { Object.assign(c.policy, { rollbackBlocks: 129 }); },
    (c: ProjectionDeployment) => { Object.assign(c.policy, { snapshotRetentionBlocks: 100001 }); },
    (c: ProjectionDeployment) => { Object.assign(c, { extra: "forbidden" }); },
  ])("refuses malformed deployment or implicit policy %#", mutate => { const config = deployment(); mutate(config); expect(() => validateDeployment(config)).toThrow(); });
  it.each([
    (b: ValidatedBatch) => { Object.assign(b, { chainId: "1" }); },
    (b: ValidatedBatch) => { Object.assign(b, { contractAddress: a(101) }); },
    (b: ValidatedBatch) => { Object.assign(b, { manifestHash: h(101) }); },
    (b: ValidatedBatch) => { Object.assign(b, { blocks: [] }); },
    (b: ValidatedBatch) => { Object.assign(b, { blocks: Array.from({ length: 33 }, (_, i) => block(10 + i)) }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0], { number: "09" }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0], { number: "9" }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0], { events: Array(129).fill(mint()[0]) }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0].events[1], { logIndex: 0 }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0].events[1], { transactionHash: h(900) }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0].events[1], { handleKey: h(900) }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0].events[1], { tokenId: "1" }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0].events[0], { to: ZERO_ADDRESS }); },
    (b: ValidatedBatch) => { Object.assign(b.blocks[0].events[0], { kind: "LegacyMinted" }); },
  ])("refuses wrong-bound, malformed or unbounded events %#", mutate => { const config = deployment(), input = batch(config, block(10, mint())); mutate(input); expect(() => validateBatch(input, config)).toThrow(); });
  it("rejects block gaps and parent mismatches", () => {
    const config = deployment();
    expect(() => validateBatch(batch(config, block(10), block(12)), config)).toThrow("Noncontiguous");
    expect(() => validateBatch(batch(config, block(10), block(11, [], h(11), h(99))), config)).toThrow("Noncontiguous");
  });
  it("bounds the whole batch event count, not just individual blocks", () => {
    const config = deployment(), events = Array.from({ length: 64 }, (_, i) => mint(i + 1)).flat();
    expect(() => validateBatch(batch(config, ...Array.from({ length: 5 }, (_, i) => block(10 + i, events))), config)).toThrow("Too many");
  });
  it("rejects duplicate new block hashes and non-adjacent transaction hash reuse", () => {
    const config = deployment();
    expect(() => validateBatch(batch(config, block(10), block(11, [], h(10), h(10))), config)).toThrow("Duplicate block hash");
    const events = [...mint(1), ...mint(2), ...mint(3)];
    Object.assign(events[4], { transactionHash: events[0].transactionHash }); Object.assign(events[5], { transactionHash: events[0].transactionHash });
    expect(() => validateBatch(batch(config, block(10, events)), config)).toThrow("conflicting event positions");
  });
  it.each([0, -1, 51, NaN, 1.5])("rejects page size %s", value => { expect(() => validateLimit(value)).toThrow(); });
  it.each([{ kind: "all" }, { kind: "owner", value: ZERO_ADDRESS }, { kind: "mbti", value: "XXXX" }, { kind: "home", extra: true }])("rejects filter %j", value => { expect(() => validateFilter(value as GalleryFilter)).toThrow(); });
  it("binds every cursor field with canonical bounded encoding", () => {
    const config = deployment(), filter = { kind: "home" } as const;
    const value = { version: 1 as const, deployment: config.id, filter, limit: 2, snapshot: { number: "10", hash: h(10) }, last: { block: "10", transaction: 1, log: 3, token: "2" } };
    const cursor = encodeCursor(value); expect(decodeCursor(cursor, config.id, filter, 2)).toEqual(value);
    const included = { ...value, includeConfirming: true as const }, live = encodeCursor(included);
    expect(decodeCursor(live, config.id, filter, 2, true)).toEqual(included);
    expect(() => decodeCursor(live, config.id, filter, 2)).toThrow(ProjectionCursorError);
    expect(() => decodeCursor(cursor, config.id, filter, 2, true)).toThrow(ProjectionCursorError);
    for (const text of ["!", "x".repeat(2049), `${cursor}=`, encodeCursor({ ...value, deployment: randomUUID() }), encodeCursor({ ...value, limit: 3 }),
      encodeCursor({ ...value, filter: { kind: "owner", value: a(1) } }), encodeCursor({ ...value, last: { ...value.last, block: "11" } })]) expect(() => decodeCursor(text, config.id, filter, 2)).toThrow(ProjectionCursorError);
  });
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("isolated PostgreSQL OpenSignatures projection", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, projection: OpenMintProjection, config: ProjectionDeployment;
  const factory = () => new Client(cluster.config);
  const promote = async (number: number, hash = h(number), evidenceReference = `synthetic-finality-${number}`) => projection.promote({ number: String(number), hash, policyId: config.policy.id, evidenceReference });
  const home = (limit = 50, cursor?: string) => projection.gallery({ filter: { kind: "home" }, limit, ...(cursor ? { cursor } : {}) });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    await admin.query(readFileSync(new URL("./projection-schema.sql", import.meta.url), "utf8"));
    await admin.query(readFileSync(new URL("./projection-v2.sql", import.meta.url), "utf8"));
  }, 30000);
  beforeEach(async () => {
    config = deployment(); await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-fixture','development-fixture','fixture-policy')", [config.namespaceId]);
    writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, config);
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("does not grant PUBLIC execution of additive projection trigger functions", async () => {
    const rows = (await admin.query(`SELECT p.proname, EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='open_mint'
      AND p.proname IN ('guard_projection_block','guard_projection_mint','guard_projection_ownership')`)).rows;
    expect(rows).toHaveLength(3); expect(rows.every(row => row.public_execute === false)).toBe(true);
  });

  it("retains exact logs and atomically checkpoints, with replay and restart idempotence", async () => {
    const input = batch(config, block(10, [...mint(1), ...mint(2)]));
    await projection.append(input); await projection.append(input); await promote(10); await promote(10);
    expect((await home()).items.map(item => item.tokenId)).toEqual([tid(2), tid(1)]);
    expect((await projection.checkpoint()).head_number).toBe("10");
    expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.projection_logs WHERE deployment_id=$1", [config.id])).rows[0].n).toBe(4);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, config);
    expect((await home()).items[0].originalRecipient).toBe(a(1)); await projection.append(input);
    await expect(OpenMintProjection.open(writer, { ...config, manifestHash: h(999) })).rejects.toThrow("Immutable projection deployment");
  });
  it("distinguishes pending, confirmed, unknown/unavailable and halted without unminted", async () => {
    expect(await home()).toEqual({ state: "unknown", items: [] }); expect(await projection.lookup("missing")).toEqual({ state: "unknown" });
    await projection.append(batch(config, block(10, mint()))); expect(await projection.lookup("user1")).toEqual({ state: "pending" });
    await promote(10); expect((await projection.lookup("user1")).state).toBe("confirmed");
    await projection.unavailable(); expect(await home()).toEqual({ state: "unknown", items: [] }); expect(await projection.lookup("user1")).toEqual({ state: "unknown" });
    await expect(promote(10)).rejects.toThrow("cannot promote");
    expect((await projection.checkpoint()).promoted_number).toBe("10");
  });
  it("replaying a saved batch is not fresh-chain verification or a new promotion", async () => {
    const input = batch(config, block(10, mint())); await projection.append(input); await projection.unavailable();
    await projection.append(input);
    expect(await projection.checkpoint()).toMatchObject({ head_number: "10", promoted_number: null, health: "available", freshChainVerified: false });
    expect(await home()).toEqual({ state: "unknown", items: [] }); expect(await projection.lookup("missing")).toEqual({ state: "unknown" });
  });
  it("uses the same promotion boundary for mint and multiple ownership changes", async () => {
    await projection.append(batch(config, block(10, mint()))); await promote(10);
    const transfer = { kind: "Transfer" as const, tokenId: tid(1), transactionHash: h(1101), transactionIndex: 0 };
    await projection.append(batch(config, block(11, [{ ...transfer, from: a(1), to: a(2), logIndex: 0 }, { ...transfer, from: a(2), to: a(2), logIndex: 1 }, { ...transfer, from: a(2), to: a(3), logIndex: 2 }])));
    expect((await projection.lookup("user1")).item?.currentOwner).toBe(a(1));
    expect((await projection.gallery({ filter: { kind: "owner", value: a(3) }, limit: 1 })).items).toEqual([]);
    await promote(11); expect((await projection.lookup("user1")).item).toMatchObject({ originalRecipient: a(1), currentOwner: a(3) });
    expect((await projection.gallery({ filter: { kind: "owner", value: a(2) }, limit: 1 })).items).toEqual([]);
  });
  it("uses immutable positions and pins home/MBTI/owner cursors across later transfers", async () => {
    await projection.append(batch(config, block(10, [...mint(1), ...mint(2), ...mint(3, "user3", a(1), 2, "ENFP")]))); await promote(10);
    const first = await home(1); expect(first.items[0].tokenId).toBe(tid(3)); expect(first.nextCursor).toBeDefined();
    const ownerFirst = await projection.gallery({ filter: { kind: "owner", value: a(1) }, limit: 1 });
    await projection.append(batch(config, block(11, [{ kind: "Transfer", tokenId: tid(2), from: a(1), to: a(2), transactionHash: h(1101), transactionIndex: 0, logIndex: 0 }]))); await promote(11);
    const next = await home(1, first.nextCursor); expect(next.snapshot?.number).toBe("10"); expect(next.items[0]).toMatchObject({ tokenId: tid(2), currentOwner: a(1), originalRecipient: a(1) });
    const ownerNext = await projection.gallery({ filter: { kind: "owner", value: a(1) }, limit: 1, cursor: ownerFirst.nextCursor }); expect(ownerNext.items[0].tokenId).toBe(tid(2));
    expect((await projection.gallery({ filter: { kind: "owner", value: a(2) }, limit: 5 })).items[0]).toMatchObject({ tokenId: tid(2), currentOwner: a(2), originalRecipient: a(1) });
    expect((await projection.gallery({ filter: { kind: "mbti", value: "INTJ" }, limit: 5 })).items.map(item => item.tokenId)).toEqual([tid(2), tid(1)]);
    expect(() => projection.gallery({ filter: { kind: "owner", value: a(2) }, limit: 1, cursor: ownerFirst.nextCursor })).toThrow("cursor");
  });
  it("rolls back an unpromoted fork while retaining logs and original recipient", async () => {
    await projection.append(batch(config, block(10, mint()))); await promote(10);
    await projection.append(batch(config, block(11, [{ kind: "Transfer", tokenId: tid(1), from: a(1), to: a(2), transactionHash: h(1101), transactionIndex: 0, logIndex: 0 }]), block(12, mint(2))));
    const replacement = block(11, [{ kind: "Transfer", tokenId: tid(1), from: a(1), to: a(3), transactionHash: h(1111), transactionIndex: 0, logIndex: 0 }], h(111), h(10));
    expect(await projection.append(batch(config, replacement))).toBe("observed"); await promote(11, h(111));
    expect((await home()).items).toHaveLength(1); expect((await home()).items[0]).toMatchObject({ currentOwner: a(3), originalRecipient: a(1) });
    expect(await projection.lookup("user2")).toEqual({ state: "unknown" });
    expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.projection_blocks WHERE deployment_id=$1 AND NOT canonical", [config.id])).rows[0].n).toBe(2);
    expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.projection_logs WHERE deployment_id=$1", [config.id])).rows[0].n).toBe(6);
  });
  it("halts durably on a promoted contradiction and cannot resume by replay or unavailable", async () => {
    await projection.append(batch(config, block(10, mint()), block(11))); await promote(11);
    expect(await projection.append(batch(config, block(11, [], h(111), h(10))))).toBe("safety-halted");
    expect(await home()).toEqual({ state: "safety-halted", items: [] }); expect(await projection.lookup("user1")).toEqual({ state: "safety-halted" });
    await projection.unavailable(); expect(await projection.append(batch(config, block(10, mint())))).toBe("safety-halted");
    await expect(promote(11)).rejects.toThrow("cannot promote");
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, config);
    expect((await projection.checkpoint()).health).toBe("safety-halted");
  });
  it("halts on rollback beyond the explicit horizon even before promotion", async () => {
    await projection.append(batch(config, ...Array.from({ length: 6 }, (_, i) => block(10 + i))));
    expect(await projection.append(batch(config, block(11, [], h(111), h(10))))).toBe("safety-halted");
  });
  it("halts immutable same-hash log contradictions without replacing evidence", async () => {
    await projection.append(batch(config, block(10, mint())));
    expect(await projection.append(batch(config, block(10)))).toBe("safety-halted");
    expect((await projection.checkpoint()).halt_reason).toBe("immutable-block-contradiction");
  });
  it("requires the exact deployment block and a contiguous known parent", async () => {
    await expect(projection.append(batch(config, block(11)))).rejects.toThrow("exact deployment");
    await projection.append(batch(config, block(10)));
    await expect(projection.append(batch(config, block(12)))).rejects.toThrow("gap");
    await expect(projection.append(batch(config, block(11, [], h(11), h(999))))).rejects.toThrow("known canonical parent");
    expect(await projection.append(batch(config, block(10, [], h(999))))).toBe("safety-halted");
  });
  it("rejects competing handles/tokens and wrong transfers atomically", async () => {
    await projection.append(batch(config, block(10, mint())));
    await expect(projection.append(batch(config, block(11, mint(2, "user1"))))).rejects.toThrow();
    await expect(projection.append(batch(config, block(11, mint(1, "other"))))).rejects.toThrow();
    await expect(projection.append(batch(config, block(11, [{ kind: "Transfer", tokenId: tid(1), from: a(2), to: a(3), transactionHash: h(900), transactionIndex: 0, logIndex: 0 }])))).rejects.toThrow("projected owner");
    expect((await projection.checkpoint()).head_number).toBe("10");
    expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.projection_blocks WHERE deployment_id=$1", [config.id])).rows[0].n).toBe(1);
  });
  it("refuses missing or mismatched mint Transfer evidence", async () => {
    await expect(projection.append(batch(config, block(10, [mint()[1]])))).rejects.toThrow("matching");
    await expect(projection.append(batch(config, block(10, [mint()[0]])))).rejects.toThrow("Unmatched");
    const events = mint(); Object.assign(events[0], { to: a(2) });
    await expect(projection.append(batch(config, block(10, events)))).rejects.toThrow("matching");
    expect((await projection.checkpoint()).head_number).toBeNull();
  });
  it("rolls back all inserts when final checkpoint persistence fails", async () => {
    await admin.query(`CREATE FUNCTION open_mint.test_fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$;
      CREATE TRIGGER test_fail_checkpoint BEFORE UPDATE ON open_mint.projection_checkpoints FOR EACH ROW EXECUTE FUNCTION open_mint.test_fail_checkpoint()`);
    try { await expect(projection.append(batch(config, block(10, mint())))).rejects.toThrow("injected checkpoint failure"); }
    finally { await admin.query("DROP TRIGGER test_fail_checkpoint ON open_mint.projection_checkpoints; DROP FUNCTION open_mint.test_fail_checkpoint()"); }
    for (const table of ["projection_blocks", "projection_logs", "projection_mints", "projection_ownership"]) expect((await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE deployment_id=$1`, [config.id])).rows[0].n).toBe(0);
    await projection.append(batch(config, block(10, mint())));
  });
  it("invalidates retained cursors after the explicitly bounded snapshot horizon", async () => {
    await projection.append(batch(config, block(10, [...mint(1), ...mint(2)]))); await promote(10); const first = await home(1);
    await projection.append(batch(config, ...Array.from({ length: 5 }, (_, i) => block(11 + i)))); await promote(15);
    await expect(home(1, first.nextCursor)).rejects.toThrow("Expired");
  });
  it("keeps a corrupt or unavailable artwork from breaking unrelated gallery works", async () => {
    await projection.append(batch(config, block(10, [...mint(1), ...mint(2), ...mint(3)]))); await promote(10);
    await projection.setArtifactAvailability({ tokenId: tid(3), artifactDigest: h(3003), availability: "available" });
    await projection.setArtifactAvailability({ tokenId: tid(2), artifactDigest: h(3002), availability: "quarantined" });
    await admin.query("ALTER TABLE open_mint.projection_mints DISABLE TRIGGER immutable_projection_mint");
    try { await admin.query("UPDATE open_mint.projection_mints SET payload=$3 WHERE deployment_id=$1 AND token_id=$2", [config.id, tid(1), Buffer.from("corrupt")]); }
    finally { await admin.query("ALTER TABLE open_mint.projection_mints ENABLE TRIGGER immutable_projection_mint"); }
    expect((await home()).items.map(item => [item.tokenId, item.availability])).toEqual([[tid(3), "available"], [tid(2), "quarantined"], [tid(1), "quarantined"]]);
    expect((await projection.lookup("user1")).state).toBe("unknown");
    await expect(projection.setArtifactAvailability({ tokenId: "999", artifactDigest: h(3999), availability: "available" })).rejects.toThrow("Unknown");
  });
  it("binds delayed availability observations to the exact post-reorg artifact", async () => {
    await projection.append(batch(config, block(10), block(11, mint())));
    const changed = mint(); Object.assign(changed[1], { artifactDigest: h(3999) });
    await projection.append(batch(config, block(11, changed, h(111), h(10)))); await promote(11, h(111));
    await expect(projection.setArtifactAvailability({ tokenId: tid(1), artifactDigest: h(3001), availability: "available" })).rejects.toThrow("binding changed");
    expect((await home()).items[0].availability).toBe("unavailable");
    await projection.setArtifactAvailability({ tokenId: tid(1), artifactDigest: h(3999), availability: "available" });
    expect((await home()).items[0].availability).toBe("available");
  });
  it("quarantines a well-formed materialized commitment that conflicts with its retained log", async () => {
    await projection.append(batch(config, block(10, [...mint(1), ...mint(2)]))); await promote(10);
    const changed = { ...mint()[1], artifactDigest: h(3999) };
    await admin.query("ALTER TABLE open_mint.projection_mints DISABLE TRIGGER immutable_projection_mint");
    try { await admin.query("UPDATE open_mint.projection_mints SET payload=$3 WHERE deployment_id=$1 AND token_id=$2", [config.id, tid(1), Buffer.from(JSON.stringify(changed))]); }
    finally { await admin.query("ALTER TABLE open_mint.projection_mints ENABLE TRIGGER immutable_projection_mint"); }
    expect((await home()).items).toEqual([expect.objectContaining({ tokenId: tid(2), handle: "user2" }), { tokenId: tid(1), availability: "quarantined" }]);
  });
  it("enforces promotion policy, canonical hash and exact immutable evidence", async () => {
    await projection.append(batch(config, block(10, mint())));
    expect(() => projection.promote({ number: "10", hash: h(10), policyId: "other", evidenceReference: "ref" })).toThrow("policy");
    await expect(promote(11)).rejects.toThrow("cannot promote"); await expect(promote(10, h(99))).rejects.toThrow("canonical");
    await promote(10); await expect(promote(10, h(10), "changed-evidence")).rejects.toThrow("Conflicting");
    await expect(admin.query("DELETE FROM open_mint.projection_logs WHERE deployment_id=$1", [config.id])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("DELETE FROM open_mint.projection_mints WHERE deployment_id=$1", [config.id])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("UPDATE open_mint.projection_mints SET handle='changed' WHERE deployment_id=$1", [config.id])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("UPDATE open_mint.projection_promotions SET evidence_reference='changed' WHERE deployment_id=$1", [config.id])).rejects.toMatchObject({ code: "55000" });
  });
  it("rejects a second writer and refuses reads after ownership is lost", async () => {
    await expect(ExclusiveWriter.acquire(factory)).rejects.toThrow(WriterUnavailableError);
    const pid = (await admin.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1936152941 AND objid=17 AND granted")).rows[0].pid;
    await admin.query("SELECT pg_terminate_backend($1)", [pid]); await expect(home()).rejects.toThrow(WriterUnavailableError);
  });
});
