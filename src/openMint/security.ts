import { randomBytes } from "node:crypto";
import { getAddress, hashMessage, type Address } from "viem";
import { requireCanonicalSignatureFrom } from "../v2/core/ethereumSignature.js";

export const opaqueCode = (): string => randomBytes(32).toString("base64url");
export const isCode = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export interface PublicErrorDetails {
  reference?: string;
  reservedUntil?: string;
  category?: "reservation" | "assessment" | "wallet" | "network" | "temporary";
}
export const isDiagnosticReference = (value: unknown): value is string => typeof value === "string"
  && (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) || /^legacy-[a-f0-9]{24}$/.test(value));
/** API error metadata has an independent allowlist; never serialize an arbitrary Error object. */
export function publicErrorDetails(details: PublicErrorDetails | undefined): PublicErrorDetails {
  const result: PublicErrorDetails = {};
  if (isDiagnosticReference(details?.reference)) result.reference = details.reference;
  if (typeof details?.reservedUntil === "string" && Number.isFinite(Date.parse(details.reservedUntil)) && new Date(details.reservedUntil).toISOString() === details.reservedUntil) result.reservedUntil = details.reservedUntil;
  if (details?.category && ["reservation", "assessment", "wallet", "network", "temporary"].includes(details.category)) result.category = details.category;
  return result;
}
export class PublicError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: PublicErrorDetails) { super(message); }
}
export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicError(400, "INVALID_INPUT", "Invalid request.");
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => ![...required, ...optional].includes(key))) {
    throw new PublicError(400, "INVALID_FIELDS", "Unexpected or missing request fields.");
  }
  return record;
}
export interface SiteSession {
  id: string;
  csrf: string;
  expiresAt: number;
  generation: number;
  wallet?: Address;
  walletProof?: { wallet: Address; code?: string; expiresAt: number };
  challenge?: { id: string; message: string; address: Address; code?: string; expiresAt: number };
}

/** Local process sessions deliberately expire on restart. They never authenticate an X account. */
export class WalletSessions {
  readonly #sessions = new Map<string, SiteSession>();
  constructor(readonly origin: string, readonly chainId: number, readonly now: () => number = Date.now) {}
  session(cookie?: string): { session: SiteSession; created: boolean } {
    for (const [id, session] of this.#sessions) if (session.expiresAt <= this.now()) this.#sessions.delete(id);
    const id = cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("sg_open_session="))?.slice(16);
    const existing = id && this.#sessions.get(id);
    if (existing) return { session: existing, created: false };
    if (this.#sessions.size >= 10_000) throw new PublicError(429, "BUSY", "Please try again later.");
    const session: SiteSession = { id: opaqueCode(), csrf: opaqueCode(), expiresAt: this.now() + 86_400_000, generation: 0 };
    this.#sessions.set(session.id, session);
    return { session, created: true };
  }
  cookie(session: SiteSession): string {
    return `sg_open_session=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  authorizePost(session: SiteSession, origin: string | undefined, csrf: string | undefined): void {
    if (session.expiresAt <= this.now() || this.#sessions.get(session.id) !== session || origin !== this.origin || csrf !== session.csrf) {
      throw new PublicError(403, "SESSION_REQUIRED", "Refresh this page and try again.");
    }
  }
  challenge(session: SiteSession, address: unknown, code?: string, purpose: "mint" | "admin" = "mint"): { challengeId: string; message: string } {
    let canonical: Address;
    try { canonical = getAddress(String(address)); } catch { throw new PublicError(400, "INVALID_WALLET", "Enter a valid wallet address."); }
    if (/^0x0{40}$/i.test(canonical) || (code !== undefined && !isCode(code))) throw new PublicError(400, "INVALID_WALLET", "Invalid wallet request.");
    const now = this.now();
    const id = opaqueCode();
    const expiresAt = now + 600_000;
    const nonce = randomBytes(16).toString("hex");
    const statement = purpose === "admin"
      ? "Sign in to administer the free-mint allowlist and quota. Signing in does not submit a contract transaction. Every change requires separate approval in your wallet."
      : code ? "Connect this wallet to this signature request. This does not submit a mint transaction." : "Sign in to view your collection and prepare mints when you choose Mint & reveal. Connecting alone does not request an assessment or submit a transaction.";
    const resource = purpose === "admin" ? `${this.origin}/admin` : code ? `${this.origin}/requests/${code}` : `${this.origin}/me`;
    const message = `${new URL(this.origin).host} wants you to sign in with your Ethereum account:\n${canonical}\n\n${statement}\n\nURI: ${this.origin}\nVersion: 1\nChain ID: ${this.chainId}\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}\nResources:\n- ${resource}`;
    // Superseding a challenge also discards prior mint consent/proof.
    delete session.walletProof;
    session.generation++;
    session.challenge = { id, address: canonical, code, message, expiresAt };
    return { challengeId: id, message };
  }
  async verify(session: SiteSession, challengeId: unknown, signature: unknown): Promise<Address> {
    const challenge = session.challenge;
    const generation = session.generation;
    if (!challenge || challenge.id !== challengeId || challenge.expiresAt <= this.now() || typeof signature !== "string") {
      throw new PublicError(409, "CHALLENGE_EXPIRED", "Connect your wallet again.");
    }
    // Consume before awaiting signature verification: concurrent requests cannot replay it.
    delete session.challenge;
    try { await requireCanonicalSignatureFrom(hashMessage(challenge.message), signature, challenge.address); }
    catch { throw new PublicError(403, "INVALID_PROOF", "The wallet signature could not be verified."); }
    if (session.generation !== generation || session.challenge || this.#sessions.get(session.id) !== session || session.expiresAt <= this.now() || challenge.expiresAt <= this.now()) {
      throw new PublicError(409, "CHALLENGE_REPLACED", "Connect your wallet again.");
    }
    session.wallet = challenge.address;
    session.walletProof = { wallet: challenge.address, code: challenge.code, expiresAt: challenge.expiresAt };
    return challenge.address;
  }
  logout(session: SiteSession): void { session.generation++; this.#sessions.delete(session.id); delete session.wallet; delete session.walletProof; delete session.challenge; }
}
