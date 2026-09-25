import { encodeFunctionData, getAddress, hashTypedData, parseAbi, type Address, type Hex } from "viem";
import { exactObject } from "./assessment.js";
import { openMintDomain, openMintHandleKey, type OpenMintDomainInput } from "./authorization.js";
import { GENERATIVE_INPUT_PROFILE, generativeCommitment, validateGenerativeInputs, type GenerativeInputs } from "./generativeInputs.js";
import { GENERATIVE_PROFILES, profileForInputs, type GenerativeInputProfile } from "./generativeProfiles.js";
import { requireCanonicalSignatureFrom } from "../v2/core/ethereumSignature.js";

export const GENERATIVE_DOMAIN_NAME = GENERATIVE_PROFILES["generative-experimental-v1"].domainName;
export const GENERATIVE_MINT_TYPES = { GenerativeMintAuthorization: [
  { name: "handleKey", type: "bytes32" }, { name: "assessmentDigest", type: "bytes32" }, { name: "inputDigest", type: "bytes32" },
  { name: "recipient", type: "address" }, { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" }, { name: "deadline", type: "uint64" },
] } as const;
export interface GenerativeAuthorizationInput {
  handleKey: Hex; assessmentDigest: Hex; inputDigest: Hex; recipient: string; nonce: Hex;
  issuedAt: bigint | string | number; deadline: bigint | string | number;
}
function timestamp(value: bigint | string | number): bigint {
  if ((typeof value !== "bigint" && typeof value !== "string" && typeof value !== "number")
    || (typeof value === "number" && !Number.isSafeInteger(value)) || (typeof value === "string" && !/^[1-9][0-9]*$/.test(value))) throw new Error("Invalid authorization timestamp.");
  const n = BigInt(value);
  if (n <= 0n || n >= 1n << 64n) throw new Error("Invalid authorization timestamp.");
  return n;
}
export function normalizeGenerativeAuthorization(value: GenerativeAuthorizationInput) {
  exactObject(value, ["handleKey", "assessmentDigest", "inputDigest", "recipient", "nonce", "issuedAt", "deadline"], "generative authorization");
  const issuedAt = timestamp(value.issuedAt), deadline = timestamp(value.deadline), recipient = getAddress(value.recipient);
  if (/^0x0{40}$/i.test(recipient) || deadline <= issuedAt || deadline - issuedAt > 900n) throw new Error("Invalid authorization recipient or lifetime.");
  return { handleKey: generativeCommitment(value.handleKey), assessmentDigest: generativeCommitment(value.assessmentDigest),
    inputDigest: generativeCommitment(value.inputDigest), recipient, nonce: generativeCommitment(value.nonce), issuedAt, deadline };
}
export function generativeMintTypedData(input: OpenMintDomainInput, authorization: GenerativeAuthorizationInput, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE) {
  const domain = { ...openMintDomain(input), name: profileForInputs(profile).domainName };
  if (domain.chainId !== 31337n) throw new Error("Generative issuance remains local Anvil only; public admission is not implemented.");
  return { domain, types: GENERATIVE_MINT_TYPES, primaryType: "GenerativeMintAuthorization" as const, message: normalizeGenerativeAuthorization(authorization) };
}
export function generativeMintDigest(domain: OpenMintDomainInput, authorization: GenerativeAuthorizationInput, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE): Hex {
  return hashTypedData(generativeMintTypedData(domain, authorization, profile));
}
/** Pure encoding for the separate reviewed staging composition; no authority,
 * key access or activation. Historical helpers remain Anvil-only. */
export function stagingGenerativeMintTypedData(input: OpenMintDomainInput, authorization: GenerativeAuthorizationInput, profile: GenerativeInputProfile) {
  const domain = { ...openMintDomain(input), name: profileForInputs(profile).domainName };
  if (domain.chainId !== 11155111n || profile !== "sg-generative-inputs-v1-rc1") throw new Error("Exact Sepolia RC1 signing profile required.");
  return { domain, types: GENERATIVE_MINT_TYPES, primaryType: "GenerativeMintAuthorization" as const, message: normalizeGenerativeAuthorization(authorization) };
}
export async function verifyGenerativeMintAuthorization(domain: OpenMintDomainInput, authorization: GenerativeAuthorizationInput, signature: string, authorizer: Address, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE): Promise<boolean> {
  try { await requireCanonicalSignatureFrom(generativeMintDigest(domain, authorization, profile), signature, authorizer); return true; }
  catch { return false; }
}
export const GENERATIVE_MINT_ABI = parseAbi([
  "struct GenerativeMintAuthorization { bytes32 handleKey; bytes32 assessmentDigest; bytes32 inputDigest; address recipient; bytes32 nonce; uint64 issuedAt; uint64 deadline; }",
  "function mint(string handle,string mbti,GenerativeMintAuthorization a,bytes signature) returns (uint256 tokenId)",
  "function authorizationDigest(GenerativeMintAuthorization a) view returns (bytes32)",
  "function inputDigest(string handle,string mbti) view returns (bytes32)",
  "function renderer() view returns (address)", "function rendererIdentity() view returns (bytes32)",
  "function INPUT_PROFILE() view returns (string)", "function inputs(uint256 tokenId) view returns (string handle,string mbti)",
  "function tokenURI(uint256 tokenId) view returns (string)", "function svg(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function provenance(uint256 tokenId) view returns (bytes32 assessmentDigest,bytes32 authorizationDigest,address mintRecipient)",
  "event GenerativeSignatureMinted(bytes32 indexed handleKey,bytes32 indexed nonce,address indexed recipient,uint256 tokenId,string renderHandle,string mbti,bytes32 assessmentDigest,bytes32 inputDigest,bytes32 authorizationDigest)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
/** Calldata is released only after durable issuance; this helper neither signs nor spends. */
export async function generativeMintCalldata(input: { domain: OpenMintDomainInput; authorization: GenerativeAuthorizationInput;
  inputs: GenerativeInputs; signature: Hex; authorizer: Address }): Promise<Hex> {
  const a = normalizeGenerativeAuthorization(input.authorization), art = validateGenerativeInputs(input.inputs);
  if (a.handleKey !== openMintHandleKey(art.canonicalHandle) || a.assessmentDigest !== art.assessmentDigest || a.inputDigest !== art.digest) throw new Error("Generative authorization/input mismatch.");
  await requireCanonicalSignatureFrom(generativeMintDigest(input.domain, a, art.profile), input.signature, input.authorizer);
  return encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: [art.renderHandle, art.mbti, a, input.signature] });
}
