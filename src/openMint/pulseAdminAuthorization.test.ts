import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openMintHandleKey } from "./authorization.js";
import { generativeInputDigest } from "./generativeInputs.js";
import { PULSE_PAID_SLOT, pulseMintTypedData } from "./pulseAuthorization.js";
import { normalizePulseAdminAuthorization, pulseAdminMintDigest, pulseAdminMintTypedData } from "./pulseAdminAuthorization.js";

const hash = keccak256(stringToHex("admin fixture")), wallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const domain = { chainId: 11155111n, verifyingContract: "0x1111111111111111111111111111111111111111" };
const free = { handleKey: openMintHandleKey("alice"), assessmentDigest: hash,
  inputDigest: generativeInputDigest("Alice", "INTJ", hash, "sg-generative-pulse-inputs-v1-rc1"),
  recipient: wallet.address, nonce: hash, issuedAt: "100", deadline: "200", mintMode: 0 as const,
  slotId: "0", maxPrice: "0", freeConfigRevision: "1" };

describe("RC2 revision-bound Pulse mint authorization", () => {
  it("binds all eleven fields to an independent domain and signature", async () => {
    const data = pulseAdminMintTypedData(domain, free);
    expect(data.domain.name).toBe("SignaturesPulseMintRC2");
    expect(data.types.PulseMintAuthorization).toHaveLength(11);
    expect(data.types.PulseMintAuthorization[10]).toEqual({ name: "freeConfigRevision", type: "uint64" });
    expect(data.message.freeConfigRevision).toBe(1n);
    expect(pulseAdminMintDigest(domain, free)).toBe(hashTypedData(data));
    const { freeConfigRevision: _revision, ...legacy } = free;
    expect(hashTypedData(pulseMintTypedData(domain, legacy))).not.toBe(hashTypedData(data));
    expect(pulseAdminMintDigest(domain, { ...free, freeConfigRevision: "2" })).not.toBe(hashTypedData(data));
    expect(await wallet.signTypedData(data)).not.toBe(await wallet.signTypedData(pulseMintTypedData(domain, legacy)));
  });
  it("uses positive current revisions only for free authorizations and zero only for paid", () => {
    expect(normalizePulseAdminAuthorization(free).freeConfigRevision).toBe(1n);
    const paid = { ...free, mintMode: 1 as const, slotId: PULSE_PAID_SLOT, maxPrice: "1", freeConfigRevision: "0" };
    expect(normalizePulseAdminAuthorization(paid).freeConfigRevision).toBe(0n);
    expect(() => normalizePulseAdminAuthorization({ ...free, freeConfigRevision: "0" })).toThrow();
    expect(() => normalizePulseAdminAuthorization({ ...paid, freeConfigRevision: "1" })).toThrow();
    expect(() => normalizePulseAdminAuthorization({ ...free, maxPrice: "1" })).toThrow();
    expect(() => normalizePulseAdminAuthorization({ ...paid, slotId: "0" })).toThrow();
  });
  it.each(["01", "-1", "0x1", "1.0", 1, 1n << 64n])("rejects noncanonical/out-of-range revisions %s", revision => {
    expect(() => normalizePulseAdminAuthorization({ ...free, freeConfigRevision: revision as string })).toThrow();
  });
  it("rejects missing/extra fields and unsupported chains instead of falling back to RC1", () => {
    const { freeConfigRevision: _revision, ...missing } = free;
    expect(() => normalizePulseAdminAuthorization(missing as typeof free)).toThrow();
    expect(() => normalizePulseAdminAuthorization({ ...free, trusted: true } as typeof free)).toThrow();
    expect(() => pulseAdminMintTypedData({ ...domain, chainId: 1n }, free)).toThrow();
  });
});
