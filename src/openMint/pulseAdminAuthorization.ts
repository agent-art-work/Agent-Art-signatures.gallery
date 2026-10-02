import { hashTypedData } from "viem";
import { openMintDomain, type OpenMintDomainInput } from "./authorization.js";
import { normalizePulseAuthorization, pulseUint, type PulseAuthorizationInput } from "./pulseAuthorization.js";
import { PULSE_AUTHORIZATION_TYPES } from "./pulseCandidate.js";
import { exactObject } from "./assessment.js";

/** RC2 is a separate signing domain and wire format. Never infer it from calldata. */
export const PULSE_ADMIN_PROFILE = "generative-pulse-v1-rc2" as const;
export const PULSE_ADMIN_AUTHORIZATION_TYPES = Object.freeze({
  PulseMintAuthorization: Object.freeze([...PULSE_AUTHORIZATION_TYPES.PulseMintAuthorization,
    Object.freeze({ name: "freeConfigRevision", type: "uint64" })]),
});
export interface PulseAdminAuthorizationInput extends PulseAuthorizationInput {
  freeConfigRevision: string | bigint;
}
export function normalizePulseAdminAuthorization(value: PulseAdminAuthorizationInput) {
  exactObject(value, ["handleKey", "assessmentDigest", "inputDigest", "recipient", "nonce", "issuedAt", "deadline",
    "mintMode", "slotId", "maxPrice", "freeConfigRevision"], "Pulse admin authorization");
  const { freeConfigRevision, ...base } = value;
  const authorization = normalizePulseAuthorization(base), revision = pulseUint(freeConfigRevision, 64);
  if (authorization.mintMode === 0 ? revision === 0n : revision !== 0n)
    throw new Error("Pulse free configuration revision mismatch.");
  return { ...authorization, freeConfigRevision: revision };
}
export function pulseAdminMintTypedData(input: OpenMintDomainInput, authorization: PulseAdminAuthorizationInput) {
  const domain = { ...openMintDomain(input), name: "SignaturesPulseMintRC2" };
  if (domain.chainId !== 31337n && domain.chainId !== 11155111n) throw new Error("Unsupported Pulse chain.");
  return { domain, types: PULSE_ADMIN_AUTHORIZATION_TYPES, primaryType: "PulseMintAuthorization" as const,
    message: normalizePulseAdminAuthorization(authorization) };
}
export const pulseAdminMintDigest = (domain: OpenMintDomainInput, authorization: PulseAdminAuthorizationInput) =>
  hashTypedData(pulseAdminMintTypedData(domain, authorization));
