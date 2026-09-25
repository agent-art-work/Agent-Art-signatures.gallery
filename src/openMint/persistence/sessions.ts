import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, hashMessage, type Address, type Hex } from "viem";
import { requireCanonicalSignatureFrom } from "../../v2/core/ethereumSignature.js";
import { isCode, opaqueCode, PublicError } from "../security.js";
import { ExclusiveWriter, PersistenceConflictError, type OwnershipConnection } from "./writer.js";

type Transaction = Pick<OwnershipConnection, "query">;
export interface DurableSiteSession {
  /** Supplied by the authenticated cookie, never recovered from the database. */
  readonly id: string;
  readonly csrf: string;
  readonly expiresAt: number;
  readonly generation: string;
  readonly wallet?: Address;
  readonly walletProof?: { readonly wallet: Address; readonly codeHash?: string; readonly expiresAt: number };
}
interface SessionRow {
  session_hash: string; csrf: string; expires_at: Date; generation: string; revoked: boolean;
  wallet: string | null; proof_wallet: string | null; proof_code_hash: string | null; proof_expires_at: Date | null;
  active_challenge_hash: string | null;
}
interface ChallengeRow {
  challenge_hash: string; session_hash: string; generation: string; message: Buffer; wallet: string;
  code_hash: string | null; expires_at: Date; consumed_at: Date | null;
}
type VerifySignature = (digest: Hex, signature: string, address: Address) => Promise<unknown>;
type SessionOptions = { writer: ExclusiveWriter; namespaceId: string; origin: string; chainId: number; verifySignature?: VerifySignature };
const STAGING_ORIGIN = "https://staging.signatures.gallery";
const LOCAL_COOKIE = Object.freeze({ name: "sg_open_session", sameSite: "Lax" as const });
const STAGING_COOKIE = Object.freeze({ name: "__Host-sg-staging", sameSite: "Strict" as const });

