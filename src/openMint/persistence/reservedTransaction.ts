import { encodeFunctionData, getAddress, type Hex } from "viem";
import { GENERATIVE_MINT_ABI, normalizeGenerativeAuthorization } from "../generativeAuthorization.js";
import { pulseMintCalldata, normalizePulseAuthorization, type PulseAuthorizationInput } from "../pulseAuthorization.js";
import type { AuthorizationReservation } from "./generativeAuthorizations.js";
import type { MBTI } from "../identity.js";

/** Exact wire transaction derived only from durable signed authority. */
export function reservedWalletTransaction(r: AuthorizationReservation, signature: Hex) {
  const pulse = r.version === "sg-generative-pulse-authorization-v1-rc1";
  const a = pulse ? normalizePulseAuthorization(r.authorization as PulseAuthorizationInput) : normalizeGenerativeAuthorization(r.authorization);
  const data = pulse ? pulseMintCalldata({ domain: r.domain, authorization: r.authorization as PulseAuthorizationInput,
    inputs: { profile: "sg-generative-pulse-inputs-v1-rc1", canonicalHandle: r.handle, renderHandle: r.renderHandle,
      mbti: r.mbti as MBTI, assessmentDigest: a.assessmentDigest, rendererIdentity: r.rendererIdentity, digest: a.inputDigest },
    signature, proof: r.proof! }) : encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: [r.renderHandle, r.mbti, a, signature] });
  return { from: getAddress(a.recipient), to: getAddress(r.domain.verifyingContract), chainId: `0x${BigInt(r.domain.chainId).toString(16)}`,
    value: pulse ? `0x${normalizePulseAuthorization(r.authorization as PulseAuthorizationInput).maxPrice.toString(16)}` : "0x0", data };
}
