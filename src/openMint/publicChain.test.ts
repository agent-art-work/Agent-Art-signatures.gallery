import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, type Address, type Hex } from "viem";
import { openMintHandleKey, openMintTokenURIHash, type OpenMintAuthorizationInput } from "./authorization.js";
import { PUBLIC_CHAIN_READ_ABI, PublicChainGate, readPublicChainEligibility, type PublicChainGateConfig } from "./publicChain.js";
import { createPublicChainHttpRpc, type PublicChainReadMethod, type PublicChainRpc } from "./publicChainRpc.js";
import { privateKeyToAccount } from "viem/accounts";
import { onchainMintDigest, onchainMintTypedData } from "./onchainAuthorization.js";

const bytes32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const contract = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const authorizer = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address;
const runtime = "0x60006000" as Hex;
const block = { number: 10n, hash: bytes32("10") };
const tokenURI = "ipfs://open-mint-vector/metadata.json";
const authorization: OpenMintAuthorizationInput = {
  handleKey: openMintHandleKey("bigu"), recipient, assessmentDigest: bytes32("22"), artifactDigest: bytes32("33"),
  tokenURIHash: openMintTokenURIHash(tokenURI), nonce: bytes32("44"), issuedAt: 1800000000n, deadline: 1800000900n,
};
// Existing Solidity/TypeScript literal vector. No key, signer, or wallet needed.
const signature = "0x194368c98343eaf582ae494b38d5b6780c27398241b4902b8902485689c11ddc25ed91130926c61bef760d6685c4b3e5baef5a8c738742d8a02dce8fd4fd75851b";
const digest = "0xb769ac25cc7374bc4aa474bd64acb1a1aed5e6324215012928f0a05c02c72a31";
const input = () => ({ block: { ...block }, handle: "bigu", recipient, nonce: authorization.nonce });
const signedInput = () => ({ ...input(), tokenURI, assessmentDigest: authorization.assessmentDigest, artifactDigest: authorization.artifactDigest, authorization: { ...authorization }, signature });
type RpcRequest = { source: number; method: PublicChainReadMethod; params: readonly unknown[]; signal: AbortSignal };
type Override = (request: RpcRequest, result: unknown) => unknown;
const encoded = (name: string, result: unknown): Hex => encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
const readName = (request: RpcRequest) => request.method === "eth_call"
  ? decodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, data: (request.params[0] as { data: Hex }).data }).functionName : undefined;

function fixture() {
  const config: PublicChainGateConfig = { namespaceId: "namespace-1", deploymentId: "deployment-1", chainId: 31337n,
    genesisHash: bytes32("01"), deploymentBlock: { number: 2n, hash: bytes32("02") }, contract, runtimeCodeHash: keccak256(runtime), authorizer,
    maxBlockAgeMs: 120_000, maxFutureSkewMs: 5_000, evidenceTtlMs: 10_000, observationTimeoutMs: 1_000 };
  let now = 1800000060000;
  const requests: RpcRequest[] = [];
  const overrides: Override[] = [];
  const rpc = (source: number): PublicChainRpc => ({ id: `rpc-${source}`, request: vi.fn(async (method, params, signal) => {
    const request = { source, method, params, signal }; requests.push(request);
    let result: unknown;
    if (method === "eth_chainId") result = "0x7a69";
    else if (method === "eth_getBlockByNumber") {
      const n = BigInt(params[0] as string);
      result = { number: numberToHex(n), hash: n === 0n ? bytes32("01") : n === 2n ? bytes32("02") : block.hash,
        timestamp: numberToHex(1800000060n) };
    } else if (method === "eth_getCode") result = params[0] === contract ? runtime : "0x";
    else {
      const name = readName(request)!;
      result = encoded(name, name === "trustedAuthorizer" ? authorizer : name === "eip712Domain"
        ? ["0x0f", "SignaturesOpenMint", "1", 31337n, contract, bytes32("00"), []]
        : name === "authorizationDigest" ? digest : false);
    }
    for (const override of overrides) result = await override(request, result);
    return result;
  }) });
  const rpcs = [rpc(0), rpc(1)] as const;
  const gate = new PublicChainGate(config, rpcs, () => now);
  const expected = () => ({ namespaceId: "namespace-1", deploymentId: "deployment-1", handle: "bigu", recipient, nonce: authorization.nonce, now });
  return { config, gate, rpcs, requests, overrides, expected, setNow: (value: number) => { now = value; } };
}
afterEach(() => vi.useRealTimers());