/** Digests are private lookup values, never replacement capability URLs. */
export function capabilityHash(value: string): string {
  if (!isCode(value)) throw new PublicError(400, "INVALID_INPUT", "Invalid private capability.");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function sessionError(): PublicError { return new PublicError(403, "SESSION_REQUIRED", "Refresh this page and try again."); }
function challengeError(replaced = false): PublicError { return new PublicError(409, replaced ? "CHALLENGE_REPLACED" : "CHALLENGE_EXPIRED", "Connect your wallet again."); }
function cookieToken(name: string, cookie?: string): string | undefined {
  if (cookie !== undefined && cookie.length > 8192) throw new PublicError(400, "INVALID_INPUT", "Cookie header exceeds the size limit.");
  const prefix = `${name}=`;
  const tokens = cookie?.split(";").map(value => value.trim()).filter(value => value.startsWith(prefix)) ?? [];
  if (tokens.length > 1) throw new PublicError(400, "INVALID_INPUT", "Ambiguous session cookie.");
  const token = tokens[0]?.slice(prefix.length);
  return isCode(token) ? token : undefined;
}

/** Async companion to the local WalletSessions map.
 * All lifetimes and signature context match the local flow; proof scope stores
 * a hash, so call sites must compare codeHash, not expect a recoverable code.
 */
export class PostgresWalletSessions {
  readonly #policy: typeof LOCAL_COOKIE | typeof STAGING_COOKIE;
  private constructor(readonly writer: ExclusiveWriter, readonly namespaceId: string, readonly origin: string,
    readonly chainId: number, readonly verifySignature: VerifySignature, staging: boolean) { this.#policy = staging ? STAGING_COOKIE : LOCAL_COOKIE; }

  get cookiePolicy() { return this.#policy; }

  static async open(options: SessionOptions): Promise<PostgresWalletSessions> {
    if (options.origin === STAGING_ORIGIN || options.chainId === 11155111) throw new Error("Use the explicit staging session factory.");
    return this.#open(options, false);
  }
  /** Fixed host-only Secure/Strict policy; not selected from request input.
   * No legacy cookie fallback or automatic migration of browser authority. */
  static async openStaging(options: SessionOptions): Promise<PostgresWalletSessions> {
    if (options.origin !== STAGING_ORIGIN || options.chainId !== 11155111) throw new Error("Invalid staging session binding.");
    return this.#open(options, true);
  }

  static async #open(options: SessionOptions, staging: boolean): Promise<PostgresWalletSessions> {
    options = { ...options }; // Capture the binding before the database await.
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || origin.username || origin.password || options.origin.length > 2048
      || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname)))
      || !Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw new Error("Invalid exact session origin or chain.");
    await options.writer.transaction(async tx => {
      const row = (await tx.query<{ origin: string; chain_id: string }>("SELECT origin, chain_id::text FROM open_mint.session_profiles WHERE namespace_id = $1", [options.namespaceId])).rows[0];
      if (row?.origin !== options.origin || row.chain_id !== String(options.chainId)) throw new PersistenceConflictError("Session origin/chain profile mismatch.");
    });
    return new PostgresWalletSessions(options.writer, options.namespaceId, options.origin, options.chainId, options.verifySignature ?? requireCanonicalSignatureFrom, staging);
  }
  async #now(tx: Transaction): Promise<Date> { return (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now; }
  async #row(tx: Transaction, token: string): Promise<SessionRow | undefined> {
    return (await tx.query<SessionRow>("SELECT *, generation::text FROM open_mint.sessions WHERE namespace_id = $1 AND session_hash = $2 FOR UPDATE", [this.namespaceId, capabilityHash(token)])).rows[0];
  }
  #view(row: SessionRow, token: string): DurableSiteSession {
    return { id: token, csrf: row.csrf, expiresAt: row.expires_at.getTime(), generation: row.generation,
      ...(row.wallet ? { wallet: getAddress(row.wallet) } : {}), ...(row.proof_wallet && row.proof_expires_at ? { walletProof: {
        wallet: getAddress(row.proof_wallet), ...(row.proof_code_hash ? { codeHash: row.proof_code_hash } : {}), expiresAt: row.proof_expires_at.getTime(),
      } } : {}) };
  }
  #live(row: SessionRow | undefined, now: Date): row is SessionRow { return !!row && !row.revoked && row.expires_at.getTime() > now.getTime(); }

  async session(cookie?: string): Promise<{ session: DurableSiteSession; created: boolean }> {
    const token = cookieToken(this.#policy.name, cookie);
    return this.writer.transaction(async tx => {
      const now = await this.#now(tx), row = token && isCode(token) ? await this.#row(tx, token) : undefined;
      if (token && this.#live(row, now)) return { session: this.#view(row, token), created: false };
      const count = (await tx.query<{ count: string }>("SELECT count(*)::text AS count FROM open_mint.sessions WHERE namespace_id = $1 AND NOT revoked AND expires_at > $2", [this.namespaceId, now])).rows[0];
      if (!count || BigInt(count.count) >= 10000n) throw new PublicError(429, "BUSY", "Please try again later.");
      const id = opaqueCode(), csrf = opaqueCode(), expires = new Date(now.getTime() + 86_400_000);
      await tx.query("INSERT INTO open_mint.sessions(namespace_id, session_hash, csrf, expires_at) VALUES ($1, $2, $3, $4)", [this.namespaceId, capabilityHash(id), csrf, expires]);
      return { session: { id, csrf, expiresAt: expires.getTime(), generation: "0" }, created: true };
    });
  }
  /** Private reads and mutations must never create a replacement session. */
  async requireSession(cookie?: string): Promise<DurableSiteSession> {
    const token = cookieToken(this.#policy.name, cookie);
    if (!token) throw sessionError();
    return this.writer.transaction(async tx => {
      const row = await this.#row(tx, token), now = await this.#now(tx);
      if (!this.#live(row, now)) throw sessionError();
      return this.#view(row, token);
    });
  }
  cookie(session: DurableSiteSession): string {
    capabilityHash(session.id);
    return this.#cookie(session.id, 86400);
  }
  clearCookie(): string { return this.#cookie("", 0); }
  #cookie(value: string, age: number): string {
    return `${this.#policy.name}=${value}; HttpOnly; SameSite=${this.#policy.sameSite}; Path=/; Max-Age=${age}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  authorizePost(token: string, origin: string | undefined, csrf: string | undefined): Promise<void> {
    return this.writer.transaction(async tx => {
      const row = await this.#row(tx, token), now = await this.#now(tx);
      if (!this.#live(row, now) || origin !== this.origin || !isCode(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(row.csrf))) throw sessionError();
    });
  }
  challenge(token: string, address: unknown, code?: string): Promise<{ challengeId: string; message: string }> {
    let wallet: Address;
    try { wallet = getAddress(String(address)); } catch { throw new PublicError(400, "INVALID_WALLET", "Enter a valid wallet address."); }
    if (/^0x0{40}$/i.test(wallet) || (code !== undefined && !isCode(code))) throw new PublicError(400, "INVALID_WALLET", "Invalid wallet request.");
    return this.writer.transaction(async tx => {
      const row = await this.#row(tx, token), now = await this.#now(tx);
      if (!this.#live(row, now)) throw sessionError();
      const challengeId = opaqueCode(), expires = new Date(now.getTime() + 600_000), generation = (BigInt(row.generation) + 1n).toString();
      const statement = code ? "Connect this wallet to this signature request. This does not submit a mint transaction." : "Sign in to view your collection and prepare mints when you choose Mint & reveal. Connecting alone does not request an assessment or submit a transaction.";
      const resource = code ? `${this.origin}/requests/${code}` : `${this.origin}/me`;
      const message = `${new URL(this.origin).host} wants you to sign in with your Ethereum account:\n${wallet}\n\n${statement}\n\nURI: ${this.origin}\nVersion: 1\nChain ID: ${this.chainId}\nNonce: ${randomBytes(16).toString("hex")}\nIssued At: ${now.toISOString()}\nExpiration Time: ${expires.toISOString()}\nResources:\n- ${resource}`;
      await tx.query("UPDATE open_mint.wallet_challenges SET consumed_at = $3 WHERE namespace_id = $1 AND session_hash = $2 AND consumed_at IS NULL", [this.namespaceId, row.session_hash, now]);
      await tx.query(`INSERT INTO open_mint.wallet_challenges(namespace_id, challenge_hash, session_hash, generation, message, wallet, code_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [this.namespaceId, capabilityHash(challengeId), row.session_hash, generation, Buffer.from(message), wallet, code ? capabilityHash(code) : null, expires]);
      await tx.query(`UPDATE open_mint.sessions SET generation = $3, proof_wallet = NULL, proof_code_hash = NULL, proof_expires_at = NULL,
        active_challenge_hash = $4 WHERE namespace_id = $1 AND session_hash = $2`, [this.namespaceId, row.session_hash, generation, capabilityHash(challengeId)]);
      return { challengeId, message };
    });
  }

  async verify(token: string, challengeId: unknown, signature: unknown): Promise<Address> {
    if (!isCode(challengeId) || typeof signature !== "string") throw challengeError();
    const challenge = await this.writer.transaction(async tx => {
      const row = await this.#row(tx, token), now = await this.#now(tx);
      if (!this.#live(row, now) || row.active_challenge_hash !== capabilityHash(challengeId)) throw challengeError();
      const challenge = (await tx.query<ChallengeRow>("SELECT *, generation::text FROM open_mint.wallet_challenges WHERE namespace_id = $1 AND challenge_hash = $2 AND session_hash = $3 FOR UPDATE", [this.namespaceId, row.active_challenge_hash, row.session_hash])).rows[0];
      if (!challenge || challenge.consumed_at || challenge.generation !== row.generation || challenge.expires_at.getTime() <= now.getTime()) throw challengeError();
      await tx.query("UPDATE open_mint.wallet_challenges SET consumed_at = $3 WHERE namespace_id = $1 AND challenge_hash = $2 AND consumed_at IS NULL", [this.namespaceId, challenge.challenge_hash, now]);
      await tx.query("UPDATE open_mint.sessions SET active_challenge_hash = NULL WHERE namespace_id = $1 AND session_hash = $2", [this.namespaceId, row.session_hash]);
      return challenge;
    });
    // No database transaction spans asynchronous signature verification. The
    // challenge has already been consumed even if verification throws/crashes.
    this.writer.assertHealthy();
    try {
      if (signature.length > 132) throw new Error("Signature exceeds the size limit.");
      const message = new TextDecoder("utf-8", { fatal: true }).decode(challenge.message);
      await this.verifySignature(hashMessage(message), signature, getAddress(challenge.wallet));
    } catch { throw new PublicError(403, "INVALID_PROOF", "The wallet signature could not be verified."); }
    return this.writer.transaction(async tx => {
      const row = await this.#row(tx, token), now = await this.#now(tx);
      if (!this.#live(row, now) || row.generation !== challenge.generation || row.active_challenge_hash || challenge.expires_at.getTime() <= now.getTime()) throw challengeError(true);
      await tx.query(`UPDATE open_mint.sessions SET wallet = $3, proof_wallet = $3, proof_code_hash = $4, proof_expires_at = $5
        WHERE namespace_id = $1 AND session_hash = $2 AND generation = $6`, [this.namespaceId, row.session_hash, challenge.wallet, challenge.code_hash, challenge.expires_at, challenge.generation]);
      return getAddress(challenge.wallet);
    });
  }
  logout(token: string): Promise<void> {
    return this.writer.transaction(async tx => {
      const row = await this.#row(tx, token), now = await this.#now(tx);
      if (!row || row.revoked) return;
      await tx.query("UPDATE open_mint.wallet_challenges SET consumed_at = $3 WHERE namespace_id = $1 AND session_hash = $2 AND consumed_at IS NULL", [this.namespaceId, row.session_hash, now]);
      await tx.query(`UPDATE open_mint.sessions SET generation = generation + 1, revoked = true, wallet = NULL,
        proof_wallet = NULL, proof_code_hash = NULL, proof_expires_at = NULL, active_challenge_hash = NULL
        WHERE namespace_id = $1 AND session_hash = $2`, [this.namespaceId, row.session_hash]);
    });
  }
}
