import { randomUUID } from "node:crypto";
import { decodeFunctionData, encodeFunctionResult, getAddress, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMintHandleKey } from "./authorization.js";
import { generativeMintDigest, GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";
import { generativeInputDigest } from "./generativeInputs.js";
import { GenerativeRecoveryChain, readGenerativeRecoveryEvidence } from "./generativeRecoveryChain.js";
import { recoveryFixtureSources } from "./fixtures/generativeRecoveryRpc.js";
import { chainHash, eligibilityFixture, fixtureRendererPin } from "./persistence/fixtures/eligibility.js";
import type { AuthorizationReservation } from "./persistence/generativeAuthorizations.js";
import { PUBLIC_CHAIN_READ_ABI } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";

function fixture() {
  const gate = eligibilityFixture(randomUUID(), randomUUID());
  const config = { ...gate.config, contractProfile: "generative-experimental-v1" as const, generativeRenderer: fixtureRendererPin };
  const domain = { chainId: "31337", verifyingContract: config.contract };
  const deadline = Math.floor(Date.now() / 1000) - 1;
  const authorization = { handleKey: openMintHandleKey("alice"), assessmentDigest: chainHash("44"),
    inputDigest: generativeInputDigest("Alice", "INTJ", fixtureRendererPin.identity), recipient: "0x5555555555555555555555555555555555555555" as const,
    nonce: chainHash("33"), issuedAt: String(deadline - 60), deadline: String(deadline) };
  const reservation: AuthorizationReservation = { version: "sg-generative-authorization-experimental-1", id: randomUUID(), namespaceId: config.namespaceId,
    deploymentId: config.deploymentId, requestId: randomUUID(), sessionHash: "0".repeat(64), generation: "1", handle: "alice", assessmentId: randomUUID(),
    renderHandle: "Alice", mbti: "INTJ", rendererIdentity: fixtureRendererPin.identity, authorizer: config.authorizer, domain,
    authorization, digest: generativeMintDigest(domain, authorization), typedData: {} };
  return { config, reservation, sources: recoveryFixtureSources(gate.sources(config)) };
}
afterEach(() => vi.restoreAllMocks());
describe("finalized expiry recovery evidence (read only, no RPC writes)", () => {
  it("requires an opaque, fresh, exact-authority witness; audit JSON cannot unlock anything", async () => {
    const f = fixture(), observer = new GenerativeRecoveryChain(f.config, f.sources);
    const witness = await observer.observe(f.reservation, new AbortController().signal);
    const e = readGenerativeRecoveryEvidence(witness, f.reservation, Date.now());
    expect(e.finalized.number).toBe("10"); expect(e.sources).toHaveLength(2);
    expect(Object.isFrozen(e.config.generativeRenderer)).toBe(true);
    for (const fake of [null, {}, JSON.parse(JSON.stringify(witness)), e]) expect(() => readGenerativeRecoveryEvidence(fake, f.reservation, Date.now())).toThrow();
    for (const r of [{ ...f.reservation, id: randomUUID() }, { ...f.reservation, digest: chainHash("77") },
      { ...f.reservation, domain: { ...f.reservation.domain, verifyingContract: getAddress(f.reservation.authorization.recipient) } },
      { ...f.reservation, namespaceId: randomUUID() }]) expect(() => readGenerativeRecoveryEvidence(witness, r, Date.now())).toThrow();
    for (const now of [NaN, -1, e.observedAt - 1, e.validUntil, e.validUntil + 1]) expect(() => readGenerativeRecoveryEvidence(witness, f.reservation, now)).toThrow();
  });
  it.each(["same-deadline", "not-expired", "wrong-renderer", "wrong-chain", "wrong-authorizer", "wrong-namespace", "bad-deadline"])("refuses %s", async scenario => {
    const f = fixture(), r = structuredClone(f.reservation);
    if (scenario === "same-deadline") r.authorization.deadline = String(Math.floor(Date.now() / 1000));
    if (scenario === "not-expired") r.authorization.deadline = String(Math.floor(Date.now() / 1000) + 50);
    const changed = scenario === "wrong-renderer" ? { ...r, rendererIdentity: chainHash("88") }
      : scenario === "wrong-chain" ? { ...r, domain: { ...r.domain, chainId: "1" } }
      : scenario === "wrong-authorizer" ? { ...r, authorizer: getAddress(r.authorization.recipient) }
      : scenario === "wrong-namespace" ? { ...r, namespaceId: randomUUID() }
      : scenario === "bad-deadline" ? { ...r, authorization: { ...r.authorization, deadline: "oops" } } : r;
    await expect(new GenerativeRecoveryChain(f.config, f.sources).observe(changed, new AbortController().signal)).rejects.toThrow();
  });
  it.each(["null-finalized", "bad-number", "bad-hash", "before-deployment", "ahead-of-latest", "future-finalized", "disagree", "changed-head", "wrong-code", "rpc-error", "mintedHandle", "usedNonces", "revokedNonces", "paused"])("keeps reservations when %s", async scenario => {
    const f = fixture(), abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
    const sources = f.sources.map((rpc, index) => {
      let finalCalls = 0;
      return { id: rpc.id, async request(method, params, signal) {
        if (scenario === "rpc-error") throw new Error("private-rpc-credential-do-not-return");
        const raw = await rpc.request(method, params, signal);
        if (method === "eth_getCode" && scenario === "wrong-code") return "0x6000";
        if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
          const r = raw as Record<string, unknown>; ++finalCalls;
          if (scenario === "null-finalized") return null;
          if (scenario === "bad-number") return { ...r, number: "0x00" };
          if (scenario === "bad-hash") return { ...r, hash: chainHash("00") };
          if (scenario === "before-deployment") return { ...r, number: "0x1" };
          if (scenario === "ahead-of-latest") return { ...r, number: "0xb" };
          if (scenario === "future-finalized") return { ...r, timestamp: `0x${(BigInt(r.timestamp as string) + 1n).toString(16)}` };
          if (scenario === "disagree" && index === 1 || scenario === "changed-head" && finalCalls > 1) return { ...r, hash: chainHash("88") };
        }
        if (method === "eth_call") {
          const name = decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data }).functionName;
          if (name === scenario) return encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: name as "paused", result: true });
        }
        return raw;
      } } satisfies PublicChainRpc;
    }) as unknown as readonly [PublicChainRpc, PublicChainRpc];
    await expect(new GenerativeRecoveryChain(f.config, sources).observe(f.reservation, new AbortController().signal)).rejects.toThrow("Recovery cannot be verified");
  });
  it("bounds a hung transport and honors cancellation without restarting work", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const request = vi.fn(() => new Promise(() => {}));
    const sources: readonly [PublicChainRpc, PublicChainRpc] = [{ id: "first", request }, { id: "second", request }];
    const chain = new GenerativeRecoveryChain({ ...f.config, observationTimeoutMs: 30 }, sources);
    await expect(chain.observe(f.reservation, controller.signal)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    await expect(chain.observe(f.reservation, new AbortController().signal)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(4);
  });
  it("refuses public targets or duplicate sources", () => {
    const f = fixture();
    expect(() => new GenerativeRecoveryChain({ ...f.config, chainId: 11155111n }, f.sources)).toThrow();
    expect(() => new GenerativeRecoveryChain({ ...f.config, contractProfile: undefined, generativeRenderer: undefined }, f.sources)).toThrow();
    expect(() => new GenerativeRecoveryChain(f.config, [f.sources[0], f.sources[0]])).toThrow();
  });
});
