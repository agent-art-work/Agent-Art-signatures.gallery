import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generativeProjectionFixture as baseFixture, genEncoded } from "../fixtures/generativeProjectionRpc.js";
import { testHash as h, testAddress as a } from "../fixtures/projectionRpc.js";
import { createProjectionObserver, readProjectionObservation } from "./observer.js";
import { decodeGenerativeSignaturesBlock } from "./generativeDecode.js";
import { createGenerativeArtworkReader } from "../generativeReads.js";
import { createGenerativeArtworkReads } from "./generativeArtwork.js";
import { createProjectionCoordinator } from "./coordinator.js";
import { OpenMintProjection, type ProjectedMint } from "./postgres.js";
import { validateBatch, validateDeployment } from "./model.js";
import { disposablePostgres, installSchema } from "../persistence/fixtures/postgres.js";
import { ExclusiveWriter } from "../persistence/writer.js";
import { generativeRuntimeGrants, GENERATIVE_RUNTIME_PRIVILEGES } from "../persistence/runtimeRole.js";
import { auditGenerativeRole } from "../persistence/roleAudit.js";
import type { ProjectionReads } from "./http.js";

const signal = () => new AbortController().signal, empty = { head: null, promoted: null, tail: [] };
async function decoded(f = baseFixture()) {
  return decodeGenerativeSignaturesBlock({ deployment: f.options.deployment, block: { number: "11", hash: h(11), parentHash: h(10), timestamp: String(BigInt(f.header(11).timestamp)) },
    logs: f.logs(11), timeoutMs: 2000, signal: signal(), read: createGenerativeArtworkReader(f.options) });
}
describe.each(["generative-experimental-v1", "generative-v1-rc1"] as const)("%s event and verified public artwork boundaries", contractProfile => {
  const generativeProjectionFixture = () => baseFixture(contractProfile);
  it("acquires canonical receipt-bound input events, not output artifact hashes", async () => {
    const f = generativeProjectionFixture(), w = await createProjectionObserver(f.options)(empty, signal());
    const e = readProjectionObservation(w, f.options.deployment, Date.now()), m = e.batch!.blocks[1].events[1];
    expect(m).toMatchObject({ kind: "GenerativeSignatureMinted", handle: "alice_bob_key", renderHandle: "Alice_Bob_Key", mbti: "INTJ", inputDigest: f.inputs.digest });
    expect(m).not.toHaveProperty("artifactDigest"); expect(m).not.toHaveProperty("tokenURIHash");
    expect(e.promotion!.number).toBe("10"); expect(f.calls.filter(c => c.name === "tokenURI")).toHaveLength(2);
    expect(f.calls.filter(c => c.method === "eth_getTransactionReceipt")).toHaveLength(2);
    expect(f.calls.every(c => c.signal.aborted)).toBe(true);
  });
  it.each(["renderer", "rendererIdentity", "INPUT_PROFILE", "inputs", "provenance", "eip712Domain", "eth_getCode", "eth_getLogs", "eth_getTransactionReceipt"])("fails closed on %s disagreement", async name => {
    const f = generativeProjectionFixture();
    f.mutate((result, c) => c.source !== 1 || c.name !== name ? result : name === "eth_getLogs" ? [] : name === "eth_getTransactionReceipt" ? null : name === "eth_getCode" ? "0x6002" : "0x");
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow("unavailable");
  });
  it("requires explicit consistent local renderer pins and no old evidence resolver", () => {
    const f = generativeProjectionFixture();
    for (const patch of [{ deployment: { ...f.options.deployment, generativeRenderer: undefined } }, { resolveMint: async () => undefined },
      { config: { ...f.options.config, generativeRenderer: undefined } }]) expect(() => createProjectionObserver({ ...f.options, ...patch })).toThrow();
    if (contractProfile === "generative-experimental-v1") expect(() => validateDeployment({ ...f.options.deployment, chainId: "11155111" })).toThrow("Unsupported");
    else expect(validateDeployment({ ...f.options.deployment, chainId: "11155111" }).chainId).toBe("11155111");
  });
  it.each(["trailing data", "removed", "wrong token", "wrong recipient", "wrong commitment", "wrong profile"])("refuses malformed generative event: %s", async mode => {
    const f = generativeProjectionFixture();
    if (mode === "trailing data" || mode === "removed") {
      const original = f.logs;
      f.logs = n => original(n).map(l => mode === "removed" ? { ...l, removed: true } : { ...l, data: l.data + "00" });
      await expect(decoded(f)).rejects.toThrow(); return;
    }
    const result = await decoded(f), mint = result.block.events[1];
    Object.assign(mint, mode === "wrong token" ? { tokenId: "1" } : mode === "wrong recipient" ? { recipient: a(0) } : mode === "wrong commitment" ? { inputDigest: h(77) } : { rendererIdentity: h(77) });
    expect(() => validateBatch({ chainId: "31337", contractAddress: f.options.deployment.contractAddress, manifestHash: f.options.deployment.manifestHash, blocks: [result.block] }, f.options.deployment)).toThrow();
  });
  it("bounds stalled and cancelled event readers", async () => {
    const f = generativeProjectionFixture();
    const base = { deployment: f.options.deployment, block: { number: "11", hash: h(11), parentHash: h(10), timestamp: "1" }, logs: f.logs(11), timeoutMs: 5, signal: signal(), read: () => new Promise<never>(() => {}) };
    await expect(decodeGenerativeSignaturesBlock(base)).rejects.toThrow("cancelled");
    const c = new AbortController(); c.abort(); await expect(decodeGenerativeSignaturesBlock({ ...base, signal: c.signal })).rejects.toThrow();
    for (const timeoutMs of [0, NaN, 30001]) await expect(decodeGenerativeSignaturesBlock({ ...base, timeoutMs })).rejects.toThrow();
    await expect(decodeGenerativeSignaturesBlock({ ...base, logs: Array(129).fill(f.logs(11)[0]) })).rejects.toThrow();
  });
  function publicReads() {
    const f = generativeProjectionFixture(), mint: ProjectedMint = { tokenId: f.tokenId, availability: "unavailable", handle: f.inputs.canonicalHandle, renderHandle: f.inputs.renderHandle,
      mbti: f.inputs.mbti, inputDigest: f.inputs.digest, rendererIdentity: f.inputs.rendererIdentity, assessmentDigest: f.inputs.assessmentDigest,
      originalRecipient: a(1), currentOwner: a(3), transactionHash: h(200), authorizationDigest: h(501), inclusion: { number: "11", hash: h(11) } };
    const lookup = vi.fn<ProjectionReads["lookup"]>().mockResolvedValue({ state: "confirming", item: mint });
    const options = { ...f.options, projection: { lookup }, timeoutMs: 2000 };
    return { f, mint, lookup, options, reads: createGenerativeArtworkReads(options) };
  }
  it.each(["confirming", "confirmed"] as const)("recovers %s page and exact SVG/metadata, without a private journal or inferred Grok claims", async state => {
    const { f, mint, lookup, reads } = publicReads(); lookup.mockResolvedValue({ state, item: mint });
    const page = await reads.detail(f.inputs.canonicalHandle, signal());
    expect(page).toMatchObject({ mbti: "INTJ", renderHandle: "Alice_Bob_Key", inputDigest: f.inputs.digest, rendererIdentity: f.inputs.rendererIdentity,
      mint: { state: state === "confirmed" ? "minted" : "confirming" } });
    expect(page).not.toHaveProperty("artifactDigest"); expect(page).not.toHaveProperty("assessmentProvenance");
    for (const kind of ["svg", "metadata", "png"] as const) {
      const result = await reads.media(f.inputs.canonicalHandle, f.inputs.digest, kind, signal());
      expect(Buffer.from(result.bytes)).toEqual(kind === "svg" ? Buffer.from(f.svg) : kind === "metadata" ? Buffer.from(JSON.stringify(f.metadata)) : expect.any(Buffer));
      if (kind === "png") expect(Buffer.from(result.bytes).subarray(1, 4).toString()).toBe("PNG");
    }
    expect(lookup).toHaveBeenCalledTimes(8);
  });
  it.each(["unknown", "pending", "safety-halted"] as const)("does not read chain artwork for %s", async state => {
    const { f, mint, lookup, reads } = publicReads(); lookup.mockResolvedValue({ state, item: mint });
    await expect(reads.detail(f.inputs.canonicalHandle, signal())).rejects.toThrow("unavailable"); expect(f.calls).toHaveLength(0);
  });
  it("sharing PNG requires finality on both sides of rendering; Confirming still reveals only on-page", async () => {
    const { f, mint, lookup, reads } = publicReads();
    await expect(reads.sharingPng(f.inputs.canonicalHandle, f.inputs.digest, signal())).rejects.toThrow("unavailable");
    expect(f.calls).toHaveLength(0);
    lookup.mockResolvedValue({ state: "confirmed", item: mint });
    const shared = await reads.sharingPng(f.inputs.canonicalHandle, f.inputs.digest, signal());
    expect(shared.bytes).toEqual((await reads.media(f.inputs.canonicalHandle, f.inputs.digest, "png", signal())).bytes);
    lookup.mockResolvedValueOnce({ state: "confirmed", item: mint }).mockResolvedValue({ state: "unknown" });
    await expect(reads.sharingPng(f.inputs.canonicalHandle, f.inputs.digest, signal())).rejects.toThrow("unavailable");
  });
  it("artwork drain waits for underlying lookup cleanup even after the public read timed out", async () => {
    const { f, lookup, options } = publicReads(); let release!: () => void;
    lookup.mockImplementation(() => new Promise(resolve => { release = () => resolve({ state: "unknown" }); }));
    const reads = createGenerativeArtworkReads({ ...options, timeoutMs: 5 });
    await expect(reads.sharingPng(f.inputs.canonicalHandle, f.inputs.digest, signal())).rejects.toThrow("unavailable");
    let complete = false; const draining = reads.drain().then(() => { complete = true; }); await Promise.resolve(); expect(complete).toBe(false);
    release(); await draining; expect(complete).toBe(true); expect(f.calls).toHaveLength(0);
  });
  it.each([{ handle: "other" }, { tokenId: "1" }, { availability: "quarantined" }, { transactionHash: undefined }, { inclusion: undefined },
    { artifactDigest: h(5) }, { tokenURIHash: h(5) }, { rendererIdentity: h(5) }, { inputDigest: h(5) }, { assessmentDigest: h(5) },
    { mbti: "ENFP" }, { renderHandle: "alice_bob_key" }, { originalRecipient: a(5) }, { authorizationDigest: h(5) }])("rejects corrupt public binding %#", async change => {
    const { f, mint, lookup, reads } = publicReads(); lookup.mockResolvedValue({ state: "confirming", item: { ...mint, ...change } as ProjectedMint });
    await expect(reads.detail(f.inputs.canonicalHandle, signal())).rejects.toThrow("unavailable");
  });
  it("withdraws when freshness or inclusion changes during read, and refuses malformed input", async () => {
    const { f, lookup, reads, options } = publicReads();
    lookup.mockResolvedValueOnce({ state: "confirming", item: (await lookup(f.inputs.canonicalHandle)).item }).mockResolvedValue({ state: "unknown" });
    await expect(reads.detail(f.inputs.canonicalHandle, signal())).rejects.toThrow();
    for (const handle of ["Alice", "../alice"]) await expect(reads.detail(handle, signal())).rejects.toThrow();
    for (const timeoutMs of [0, 30001, NaN]) expect(() => createGenerativeArtworkReads({ ...options, timeoutMs })).toThrow();
    await expect(reads.media("alice", "bad", "svg", signal())).rejects.toThrow();
    await expect(reads.media("alice", h(1), "secret" as never, signal())).rejects.toThrow();
  });
  it.each(["cancel", "pre-cancel", "hung"])("bounds %s public artwork reads", async mode => {
    const { lookup, options, f } = publicReads(); lookup.mockImplementation(() => new Promise(() => {}));
    const c = new AbortController(); if (mode === "pre-cancel") c.abort(); if (mode === "cancel") setTimeout(() => c.abort(), 1);
    await expect(createGenerativeArtworkReads({ ...options, timeoutMs: 5 }).detail(f.inputs.canonicalHandle, c.signal)).rejects.toThrow("unavailable");
  });
  it("rejects incorrect requested digest and tampered inputs from two agreeing RPCs", async () => {
    const { f, reads } = publicReads(); await expect(reads.media(f.inputs.canonicalHandle, h(88), "svg", signal())).rejects.toThrow();
    f.mutate((result, c) => c.name === "inputs" ? genEncoded("inputs", ["Alice_Bob_Key", "ENFP"]) : result);
    await expect(decoded(f)).rejects.toThrow();
  });
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1").each(["generative-experimental-v1", "generative-v1-rc1"] as const)("%s restricted projection on real disposable PostgreSQL", contractProfile => {
  const generativeProjectionFixture = () => baseFixture(contractProfile);
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, runtime: Client, writer: ExclusiveWriter;
  let f: ReturnType<typeof generativeProjectionFixture>, projection: OpenMintProjection, service: ReturnType<typeof createProjectionCoordinator>;
  const role = "sg_generative_projection", factory = () => new Client({ ...cluster.config, user: role, options: "-c search_path=pg_catalog" });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    for (const file of ["../persistence/requests-schema.sql", "../persistence/generative-input-schema.sql", "../persistence/generative-authorization-schema.sql", "projection-schema.sql", "projection-v2.sql", "projection-v3.sql"]) {
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    }
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(generativeRuntimeGrants(role)); runtime = factory(); await runtime.connect();
  }, 30000);
  beforeEach(async () => {
    f = generativeProjectionFixture();
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-real','grok','test')", [f.options.deployment.namespaceId]);
    writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, f.options.deployment);
    service = createProjectionCoordinator(projection, f.options);
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await runtime?.end(); await admin?.end(); cluster?.stop(); });
  it("audits the exact role without publication or old authority permissions", async () => {
    expect(await auditGenerativeRole(runtime)).toMatchObject({ scope: "open-mint-generative-role-v1", ok: true, failedChecks: [] });
    expect(GENERATIVE_RUNTIME_PRIVILEGES.some(t => /publication|public_artifact|^authorizations$/.test(t.name))).toBe(false);
  });
  it("opens only a preprovisioned installed projection and never recreates missing state", async () => {
    expect(await (await OpenMintProjection.openExisting(writer, f.options.deployment)).checkpoint()).toMatchObject({ health: "unknown" });
    await admin.query("DELETE FROM open_mint.projection_checkpoints WHERE deployment_id=$1", [f.options.deployment.id]);
    await expect(OpenMintProjection.openExisting(writer, f.options.deployment)).rejects.toThrow("Installed projection unavailable");
    expect((await admin.query("SELECT count(*)::int AS count FROM open_mint.projection_checkpoints WHERE deployment_id=$1", [f.options.deployment.id])).rows[0].count).toBe(0);
  });
  it("reveals inclusion as Confirming, galleries after finality, exact current ownership and restart withdrawal", async () => {
    f.transfer(); expect(await service.sync(signal())).toBe("observed");
    expect((await service.lookup(f.inputs.canonicalHandle)).state).toBe("confirming");
    const live = { includeConfirming: true, limit: 10 };
    expect((await service.gallery({ ...live, filter: { kind: "home" } })).items[0]).toMatchObject({ mintState: "confirming", currentOwner: a(3) });
    expect((await service.gallery({ ...live, filter: { kind: "owner", value: a(3) } })).items).toHaveLength(1);
    expect((await service.gallery({ ...live, filter: { kind: "owner", value: a(1) } })).items).toHaveLength(0);
    expect((await service.gallery({ filter: { kind: "home" }, limit: 10 })).items).toHaveLength(0);
    f.setFinalized(11); expect(await service.sync(signal())).toBe("observed");
    const mint = (await service.gallery({ filter: { kind: "mbti", value: "INTJ" }, limit: 10 })).items[0];
    expect(mint).toMatchObject({ renderHandle: "Alice_Bob_Key", inputDigest: f.inputs.digest, currentOwner: a(1), originalRecipient: a(1) });
    expect(mint).not.toHaveProperty("artifactDigest");
    f.setFinalized(12); expect(await service.sync(signal())).toBe("observed");
    expect((await service.gallery({ filter: { kind: "owner", value: a(3) }, limit: 10 })).items[0]).toMatchObject({ currentOwner: a(3), originalRecipient: a(1) });
    const page = await createGenerativeArtworkReads({ ...f.options, projection: service, timeoutMs: 2000 }).detail(f.inputs.canonicalHandle, signal());
    expect(page.mint!.state).toBe("minted");
    service.withdraw(); await writer.close(); writer = await ExclusiveWriter.acquire(factory);
    projection = await OpenMintProjection.open(writer, f.options.deployment); service = createProjectionCoordinator(projection, f.options);
    expect((await service.lookup(f.inputs.canonicalHandle)).state).toBe("unknown");
    expect(await service.sync(signal())).toBe("observed"); expect((await service.lookup(f.inputs.canonicalHandle)).state).toBe("confirmed");
  });
  it("removes orphaned inclusion while keeping immutable logs, then halts on finalized contradiction", async () => {
    await service.sync(signal()); f.fork(11); expect(await service.sync(signal())).toBe("observed");
    expect((await service.lookup(f.inputs.canonicalHandle)).state).toBe("unknown");
    expect((await admin.query("SELECT count(*)::int n FROM open_mint.projection_logs WHERE deployment_id=$1", [f.options.deployment.id])).rows[0].n).toBe(2);
    f.setFinalized(12); await service.sync(signal()); f.fork(12);
    expect(await service.sync(signal())).toBe("safety-halted");
  });
  it("quarantines corrupted projection payloads without interpreting them as unminted", async () => {
    f.setFinalized(11); await service.sync(signal());
    await admin.query("ALTER TABLE open_mint.projection_mints DISABLE TRIGGER immutable_projection_mint");
    try { await admin.query("UPDATE open_mint.projection_mints SET payload=convert_to('{}','UTF8') WHERE deployment_id=$1", [f.options.deployment.id]); }
    finally { await admin.query("ALTER TABLE open_mint.projection_mints ENABLE TRIGGER immutable_projection_mint"); }
    expect((await service.lookup(f.inputs.canonicalHandle)).item).toEqual({ tokenId: f.tokenId, availability: "quarantined" });
  });
  it.each(["UPDATE open_mint.generative_inputs SET payload='x'", "DELETE FROM open_mint.generative_authorization_signatures",
    "UPDATE open_mint.generative_issuance_profiles SET enabled=true", "UPDATE open_mint.generative_authorizations SET input_digest='x'",
    "UPDATE open_mint.projection_mints SET mbti='ENFP'", "TRUNCATE open_mint.projection_logs", "ALTER TABLE open_mint.projection_logs DISABLE TRIGGER ALL"])("denies ungranted mutation %s", async sql => {
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
  });
  it("detects extra input-write grants and refuses migration replay", async () => {
    await admin.query(`GRANT UPDATE(payload) ON open_mint.generative_inputs TO ${role}`);
    try { expect((await auditGenerativeRole(runtime)).failedChecks).toContain("noExtraPrivileges"); }
    finally { await admin.query(`REVOKE UPDATE(payload) ON open_mint.generative_inputs FROM ${role}`); }
    await expect(admin.query(readFileSync(new URL("projection-v3.sql", import.meta.url), "utf8"))).rejects.toMatchObject({ code: "55000" }); await admin.query("ROLLBACK");
    expect((await admin.query("SELECT version FROM open_mint.projection_schema_version")).rows).toEqual([{ version: 3 }]);
  });
});
