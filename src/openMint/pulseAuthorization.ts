import { encodeFunctionData, getAddress, hashTypedData, parseAbi, type Hex } from "viem";
import { exactObject } from "./assessment.js";
import { openMintDomain, openMintHandleKey, type OpenMintDomainInput } from "./authorization.js";
import { normalizeGenerativeAuthorization, type GenerativeAuthorizationInput } from "./generativeAuthorization.js";
import { validateGenerativeInputs, type GenerativeInputs } from "./generativeInputs.js";
import { requireCanonicalSignatureFrom } from "../v2/core/ethereumSignature.js";
import { PULSE_AUTHORIZATION_TYPES, PULSE_MINT_CANDIDATE } from "./pulseCandidate.js";

export const PULSE_PAID_SLOT = (1n << 256n) - 1n;
export function pulseUint(value: unknown, bits = 256): bigint {
  if (typeof value !== "bigint" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error("Invalid Pulse integer.");
  const n = BigInt(value as string | bigint);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error("Pulse integer out of range.");
  return n;
}
export interface PulseAuthorizationInput extends GenerativeAuthorizationInput {
  mintMode: 0 | 1; slotId: string | bigint; maxPrice: string | bigint;
}
export function normalizePulseAuthorization(value: PulseAuthorizationInput) {
  exactObject(value, ["handleKey", "assessmentDigest", "inputDigest", "recipient", "nonce", "issuedAt", "deadline", "mintMode", "slotId", "maxPrice"], "Pulse authorization");
  const { mintMode, slotId, maxPrice, ...base } = value;
  const slot = pulseUint(slotId), cap = pulseUint(maxPrice);
  if ((mintMode !== 0 && mintMode !== 1) || (mintMode === 0 ? slot === PULSE_PAID_SLOT || cap !== 0n : slot !== PULSE_PAID_SLOT)) throw new Error("Pulse mode/slot/ceiling mismatch.");
  return { ...normalizeGenerativeAuthorization(base), mintMode, slotId: slot, maxPrice: cap };
}
export function pulseMintTypedData(input: OpenMintDomainInput, a: PulseAuthorizationInput) {
  const domain = { ...openMintDomain(input), name: PULSE_MINT_CANDIDATE.domainName };
  if (domain.chainId !== 31337n && domain.chainId !== 11155111n) throw new Error("Unsupported Pulse chain.");
  return { domain, types: PULSE_AUTHORIZATION_TYPES, primaryType: "PulseMintAuthorization" as const, message: normalizePulseAuthorization(a) };
}
export const pulseMintDigest = (domain: OpenMintDomainInput, a: PulseAuthorizationInput) => hashTypedData(pulseMintTypedData(domain, a));

/** Reviewed ABI subset; tests bind every member to the complete C5 ABI. */
export const PULSE_MINT_ABI = parseAbi([
  "struct PulseMintAuthorization { bytes32 handleKey; bytes32 assessmentDigest; bytes32 inputDigest; address recipient; bytes32 nonce; uint64 issuedAt; uint64 deadline; uint8 mintMode; uint256 slotId; uint256 maxPrice; }",
  "struct Config { uint256 k; uint256 genesisPrice; uint256 genesisFloor; uint256 pts; }",
  "struct State { uint64 epochIndex; uint64 openTime; uint64 curveStartTime; uint64 anchorTime; uint256 floorPrice; }",
  "struct SaleStatus { uint8 phase; bool paused; uint256 freeMinted; uint256 freeSlotCount; uint64 freeDeadline; uint64 paidStartTime; uint8 endReason; uint64 lastPaidMintBlock; }",
  "function mintFree(string handle,string mbti,PulseMintAuthorization a,bytes signature,bytes32[] proof) returns (uint256 tokenId)",
  "function mintPaid(string handle,string mbti,PulseMintAuthorization a,bytes signature) payable returns (uint256 tokenId)",
  "function authorizationDigest(PulseMintAuthorization a) view returns (bytes32)",
  "function saleStatus() view returns (SaleStatus)", "function getPulseConfig() view returns (Config)",
  "function getPulseState() view returns (State)", "function getCurrentPrice() view returns (uint256)",
  "function pulseCore() view returns (address)", "function coreRuntimeCodeHash() view returns (bytes32)",
  "function boundChainId() view returns (uint256)", "function treasury() view returns (address)",
  "function freeMintRoot() view returns (bytes32)", "function freeSlotCount() view returns (uint256)",
  "function freeDeadline() view returns (uint64)", "function deployedAt() view returns (uint64)",
  "function saleConfigHash() view returns (bytes32)", "function isFreeSlotClaimed(uint256 slotId) view returns (bool)",
  "event MintEconomics(uint256 indexed tokenId,bytes32 indexed nonce,uint256 indexed slotId,uint8 mintMode,uint256 price,uint256 maxPrice,uint64 epochIndex)",
  "event Sale(address indexed buyer,uint64 indexed epochIndex,uint256 price,uint64 timestamp,uint64 nextAnchorA,uint256 nextFloorB)",
  "event PaidPhaseStarted(uint64 startTime,uint8 reason,uint256 freeMinted)",
]);

export function pulseMintCalldata(input: { domain: OpenMintDomainInput; authorization: PulseAuthorizationInput;
  inputs: GenerativeInputs; signature: Hex; proof: readonly Hex[] }) {
  const art = validateGenerativeInputs(input.inputs), a = normalizePulseAuthorization(input.authorization);
  if (art.profile !== PULSE_MINT_CANDIDATE.inputProfile || a.handleKey !== openMintHandleKey(art.canonicalHandle)
    || a.inputDigest !== art.digest || a.assessmentDigest !== art.assessmentDigest
    || input.proof.length > 64 || input.proof.some(p => !/^0x[0-9a-f]{64}$/.test(p))
    || (a.mintMode === 1 && input.proof.length)) throw new Error("Pulse authorization/input/proof mismatch.");
  return a.mintMode === 0
    ? encodeFunctionData({ abi: PULSE_MINT_ABI, functionName: "mintFree", args: [art.renderHandle, art.mbti, a, input.signature, [...input.proof]] })
    : encodeFunctionData({ abi: PULSE_MINT_ABI, functionName: "mintPaid", args: [art.renderHandle, art.mbti, a, input.signature] });
}
export async function verifyPulseSignature(domain: OpenMintDomainInput, a: PulseAuthorizationInput, signature: string, signer: string) {
  await requireCanonicalSignatureFrom(pulseMintDigest(domain, a), signature, getAddress(signer));
}
