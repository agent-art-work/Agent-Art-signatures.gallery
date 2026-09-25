import { encodeFunctionData, hashTypedData, parseAbi, type Hex } from "viem";
import { OPEN_MINT_ABI, OPEN_MINT_TYPES, OPEN_MINT_PRIMARY_TYPE, openMintDomain, openMintHandleKey,
  normalizeOpenMintAuthorization, type OpenMintAuthorizationInput, type OpenMintDomainInput } from "./authorization.js";
import { requireCanonicalSignatureFrom } from "../v2/core/ethereumSignature.js";
import type { OnchainArtifact } from "./onchainArtifact.js";

export const ONCHAIN_DOMAIN_NAME = "SignaturesOnchainMint" as const;
export function onchainMintTypedData(domain: OpenMintDomainInput, input: OpenMintAuthorizationInput) {
  return { domain: { ...openMintDomain(domain), name: ONCHAIN_DOMAIN_NAME }, types: OPEN_MINT_TYPES,
    primaryType: OPEN_MINT_PRIMARY_TYPE, message: normalizeOpenMintAuthorization(input) };
}
export function onchainMintDigest(domain: OpenMintDomainInput, input: OpenMintAuthorizationInput): Hex {
  return hashTypedData(onchainMintTypedData(domain, input));
}
export async function verifyOnchainMintAuthorization(domain: OpenMintDomainInput, input: OpenMintAuthorizationInput,
  signature: string, authorizer: `0x${string}`): Promise<boolean> {
  try { await requireCanonicalSignatureFrom(onchainMintDigest(domain, input), signature, authorizer); return true; }
  catch { return false; }
}
export const ONCHAIN_MINT_ABI = [
  ...OPEN_MINT_ABI.filter(item => item.type !== "constructor" && !(item.type === "function" && item.name === "mint")),
  ...parseAbi([
    "struct OpenMintAuthorization { bytes32 handleKey; bytes32 assessmentDigest; bytes32 artifactDigest; address recipient; bytes32 tokenURIHash; bytes32 nonce; uint64 issuedAt; uint64 deadline; }",
    "struct ArtworkInput { string renderHandle; string mbti; string svg; }",
    "constructor(string collectionName_,string collectionSymbol_,uint48 defaultAdminDelay_,address delayedAdmin_,address authorizerManager_,address pauser_,address nonceRevoker_,address initialAuthorizer_)",
    "function mint(string normalizedHandle,OpenMintAuthorization a,ArtworkInput art,bytes signature) returns (uint256 tokenId)",
    "function svg(uint256 tokenId) view returns (string)",
    "function artwork(uint256 tokenId) view returns (address svgData,string renderHandle,string mbti)",
    "function metadataURI(string renderHandle,string mbti,string svg_,bytes32 assessment) pure returns (string)",
    "function artifactDigest(string normalizedHandle,string renderHandle,string mbti,bytes32 assessment,bytes32 svgSha256,bytes32 uriHash) pure returns (bytes32)",
    "error InvalidArtwork()", "error ArtifactDigestMismatch()",
  ]),
] as const;

/** Builds calldata for an already reserved and signed record; does not sign or
 * authorize spending. Callers must validate the saved artifact/assessment first. */
export async function onchainMintCalldata(input: { domain: OpenMintDomainInput; authorization: OpenMintAuthorizationInput;
  artifact: OnchainArtifact; signature: Hex; authorizer: `0x${string}` }): Promise<Hex> {
  const a = normalizeOpenMintAuthorization(input.authorization), art = input.artifact;
  if (a.handleKey !== openMintHandleKey(art.canonicalHandle) || a.assessmentDigest !== art.assessmentDigest
    || a.artifactDigest !== art.digest || a.tokenURIHash !== art.tokenURIHash) throw new Error("On-chain authorization/artifact mismatch.");
  await requireCanonicalSignatureFrom(onchainMintDigest(input.domain, a), input.signature, input.authorizer);
  return encodeFunctionData({ abi: ONCHAIN_MINT_ABI, functionName: "mint",
    args: [art.canonicalHandle, a, art.artwork, input.signature] });
}
