import { expect, it } from "vitest";
import { createStagingEligibilityReader, PublicChainGate, readPublicChainEligibility } from "../publicChain.js";
import { chainHash, eligibilityFixture, fixturePinForProfile } from "../persistence/fixtures/eligibility.js";

it("uses two real witness paths for explicit Sepolia RC1, without opening the default local constructor", async () => {
  const now = Date.now(), f = eligibilityFixture("staging-ns", "release", () => now);
  const config = { ...f.config, chainId: 11155111n, contractProfile: "generative-v1-rc1" as const, generativeRenderer: fixturePinForProfile("generative-v1-rc1") };
  const sources = f.sources(config), reader = createStagingEligibilityReader(config, sources, () => now);
  expect(() => new PublicChainGate(config, sources)).toThrow();
  expect(() => new PublicChainGate(config, sources, Date.now, Symbol("explicit Sepolia RC1 read-only eligibility"))).toThrow();
  expect(Object.keys(reader)).toEqual(["preflight"]);
  const intent = { block: { number: 10n, hash: chainHash("10") }, handle: "alice", recipient: f.config.authorizer, nonce: chainHash("33") };
  const w = await reader.preflight(intent);
  expect(readPublicChainEligibility(w, { ...intent, namespaceId: "staging-ns", deploymentId: "release", now }).chainId).toBe(11155111n);
  expect(() => readPublicChainEligibility({ ...w }, { ...intent, namespaceId: "staging-ns", deploymentId: "release", now })).toThrow();
  for (const patch of [{ chainId: 1n }, { chainId: 31337n }, { contractProfile: "generative-experimental-v1" as const }, { generativeRenderer: undefined }]) {
    expect(() => createStagingEligibilityReader({ ...config, ...patch }, sources)).toThrow();
  }
  await expect(createStagingEligibilityReader(config, f.sources({ ...config, authorizer: config.contract }), () => now).preflight(intent)).rejects.toThrow();
});
