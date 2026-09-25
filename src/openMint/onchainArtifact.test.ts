import { describe, expect, it } from "vitest";
import { decodeFunctionData, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { renderSignatureSvg, MBTI_TYPES } from "../algorithmV2/index.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { assessmentDigest } from "./assessment.js";
import { encodeOnchainArtifact, prepareOnchainArtifact, verifyOnchainArtifact, onchainMetadataURI,
  onchainArtifactDigest, ONCHAIN_ARTIFACT_DOMAIN, ONCHAIN_COLLECTION_URI } from "./onchainArtifact.js";
import { ONCHAIN_MINT_ABI, onchainMintTypedData, onchainMintCalldata, onchainMintDigest } from "./onchainAuthorization.js";
import { openMintHandleKey, openMintTypedData, openMintDigest } from "./authorization.js";

describe("fully on-chain artwork profile", () => {
  const assessment = syntheticPublicAssessment();
  const artifact = prepareOnchainArtifact(assessment);
  it("contains exact locked SVG, metadata and original spelling without a storage domain", () => {
    const json = Buffer.from(artifact.tokenURI.split(",")[1], "base64").toString(), metadata = JSON.parse(json);
    expect(metadata.name).toBe("@Alice_Bob_Key × INTJ");
    expect(Buffer.from(metadata.image.split(",")[1], "base64").toString()).toBe(renderSignatureSvg("Alice_Bob_Key", "INTJ"));
    expect(metadata.properties.assessment_digest).toBe(assessment.digest);
    expect(metadata.properties.svg_sha256).toBe(artifact.svgSha256);
    expect(metadata.properties.assessor).toBe("Grok");
    expect(json).not.toMatch(/ipfs:|https:|providerResponseId|private-response-id|private-reference|external_url/);
    expect(artifact.profile).toBe(ONCHAIN_ARTIFACT_DOMAIN);
    expect(artifact.digest).toBe(onchainArtifactDigest(artifact));
    expect(prepareOnchainArtifact(assessment)).toEqual(artifact);
    expect(() => verifyOnchainArtifact(artifact, assessment)).not.toThrow();
    expect(JSON.parse(Buffer.from(ONCHAIN_COLLECTION_URI.split(",")[1], "base64").toString()).name).toBe("Signatures Gallery");
  });
  it.each(MBTI_TYPES)("round-trips %s with all display data embedded", mbti => {
    const art = { renderHandle: "Alice_Bob_Key", mbti, svg: renderSignatureSvg("Alice_Bob_Key", mbti) };
    const encoded = encodeOnchainArtifact(art, assessment.digest);
    const metadata = JSON.parse(Buffer.from(encoded.tokenURI.split(",")[1], "base64").toString());
    expect(Buffer.from(metadata.image.split(",")[1], "base64").toString()).toBe(art.svg);
    expect(encoded.canonicalHandle).toBe("alice_bob_key");
  });
  it("rejects forged rendering even with self-consistent new hashes", () => {
    const forged = encodeOnchainArtifact({ ...artifact.artwork, svg: "<svg/>" }, assessment.digest);
    expect(() => verifyOnchainArtifact(forged, assessment)).toThrow("frozen assessment");
    expect(() => verifyOnchainArtifact({ ...artifact, extra: true } as never, assessment)).toThrow();
    expect(() => verifyOnchainArtifact({ ...artifact, artwork: { ...artifact.artwork, extra: true } } as never, assessment)).toThrow();
    expect(() => verifyOnchainArtifact({ ...artifact, artwork: null } as never, assessment)).toThrow();
  });
  it.each(["digest", "svgSha256", "tokenURI", "tokenURIHash", "profile", "rendererVersion", "assessmentDigest", "canonicalHandle"])("rejects changed %s", field => {
    expect(() => verifyOnchainArtifact({ ...artifact, [field]: "changed" }, assessment)).toThrow();
  });
  it.each(["", "<svg>".padEnd(16_385), null])("rejects unsupported SVG sizes/types", svg => {
    expect(() => onchainMetadataURI({ ...artifact.artwork, svg } as never, assessment.digest)).toThrow();
  });
  it.each(["x\"", "abcdefghijklmnop", "", "@alice", "x\n"])("rejects unsafe handle %s", renderHandle => {
    expect(() => onchainMetadataURI({ ...artifact.artwork, renderHandle }, assessment.digest)).toThrow();
  });
  it("rejects invalid commitments and MBTI", () => {
    expect(() => onchainMetadataURI({ ...artifact.artwork, mbti: "intj" } as never, assessment.digest)).toThrow();
    expect(() => onchainMetadataURI(artifact.artwork, `0x${"0".repeat(64)}`)).toThrow();
    expect(() => onchainArtifactDigest({ ...artifact, canonicalHandle: "bob" })).toThrow();
    expect(() => onchainArtifactDigest({ ...artifact, svgSha256: "bad" } as never)).toThrow();
  });
  it("does not promote fixture or historical unverified assessments", () => {
    const { digest: _, xIdentity, ...base } = assessment;
    const unverified = { ...base, digest: assessmentDigest(base) };
    expect(() => prepareOnchainArtifact(unverified)).toThrow("X-verified Grok");
    const fixture = { ...base, provenance: "development-fixture" as const, model: "development-fixture-v1",
      providerResponseId: "development-fixture:test", xIdentity: { ...xIdentity!, provenance: "development-fixture" as const } };
    expect(() => prepareOnchainArtifact({ ...fixture, digest: assessmentDigest(fixture) })).toThrow("X-verified Grok");
  });
});

describe("separate on-chain authorization domain and calldata", () => {
  const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const domain = { chainId: 31337, verifyingContract: "0x1111111111111111111111111111111111111111" };
  const artifact = prepareOnchainArtifact(syntheticPublicAssessment());
  const authorization = { handleKey: openMintHandleKey(artifact.canonicalHandle), assessmentDigest: artifact.assessmentDigest,
    artifactDigest: artifact.digest, recipient: signer.address, tokenURIHash: artifact.tokenURIHash,
    nonce: keccak256(stringToHex("nonce")), issuedAt: 1_800_000_000n, deadline: 1_800_000_900n };
  it("validates signature and includes complete SVG, not an external URI", async () => {
    const signature = await signer.signTypedData(onchainMintTypedData(domain, authorization));
    const data = await onchainMintCalldata({ domain, authorization, artifact, signature, authorizer: signer.address });
    const decoded = decodeFunctionData({ abi: ONCHAIN_MINT_ABI, data });
    expect(decoded.functionName).toBe("mint");
    expect(decoded.args?.[2]).toEqual(artifact.artwork);
    expect(onchainMintDigest(domain, authorization)).not.toBe(openMintDigest(domain, authorization));
  });
  it("rejects old-domain signatures, swapped artifacts and mismatched commitments", async () => {
    const signature = await signer.signTypedData(openMintTypedData(domain, authorization));
    await expect(onchainMintCalldata({ domain, authorization, artifact, signature, authorizer: signer.address })).rejects.toThrow();
    for (const field of ["handleKey", "assessmentDigest", "artifactDigest", "tokenURIHash"] as const) {
      await expect(onchainMintCalldata({ domain, authorization: { ...authorization, [field]: keccak256(stringToHex("wrong")) },
        artifact, signature, authorizer: signer.address })).rejects.toThrow("mismatch");
    }
  });
});
