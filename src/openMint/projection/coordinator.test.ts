import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { projectionRpcFixture, testHash } from "../fixtures/projectionRpc.js";
import { disposablePostgres, installSchema } from "../persistence/fixtures/postgres.js";
import { ExclusiveWriter } from "../persistence/writer.js";
import { createProjectionCoordinator } from "./coordinator.js";
import { createProjectionObserver, type ProjectionObservation } from "./observer.js";
import { OpenMintProjection } from "./postgres.js";
import { createProjectionReadHandler } from "./http.js";
import { createVerifiedArtworkReads } from "./artwork.js";
import { createProjectionPoller } from "./poller.js";

const signal = () => new AbortController().signal;
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("RPC witness → fenced PostgreSQL → read service", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, projection: OpenMintProjection;
  let fixture: Awaited<ReturnType<typeof projectionRpcFixture>>, service: ReturnType<typeof createProjectionCoordinator>;
  const factory = () => new Client(cluster.config);
  const home = () => service.gallery({ filter: { kind: "home" }, limit: 10 });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    await admin.query(readFileSync(new URL("./projection-schema.sql", import.meta.url), "utf8"));
    await admin.query(readFileSync(new URL("./projection-v2.sql", import.meta.url), "utf8"));
  }, 30000);
  beforeEach(async () => {
    fixture = await projectionRpcFixture();
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-fixture','development-fixture','fixture-policy')", [fixture.options.deployment.namespaceId]);
    writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, fixture.options.deployment);
    service = createProjectionCoordinator(projection, fixture.options);
  });
  afterEach(async () => { vi.restoreAllMocks(); await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("reveals Confirming after verified inclusion, keeping galleries empty until finalized", async () => {
    expect(await home()).toEqual({ state: "unknown", items: [] });
    expect(await service.sync(signal())).toBe("observed");
    expect(await service.lookup("alice_bob_key")).toMatchObject({ state: "confirming", item: { mbti: "INTJ", transactionHash: testHash(200) } });
    expect((await home()).items).toEqual([]);
    expect(await projection.lookup("alice_bob_key")).toEqual({ state: "pending" }); // raw store has no reveal authority
    fixture.setFinalized(11); expect(await service.sync(signal())).toBe("observed");
    expect(await service.lookup("alice_bob_key")).toMatchObject({ state: "confirmed" });
    expect((await home()).items).toHaveLength(1);
    expect((await service.gallery({ filter: { kind: "mbti", value: "INTJ" }, limit: 10 })).items).toHaveLength(1);
    const calls = fixture.calls.length; await home(); await service.lookup("alice_bob_key"); expect(fixture.calls).toHaveLength(calls);
  });
  it("shows fresh RPC-validated inclusion in presentation galleries while retaining finalized-only reads", async () => {
    const live = (filter = { kind: "home" } as import("./model.js").GalleryFilter) => service.gallery({ filter, limit: 10, includeConfirming: true });
    expect(await live()).toEqual({ state: "unknown", items: [] });
    expect(await service.sync(signal())).toBe("observed");
    const owner = (await live()).items[0].currentOwner!;
    for (const filter of [{ kind: "home" }, { kind: "mbti", value: "INTJ" }, { kind: "owner", value: owner }] as const) {
      const result = await live(filter);
      expect(result.items).toEqual([expect.objectContaining({ mintState: "confirming", handle: "alice_bob_key", currentOwner: owner })]);
      expect(result.state).toBe("confirmed");
    }
    expect((await home()).items).toHaveLength(0);
    expect(await projection.gallery({ filter: { kind: "home" }, limit: 10, includeConfirming: true })).toEqual({ state: "unknown", items: [] });
    fixture.setFinalized(11); await service.sync(signal());
    expect((await live()).items[0].mintState).toBe("minted");
    service.withdraw(); expect(await live()).toEqual({ state: "unknown", items: [] });
  });
  it("requires fresh verification after restart, even with a saved available checkpoint", async () => {
    fixture.setFinalized(12); await service.sync(signal()); expect((await home()).items).toHaveLength(1);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, fixture.options.deployment);
    service = createProjectionCoordinator(projection, fixture.options);
    expect(await home()).toEqual({ state: "unknown", items: [] }); expect(await service.lookup("alice_bob_key")).toEqual({ state: "unknown" });
    expect(await service.sync(signal())).toBe("observed"); expect((await home()).items).toHaveLength(1);
  });
  it("withdraws immediately on drain and refuses freshness from an already-running pass", async () => {
    await service.sync(signal()); expect((await service.lookup("alice_bob_key")).state).toBe("confirming");
    service.withdraw(); expect(await service.lookup("alice_bob_key")).toEqual({ state: "unknown" });
    let resume!: () => void, entered!: () => void;
    const waiting = new Promise<void>(r => { resume = r; }), ready = new Promise<void>(r => { entered = r; });
    const apply = projection.applyObservation.bind(projection);
    vi.spyOn(projection, "applyObservation").mockImplementationOnce(async witness => { entered(); await waiting; return apply(witness); });
    const pending = service.sync(signal()); await ready; service.withdraw(); resume();
    expect(await pending).toBe("unavailable"); expect(await service.lookup("alice_bob_key")).toEqual({ state: "unknown" });
    expect(await service.sync(signal())).toBe("observed"); expect((await service.lookup("alice_bob_key")).state).toBe("confirming");
  });
  it("polls read-only finality through the real coordinator, then withdraws on stop", async () => {
    let completed!: () => void;
    const sync = async (s: AbortSignal) => { const outcome = await service.sync(s); completed(); return outcome; };
    const poller = createProjectionPoller({ sync, withdraw: service.withdraw }, { intervalMs: 250, maxBackoffMs: 1000, passTimeoutMs: 5000 });
    try {
      const first = new Promise<void>(r => { completed = r; }); poller.start(signal()); await first;
      expect((await service.lookup("alice_bob_key")).state).toBe("confirming");
      const second = new Promise<void>(r => { completed = r; }); fixture.setFinalized(11); await second;
      expect((await home()).items).toHaveLength(1);
    } finally { poller.stop(); }
    expect(await home()).toEqual({ state: "unknown", items: [] });
  });
  it("removes provisional reveal on shallow reorg, retaining exact orphan logs", async () => {
    await service.sync(signal()); fixture.fork(11);
    expect(await service.sync(signal())).toBe("observed"); expect(await service.lookup("alice_bob_key")).toEqual({ state: "unknown" });
    const rows = await admin.query("SELECT count(*)::int AS n FROM open_mint.projection_logs WHERE deployment_id=$1", [fixture.options.deployment.id]);
    expect(rows.rows[0].n).toBe(2); expect((await projection.checkpoint()).head_hash).toBe(testHash(10012));
  });
  it("persists finalized contradictions as a safety halt, never an empty/unminted result", async () => {
    fixture.setFinalized(11); await service.sync(signal()); fixture.fork(11);
    expect(await service.sync(signal())).toBe("safety-halted");
    expect(await home()).toEqual({ state: "unknown", items: [] });
    expect(await projection.checkpoint()).toMatchObject({ health: "safety-halted", halt_reason: "canonical-contradiction" });
    expect(await service.sync(signal())).toBe("safety-halted");
    expect((await projection.checkpoint()).health).toBe("safety-halted");
    // A new process must stop too, before consulting RPCs or retrying a halt.
    service = createProjectionCoordinator(projection, fixture.options);
    const calls = fixture.calls.length; expect(await service.sync(signal())).toBe("safety-halted"); expect(fixture.calls).toHaveLength(calls);
  });
  it("reports writer loss as terminal rather than retryable chain unavailability", async () => {
    await service.sync(signal()); const calls = fixture.calls.length; await writer.close();
    expect(await service.sync(signal())).toBe("writer-unavailable"); expect(fixture.calls).toHaveLength(calls);
    expect(await home()).toEqual({ state: "unknown", items: [] });
  });
  it("fails closed on an RPC outage and recovers only through an explicit new pass", async () => {
    fixture.setFinalized(11); await service.sync(signal());
    fixture.mutate(() => { throw new Error("https://rpc.example/SECRET"); });
    expect(await service.sync(signal())).toBe("unavailable"); expect((await home()).items).toEqual([]);
    expect((await projection.checkpoint()).promoted_number).toBe("11");
    fixture.mutate(r => r); expect(await service.sync(signal())).toBe("observed"); expect((await home()).items).toHaveLength(1);
  });
  it("rejects forged, cross-deployment, expired and replayed observations", async () => {
    await expect(projection.applyObservation({} as ProjectionObservation)).rejects.toThrow();
    const observe = createProjectionObserver(fixture.options), cursor = await projection.chainCursor(), witness = await observe(cursor, signal());
    await projection.applyObservation(witness);
    await expect(projection.applyObservation(witness)).rejects.toThrow("changed during");
    const old = await createProjectionObserver(fixture.options, () => Date.now() - 40_000)(await projection.chainCursor(), signal());
    await expect(projection.applyObservation(old)).rejects.toThrow();
    const foreign = await projectionRpcFixture();
    await expect(projection.applyObservation(await createProjectionObserver(foreign.options)({ head: null, promoted: null, tail: [] }, signal()))).rejects.toThrow();
  });
  it("does not expose partial backfill, even after its early blocks are promoted", async () => {
    fixture.setHead(70); fixture.setFinalized(65);
    expect(await service.sync(signal())).toBe("observed"); expect((await projection.checkpoint()).head_number).toBe("41");
    expect(await home()).toEqual({ state: "unknown", items: [] }); expect(await service.lookup("alice_bob_key")).toEqual({ state: "unknown" });
    expect(await service.sync(signal())).toBe("observed"); expect((await home()).items).toHaveLength(1);
  });
  it("serializes sync and withdraws freshness while a new pass is in flight", async () => {
    fixture.setFinalized(11); await service.sync(signal()); const stop = new AbortController();
    fixture.mutate(() => new Promise(() => {})); const running = service.sync(stop.signal);
    expect(await service.sync(signal())).toBe("busy"); expect(await home()).toEqual({ state: "unknown", items: [] });
    stop.abort(); expect(await running).toBe("unavailable");
  });
  it("invalidates an in-flight read if a sync begins before it completes", async () => {
    fixture.setFinalized(11); await service.sync(signal());
    const original = projection.gallery.bind(projection);
    vi.spyOn(projection, "gallery").mockImplementation(async (...args) => { const result = await original(...args); await service.sync(signal()); return result; });
    expect(await home()).toEqual({ state: "unknown", items: [] });
  });
  it("cannot reveal through an old witness after an offline maintenance write", async () => {
    await service.sync(signal()); await projection.unavailable(); expect(await service.lookup("alice_bob_key")).toEqual({ state: "unknown" });
  });
  it("rolls append, ownership and checkpoint back together when finality persistence fails", async () => {
    fixture.setFinalized(11);
    await admin.query(`CREATE FUNCTION open_mint.test_reject_promotion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected persistence fault'; END $$;
      CREATE TRIGGER test_reject_promotion BEFORE INSERT ON open_mint.projection_promotions FOR EACH ROW EXECUTE FUNCTION open_mint.test_reject_promotion()`);
    try {
      expect(await service.sync(signal())).toBe("unavailable");
      expect(await projection.checkpoint()).toMatchObject({ head_number: null, promoted_number: null });
      for (const table of ["projection_blocks", "projection_logs", "projection_mints", "projection_ownership"]) {
        expect((await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE deployment_id=$1`, [fixture.options.deployment.id])).rows[0].n).toBe(0);
      }
    } finally { await admin.query("DROP TRIGGER test_reject_promotion ON open_mint.projection_promotions; DROP FUNCTION open_mint.test_reject_promotion()"); }
    expect(await service.sync(signal())).toBe("observed"); expect((await home()).items).toHaveLength(1);
  });
  it("rolls back a witness that expires during the real database transaction", async () => {
    fixture.options.config.evidenceTtlMs = 100;
    const witness = await createProjectionObserver(fixture.options)(await projection.chainCursor(), signal());
    await admin.query(`CREATE FUNCTION open_mint.test_delay_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
      CREATE TRIGGER test_delay_checkpoint BEFORE UPDATE ON open_mint.projection_checkpoints FOR EACH ROW EXECUTE FUNCTION open_mint.test_delay_checkpoint()`);
    try {
      await expect(projection.applyObservation(witness)).rejects.toThrow();
      expect(await projection.checkpoint()).toMatchObject({ head_number: null, promoted_number: null });
    } finally { await admin.query("DROP TRIGGER test_delay_checkpoint ON open_mint.projection_checkpoints; DROP FUNCTION open_mint.test_delay_checkpoint()"); }
  });
  it("rejects malformed cursors without relabeling them as empty galleries", async () => {
    fixture.setFinalized(11); await service.sync(signal());
    await expect(service.gallery({ filter: { kind: "home" }, limit: 10, cursor: "invalid" })).rejects.toThrow("cursor");
  });
  it("keeps unrelated pages readable when a projected item is corrupt", async () => {
    fixture.setFinalized(11); await service.sync(signal());
    await admin.query("ALTER TABLE open_mint.projection_mints DISABLE TRIGGER USER");
    try { await admin.query("UPDATE open_mint.projection_mints SET mbti='ENFP' WHERE deployment_id=$1", [fixture.options.deployment.id]); }
    finally { await admin.query("ALTER TABLE open_mint.projection_mints ENABLE TRIGGER USER"); }
    expect((await home()).items[0]).toMatchObject({ availability: "quarantined" });
    expect(await service.lookup("alice_bob_key")).toMatchObject({ state: "unknown", item: { availability: "quarantined" } });
  });
  it.skipIf(process.env.OPEN_MINT_TEST_HTTP !== "1")("serves verified status and paginated galleries over real isolated loopback HTTP with no read-triggered RPC", async () => {
    const artwork = createVerifiedArtworkReads({ projection: service,
      journal: { namespaceId: fixture.options.deployment.namespaceId, origin: fixture.evidence.artifact.origin, load: async () => structuredClone(fixture.evidence.artifact) },
      namespaceId: fixture.options.deployment.namespaceId, origin: fixture.evidence.artifact.origin, timeoutMs: 1000 });
    const handler = createProjectionReadHandler(service, artwork), server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect((await fetch(`${url}/api/gallery`)).status).toBe(503);
      const mediaUrl = `${url}/api/signatures/alice_bob_key/artwork/${fixture.evidence.artifact.digest}/svg`;
      expect((await fetch(mediaUrl)).status).toBe(503);
      await service.sync(signal());
      const status = await fetch(`${url}/api/signatures/alice_bob_key/status`); expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toMatchObject({ state: "confirming" });
      const image = await fetch(mediaUrl); expect(image.status).toBe(200); expect(image.headers.get("cache-control")).toBe("no-store");
      expect(image.headers.get("content-security-policy")).toContain("sandbox");
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(fixture.evidence.artifact.svg.bytes);
      expect((await fetch(`${mediaUrl}?mbti=ENFP`)).status).toBe(400);
      expect((await (await fetch(`${url}/api/gallery`)).json()).items).toEqual([expect.objectContaining({ mintState: "confirming" })]);
      fixture.setFinalized(11); await service.sync(signal()); const before = fixture.calls.length;
      expect((await (await fetch(`${url}/api/gallery?mbti=INTJ&limit=1`)).json()).items).toHaveLength(1);
      expect((await (await fetch(`${url}/api/signatures/alice_bob_key/status`)).json()).state).toBe("minted");
      expect(fixture.calls).toHaveLength(before);
      fixture.mutate(() => { throw new Error("RPC unavailable"); }); await service.sync(signal()); expect((await fetch(mediaUrl)).status).toBe(503);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
