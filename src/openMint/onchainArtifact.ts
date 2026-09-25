import { createHash } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { validateAssessment, type Assessment } from "./assessment.js";
import { openMintTokenURIHash } from "./authorization.js";
import { canonicalHandle, preservedHandle, isMbti, RENDERER_VERSION, type MBTI } from "./identity.js";

/** New namespace only. Never reinterpret an old IPFS/HTTPS artifact as on-chain. */
export const ONCHAIN_ARTIFACT_DOMAIN = "signatures.gallery/onchain-artifact/v1" as const;
export const ONCHAIN_METADATA_VERSION = "sg-onchain-metadata-1.0.0" as const;
export const ONCHAIN_MAX_SVG_BYTES = 16_384;
export const ONCHAIN_DESCRIPTION = "A signature interpreted by Grok. MBTI is an artistic input, not a psychological diagnosis. Owning this token does not imply ownership or control of the X account.";
export const ONCHAIN_COLLECTION_URI = `data:application/json;base64,${Buffer.from('{"name":"Signatures Gallery","description":"Fully on-chain signature artwork. One token per canonical X handle."}').toString("base64")}`;
export interface OnchainArtworkInput { readonly renderHandle: string; readonly mbti: MBTI; readonly svg: string }
export interface OnchainArtifact {
  readonly profile: typeof ONCHAIN_ARTIFACT_DOMAIN;
  readonly canonicalHandle: string;
  readonly assessmentDigest: Hex;
  readonly rendererVersion: typeof RENDERER_VERSION;
  readonly artwork: OnchainArtworkInput;
  readonly svgSha256: Hex;
  readonly tokenURI: string;
  readonly tokenURIHash: Hex;
  readonly digest: Hex;
}
const sha256 = (value: string): Hex => `0x${createHash("sha256").update(value, "utf8").digest("hex")}`;
function hash(value: string): void {
  if (!/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new Error("Invalid on-chain commitment.");
}

/** Fixed serializer, intentionally identical to OnchainSignatures.metadataURI. */
export function onchainMetadataURI(art: OnchainArtworkInput, assessmentDigest: Hex): string {
  if (preservedHandle(art.renderHandle) !== art.renderHandle || !isMbti(art.mbti)) throw new Error("Invalid on-chain artwork identity.");
  hash(assessmentDigest);
  if (typeof art.svg !== "string" || Buffer.byteLength(art.svg) < 1 || Buffer.byteLength(art.svg) > ONCHAIN_MAX_SVG_BYTES) {
    throw new Error("On-chain SVG exceeds the supported byte limit.");
  }
  const metadata = {
    name: `@${art.renderHandle} × ${art.mbti}`, description: ONCHAIN_DESCRIPTION,
    image: `data:image/svg+xml;base64,${Buffer.from(art.svg).toString("base64")}`,
    attributes: [{ trait_type: "Handle", value: art.renderHandle }, { trait_type: "MBTI", value: art.mbti },
      { trait_type: "Renderer", value: RENDERER_VERSION }],
    properties: { metadata_version: ONCHAIN_METADATA_VERSION, assessment_digest: assessmentDigest,
      assessor: "Grok", svg_sha256: sha256(art.svg) },
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
}

export function onchainArtifactDigest(input: {
  canonicalHandle: string; artwork: OnchainArtworkInput; assessmentDigest: Hex; svgSha256: Hex; tokenURIHash: Hex;
}): Hex {
  if (canonicalHandle(input.canonicalHandle) !== input.canonicalHandle
    || preservedHandle(input.artwork.renderHandle) !== input.artwork.renderHandle
    || canonicalHandle(input.artwork.renderHandle) !== input.canonicalHandle || !isMbti(input.artwork.mbti)) {
    throw new Error("Invalid on-chain artwork identity.");
  }
  for (const value of [input.assessmentDigest, input.svgSha256, input.tokenURIHash]) hash(value);
  return keccak256(encodeAbiParameters([
    { type: "string" }, { type: "bytes32" }, ...Array.from({ length: 5 }, () => ({ type: "string" as const })),
    { type: "bytes32" }, { type: "bytes32" },
  ], [ONCHAIN_ARTIFACT_DOMAIN, input.assessmentDigest, input.canonicalHandle, input.artwork.renderHandle,
    input.artwork.mbti, RENDERER_VERSION, ONCHAIN_METADATA_VERSION, input.svgSha256, input.tokenURIHash]));
}

/** Encoding only: no claim that arbitrary input was assessed by Grok. Signing
 * services MUST enter through prepareOnchainArtifact, not this low-level helper. */
export function encodeOnchainArtifact(artwork: OnchainArtworkInput, assessmentDigest: Hex): OnchainArtifact {
  const art = Object.freeze({ ...artwork });
  const handle = canonicalHandle(art.renderHandle), tokenURI = onchainMetadataURI(art, assessmentDigest);
  const fields = { canonicalHandle: handle, artwork: art, assessmentDigest,
    svgSha256: sha256(art.svg), tokenURIHash: openMintTokenURIHash(tokenURI) };
  return Object.freeze({ profile: ONCHAIN_ARTIFACT_DOMAIN, rendererVersion: RENDERER_VERSION, ...fields,
    tokenURI, digest: onchainArtifactDigest(fields) });
}

/** Paid authority is established upstream. This only accepts the saved validated
 * native, X-verified Grok assessment and renders its exact case-sensitive handle. */
export function prepareOnchainArtifact(input: Assessment): OnchainArtifact {
  const assessment = validateAssessment(input);
  if (assessment.provenance !== "grok" || assessment.rendererVersion !== RENDERER_VERSION
    || assessment.xIdentity?.provenance !== "x-api") throw new Error("On-chain artwork requires an X-verified Grok assessment.");
  const renderHandle = assessment.xIdentity.username;
  return encodeOnchainArtifact({ renderHandle, mbti: assessment.mbti,
    svg: renderSignatureSvg(renderHandle, assessment.mbti) }, assessment.digest);
}

export function verifyOnchainArtifact(value: OnchainArtifact, assessment: Assessment): void {
  const expected = prepareOnchainArtifact(assessment);
  if (!value || Object.keys(value).length !== Object.keys(expected).length
    || !value.artwork || Object.keys(value.artwork).length !== 3
    || Object.keys(expected).some(key => key === "artwork"
      ? ["renderHandle", "mbti", "svg"].some(field => value.artwork[field as keyof OnchainArtworkInput] !== expected.artwork[field as keyof OnchainArtworkInput])
      : value[key as keyof OnchainArtifact] !== expected[key as keyof OnchainArtifact])) {
    throw new Error("On-chain artifact does not match the frozen assessment rendering.");
  }
}
