import { readFileSync } from "node:fs";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, getAddress, keccak256, type Hex } from "viem";
import { PULSE_MINT_CANDIDATE } from "../pulseCandidate.js";
import type { PulseDeploymentPin } from "../pulseEconomics.js";

/** Offline test artifacts only. No real allowlist, credentials or network. */
export const pulseFixtureCoreCode = readFileSync(new URL("../../../contracts/vendor/pulse-core-v1.0.0/PulseCoreV1.runtime.hex", import.meta.url), "utf8").trim() as Hex;
export function pulseFixturePin(contract: string, rendererIdentity: Hex, wallets: readonly string[], now = Math.floor(Date.now() / 1000)) {
  const tree = StandardMerkleTree.of(wallets.map((wallet, i) => [String(i), getAddress(wallet)]), ["uint256", "address"]);
  const pin: PulseDeploymentPin = {
    core: getAddress("0x5555555555555555555555555555555555555555"), coreRuntimeCodeHash: PULSE_MINT_CANDIDATE.pulseRuntimeCodeHash,
    treasury: getAddress("0x6666666666666666666666666666666666666666"), root: tree.root as Hex,
    slotCount: String(wallets.length), freeDeadline: String(now + 3600), deployedAt: String(now),
    config: { k: "2", genesisPrice: "1000000000", genesisFloor: "500000000", pts: "60" }, saleConfigHash: "0x" as Hex,
  };
  const saleConfigHash = keccak256(encodeAbiParameters([
    { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], ["signatures.gallery/pulse-sale/v1-rc1", 31337n, getAddress(contract), getAddress(pin.core), pin.coreRuntimeCodeHash, rendererIdentity,
    getAddress(pin.treasury), pin.root, BigInt(pin.slotCount), BigInt(pin.freeDeadline), 2n, 1000000000n, 500000000n, 60n]));
  return { pin: { ...pin, saleConfigHash }, slots: wallets.map((wallet, i) => ({ slotId: String(i), wallet: getAddress(wallet), proof: tree.getProof(i) as Hex[] })) };
}
