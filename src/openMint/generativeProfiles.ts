/** Explicit wire identities. Defaults elsewhere preserve historical experimental
 * bytes; candidate selection must come from a durable deployment, never a GET. */
export const GENERATIVE_PROFILES = Object.freeze({
  "generative-experimental-v1": Object.freeze({
    contractProfile: "generative-experimental-v1", inputProfile: "sg-generative-inputs-experimental-1",
    rendererVersion: "experimental-fixed18-not-locked", domainName: "SignaturesGenerativeMintExperimental",
    reservationVersion: "sg-generative-authorization-experimental-1",
    description: "Experimental local generative signature. Not a production token.",
  } as const),
  "generative-v1-rc1": Object.freeze({
    contractProfile: "generative-v1-rc1", inputProfile: "sg-generative-inputs-v1-rc1",
    rendererVersion: "sg-evm-renderer-1.0.0-rc.1", domainName: "SignaturesGenerativeMintRC1",
    reservationVersion: "sg-generative-authorization-v1-rc1",
    description: "Release-candidate generative signature for an X handle. MBTI is an artistic input, not a psychological diagnosis.",
  } as const),
});
export type GenerativeContractProfile = keyof typeof GENERATIVE_PROFILES;
export type GenerativeProfile = typeof GENERATIVE_PROFILES[GenerativeContractProfile];
export type GenerativeInputProfile = GenerativeProfile["inputProfile"];
export type GenerativeReservationVersion = GenerativeProfile["reservationVersion"];
export function isGenerativeProfile(value: unknown): value is GenerativeContractProfile {
  return value === "generative-experimental-v1" || value === "generative-v1-rc1";
}
export function generativeProfile(value: unknown): GenerativeProfile {
  if (!isGenerativeProfile(value)) throw new Error("Unknown generative contract profile.");
  return GENERATIVE_PROFILES[value];
}
export function profileForInputs(value: unknown): GenerativeProfile {
  const found = Object.values(GENERATIVE_PROFILES).find(p => p.inputProfile === value);
  if (!found) throw new Error("Unknown generative input profile.");
  return found;
}
export function profileForReservation(value: unknown): GenerativeProfile {
  const found = Object.values(GENERATIVE_PROFILES).find(p => p.reservationVersion === value);
  if (!found) throw new Error("Unknown generative reservation version.");
  return found;
}