describe("public chain eligibility gate (mocked independent sources)", () => {
  it("requires an explicitly selected on-chain domain and verifies its signature and digest", async () => {
    const f = fixture(); f.config.contractProfile = "onchain-v1";
    const gate = new PublicChainGate(f.config, f.rpcs, () => f.expected().now);
    const d = { chainId: 31337n, verifyingContract: contract }, onchainDigest = onchainMintDigest(d, authorization);
    const key = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
    const onchainSignature = await key.signTypedData(onchainMintTypedData(d, authorization));
    f.overrides.push((request, result) => readName(request) === "eip712Domain"
      ? encoded("eip712Domain", ["0x0f", "SignaturesOnchainMint", "1", 31337n, contract, bytes32("00"), []])
      : readName(request) === "authorizationDigest" ? encoded("authorizationDigest", onchainDigest) : result);
    const result = await gate.verifyAuthorization({ ...signedInput(), signature: onchainSignature });
    expect(result.authorizationDigest).toBe(onchainDigest);
    expect(readPublicChainEligibility(result.eligibility, f.expected()).contractProfile).toBe("onchain-v1");
    await expect(gate.verifyAuthorization(signedInput())).rejects.toThrow("Invalid authorizer");
    await expect(f.gate.preflight(input())).rejects.toThrow("domain disagrees");
    expect(() => new PublicChainGate({ ...f.config, contractProfile: "auto" as never }, f.rpcs)).toThrow("Unknown contract profile");
  });
  it("pins every state read to exactly one explicit canonical block and issues immutable evidence", async () => {
    const f = fixture(), witness = await f.gate.preflight(input());
    const evidence = readPublicChainEligibility(witness, f.expected());
    const { now: _now, ...binding } = f.expected();
    expect(evidence).toMatchObject({ ...binding, chainId: 31337n, genesisHash: f.config.genesisHash, contract, authorizer,
      runtimeCodeHash: f.config.runtimeCodeHash, block: { ...block, timestamp: 1800000060n }, observedAt: f.expected().now, validUntil: f.expected().now + 10_000, sources: ["rpc-0", "rpc-1"] });
    expect(Object.isFrozen(evidence)).toBe(true); expect(Object.isFrozen(evidence.block)).toBe(true);
    expect(Object.isFrozen(evidence.deploymentBlock)).toBe(true); expect(Object.isFrozen(evidence.sources)).toBe(true);
    expect(f.requests).toHaveLength(28);
    for (const request of f.requests) {
      if (request.method === "eth_getCode" || request.method === "eth_call") expect(request.params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
      if (request.method === "eth_getBlockByNumber") expect(["0x0", "0x2", "0xa"]).toContain(request.params[0]);
    }
    expect(f.requests.every(request => request.signal.aborted)).toBe(true);
    expect(JSON.stringify(witness)).toBe("{}");
  });
  it("requires both configured sources, with no fallback when one is unavailable", async () => {
    const f = fixture(); f.overrides.push((request, result) => { if (request.source === 1) throw new Error("secret RPC URL"); return result; });
    await expect(f.gate.preflight(input())).rejects.toThrow("failed closed");
  });
  it.each(["namespaceId", "deploymentId", "handle", "recipient", "nonce"] as const)("rejects a witness rebound to %s", async field => {
    const f = fixture(), witness = await f.gate.preflight(input());
    const value = field === "recipient" ? contract : field === "nonce" ? bytes32("77") : "other";
    expect(() => readPublicChainEligibility(witness, { ...f.expected(), [field]: value })).toThrow("binding mismatch");
  });
  it("rejects forged, serialized, expired, future-clock, and invalid-clock witnesses", async () => {
    const f = fixture(), witness = await f.gate.preflight(input());
    for (const forged of [undefined, true, {}, { eligible: true }, JSON.parse(JSON.stringify(witness))]) {
      expect(() => readPublicChainEligibility(forged, f.expected())).toThrow("Unknown");
    }
    for (const now of [f.expected().now - 1, f.expected().now + 10_000, NaN, Infinity, -1, 1.5]) {
      expect(() => readPublicChainEligibility(witness, { ...f.expected(), now })).toThrow();
    }
  });
  it("snapshots mutable configuration and request identity before asynchronous work", async () => {
    const f = fixture(), request = input(), task = f.gate.preflight(request);
    request.handle = "other"; request.block.hash = bytes32("55"); f.config.namespaceId = "other";
    (f.config.deploymentBlock as { hash: Hex }).hash = bytes32("88"); f.config.authorizer = recipient;
    expect(readPublicChainEligibility(await task, f.expected()).deploymentBlock.hash).toBe(bytes32("02"));
  });
  it.each(["0x1", null, undefined, "0x07a69", "31337"])("rejects wrong/malformed chain ID %j", async value => {
    const f = fixture(); f.overrides.push((request, result) => request.source === 1 && request.method === "eth_chainId" ? value : result);
    await expect(f.gate.preflight(input())).rejects.toThrow();
  });
  it.each(["0x0", "0x2", "0xa"])("rejects wrong genesis/deployment/observation block %s", async number => {
    const f = fixture(); f.overrides.push((request, result) => request.method === "eth_getBlockByNumber" && request.params[0] === number ? { ...result as object, hash: bytes32("77") } : result);
    await expect(f.gate.preflight(input())).rejects.toThrow("pin disagrees");
  });
  it.each([null, {}, { number: null }, { timestamp: "0x00" }, { hash: null }])("fails closed on missing/malformed header %j", async malformed => {
    const f = fixture(); f.overrides.push((request, result) => request.method === "eth_getBlockByNumber" && request.params[0] === "0xa"
      ? malformed && Object.keys(malformed).length ? { ...result as object, ...malformed } : malformed : result);
    await expect(f.gate.preflight(input())).rejects.toThrow();
  });
  it("rejects reorgs and chain switching during reads", async () => {
    for (const method of ["eth_chainId", "eth_getBlockByNumber"] as const) {
      const f = fixture(); let count = 0;
      f.overrides.push((request, result) => request.source === 0 && request.method === method && (method === "eth_chainId" || request.params[0] === "0xa") && ++count === 2
        ? method === "eth_chainId" ? "0x1" : { ...result as object, hash: bytes32("77") } : result);
      await expect(f.gate.preflight(input())).rejects.toThrow();
    }
  });
  it("rejects source disagreement even if both return individually fresh headers", async () => {
    const f = fixture(); f.overrides.push((request, result) => request.source === 1 && request.method === "eth_getBlockByNumber" ? { ...result as object, timestamp: numberToHex(1800000061n) } : result);
    await expect(f.gate.preflight(input())).rejects.toThrow("sources disagree");
  });
  it.each([undefined, null, "0x0", "0x6001"])("rejects unavailable/mismatched contract code %j", async value => {
    const f = fixture(); f.overrides.push((request, result) => request.method === "eth_getCode" && request.params[0] === contract ? value : result);
    await expect(f.gate.preflight(input())).rejects.toThrow();
  });
  it.each([undefined, null, "0x00", "0x6001", `0xef0100${"11".repeat(20)}`])("rejects missing or nonempty recipient code %j", async value => {
    const f = fixture(); f.overrides.push((request, result) => request.method === "eth_getCode" && request.params[0] === recipient ? value : result);
    await expect(f.gate.preflight(input())).rejects.toThrow();
  });
  it("rejects a changed or missing trusted authorizer", async () => {
    const f = fixture(); f.overrides.push((request, result) => readName(request) === "trustedAuthorizer" ? encoded("trustedAuthorizer", recipient) : result);
    await expect(f.gate.preflight(input())).rejects.toThrow("authorizer disagrees");
  });
  it.each([[0, "0x1f"], [1, "Other"], [2, "2"], [3, 1n], [4, recipient], [5, bytes32("99")], [6, [1n]]] as const)("rejects changed EIP-5267 field %i", async (index, value) => {
    const f = fixture(); const domain: unknown[] = ["0x0f", "SignaturesOpenMint", "1", 31337n, contract, bytes32("00"), []]; domain[index] = value;
    f.overrides.push((request, result) => readName(request) === "eip712Domain" ? encoded("eip712Domain", domain) : result);
    await expect(f.gate.preflight(input())).rejects.toThrow("domain disagrees");
  });
  it.each(["paused", "mintedHandle", "usedNonces", "revokedNonces"])("rejects true or missing %s", async name => {
    for (const value of [encoded(name, true), "0x", undefined]) {
      const f = fixture(); f.overrides.push((request, result) => readName(request) === name ? value : result);
      await expect(f.gate.preflight(input())).rejects.toThrow();
    }
  });
  it.each([1800000180000, 1800000054999, NaN])("rejects stale block, future block, or invalid clock %s", async now => {
    const f = fixture(); f.setNow(now);
    await expect(f.gate.preflight(input())).rejects.toThrow();
  });
  it("caps witness validity at block age and detects a backwards observation clock", async () => {
    const f = fixture(); f.setNow(1800000179999);
    const witness = await f.gate.preflight(input());
    expect(readPublicChainEligibility(witness, f.expected()).validUntil).toBe(1800000180000);
    const g = fixture(); g.overrides.push((_, result) => { g.setNow(1800000059999); return result; });
    await expect(g.gate.preflight(input())).rejects.toThrow("clock disagrees");
  });
  it("bounds stalled injected RPCs, aborts both sources, and never issues later reads", async () => {
    vi.useFakeTimers(); const f = fixture(); f.overrides.push(() => new Promise(() => {}));
    const task = f.gate.preflight(input()).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await task).toMatchObject({ message: "Chain observation timed out." });
    expect(f.requests).toHaveLength(8); expect(f.requests.every(request => request.signal.aborted)).toBe(true);
  });
  it.each(["first", "last"])("rejects elapsed deadline after the %s read even if promise microtasks starve timers", async phase => {
    const f = fixture(); let elapsed = 0, finalHeaders = 0;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    f.overrides.push((request, result) => {
      if (phase === "first" || (request.source === 1 && request.method === "eth_getBlockByNumber" && request.params[0] === "0xa" && ++finalHeaders === 2)) elapsed = 1000;
      return result;
    });
    try {
      await expect(f.gate.preflight(input())).rejects.toThrow("timed out");
      expect(f.requests.every(request => request.signal.aborted)).toBe(true);
      if (phase === "first") expect(f.requests.some(request => request.method === "eth_call")).toBe(false);
      // The injected wall clock did not advance: this is elapsed execution
      // expiry, not evidence/block freshness or a timer callback.
      expect(f.expected().now).toBe(1800000060000);
    } finally { monotonic.mockRestore(); }
  });
  it("rejects invalid inputs before any RPC", async () => {
    for (const changed of [{ handle: "Bigu" }, { recipient: "0x" }, { nonce: bytes32("00") }, { block: { ...block, number: 1n } }, { block: { ...block, number: -1n } }]) {
      const f = fixture(); await expect(f.gate.preflight({ ...input(), ...changed })).rejects.toThrow(); expect(f.requests).toHaveLength(0);
    }
  });
  it("requires distinct sources and explicit bounded configuration", () => {
    const f = fixture();
    for (const changed of [{ observationTimeoutMs: 0 }, { evidenceTtlMs: 60_001 }, { maxBlockAgeMs: Infinity }, { maxFutureSkewMs: -1 }, { genesisHash: bytes32("00") }, { namespaceId: "" }]) {
      expect(() => new PublicChainGate({ ...f.config, ...changed }, f.rpcs)).toThrow();
    }
    expect(() => new PublicChainGate(f.config, [f.rpcs[0], f.rpcs[0]])).toThrow("distinct");
    expect(() => new PublicChainGate(f.config, [f.rpcs[0], { ...f.rpcs[1], id: "rpc-0" }])).toThrow("distinct");
  });
});

