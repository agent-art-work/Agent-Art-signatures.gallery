import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import * as ecdsa from "../v2/core/ethereumSignature.js";
import { fields, isCode, opaqueCode, PublicError, publicErrorDetails, isDiagnosticReference, WalletSessions } from "./security.js";

const alice = privateKeyToAccount(`0x${"1".repeat(64)}`);
const bob = privateKeyToAccount(`0x${"2".repeat(64)}`);
const origin = "https://signatures.example";
const initialTime = 1_800_000_000_000;
afterEach(() => vi.restoreAllMocks());

describe("open mint session and input boundary", () => {
  it("allowlists diagnostic metadata without reflecting capability codes or arbitrary provider details", () => {
    const reference = "d63d39b6-fb45-45aa-bc27-914d4801cfd3";
    const reservedUntil = "2026-09-19T10:00:00.000Z";
    expect(publicErrorDetails({ reference, reservedUntil, category: "reservation", secret: "private" } as never))
      .toEqual({ reference, reservedUntil, category: "reservation" });
    expect(publicErrorDetails(undefined)).toEqual({});
    expect(publicErrorDetails(null as never)).toEqual({});
    for (const value of [opaqueCode(), "not-a-reference", reference.toUpperCase(), "<script>", "", 1]) {
      expect(isDiagnosticReference(value)).toBe(false);
      expect(publicErrorDetails({ reference: value } as never)).toEqual({});
    }
    const legacy = `legacy-${"a".repeat(24)}`;
    expect(publicErrorDetails({ reference: legacy })).toEqual({ reference: legacy });
    for (const reservedUntil of ["invalid", "2026-09-19", "2026-09-19T10:00:00Z", "2026-02-31T00:00:00.000Z", 42]) {
      expect(publicErrorDetails({ reservedUntil, category: "private-dump" } as never)).toEqual({});
    }
    for (const category of ["reservation", "assessment", "wallet", "network", "temporary"] as const) {
      expect(publicErrorDetails({ category })).toEqual({ category });
    }
  });

  it("pairs exact cookies with their original session and csrf token", () => {
    const sessions = new WalletSessions(origin, 31337, () => initialTime);
    const first = sessions.session();
    expect(first.created).toBe(true);
    expect(isCode(first.session.id)).toBe(true);
    expect(isCode(first.session.csrf)).toBe(true);
    expect(first.session.id).not.toBe(first.session.csrf);
    const cookie = sessions.cookie(first.session);
    expect(cookie).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=86400; Secure");
    expect(sessions.session(cookie)).toEqual({ session: first.session, created: false });
    expect(sessions.session(`unrelated=1; sg_open_session=${first.session.id}; another=2`).session).toBe(first.session);
    expect(sessions.session(`prefix_sg_open_session=${first.session.id}`).created).toBe(true);
    expect(sessions.session(`sg_open_session=${opaqueCode()}`).created).toBe(true);
    expect(() => sessions.authorizePost(first.session, origin, first.session.csrf)).not.toThrow();
    for (const [requestOrigin, csrf] of [[undefined, first.session.csrf], ["https://attacker.example", first.session.csrf], [origin, undefined], [origin, "wrong"]]) {
      expect(() => sessions.authorizePost(first.session, requestOrigin, csrf)).toThrow(PublicError);
    }
    expect(() => sessions.authorizePost({ ...first.session }, origin, first.session.csrf)).toThrow();
  });

  it("expires sessions, clears them on logout, and does not persist them across process restarts", () => {
    let now = initialTime;
    const sessions = new WalletSessions("http://127.0.0.1:4318", 31337, () => now);
    const { session } = sessions.session();
    expect(sessions.cookie(session)).not.toContain("Secure");
    const cookie = sessions.cookie(session);
    expect(new WalletSessions(origin, 31337).session(cookie).created).toBe(true);
    session.wallet = alice.address;
    session.walletProof = { wallet: alice.address, expiresAt: now + 600_000 };
    sessions.challenge(session, alice.address);
    sessions.logout(session);
    expect(session.wallet).toBeUndefined();
    expect(session.walletProof).toBeUndefined();
    expect(session.challenge).toBeUndefined();
    expect(sessions.session(cookie).created).toBe(true);
    expect(() => sessions.authorizePost(session, sessions.origin, session.csrf)).toThrow();
    const replacement = sessions.session().session;
    now = replacement.expiresAt;
    expect(() => sessions.authorizePost(replacement, sessions.origin, replacement.csrf)).toThrow();
    expect(sessions.session(sessions.cookie(replacement)).created).toBe(true);
  });

  it("caps active sessions", () => {
    const sessions = new WalletSessions(origin, 31337, () => initialTime);
    for (let i = 0; i < 10_000; i++) sessions.session();
    expect(() => sessions.session()).toThrow("Please try again later");
  });

  it("rejects injected fields including model, MBTI, callback result and authorization", () => {
    expect(fields({ handle: "alice" }, ["handle"])).toEqual({ handle: "alice" });
    expect(fields({ handle: "alice", consent: true }, ["handle"], ["consent"])).toEqual({ handle: "alice", consent: true });
    for (const value of [null, false, [], "alice", {}, { handle: "alice", model: "evil" }, { handle: "alice", mbti: "INTJ" }, { handle: "alice", result: {} }, { handle: "alice", authorization: {} }, Object.create({ handle: "alice" })]) {
      expect(() => fields(value, ["handle"])).toThrow(PublicError);
    }
    expect(isCode(opaqueCode())).toBe(true);
    for (const value of [null, 1, "", "a".repeat(42), "a".repeat(44), "/".repeat(43)]) expect(isCode(value)).toBe(false);
  });
});

