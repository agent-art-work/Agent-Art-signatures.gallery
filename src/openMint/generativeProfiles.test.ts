import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GENERATIVE_PROFILES, generativeProfile, isGenerativeProfile, profileForInputs, profileForReservation } from "./generativeProfiles.js";
import { generativeInputDigest, generativeRendererIdentity, prepareGenerativeInputs, profileForRenderer, validateGenerativeInputs,
  validateGenerativeRendererPin, verifyGenerativeInputs } from "./generativeInputs.js";
import { generativeMintTypedData, generativeMintCalldata, verifyGenerativeMintAuthorization } from "./generativeAuthorization.js";
import { openMintHandleKey } from "./authorization.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { eligibilityFixture, fixturePinForProfile } from "./persistence/fixtures/eligibility.js";
import { PublicChainGate } from "./publicChain.js";
import { GenerativeWalletChain } from "./walletChain.js";
import { GenerativeRecoveryChain } from "./generativeRecoveryChain.js";

const profiles = Object.values(GENERATIVE_PROFILES);
const hash = (s: string) => keccak256(stringToHex(s));
const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const domain = { chainId: 31337, verifyingContract: "0x1111111111111111111111111111111111111111" };
describe("explicit generative profile registry", () => {
  it("matches the reviewed candidate lock; upstream artwork versions remain separate", () => {
    const lock = JSON.parse(readFileSync(new URL("../../contracts/releases/generative-v1-rc1.json", import.meta.url), "utf8"));
    const p = GENERATIVE_PROFILES["generative-v1-rc1"];
    expect(p.inputProfile).toBe(lock.inputProfile); expect(p.rendererVersion).toBe(lock.renderer); expect(p.domainName).toBe(lock.domainName);
    expect(lock.oracle.rendererVersion).toBe("sg-renderer-2.0.0");
    expect(Object.isFrozen(GENERATIVE_PROFILES)).toBe(true);
  });
  it.each([undefined, null, "", "__proto__", "constructor", "generative-v2", "sg-renderer-2.0.1", {}])("rejects unknown identity %j", value => {
    expect(isGenerativeProfile(value)).toBe(false);
    expect(() => generativeProfile(value)).toThrow(); expect(() => profileForInputs(value)).toThrow(); expect(() => profileForReservation(value)).toThrow();
    if (value !== undefined) expect(() => generativeInputDigest("Alice", "INTJ", hash("id"), value as never)).toThrow();
  });
  // Undefined is the historical default at low-level encoding boundaries only.
  it("preserves historical experimental default bytes", () => {
    const pin = fixturePinForProfile("generative-experimental-v1"), p = profiles[0];
    expect(generativeRendererIdentity(pin.address, pin.runtimeCodeHash)).toBe(pin.identity);
    expect(prepareGenerativeInputs(syntheticPublicAssessment(), pin.identity)).toEqual(prepareGenerativeInputs(syntheticPublicAssessment(), pin.identity, p.inputProfile));
    expect(pin).not.toHaveProperty("inputProfile");
  });
});
describe.each(profiles)("$contractProfile isolation", p => {
  const other = profiles.find(v => v !== p)!, pin = fixturePinForProfile(p.contractProfile);
  const assessment = syntheticPublicAssessment(), snapshot = JSON.stringify(assessment);
  const inputs = prepareGenerativeInputs(assessment, pin.identity, p.inputProfile);
  const a = { handleKey: openMintHandleKey(inputs.canonicalHandle), assessmentDigest: inputs.assessmentDigest, inputDigest: inputs.digest,
    recipient: signer.address, nonce: hash("profile-nonce"), issuedAt: 1800000000n, deadline: 1800000900n };
  it("freezes input, reservation and presentation identities without changing accepted assessment", () => {
    expect(profileForInputs(p.inputProfile)).toBe(p); expect(profileForReservation(p.reservationVersion)).toBe(p);
    expect(profileForRenderer(pin)).toBe(p); expect(Object.isFrozen(p)).toBe(true);
    expect(validateGenerativeRendererPin(pin)).toEqual(pin);
    expect(inputs.profile).toBe(p.inputProfile); expect(validateGenerativeInputs(inputs)).toEqual(inputs);
    expect(() => verifyGenerativeInputs(inputs, assessment, pin.identity, p.inputProfile)).not.toThrow();
    expect(JSON.stringify(assessment)).toBe(snapshot);
    expect(() => verifyGenerativeInputs(inputs, assessment, pin.identity, other.inputProfile)).toThrow();
    expect(() => validateGenerativeInputs({ ...inputs, profile: other.inputProfile })).toThrow();
    expect(() => validateGenerativeRendererPin({ ...pin, inputProfile: other.inputProfile })).toThrow();
    expect(() => validateGenerativeRendererPin({ ...pin, inputProfile: null } as never)).toThrow();
    expect(generativeRendererIdentity(pin.address, pin.runtimeCodeHash, other.inputProfile)).not.toBe(pin.identity);
  });
  it("separates EIP-712 signatures and never admits mixed-profile calldata", async () => {
    const typed = generativeMintTypedData(domain, a, p.inputProfile), signature = await signer.signTypedData(typed);
    expect(typed.domain.name).toBe(p.domainName);
    expect(await verifyGenerativeMintAuthorization(domain, a, signature, signer.address, p.inputProfile)).toBe(true);
    expect(await verifyGenerativeMintAuthorization(domain, a, signature, signer.address, other.inputProfile)).toBe(false);
    await expect(generativeMintCalldata({ domain, authorization: a, inputs, signature, authorizer: signer.address })).resolves.toMatch(/^0x/);
    const forgedInputs = prepareGenerativeInputs(assessment, pin.identity, other.inputProfile), forgedAuth = { ...a, inputDigest: forgedInputs.digest };
    await expect(generativeMintCalldata({ domain, authorization: forgedAuth, inputs: forgedInputs, signature, authorizer: signer.address })).rejects.toThrow();
    const wrongDomain = await signer.signTypedData(generativeMintTypedData(domain, a, other.inputProfile));
    await expect(generativeMintCalldata({ domain, authorization: a, inputs, signature: wrongDomain, authorizer: signer.address })).rejects.toThrow();
  });
  it("requires profile/pin agreement in chain, wallet and recovery gates", () => {
    const f = eligibilityFixture("ns", "deployment"), config = { ...f.config, contractProfile: p.contractProfile, generativeRenderer: pin };
    const sources = f.sources(config);
    for (const Gate of [PublicChainGate, GenerativeWalletChain, GenerativeRecoveryChain]) {
      expect(() => new Gate(config, sources)).not.toThrow();
      expect(() => new Gate({ ...config, contractProfile: other.contractProfile }, sources)).toThrow();
      expect(() => new Gate({ ...config, generativeRenderer: undefined }, sources)).toThrow();
      expect(() => new Gate({ ...config, chainId: 11155111n }, sources)).toThrow();
    }
    expect(() => generativeMintTypedData({ ...domain, chainId: 11155111 }, a, p.inputProfile)).toThrow("local Anvil");
  });
});