describe("read-only signed authorization gate", () => {
  it("verifies the existing literal signature and on-chain digest without signing", async () => {
    const f = fixture(), result = await f.gate.verifyAuthorization(signedInput());
    expect(result.authorizationDigest).toBe(digest);
    expect(readPublicChainEligibility(result.eligibility, f.expected()).nonce).toBe(authorization.nonce);
    expect(f.requests.filter(request => readName(request) === "authorizationDigest")).toHaveLength(2);
  });
  it.each(["handle", "tokenURI", "assessmentDigest", "artifactDigest", "signature"] as const)("rejects changed %s without RPC", async field => {
    const f = fixture(), value = field.endsWith("Digest") ? bytes32("99") : "other";
    await expect(f.gate.verifyAuthorization({ ...signedInput(), [field]: value })).rejects.toThrow(); expect(f.requests).toHaveLength(0);
  });
  it("rejects an on-chain digest inconsistent with the verified local domain", async () => {
    const f = fixture(); f.overrides.push((request, result) => readName(request) === "authorizationDigest" ? encoded("authorizationDigest", bytes32("99")) : result);
    await expect(f.gate.verifyAuthorization(signedInput())).rejects.toThrow("digest disagrees");
  });
  it.each([1799999999n, 1800000900n, 1800000901n])("rejects signature outside its block/wall-clock window at %s", async timestamp => {
    const f = fixture(); f.setNow(Number(timestamp) * 1000);
    f.overrides.push((request, result) => request.method === "eth_getBlockByNumber" ? { ...result as object, timestamp: numberToHex(timestamp) } : result);
    await expect(f.gate.verifyAuthorization(signedInput())).rejects.toThrow("not active");
  });
  it("caps evidence before signature expiry", async () => {
    const f = fixture(); f.setNow(1800000899000);
    f.overrides.push((request, result) => request.method === "eth_getBlockByNumber" ? { ...result as object, timestamp: numberToHex(1800000899n) } : result);
    const result = await f.gate.verifyAuthorization(signedInput());
    expect(readPublicChainEligibility(result.eligibility, f.expected()).validUntil).toBe(1800000900000);
  });
});