describe("wallet proof freshness and challenge isolation", () => {
  it("uses explicit admin sign-in wording without granting contract permissions", async () => {
    const sessions = new WalletSessions(origin, 11155111, () => initialTime);
    const { session } = sessions.session();
    const challenge = sessions.challenge(session, alice.address, undefined, "admin");
    expect(challenge.message).toContain("administer the free-mint allowlist and quota");
    expect(challenge.message).toContain("Every change requires separate approval in your wallet");
    expect(challenge.message).toContain(`Resources:\n- ${origin}/admin`);
    expect(challenge.message).not.toContain("prepare mints when you choose");
    expect(await sessions.verify(session, challenge.challengeId, await alice.signMessage({ message: challenge.message }))).toBe(alice.address);
    expect(session.walletProof?.wallet).toBe(alice.address);
    expect(session).not.toHaveProperty("admin");
  });

  it("binds a wallet proof to a request code, origin, chain and expiring challenge", async () => {
    const sessions = new WalletSessions(origin, 31337, () => initialTime);
    const session = sessions.session().session;
    const code = opaqueCode();
    const challenge = sessions.challenge(session, alice.address.toLowerCase(), code);
    expect(challenge.message).toContain(`${origin}/requests/${code}`);
    expect(challenge.message).toContain("Chain ID: 31337");
    expect(challenge.message).toContain("does not submit a mint transaction");
    expect(challenge.message).not.toContain("X account ownership");
    const signature = await alice.signMessage({ message: challenge.message });
    expect(await sessions.verify(session, challenge.challengeId, signature)).toBe(alice.address);
    expect(session.walletProof).toEqual({ wallet: alice.address, code, expiresAt: initialTime + 600_000 });
    await expect(sessions.verify(session, challenge.challengeId, signature)).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    const login = sessions.challenge(session, alice.address);
    expect(login.message).toContain(`${origin}/me`);
    expect(login.message).toContain("prepare mints when you choose Mint & reveal");
    expect(login.message).toContain("Connecting alone does not request an assessment or submit a transaction");
    expect(session.walletProof).toBeUndefined();
    await sessions.verify(session, login.challengeId, await alice.signMessage({ message: login.message }));
    expect(session.walletProof?.code).toBeUndefined();
  });

  it("rejects malformed wallet, zero wallet and malformed request code", () => {
    const sessions = new WalletSessions(origin, 31337);
    const session = sessions.session().session;
    for (const wallet of [undefined, "alice", `0x${"0".repeat(40)}`, {}]) expect(() => sessions.challenge(session, wallet)).toThrow();
    expect(() => sessions.challenge(session, alice.address, "wrong")).toThrow();
  });

  it("consumes invalid proofs and rejects the wrong wallet, challenge, session or expired proof", async () => {
    let now = initialTime;
    const sessions = new WalletSessions(origin, 31337, () => now);
    const session = sessions.session().session;
    let challenge = sessions.challenge(session, alice.address);
    await expect(sessions.verify(session, "wrong-id", "0x00")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    await expect(sessions.verify(sessions.session().session, challenge.challengeId, "0x00")).rejects.toThrow();
    await expect(sessions.verify(session, challenge.challengeId, await bob.signMessage({ message: challenge.message }))).rejects.toMatchObject({ code: "INVALID_PROOF" });
    expect(session.challenge).toBeUndefined();
    challenge = sessions.challenge(session, alice.address);
    await expect(sessions.verify(session, challenge.challengeId, "0x00")).rejects.toMatchObject({ code: "INVALID_PROOF" });
    challenge = sessions.challenge(session, alice.address);
    now += 600_000;
    await expect(sessions.verify(session, challenge.challengeId, await alice.signMessage({ message: challenge.message }))).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("permits only one concurrent verification of the same challenge", async () => {
    const sessions = new WalletSessions(origin, 31337, () => initialTime);
    const session = sessions.session().session;
    const challenge = sessions.challenge(session, alice.address);
    const signature = await alice.signMessage({ message: challenge.message });
    const results = await Promise.allSettled([sessions.verify(session, challenge.challengeId, signature), sessions.verify(session, challenge.challengeId, signature)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it.each(["logout", "supersede", "expire"])("discards proof when %s occurs during verification", async (action) => {
    let now = initialTime;
    const sessions = new WalletSessions(origin, 31337, () => now);
    const session = sessions.session().session;
    const challenge = sessions.challenge(session, alice.address);
    let finish!: () => void;
    vi.spyOn(ecdsa, "requireCanonicalSignatureFrom").mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return {} as never; });
    const pending = sessions.verify(session, challenge.challengeId, "signature");
    if (action === "logout") sessions.logout(session);
    if (action === "supersede") sessions.challenge(session, bob.address);
    if (action === "expire") now += 600_000;
    finish();
    await expect(pending).rejects.toMatchObject({ code: "CHALLENGE_REPLACED" });
    expect(session.walletProof).toBeUndefined();
  });

  it("a superseded verification cannot overwrite a newer completed wallet proof", async () => {
    const sessions = new WalletSessions(origin, 31337, () => initialTime);
    const session = sessions.session().session;
    const firstCode = opaqueCode(), secondCode = opaqueCode();
    const first = sessions.challenge(session, alice.address, firstCode);
    const finishes: Array<() => void> = [];
    vi.spyOn(ecdsa, "requireCanonicalSignatureFrom").mockImplementation(async () => { await new Promise<void>(resolve => { finishes.push(resolve); }); return {} as never; });
    const old = sessions.verify(session, first.challengeId, "signature-a");
    const second = sessions.challenge(session, bob.address, secondCode);
    const fresh = sessions.verify(session, second.challengeId, "signature-b");
    finishes[1](); await fresh;
    finishes[0]();
    await expect(old).rejects.toMatchObject({ code: "CHALLENGE_REPLACED" });
    expect(session.wallet).toBe(bob.address);
    expect(session.walletProof?.code).toBe(secondCode);
  });
});
