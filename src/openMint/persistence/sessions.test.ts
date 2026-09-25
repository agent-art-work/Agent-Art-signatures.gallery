import { randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { opaqueCode } from "../security.js";
import { PostgresWalletSessions, capabilityHash } from "./sessions.js";
import { ExclusiveWriter, WriterUnavailableError, type OwnershipConnection } from "./writer.js";

const origin = "https://signatures.example", namespaceId = randomUUID();
const alice = privateKeyToAccount(`0x${"1".repeat(64)}`), bob = privateKeyToAccount(`0x${"2".repeat(64)}`);
type Row = Record<string, any>;
/** Transactional memory test double. Real PostgreSQL replay/continuity is
 * separately covered by postgres.test.ts; no SQL isolation claim here. */
async function harness(verifySignature?: Parameters<typeof PostgresWalletSessions.open>[0]["verifySignature"], staging = false) {
  const boundOrigin = staging ? "https://staging.signatures.gallery" : origin, chainId = staging ? 11155111 : 31337;
  let state = { sessions: new Map<string, Row>(), challenges: new Map<string, Row>() };
  let now = Date.parse("2026-09-20T00:00:00Z"), countOverride: string | undefined;
  let failed = false, failCommit = false, tail: Promise<unknown> = Promise.resolve();
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: Pick<OwnershipConnection, "query"> = { async query<R extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<R>> {
    calls.push({ sql, values }); let rows: Row[] = [], count = 0;
    if (sql.includes("FROM open_mint.session_profiles")) rows = [{ origin: boundOrigin, chain_id: String(chainId) }];
    else if (sql.includes("clock_timestamp")) rows = [{ now: new Date(now) }];
    else if (sql.includes("count(*)")) rows = [{ count: countOverride ?? String([...state.sessions.values()].filter(row => !row.revoked && row.expires_at.getTime() > now).length) }];
    else if (sql.startsWith("SELECT") && sql.includes("FROM open_mint.sessions")) { const row = state.sessions.get(String(values[1])); if (row) rows = [row]; }
    else if (sql.startsWith("SELECT") && sql.includes("FROM open_mint.wallet_challenges")) { const row = state.challenges.get(String(values[1])); if (row && row.session_hash === values[2]) rows = [row]; }
    else if (sql.startsWith("INSERT INTO open_mint.sessions")) {
      state.sessions.set(String(values[1]), { session_hash: values[1], csrf: values[2], expires_at: values[3], generation: "0", revoked: false,
        wallet: null, proof_wallet: null, proof_code_hash: null, proof_expires_at: null, active_challenge_hash: null }); count = 1;
    } else if (sql.startsWith("INSERT INTO open_mint.wallet_challenges")) {
      state.challenges.set(String(values[1]), { challenge_hash: values[1], session_hash: values[2], generation: values[3], message: values[4], wallet: values[5], code_hash: values[6], expires_at: values[7], consumed_at: null }); count = 1;
    } else if (sql.startsWith("UPDATE open_mint.wallet_challenges")) {
      for (const row of state.challenges.values()) if (!row.consumed_at && (sql.includes("AND session_hash") ? row.session_hash === values[1] : row.challenge_hash === values[1])) { row.consumed_at = values[2]; count++; }
    } else if (sql.startsWith("UPDATE open_mint.sessions")) {
      const row = state.sessions.get(String(values[1])); if (!row) throw new Error("Missing test session."); count = 1;
      if (sql.includes("SET generation = $3")) Object.assign(row, { generation: values[2], proof_wallet: null, proof_code_hash: null, proof_expires_at: null, active_challenge_hash: values[3] });
      else if (sql.includes("SET active_challenge_hash")) row.active_challenge_hash = null;
      else if (sql.includes("SET wallet")) Object.assign(row, { wallet: values[2], proof_wallet: values[2], proof_code_hash: values[3], proof_expires_at: values[4] });
      else Object.assign(row, { generation: String(BigInt(row.generation) + 1n), revoked: true, wallet: null, proof_wallet: null, proof_code_hash: null, proof_expires_at: null, active_challenge_hash: null });
    } else throw new Error(`Unexpected test SQL: ${sql}`);
    return { rows, rowCount: count || rows.length, command: "", oid: 0, fields: [] } as QueryResult<R>;
  } };
  const writer = {
    assertHealthy: () => { if (failed) throw new WriterUnavailableError(); },
    transaction<T>(work: (connection: typeof tx) => Promise<T>): Promise<T> {
      const pending = tail.then(async () => {
        writer.assertHealthy(); const before = structuredClone(state);
        try { const result = await work(tx); if (failCommit) { failed = true; throw new WriterUnavailableError(); } return result; }
        catch (error) { state = before; throw error; }
      }); tail = pending.catch(() => undefined); return pending;
    },
  } as ExclusiveWriter;
  const options = { writer, namespaceId, origin: boundOrigin, chainId, verifySignature };
  return { sessions: await (staging ? PostgresWalletSessions.openStaging(options) : PostgresWalletSessions.open(options)), options, calls, state: () => state,
    advance: (ms: number) => { now += ms; }, capacity: () => { countOverride = "10000"; }, loseCommit: () => { failCommit = true; } };
}

describe("durable wallet sessions", () => {
  it("requires explicit, exact staging binding and captures it before awaiting the database", async () => {
    const h = await harness(undefined, true);
    await expect(PostgresWalletSessions.open(h.options)).rejects.toThrow("explicit staging");
    for (const patch of [{ origin }, { chainId: 31337 }, { origin: "https://staging.signatures.gallery/" }, { origin: "http://staging.signatures.gallery" }]) {
      await expect(PostgresWalletSessions.openStaging({ ...h.options, ...patch })).rejects.toThrow("staging session binding");
    }
    const options = { ...h.options }, opening = PostgresWalletSessions.openStaging(options);
    options.origin = "http://127.0.0.1"; options.chainId = 31337;
    const captured = await opening;
    expect(captured.origin).toBe(h.options.origin); expect(captured.chainId).toBe(11155111);
    expect(captured.cookiePolicy).toEqual({ name: "__Host-sg-staging", sameSite: "Strict" });
    expect(Object.isFrozen(captured.cookiePolicy)).toBe(true);
  });
  it("never imports legacy cookies into staging or accepts duplicate/prefix lookalikes", async () => {
    const h = await harness(undefined, true), { session } = await h.sessions.session();
    const cookie = h.sessions.cookie(session);
    expect(cookie).toBe(`__Host-sg-staging=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400; Secure`);
    for (const name of ["sg_open_session", "__host-sg-staging", "prefix__Host-sg-staging"]) {
      await expect(h.sessions.requireSession(`${name}=${session.id}`)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
      const fresh = await h.sessions.session(`${name}=${session.id}`);
      expect(fresh.created).toBe(true); expect(fresh.session.walletProof).toBeUndefined(); expect(fresh.session.id).not.toBe(session.id);
    }
    expect(await h.sessions.requireSession(`sg_open_session=bad; ${cookie}`)).toEqual(session);
    await expect(h.sessions.requireSession(`${cookie}; __Host-sg-staging=${session.id}`)).rejects.toThrow("Ambiguous");
    await expect(h.sessions.session(`${cookie}; __Host-sg-staging=bad`)).rejects.toThrow("Ambiguous");
  });
  it("keeps strict staging sessions/proofs across restart and revokes and clears exactly that cookie", async () => {
    const h = await harness(undefined, true), { session } = await h.sessions.session(), code = opaqueCode();
    const challenge = await h.sessions.challenge(session.id, alice.address, code);
    expect(challenge.message).toContain("staging.signatures.gallery wants you to sign in");
    expect(challenge.message).toContain("Chain ID: 11155111");
    await h.sessions.verify(session.id, challenge.challengeId, await alice.signMessage({ message: challenge.message }));
    const restarted = await PostgresWalletSessions.openStaging(h.options), cookie = restarted.cookie(session);
    expect((await restarted.requireSession(cookie)).walletProof?.codeHash).toBe(capabilityHash(code));
    await restarted.logout(session.id);
    expect(restarted.clearCookie()).toBe("__Host-sg-staging=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
    await expect(h.sessions.requireSession(cookie)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect((await h.sessions.session(cookie)).created).toBe(true);
    const local = await harness();
    expect(local.sessions.clearCookie()).toBe("sg_open_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure");
    await expect(local.sessions.requireSession(cookie)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
  });
  it("looks up required sessions without allocation or renewal and rejects ambiguous cookies", async () => {
    const h = await harness();
    for (const cookie of [undefined, "sg_open_session=invalid", `sg_open_session=${opaqueCode()}`]) {
      await expect(h.sessions.requireSession(cookie)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    }
    expect(h.state().sessions.size).toBe(0);
    const { session } = await h.sessions.session(), cookie = h.sessions.cookie(session);
    expect(await h.sessions.requireSession(cookie)).toEqual(session);
    await expect(h.sessions.requireSession(`${cookie}; sg_open_session=${opaqueCode()}`)).rejects.toThrow("Ambiguous");
    await expect(h.sessions.session(`${cookie}; sg_open_session=${session.id}`)).rejects.toThrow("Ambiguous");
    h.advance(86_400_000);
    await expect(h.sessions.requireSession(cookie)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect(h.state().sessions.size).toBe(1);
  });
  it("validates immutable origin/chain profile and capability shape", async () => {
    const h = await harness();
    for (const invalid of ["https://signatures.example/", "https://user@signatures.example", "http://signatures.example", "not a URL"]) {
      await expect(PostgresWalletSessions.open({ ...h.options, origin: invalid })).rejects.toThrow();
    }
    await expect(PostgresWalletSessions.open({ ...h.options, origin: "https://other.example" })).rejects.toThrow("profile mismatch");
    await expect(PostgresWalletSessions.open({ ...h.options, chainId: 0 })).rejects.toThrow();
    expect(() => capabilityHash("invalid")).toThrow();
  });
  it("stores hashed cookie/challenge/code keys, restores sessions across adapter restart and preserves cookie policy", async () => {
    const h = await harness(), created = await h.sessions.session(), token = created.session.id;
    expect(created.created).toBe(true); expect(h.state().sessions.has(token)).toBe(false);
    expect(h.state().sessions.has(capabilityHash(token))).toBe(true);
    const cookie = h.sessions.cookie(created.session);
    expect(cookie).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=86400; Secure");
    const restarted = await PostgresWalletSessions.open(h.options);
    expect(await restarted.session(cookie)).toEqual({ ...created, created: false });
    const code = opaqueCode(), challenge = await restarted.challenge(token, alice.address, code);
    const row = h.state().challenges.get(capabilityHash(challenge.challengeId))!;
    expect(row.code_hash).toBe(capabilityHash(code)); expect(row.challenge_hash).not.toBe(challenge.challengeId);
    expect(challenge.message).toContain(`${origin}/requests/${code}`);
    expect(challenge.message).toContain("Chain ID: 31337");
    // The exact signed message is deliberately PRIVATE and includes its resource.
    expect(Buffer.from(row.message).toString()).toBe(challenge.message);
  });
  it("authorizes exact origin + CSRF from the current live row", async () => {
    const h = await harness(), { session } = await h.sessions.session();
    await expect(h.sessions.authorizePost(session.id, origin, session.csrf)).resolves.toBeUndefined();
    for (const [requestOrigin, csrf] of [[undefined, session.csrf], ["https://evil.example", session.csrf], [origin, undefined], [origin, opaqueCode()]]) {
      await expect(h.sessions.authorizePost(session.id, requestOrigin, csrf)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    }
    h.advance(86_400_000); await expect(h.sessions.authorizePost(session.id, origin, session.csrf)).rejects.toThrow();
    expect((await h.sessions.session(h.sessions.cookie(session))).created).toBe(true);
  });
  it("bounds sessions, cookies and wallet inputs", async () => {
    const h = await harness(), { session } = await h.sessions.session();
    h.capacity(); await expect(h.sessions.session()).rejects.toMatchObject({ code: "BUSY" });
    await expect(h.sessions.session("a".repeat(8193))).rejects.toThrow("size limit");
    for (const wallet of ["bad", undefined, `0x${"0".repeat(40)}`]) expect(() => h.sessions.challenge(session.id, wallet)).toThrow();
    expect(() => h.sessions.challenge(session.id, alice.address, "invalid")).toThrow();
  });
  it("verifies real signatures and keeps scope/proof expiry while replacing consent", async () => {
    const h = await harness(), { session } = await h.sessions.session(), code = opaqueCode();
    const challenge = await h.sessions.challenge(session.id, alice.address.toLowerCase(), code);
    const signature = await alice.signMessage({ message: challenge.message });
    expect(await h.sessions.verify(session.id, challenge.challengeId, signature)).toBe(alice.address);
    const current = (await h.sessions.session(h.sessions.cookie(session))).session;
    expect(current.generation).toBe("1");
    expect(current.walletProof).toEqual({ wallet: alice.address, codeHash: capabilityHash(code), expiresAt: Date.parse("2026-09-20T00:10:00Z") });
    const next = await h.sessions.challenge(session.id, alice.address);
    expect(next.message).toContain(`${origin}/me`);
    expect(next.message).toContain("Connecting alone does not request an assessment");
    expect((await h.sessions.session(h.sessions.cookie(session))).session.walletProof).toBeUndefined();
    await h.sessions.verify(session.id, next.challengeId, await alice.signMessage({ message: next.message }));
    expect((await h.sessions.session(h.sessions.cookie(session))).session.walletProof?.codeHash).toBeUndefined();
  });
  it("consumes invalid signatures but does not consume a wrong challenge or cross-session attempt", async () => {
    const h = await harness(), { session } = await h.sessions.session(), other = (await h.sessions.session()).session;
    const challenge = await h.sessions.challenge(session.id, alice.address);
    await expect(h.sessions.verify(session.id, "bad", "signature")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    await expect(h.sessions.verify(session.id, challenge.challengeId, null)).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    await expect(h.sessions.verify(other.id, challenge.challengeId, "signature")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    await expect(h.sessions.verify(session.id, challenge.challengeId, await bob.signMessage({ message: challenge.message }))).rejects.toMatchObject({ code: "INVALID_PROOF" });
    await expect(h.sessions.verify(session.id, challenge.challengeId, "signature")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    const replacement = await h.sessions.challenge(session.id, alice.address);
    await expect(h.sessions.verify(session.id, replacement.challengeId, "x".repeat(133))).rejects.toMatchObject({ code: "INVALID_PROOF" });
  });
  it("permits exactly one concurrent verification", async () => {
    const h = await harness(), { session } = await h.sessions.session(), challenge = await h.sessions.challenge(session.id, alice.address);
    const signature = await alice.signMessage({ message: challenge.message });
    const results = await Promise.allSettled([h.sessions.verify(session.id, challenge.challengeId, signature), h.sessions.verify(session.id, challenge.challengeId, signature)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it.each(["logout", "replacement", "expiry"])("rejects a valid late signature after %s", async action => {
    let finish!: () => void;
    const h = await harness(async () => new Promise<void>(resolve => { finish = resolve; }));
    const { session } = await h.sessions.session(), challenge = await h.sessions.challenge(session.id, alice.address);
    const pending = h.sessions.verify(session.id, challenge.challengeId, "signature");
    while (!finish) await Promise.resolve();
    if (action === "logout") await h.sessions.logout(session.id);
    else if (action === "replacement") await h.sessions.challenge(session.id, bob.address);
    else h.advance(600_000);
    finish(); await expect(pending).rejects.toMatchObject({ code: "CHALLENGE_REPLACED" });
    expect((await h.sessions.session(h.sessions.cookie(session))).session.walletProof).toBeUndefined();
  });
  it("does not verify after a failed consume commit, or return proof after a failed final commit", async () => {
    const verify = vi.fn(async () => {}), h = await harness(verify), { session } = await h.sessions.session();
    const challenge = await h.sessions.challenge(session.id, alice.address); h.loseCommit();
    await expect(h.sessions.verify(session.id, challenge.challengeId, "signature")).rejects.toThrow(WriterUnavailableError);
    expect(verify).not.toHaveBeenCalled();
    const final = await harness(async () => { final.loseCommit(); });
    const second = (await final.sessions.session()).session, next = await final.sessions.challenge(second.id, alice.address);
    await expect(final.sessions.verify(second.id, next.challengeId, "signature")).rejects.toThrow(WriterUnavailableError);
  });
  it("logout is persistent and idempotent and expired challenges stay unusable", async () => {
    const h = await harness(), { session } = await h.sessions.session(), challenge = await h.sessions.challenge(session.id, alice.address);
    h.advance(600_000); await expect(h.sessions.verify(session.id, challenge.challengeId, "signature")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    await h.sessions.logout(session.id); await h.sessions.logout(session.id); await h.sessions.logout(opaqueCode());
    await expect(h.sessions.challenge(session.id, alice.address)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    const restarted = await PostgresWalletSessions.open(h.options);
    expect((await restarted.session(h.sessions.cookie(session))).created).toBe(true);
  });
});
