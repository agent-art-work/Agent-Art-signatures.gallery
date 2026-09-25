import { encodeAbiParameters, getAddress, keccak256, type Hex } from "viem";
import { exactObject, validateAssessment, type Assessment } from "./assessment.js";
import { canonicalHandle, preservedHandle, isMbti, RENDERER_VERSION, type MBTI } from "./identity.js";
import { GENERATIVE_PROFILES, profileForInputs, type GenerativeInputProfile } from "./generativeProfiles.js";

/** Experimental EVM port, NOT an upgrade of the locked TS/Python renderer. */
export const GENERATIVE_INPUT_PROFILE = GENERATIVE_PROFILES["generative-experimental-v1"].inputProfile;
export const GENERATIVE_RENDERER_VERSION = GENERATIVE_PROFILES["generative-experimental-v1"].rendererVersion;
export interface GenerativeRendererPin { readonly address: string; readonly runtimeCodeHash: Hex; readonly identity: Hex;
  /** Absent only on historical experimental pins. Never infer from code/address. */
  readonly inputProfile?: GenerativeInputProfile }
export function profileForRenderer(pin: GenerativeRendererPin) { return profileForInputs(pin.inputProfile === undefined ? GENERATIVE_INPUT_PROFILE : pin.inputProfile); }
export interface GenerativeInputs {
  readonly profile: GenerativeInputProfile;
  readonly canonicalHandle: string;
  readonly renderHandle: string;
  readonly mbti: MBTI;
  readonly assessmentDigest: Hex;
  readonly rendererIdentity: Hex;
  readonly digest: Hex;
}
export function generativeCommitment(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new Error("Invalid generative commitment.");
  return value as Hex;
}
export function generativeRendererIdentity(address: string, runtimeCodeHash: Hex, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE): Hex {
  profileForInputs(profile);
  const parsed = getAddress(address);
  if (/^0x0{40}$/i.test(parsed)) throw new Error("Zero renderer address.");
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "bytes32" }],
    [profile, parsed, generativeCommitment(runtimeCodeHash)]));
}
export function validateGenerativeRendererPin(pin: GenerativeRendererPin): Readonly<GenerativeRendererPin> {
  exactObject(pin, ["address", "runtimeCodeHash", "identity", ...(pin.inputProfile === undefined ? [] : ["inputProfile"])], "renderer pin");
  const profile = profileForRenderer(pin);
  if (generativeCommitment(pin.identity) !== generativeRendererIdentity(pin.address, pin.runtimeCodeHash, profile.inputProfile)) throw new Error("Renderer pin identity mismatch.");
  return Object.freeze({ ...pin, address: getAddress(pin.address) });
}
/** Low-level encoding only; never evidence that a user-supplied MBTI came from Grok. */
export function generativeInputDigest(renderHandle: string, mbti: MBTI, rendererIdentity: Hex, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE): Hex {
  profileForInputs(profile);
  if (preservedHandle(renderHandle) !== renderHandle || !isMbti(mbti)) throw new Error("Invalid generative inputs.");
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "string" }, { type: "string" }],
    [profile, generativeCommitment(rendererIdentity), renderHandle, mbti]));
}
/** Backend only. The durable journal must also require the exact accepted row.
 * No SVG, output hash, Base64, URI, or renderer invocation is needed for signing. */
export function prepareGenerativeInputs(value: Assessment, rendererIdentity: Hex, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE): GenerativeInputs {
  profileForInputs(profile);
  const assessment = validateAssessment(value);
  if (assessment.provenance !== "grok" || assessment.rendererVersion !== RENDERER_VERSION || assessment.xIdentity?.provenance !== "x-api") {
    throw new Error("Generative inputs require an X-verified native Grok assessment.");
  }
  const renderHandle = assessment.xIdentity.username;
  return Object.freeze({ profile, canonicalHandle: canonicalHandle(renderHandle), renderHandle,
    mbti: assessment.mbti, assessmentDigest: assessment.digest, rendererIdentity: generativeCommitment(rendererIdentity),
    digest: generativeInputDigest(renderHandle, assessment.mbti, rendererIdentity, profile) });
}
export function validateGenerativeInputs(value: GenerativeInputs): GenerativeInputs {
  exactObject(value, ["profile", "canonicalHandle", "renderHandle", "mbti", "assessmentDigest", "rendererIdentity", "digest"], "generative inputs");
  profileForInputs(value.profile);
  if (canonicalHandle(value.renderHandle) !== value.canonicalHandle
    || value.digest !== generativeInputDigest(value.renderHandle, value.mbti, value.rendererIdentity, value.profile)) throw new Error("Generative input binding mismatch.");
  generativeCommitment(value.assessmentDigest);
  return Object.freeze({ ...value });
}
export function verifyGenerativeInputs(value: GenerativeInputs, assessment: Assessment, rendererIdentity: Hex, profile: GenerativeInputProfile = GENERATIVE_INPUT_PROFILE): void {
  validateGenerativeInputs(value);
  const expected = prepareGenerativeInputs(assessment, rendererIdentity, profile);
  if (Object.keys(expected).some(key => value[key as keyof GenerativeInputs] !== expected[key as keyof GenerativeInputs])) {
    throw new Error("Generative inputs do not match the frozen assessment.");
  }
}
