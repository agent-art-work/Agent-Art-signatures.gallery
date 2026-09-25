import { Client } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireCanonicalSignatureFrom } from "../../v2/core/ethereumSignature.js";
import { opaqueCode } from "../security.js";
import { PostgresWalletSessions, capabilityHash } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";
import { namespace } from "./fixtures/data.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";

const alice = privateKeyToAccount(`0x${"1".repeat(64)}`), bob = privateKeyToAccount(`0x${"2".repeat(64)}`);
const origin = "https://signatures.example";
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("isolated PostgreSQL session continuity", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, sessions: PostgresWalletSessions, ns: ReturnType<typeof namespace>;
  const factory = () => new Client(cluster.config);
  const options = () => ({ writer, namespaceId: ns.id, origin, chainId: 31337 });
  async function provision(): Promise<void> {
    ns = namespace();
    await admin.query("INSERT INTO open_mint.namespaces(namespace_id, profile, provenance, policy_version) VALUES ($1, $2, $3, $4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query("INSERT INTO open_mint.session_profiles(namespace_id, origin, chain_id) VALUES ($1, $2, 31337)", [ns.id, origin]);
  }
  beforeAll(async () => { cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin); }, 30000);
  beforeEach(async () => { await provision(); writer = await ExclusiveWriter.acquire(factory); sessions = await PostgresWalletSessions.open(options()); });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("preserves strict staging proof across a new writer and refuses legacy cookie authority", async () => {
    const staging = { ...namespace(), profile: "staging-testnet", provenance: "grok" };
    const stagingOrigin = "https://staging.signatures.gallery";
    await admin.query("INSERT INTO open_mint.namespaces VALUES ($1, $2, $3, $4)", [staging.id, staging.profile, staging.provenance, staging.policyVersion]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES ($1, $2, 11155111)", [staging.id, stagingOrigin]);
    const bound = () => ({ writer, namespaceId: staging.id, origin: stagingOrigin, chainId: 11155111 });
    let stage = await PostgresWalletSessions.openStaging(bound());
    const { session } = await stage.session(), cookie = stage.cookie(session), code = opaqueCode();
    const challenge = await stage.challenge(session.id, alice.address, code);
    const signature = await alice.signMessage({ message: challenge.message });
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); stage = await PostgresWalletSessions.openStaging(bound());
    await stage.verify(session.id, challenge.challengeId, signature);
    const proof = (await stage.requireSession(cookie)).walletProof;
    expect(proof?.codeHash).toBe(capabilityHash(code));
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); stage = await PostgresWalletSessions.openStaging(bound());
    expect((await stage.requireSession(cookie)).walletProof).toEqual(proof);
    await expect(stage.requireSession(cookie.replace("__Host-sg-staging", "sg_open_session"))).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    await stage.logout(session.id);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); stage = await PostgresWalletSessions.openStaging(bound());
    await expect(stage.requireSession(cookie)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    const fresh = await stage.session(cookie); expect(fresh.session.walletProof).toBeUndefined();
    expect(stage.clearCookie()).toBe("__Host-sg-staging=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
  });

  it("restores exact session, CSRF, pending challenge and proof scope through writer restart", async () => {
    const { session } = await sessions.session(), cookie = sessions.cookie(session), code = opaqueCode();
    const challenge = await sessions.challenge(session.id, alice.address, code), signature = await alice.signMessage({ message: challenge.message });
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); sessions = await PostgresWalletSessions.open(options());
    const resumed = await sessions.session(cookie);
    expect(resumed.created).toBe(false); expect(resumed.session.csrf).toBe(session.csrf); expect(resumed.session.generation).toBe("1");
    await sessions.authorizePost(session.id, origin, session.csrf);
    await sessions.verify(session.id, challenge.challengeId, signature);
    const proof = (await sessions.session(cookie)).session.walletProof;
    expect(proof?.wallet).toBe(alice.address); expect(proof?.codeHash).toBe(capabilityHash(code));
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); sessions = await PostgresWalletSessions.open(options());
    expect((await sessions.session(cookie)).session.walletProof).toEqual(proof);
    const stored = (await admin.query("SELECT session_hash FROM open_mint.sessions WHERE namespace_id = $1", [ns.id])).rows[0];
    expect(stored.session_hash).toBe(capabilityHash(session.id));
    const challengeRow = (await admin.query("SELECT challenge_hash, code_hash, message FROM open_mint.wallet_challenges WHERE namespace_id = $1", [ns.id])).rows[0];
    expect(challengeRow.challenge_hash).toBe(capabilityHash(challenge.challengeId)); expect(challengeRow.code_hash).toBe(capabilityHash(code));
    expect(challengeRow.message.toString()).toBe(challenge.message);
  });
  it("allows only one concurrent verification and refuses consumed-marker reversal", async () => {
    const { session } = await sessions.session(), challenge = await sessions.challenge(session.id, alice.address), signature = await alice.signMessage({ message: challenge.message });
    const results = await Promise.allSettled([sessions.verify(session.id, challenge.challengeId, signature), sessions.verify(session.id, challenge.challengeId, signature)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(admin.query("UPDATE open_mint.wallet_challenges SET consumed_at = NULL WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("UPDATE open_mint.sessions SET generation = 0 WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
  });
  it("consumes a failed signature durably without accepting proof on restart", async () => {
    const { session } = await sessions.session(), challenge = await sessions.challenge(session.id, alice.address);
    await expect(sessions.verify(session.id, challenge.challengeId, await bob.signMessage({ message: challenge.message }))).rejects.toMatchObject({ code: "INVALID_PROOF" });
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); sessions = await PostgresWalletSessions.open(options());
    await expect(sessions.verify(session.id, challenge.challengeId, await alice.signMessage({ message: challenge.message }))).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    expect((await sessions.session(sessions.cookie(session))).session.walletProof).toBeUndefined();
  });
  it.each(["logout", "replacement"])("rejects in-flight verification after %s", async action => {
    let finish!: () => void;
    sessions = await PostgresWalletSessions.open({ ...options(), verifySignature: async () => new Promise<void>(resolve => { finish = resolve; }) });
    const { session } = await sessions.session(), challenge = await sessions.challenge(session.id, alice.address);
    const pending = sessions.verify(session.id, challenge.challengeId, "signature");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 3000, interval: 1 });
    if (action === "logout") await sessions.logout(session.id); else await sessions.challenge(session.id, bob.address);
    finish(); await expect(pending).rejects.toMatchObject({ code: "CHALLENGE_REPLACED" });
    expect((await sessions.session(sessions.cookie(session))).session.walletProof).toBeUndefined();
  });
  it("an old verification cannot overwrite a replacement proof that already committed", async () => {
    let finish!: () => void, first = true;
    sessions = await PostgresWalletSessions.open({ ...options(), verifySignature: async (digest, signature, wallet) => {
      if (first) { first = false; return new Promise<void>(resolve => { finish = resolve; }); }
      return requireCanonicalSignatureFrom(digest, signature, wallet);
    } });
    const { session } = await sessions.session(), challenge = await sessions.challenge(session.id, alice.address);
    const pending = sessions.verify(session.id, challenge.challengeId, "signature");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 3000, interval: 1 });
    const fresh = await sessions.challenge(session.id, bob.address);
    await sessions.verify(session.id, fresh.challengeId, await bob.signMessage({ message: fresh.message }));
    finish(); await expect(pending).rejects.toMatchObject({ code: "CHALLENGE_REPLACED" });
    expect((await sessions.session(sessions.cookie(session))).session.walletProof?.wallet).toBe(bob.address);
  });
  it("logout revokes durably, rejects POST and cannot be undone by an ordinary update", async () => {
    const { session } = await sessions.session(); await sessions.challenge(session.id, alice.address);
    await sessions.logout(session.id); await sessions.logout(session.id);
    await expect(sessions.authorizePost(session.id, origin, session.csrf)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    await expect(admin.query("UPDATE open_mint.sessions SET revoked = false WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); sessions = await PostgresWalletSessions.open(options());
    expect((await sessions.session(sessions.cookie(session))).created).toBe(true);
  });
  it("does not reuse another namespace's cookie or change immutable origin/chain", async () => {
    const { session } = await sessions.session(), cookie = sessions.cookie(session);
    await expect(PostgresWalletSessions.open({ ...options(), chainId: 1 })).rejects.toThrow("profile mismatch");
    await expect(admin.query("UPDATE open_mint.session_profiles SET origin = 'https://evil.example' WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
    await provision(); const other = await PostgresWalletSessions.open(options());
    expect((await other.session(cookie)).created).toBe(true);
  });
});
