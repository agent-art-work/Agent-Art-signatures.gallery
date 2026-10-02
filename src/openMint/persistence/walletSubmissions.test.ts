import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { openMintHandleKey } from "../authorization.js";
import { generativeInputDigest } from "../generativeInputs.js";
import { PULSE_PAID_SLOT, pulseMintTypedData } from "../pulseAuthorization.js";
import { opaqueCode } from "../security.js";
import type { AuthorizationReservation } from "./generativeAuthorizations.js";
import type { PostgresMintRequests } from "./requests.js";
import { reservedWalletTransaction } from "./reservedTransaction.js";
import { capabilityHash } from "./sessions.js";
import { PostgresWalletSubmissions } from "./walletSubmissions.js";

const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const wallet = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"3".padStart(64, "0")}`);
const hash = `0x${"11".repeat(32)}` as const;

describe("saved wallet-plan independent identity bindings", () => {
  it.each(["valid", "recipient", "authorizer", "namespace", "deployment"])("checks %s before saving a plan", async mismatch => {
    const now = Date.now(), expires = new Date(now + 600_000), session = { id: opaqueCode(), generation: "1", csrf: opaqueCode(), expiresAt: expires.getTime() };
    const profile = { chain_id: "31337", deployment_id: "deployment", contract_address: other.address, authorizer: signer.address, origin: "http://127.0.0.1:3000" };
    const authorization = { handleKey: openMintHandleKey("alice"),
      inputDigest: generativeInputDigest("Alice", "INTJ", hash, "sg-generative-pulse-inputs-v1-rc1"), assessmentDigest: hash,
      recipient: mismatch === "recipient" ? other.address : wallet.address, nonce: hash,
      issuedAt: String(Math.floor(now / 1000)), deadline: String(Math.floor(now / 1000) + 300),
      mintMode: 1 as const, slotId: PULSE_PAID_SLOT.toString(), maxPrice: "100" };
    const reservation = { version: "sg-generative-pulse-authorization-v1-rc1", id: "authorization",
      namespaceId: mismatch === "namespace" ? "other" : "namespace", deploymentId: mismatch === "deployment" ? "other" : profile.deployment_id,
      requestId: "request", sessionHash: capabilityHash(session.id), generation: "1", handle: "alice", renderHandle: "Alice", mbti: "INTJ",
      rendererIdentity: hash, authorizer: mismatch === "authorizer" ? other.address : signer.address,
      domain: { chainId: "31337", verifyingContract: other.address }, authorization, proof: [] } as unknown as AuthorizationReservation;
    // Even a cryptographically valid signature must match the independent
    // authenticated session and pinned deployment, not just its own payload.
    const signature = await (mismatch === "authorizer" ? other : signer).signTypedData(pulseMintTypedData(reservation.domain, authorization));
    const transaction = reservedWalletTransaction(reservation, signature);
    let writes = 0;
    const tx = { query: async (sql: string) => {
      if (sql.includes("JOIN open_mint.sessions")) return { rows: [{ request_id: "request", wallet: wallet.address, handle: "alice", generation: "1", request_generation: "1",
        csrf: session.csrf, expires_at: expires, request_expiry: expires, revoked: false, proof_wallet: wallet.address, proof_code_hash: null,
        proof_expires_at: expires, active_challenge_hash: null }] };
      if (sql.includes("clock_timestamp()")) return { rows: [{ now: new Date(now) }] };
      if (sql.includes("SELECT a.authorization_id,a.payload")) return { rows: [{ authorization_id: "authorization", payload: Buffer.from(JSON.stringify(reservation)), signature }] };
      if (sql.startsWith("INSERT")) { writes++; return { rows: [{ request_id: "request" }] }; }
      if (sql.includes("wallet_mint_dispatches") || sql.includes("wallet_mint_plans")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const requests = { profile, repository: { namespace: { id: "namespace", profile: "local-real", provenance: "grok" }, writer: { transaction: (run: (value: typeof tx) => unknown) => run(tx) } },
      pulse: { load: async () => ({ mintMode: 1, slotId: PULSE_PAID_SLOT.toString(), maxPrice: "100", proof: [] }) } } as unknown as PostgresMintRequests;
    const result = new PostgresWalletSubmissions(requests).stage(opaqueCode(), { session, origin: profile.origin, csrf: session.csrf },
      { version: "sg-pulse-wallet-plan-v1-rc1", expiresAt: new Date(Number(authorization.deadline) * 1000).toISOString(), transaction },
      { chainId: "0x7a69", contract: transaction.to, blockNumber: "0x1", blockHash: hash, nonce: "0x0" });
    if (mismatch === "valid") { expect((await result).transaction.from).toBe(wallet.address); expect(writes).toBe(1); }
    else { await expect(result).rejects.toThrow("cannot be used"); expect(writes).toBe(0); }
  });
});