describe("bounded actual viem HTTP read adapter (mock fetch only)", () => {
  function transport(fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, timeoutMs = 50) {
    const f = fixture();
    const requests: { method: PublicChainReadMethod; params: unknown[] }[] = [];
    const fetchRpc = vi.fn(fetchFn ?? (async (_url, init) => {
      expect(init?.redirect).toBe("error"); const body = JSON.parse(String(init?.body)); requests.push(body);
      const result = await f.rpcs[0].request(body.method, body.params, init!.signal!);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }));
    const rpc = createPublicChainHttpRpc({ id: "http-0", url: "https://rpc.example.org/", timeoutMs, maxResponseBytes: 4096, fetchFn: fetchRpc });
    return { ...f, rpc, requests, fetchRpc };
  }
  it("preserves EIP-1898 selectors through viem JSON-RPC and ABI decoding", async () => {
    // ABI conformance is not a 50 ms latency benchmark under parallel coverage.
    const f = transport(undefined, 1000), gate = new PublicChainGate(f.config, [f.rpc, f.rpcs[1]], () => f.expected().now);
    expect(readPublicChainEligibility(await gate.preflight(input()), f.expected()).contract).toBe(contract);
    expect(f.requests).toHaveLength(14);
    for (const request of f.requests.filter(request => ["eth_getCode", "eth_call"].includes(request.method))) {
      expect(request.params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    }
    expect(f.requests.some(request => /send|sign|wallet/i.test(request.method))).toBe(false);
  });
  it("rejects unsupported canonical hash selectors instead of falling back to numeric/latest", async () => {
    const f = transport(async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "EIP-1898 unsupported" } }); });
    await expect(f.rpc.request("eth_getCode", [recipient, { blockHash: block.hash, requireCanonical: true }], new AbortController().signal)).rejects.toThrow();
    expect(f.fetchRpc).toHaveBeenCalledOnce();
  });
  it("allows bounded read-only deployment transaction lookup without opening any signing method", async () => {
    const transactionHash = "0x" + "12".repeat(32), value = { hash: transactionHash, type: "0x2" };
    const f = transport(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("eth_getTransactionByHash"); expect(body.params).toEqual([transactionHash]);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: value });
    }, 1000);
    await expect(f.rpc.request("eth_getTransactionByHash", [transactionHash], new AbortController().signal)).resolves.toEqual(value);
    for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_sign", "wallet_addEthereumChain"]) {
      await expect(f.rpc.request(method as PublicChainReadMethod, [], new AbortController().signal)).rejects.toThrow("read-only");
    }
    expect(f.fetchRpc).toHaveBeenCalledOnce();
  });
  it("never retries HTTP failures", async () => {
    const f = transport(async () => { throw new Error("no connection"); });
    await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow(); expect(f.fetchRpc).toHaveBeenCalledOnce();
  });
  it("rejects forbidden writes before fetch", async () => {
    const f = transport();
    await expect(f.rpc.request("eth_sendRawTransaction" as PublicChainReadMethod, [], new AbortController().signal)).rejects.toThrow("read-only");
    expect(f.fetchRpc).not.toHaveBeenCalled();
  });
  it("bounds response body size", async () => {
    const f = transport(async () => new Response("x".repeat(5000), { headers: { "content-type": "application/json" } }));
    await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow(); expect(f.fetchRpc).toHaveBeenCalledOnce();
  });
  it("cancels declared-oversize bodies and always aborts the child fetch signal", async () => {
    const cancel = vi.fn();
    const f = transport(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": "5000" } }));
    await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce(); expect(f.fetchRpc.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it.each(["wrong-id", "missing-id", "missing-version", "wrong-version", "both-result-error", "no-result-error", "bad-error", "batch"])("rejects malformed or misassociated JSON-RPC envelope: %s", async mutation => {
    const f = transport(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const envelope: Record<string, unknown> = { jsonrpc: "2.0", id: request.id, result: "0x7a69" };
      if (mutation === "wrong-id") envelope.id = "wrong";
      if (mutation === "missing-id") delete envelope.id;
      if (mutation === "missing-version") delete envelope.jsonrpc;
      if (mutation === "wrong-version") envelope.jsonrpc = "1.0";
      if (mutation === "both-result-error") envelope.error = { code: -1, message: "error" };
      if (mutation === "no-result-error") delete envelope.result;
      if (mutation === "bad-error") { delete envelope.result; envelope.error = { code: "bad" }; }
      return Response.json(mutation === "batch" ? [envelope] : envelope);
    });
    await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow();
    expect(f.fetchRpc).toHaveBeenCalledOnce(); expect(f.fetchRpc.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds stalled response body reads as well as fetch", async () => {
    vi.useFakeTimers(); const f = transport(async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }));
    const task = f.rpc.request("eth_chainId", [], new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(50); expect(await task).toMatchObject({ message: "RPC read timed out." });
    expect(f.fetchRpc).toHaveBeenCalledOnce(); expect(f.fetchRpc.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds empty-chunk streams and cancels them without relying on a timer turn", async () => {
    const cancel = vi.fn();
    const f = transport(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel })));
    await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce(); expect(f.fetchRpc.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("rejects late fetch completion without waiting for a timer turn and cancels its body", async () => {
    let elapsed = 0; const cancel = vi.fn(), monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const f = transport(async () => { elapsed = 50; return new Response(new ReadableStream({ cancel })); });
    try {
      await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow();
      expect(cancel).toHaveBeenCalledOnce(); expect(f.fetchRpc).toHaveBeenCalledOnce();
      expect(f.fetchRpc.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { monotonic.mockRestore(); }
  });
  it("checks elapsed time between small streamed chunks even when timers are starved", async () => {
    let elapsed = 0, chunks = 0; const cancel = vi.fn(), monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const f = transport(async () => new Response(new ReadableStream({
      pull(controller) { elapsed += 10; chunks++; controller.enqueue(new Uint8Array([32])); }, cancel,
    })));
    try {
      await expect(f.rpc.request("eth_chainId", [], new AbortController().signal)).rejects.toThrow();
      expect(chunks).toBeLessThan(10); expect(cancel).toHaveBeenCalledOnce();
      expect(f.fetchRpc).toHaveBeenCalledOnce(); expect(f.fetchRpc.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { monotonic.mockRestore(); }
  });
  it("keeps concurrent request deadlines separate rather than renewing the older read", async () => {
    let elapsed = 0, release!: () => void, count = 0;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const f = transport(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (++count === 1) await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x7a69" });
    });
    try {
      const first = f.rpc.request("eth_chainId", [], new AbortController().signal).catch(error => error);
      while (!release) await Promise.resolve();
      elapsed = 40;
      const second = f.rpc.request("eth_chainId", [], new AbortController().signal);
      elapsed = 55; release();
      expect(await first).toBeInstanceOf(Error); await expect(second).resolves.toBe("0x7a69");
      expect(f.fetchRpc).toHaveBeenCalledTimes(2);
    } finally { monotonic.mockRestore(); }
  });
  it("cancels a stalled request and does not fetch an already cancelled request", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const f = transport(async () => { started(); return new Promise(() => {}); }), controller = new AbortController();
    const task = f.rpc.request("eth_chainId", [], controller.signal); await ready; controller.abort();
    await expect(task).rejects.toThrow("cancelled"); expect(f.fetchRpc).toHaveBeenCalledOnce();
    await expect(f.rpc.request("eth_chainId", [], controller.signal)).rejects.toThrow("cancelled"); expect(f.fetchRpc).toHaveBeenCalledOnce();
  });
  it("does not dispatch fetch if cancellation arrives in the transport microtask gap", async () => {
    const f = transport(), controller = new AbortController();
    const task = f.rpc.request("eth_chainId", [], controller.signal); controller.abort();
    await expect(task).rejects.toThrow("cancelled"); expect(f.fetchRpc).not.toHaveBeenCalled();
  });
  it.each(["http://rpc.example.org", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://rpc.internal", "https://rpc.test", "https://rpc.onion", "https://user:secret@rpc.example.org", "https://rpc.example.org/#fragment"])("rejects unsafe endpoint %s", url => {
    expect(() => createPublicChainHttpRpc({ id: "a", url, timeoutMs: 1000, maxResponseBytes: 4096, fetchFn: vi.fn() })).toThrow();
  });
});
