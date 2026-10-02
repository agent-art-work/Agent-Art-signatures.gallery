import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, toFunctionSelector, toEventSelector, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PULSE_MINT_ABI, PULSE_PAID_SLOT, normalizePulseAuthorization, pulseMintCalldata, pulseMintTypedData, pulseUint, verifyPulseSignature } from "./pulseAuthorization.js";
import { generativeInputDigest } from "./generativeInputs.js";
import { openMintHandleKey } from "./authorization.js";
import { GENERATIVE_PROFILES } from "./generativeProfiles.js";
import { pulseFixturePin } from "./fixtures/pulse.js";
import { verifyPulseProof, validatePulseDeployment } from "./pulseEconomics.js";
import { chainHash, eligibilityFixture, fixturePinForProfile } from "./persistence/fixtures/eligibility.js";
import { readPublicChainEligibility } from "./publicChain.js";

const signer = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
const domain = { chainId: 31337n, verifyingContract: "0x1111111111111111111111111111111111111111" };
const inputs = { profile: GENERATIVE_PROFILES["generative-pulse-v1-rc1"].inputProfile, canonicalHandle: "alice", renderHandle: "Alice", mbti: "INTJ" as const,
  rendererIdentity: chainHash("22"), assessmentDigest: chainHash("11"), digest: generativeInputDigest("Alice", "INTJ", chainHash("22"), "sg-generative-pulse-inputs-v1-rc1") };
const free = { handleKey: openMintHandleKey("alice"), inputDigest: inputs.digest, assessmentDigest: inputs.assessmentDigest,
  recipient: wallet.address, nonce: chainHash("33"), issuedAt: "100", deadline: "200", mintMode: 0 as const, slotId: "0", maxPrice: "0" };
describe("Pulse C6 wire and read bindings", () => {
  it("binds every adapter function and event to the frozen C5 ABI", () => {
    const full = JSON.parse(readFileSync(new URL("../../contracts/releases/generative-pulse-v1-rc1.abi.json", import.meta.url), "utf8")) as Abi;
    const fields = (a: unknown) => JSON.parse(JSON.stringify(a, (k,v) => k === "internalType" ? undefined : v));
    for (const entry of PULSE_MINT_ABI) {
      const locked = full.find(v => (v.type === "function" || v.type === "event") && v.type === entry.type && v.name === entry.name);
      expect(locked, entry.name).toBeDefined();
      if (entry.type === "function") {
        expect(toFunctionSelector(entry)).toBe(toFunctionSelector(locked as typeof entry));
        expect(entry.stateMutability).toBe((locked as typeof entry).stateMutability);
        expect(fields(entry.inputs)).toEqual(fields((locked as typeof entry).inputs));
        expect(fields(entry.outputs).map((v: Record<string, unknown>) => ({...v, name: ""}))).toEqual(fields((locked as typeof entry).outputs).map((v: Record<string, unknown>) => ({...v, name: ""})));
      } else expect(toEventSelector(entry)).toBe(toEventSelector(locked as typeof entry));
    }
  });
  it("signs all ten fields, not the historical seven", async () => {
    const data = pulseMintTypedData(domain, free), signature = await signer.signTypedData(data);
    await verifyPulseSignature(domain, free, signature, signer.address);
    const paid = { ...free, mintMode: 1 as const, slotId: PULSE_PAID_SLOT.toString(), maxPrice: "1000000000" };
    expect(hashTypedData(pulseMintTypedData(domain, paid))).not.toBe(hashTypedData(data));
    await expect(verifyPulseSignature(domain, paid, signature, signer.address)).rejects.toThrow();
    const decoded = decodeFunctionData({ abi: PULSE_MINT_ABI, data: pulseMintCalldata({ domain, authorization: free, inputs, signature, proof: [] }) });
    expect(decoded.functionName).toBe("mintFree");
    expect(decoded.args?.[2]).toEqual(normalizePulseAuthorization(free));
    expect(() => normalizePulseAuthorization({...paid, slotId: "0"})).toThrow();
    expect(() => normalizePulseAuthorization({...free, maxPrice: "1"})).toThrow();
    expect(() => pulseMintCalldata({ domain, authorization: paid, inputs, signature, proof: [chainHash("00")] })).toThrow();
  });
  it.each(["01", "-1", "1.0", "0x1", 1, (1n << 256n).toString()])("rejects noncanonical/out-of-range integers %s", value => {
    expect(() => pulseUint(value)).toThrow();
  });
  it("checks repeated-wallet leaves and immutable sale commitment", () => {
    const fixture = pulseFixturePin(domain.verifyingContract, inputs.rendererIdentity, [wallet.address, wallet.address, signer.address]);
    for (const slot of fixture.slots) verifyPulseProof(fixture.pin.root, slot.slotId, slot.wallet, slot.proof);
    expect(() => verifyPulseProof(fixture.pin.root, "0", signer.address, fixture.slots[0].proof)).toThrow();
    expect(validatePulseDeployment(fixture.pin, 31337n, domain.verifyingContract, inputs.rendererIdentity)).toEqual(fixture.pin);
    expect(() => validatePulseDeployment({...fixture.pin, freeDeadline: String(BigInt(fixture.pin.freeDeadline)+1n)}, 31337n, domain.verifyingContract, inputs.rendererIdentity)).toThrow();
  });
  it("observes immutable pins, price and slot state through two pinned sources", async () => {
    const gate = eligibilityFixture("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
    const renderer = fixturePinForProfile("generative-pulse-v1-rc1"), f = pulseFixturePin(gate.config.contract, renderer.identity, [wallet.address, wallet.address]);
    const witness = await gate.witness("alice", wallet.address, { contractProfile: "generative-pulse-v1-rc1", generativeRenderer: renderer, pulse: f.pin }, undefined, undefined, { slots: [{slotId:"1",claimed:true}] }, ["0","1"]);
    const evidence = readPublicChainEligibility(witness, {namespaceId:gate.config.namespaceId,deploymentId:gate.config.deploymentId,handle:"alice",recipient:wallet.address,now:Date.now()});
    expect(evidence.pulse?.slots).toEqual([{slotId:"0",claimed:false},{slotId:"1",claimed:true}]);
    expect(evidence.pulse?.price).toBe("0");
    expect(evidence.pulse?.state).toBeNull();
    expect(Object.keys(evidence.block).sort()).toEqual(["hash","number","timestamp"]);
  });
  it("reads the effective paid curve after deadline activation", async () => {
    const gate = eligibilityFixture("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
    const renderer = fixturePinForProfile("generative-pulse-v1-rc1"), f = pulseFixturePin(gate.config.contract, renderer.identity, [wallet.address]);
    const witness = await gate.witness("alice", wallet.address, { contractProfile: "generative-pulse-v1-rc1", generativeRenderer: renderer, pulse: f.pin }, undefined, undefined, {phase:1,price:"1500000000"});
    const e = readPublicChainEligibility(witness, {namespaceId:gate.config.namespaceId,deploymentId:gate.config.deploymentId,handle:"alice",recipient:wallet.address,now:Date.now()});
    expect(e.pulse?.price).toBe("1500000000");
    expect(e.pulse?.state?.epochIndex).toBe("1");
  });
});
