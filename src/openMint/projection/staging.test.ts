import { describe, expect, it } from "vitest";
import { createGenerativeArtworkReader, createStagingGenerativeArtworkReader } from "../generativeReads.js";
import { createGenerativeArtworkReads, createStagingGenerativeArtworkReads } from "./generativeArtwork.js";
import { createProjectionObserver, createStagingProjectionObserver } from "./observer.js";
import { generativeProjectionFixture, genEncoded } from "../fixtures/generativeProjectionRpc.js";
import { testAddress as a, testHash as h } from "../fixtures/projectionRpc.js";
import { validateDeployment } from "./model.js";

function fixture() {
  const f = generativeProjectionFixture("generative-v1-rc1");
  f.options.config.chainId = 11155111n; (f.options.deployment as { chainId: string }).chainId = "11155111";
  f.mutate((v, c) => c.method === "eth_chainId" ? "0xaa36a7" : c.name === "eip712Domain"
    ? genEncoded("eip712Domain", ["0x0f", "SignaturesGenerativeMintRC1", "1", 11155111n, a(10), h(0), []]) : v);
  return f;
}
const signal = () => new AbortController().signal;
describe("explicit Sepolia RC1 read-only projection factories", () => {
  it("ordinary factories continue to refuse Sepolia; explicit observer verifies it", async () => {
    const f = fixture();
    expect(() => createGenerativeArtworkReader(f.options)).toThrow();
    expect(() => createProjectionObserver(f.options)).toThrow();
    expect(() => createGenerativeArtworkReads({ ...f.options, projection: { lookup: async () => ({ state: "unknown" }) }, timeoutMs: 1000 })).toThrow();
    await expect(createStagingGenerativeArtworkReader(f.options)(f.inputs.canonicalHandle, { number: 11n, hash: h(11) }, signal())).resolves.toMatchObject({ inputs: f.inputs });
    await expect(createStagingProjectionObserver(f.options)({ head: null, promoted: null, tail: [] }, signal())).resolves.toBeDefined();
    await expect(createStagingGenerativeArtworkReads({ ...f.options, projection: { lookup: async () => ({ state: "unknown" }) }, timeoutMs: 1000 })
      .detail(f.inputs.canonicalHandle, signal())).rejects.toThrow("unavailable");
  });
  it.each([1n, 31337n, 84532n])("does not turn staging into a generic chain override: %s", chainId => {
    const f = fixture(); f.options.config.chainId = chainId;
    expect(() => createStagingGenerativeArtworkReader(f.options)).toThrow();
    expect(() => createStagingProjectionObserver(f.options)).toThrow();
    expect(() => createStagingGenerativeArtworkReads({ ...f.options, projection: { lookup: async () => ({ state: "unknown" }) }, timeoutMs: 1000 })).toThrow();
  });
  it("rejects experimental profile on Sepolia even in the structural deployment model", () => {
    const f = generativeProjectionFixture(); (f.options.deployment as { chainId: string }).chainId = "11155111";
    f.options.config.chainId = 11155111n;
    expect(() => validateDeployment(f.options.deployment)).toThrow();
    expect(() => createStagingGenerativeArtworkReader(f.options)).toThrow();
    expect(() => createStagingProjectionObserver(f.options)).toThrow();
  });
  it("refuses forged config/deployment pins and off-chain event resolvers", () => {
    const f = fixture();
    expect(() => createStagingProjectionObserver({ ...f.options, deployment: { ...f.options.deployment, id: "other" } })).toThrow();
    expect(() => createStagingProjectionObserver({ ...f.options, resolveMint: async () => undefined as never })).toThrow();
  });
});
