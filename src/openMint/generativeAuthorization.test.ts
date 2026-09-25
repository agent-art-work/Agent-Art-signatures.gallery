import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MBTI_TYPES } from "./identity.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { assessmentDigest } from "./assessment.js";
import { generativeInputDigest, generativeRendererIdentity, prepareGenerativeInputs, verifyGenerativeInputs,
  validateGenerativeInputs, validateGenerativeRendererPin, GENERATIVE_INPUT_PROFILE } from "./generativeInputs.js";
import { generativeMintTypedData, generativeMintCalldata, generativeMintDigest, normalizeGenerativeAuthorization,
  verifyGenerativeMintAuthorization, stagingGenerativeMintTypedData, GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";
import { openMintHandleKey } from "./authorization.js";

const hash = (text: string) => keccak256(stringToHex(text));
const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const contract = "0x1111111111111111111111111111111111111111", renderer = "0x2222222222222222222222222222222222222222";
const rendererPin = { address: renderer, runtimeCodeHash: hash("experimental-code"), identity: generativeRendererIdentity(renderer, hash("experimental-code")) };
const domain = { chainId: 31337, verifyingContract: contract };
const assessment = syntheticPublicAssessment(), inputs = prepareGenerativeInputs(assessment, rendererPin.identity);
const authorization = { handleKey: openMintHandleKey(inputs.canonicalHandle), assessmentDigest: inputs.assessmentDigest,
  inputDigest: inputs.digest, recipient: signer.address, nonce: hash("nonce"), issuedAt: 1800000000n, deadline: 1800000900n };

describe("experimental generative input authority", () => {
  it("preserves verified case and MBTI, without storing outputs or changing assessment provenance", () => {
    expect(inputs).toEqual({ profile: GENERATIVE_INPUT_PROFILE, canonicalHandle: "alice_bob_key", renderHandle: "Alice_Bob_Key",
      mbti: "INTJ", assessmentDigest: assessment.digest, rendererIdentity: rendererPin.identity, digest: inputs.digest });
    expect(() => verifyGenerativeInputs(inputs, assessment, rendererPin.identity)).not.toThrow();
    expect(validateGenerativeRendererPin(rendererPin)).toEqual(rendererPin);
    // No renderer invocation, uploader, output-digest or URI dependency in these paths.
    for (const file of ["generativeInputs.ts", "generativeAuthorization.ts", "persistence/generativeInputs.ts", "persistence/generativeAuthorizations.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/renderSignatureSvg|renderSignaturePng|prepareOnchainArtifact|openMintTokenURIHash|tokenURIHash|svgSha256|tokenURI:\s/);
    }
  });
  it.each(MBTI_TYPES)("commits literal %s without admitting a new token identity", mbti => {
    expect(generativeInputDigest("Alice_Bob_Key", mbti, rendererPin.identity)).toMatch(/^0x[0-9a-f]{64}$/);
    if (mbti !== "INTJ") expect(generativeInputDigest("Alice_Bob_Key", mbti, rendererPin.identity)).not.toBe(inputs.digest);
    expect(openMintHandleKey(inputs.canonicalHandle)).toBe(authorization.handleKey);
  });
  it("binds exact renderer code/address and exact spelling", () => {
    expect(generativeRendererIdentity(contract, rendererPin.runtimeCodeHash)).not.toBe(rendererPin.identity);
    expect(generativeRendererIdentity(renderer, hash("other"))).not.toBe(rendererPin.identity);
    expect(generativeInputDigest("alice_bob_key", "INTJ", rendererPin.identity)).not.toBe(inputs.digest);
    expect(() => validateGenerativeRendererPin({ ...rendererPin, identity: hash("wrong") })).toThrow();
    expect(() => validateGenerativeRendererPin({ ...rendererPin, extra: true } as never)).toThrow();
    expect(() => generativeRendererIdentity(`0x${"0".repeat(40)}`, hash("code"))).toThrow();
  });
  it.each(["", "@alice", "abcdefghijklmnop", "alice\n", "é", '<script>'])("rejects invalid handle %j", handle => {
    expect(() => generativeInputDigest(handle, "INTJ", rendererPin.identity)).toThrow();
  });
  it("does not treat a self-consistent client MBTI or renderer change as accepted input", () => {
    const forged = { ...inputs, mbti: "ENFP" as const, digest: generativeInputDigest(inputs.renderHandle, "ENFP", rendererPin.identity) };
    expect(() => validateGenerativeInputs(forged)).not.toThrow(); // Encoding != authority.
    expect(() => verifyGenerativeInputs(forged, assessment, rendererPin.identity)).toThrow("frozen assessment");
    expect(() => validateGenerativeInputs({ ...inputs, svg: "<svg/>" } as never)).toThrow();
    expect(() => validateGenerativeInputs({ ...inputs, canonicalHandle: "other" })).toThrow();
    const { digest: _, xIdentity, ...base } = assessment;
    expect(() => prepareGenerativeInputs({ ...base, digest: assessmentDigest(base) }, rendererPin.identity)).toThrow("X-verified");
    const fixture = { ...base, provenance: "development-fixture" as const, model: "development-fixture-v1", providerResponseId: "development-fixture:test",
      xIdentity: { ...xIdentity!, provenance: "development-fixture" as const } };
    expect(() => prepareGenerativeInputs({ ...fixture, digest: assessmentDigest(fixture) }, rendererPin.identity)).toThrow("X-verified");
  });
  it("signs a distinct domain and encodes only inputs and their authority", async () => {
    const signature = await signer.signTypedData(generativeMintTypedData(domain, authorization));
    expect(await verifyGenerativeMintAuthorization(domain, authorization, signature, signer.address)).toBe(true);
    const data = await generativeMintCalldata({ domain, authorization, inputs, signature, authorizer: signer.address });
    expect((data.length - 2) / 2).toBeLessThan(700);
    expect(decodeFunctionData({ abi: GENERATIVE_MINT_ABI, data })).toMatchObject({ functionName: "mint", args: [inputs.renderHandle, inputs.mbti, authorization, signature] });
    for (const field of ["handleKey", "assessmentDigest", "inputDigest", "nonce"] as const) {
      expect(await verifyGenerativeMintAuthorization(domain, { ...authorization, [field]: hash("wrong") }, signature, signer.address)).toBe(false);
    }
    expect(await verifyGenerativeMintAuthorization({ ...domain, verifyingContract: renderer }, authorization, signature, signer.address)).toBe(false);
    const wrong = await signer.signTypedData({ ...generativeMintTypedData(domain, authorization), domain: { ...generativeMintTypedData(domain, authorization).domain, name: "SignaturesOpenMint" } });
    await expect(generativeMintCalldata({ domain, authorization, inputs, signature: wrong, authorizer: signer.address })).rejects.toThrow();
    await expect(generativeMintCalldata({ domain, authorization: { ...authorization, inputDigest: hash("wrong") }, inputs, signature, authorizer: signer.address })).rejects.toThrow("mismatch");
  });
  it.each([0, 1, 11155111])("refuses signing on non-local chain %i", chainId => {
    expect(() => generativeMintDigest({ ...domain, chainId }, authorization)).toThrow();
  });
  it("separately encodes only Sepolia RC1 without broadening the local or experimental domain", () => {
    const typed = stagingGenerativeMintTypedData({ ...domain, chainId: 11155111 }, authorization, "sg-generative-inputs-v1-rc1");
    expect(typed.domain).toMatchObject({ chainId: 11155111n, name: "SignaturesGenerativeMintRC1", version: "1" });
    for (const chainId of [0, 1, 31337]) expect(() => stagingGenerativeMintTypedData({ ...domain, chainId }, authorization, "sg-generative-inputs-v1-rc1")).toThrow();
    expect(() => stagingGenerativeMintTypedData({ ...domain, chainId: 11155111 }, authorization, GENERATIVE_INPUT_PROFILE)).toThrow();
    expect(() => generativeMintTypedData({ ...domain, chainId: 11155111 }, authorization, "sg-generative-inputs-v1-rc1")).toThrow();
  });
  it.each([0n, -1, 1.5, "01", "0x1", "-1", 2n ** 64n, Number.MAX_SAFE_INTEGER + 1, true, null])("rejects invalid time %s", issuedAt => {
    expect(() => normalizeGenerativeAuthorization({ ...authorization, issuedAt } as never)).toThrow();
  });
  it("rejects old output fields, zero commitments, invalid lifetimes and zero recipients", () => {
    for (const patch of [{ tokenURIHash: hash("uri") }, { deadline: authorization.issuedAt }, { deadline: authorization.deadline + 1n },
      { recipient: `0x${"0".repeat(40)}` }, { nonce: `0x${"0".repeat(64)}` }]) {
      expect(() => normalizeGenerativeAuthorization({ ...authorization, ...patch } as never)).toThrow();
    }
  });
});
