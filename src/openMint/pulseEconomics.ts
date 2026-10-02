import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, type Hex } from "viem";
import { exactObject } from "./assessment.js";
import { generativeCommitment } from "./generativeInputs.js";
import { PULSE_MINT_ABI, pulseUint } from "./pulseAuthorization.js";
import { PULSE_MINT_CANDIDATE } from "./pulseCandidate.js";

export interface PulseDeploymentPin {
  readonly core: string; readonly coreRuntimeCodeHash: Hex; readonly treasury: string;
  readonly root: Hex; readonly slotCount: string; readonly freeDeadline: string; readonly deployedAt: string;
  readonly config: { readonly k: string; readonly genesisPrice: string; readonly genesisFloor: string; readonly pts: string };
  readonly saleConfigHash: Hex;
}
export interface PulseObservation {
  readonly deployment: PulseDeploymentPin;
  readonly phase: 0 | 1; readonly freeMinted: string; readonly paidStartTime: string;
  readonly endReason: number; readonly lastPaidMintBlock: string; readonly price: string;
  readonly state: { readonly epochIndex: string; readonly openTime: string; readonly curveStartTime: string; readonly anchorTime: string; readonly floorPrice: string } | null;
  readonly slots: readonly { readonly slotId: string; readonly claimed: boolean }[];
}
export function validatePulseDeployment(pin: PulseDeploymentPin, chainId: bigint, contract: string, rendererIdentity: Hex): PulseDeploymentPin {
  exactObject(pin, ["core", "coreRuntimeCodeHash", "treasury", "root", "slotCount", "freeDeadline", "deployedAt", "config", "saleConfigHash"], "Pulse deployment");
  exactObject(pin.config, ["k", "genesisPrice", "genesisFloor", "pts"], "Pulse config");
  if ((chainId !== 31337n && chainId !== 11155111n) || pin.coreRuntimeCodeHash !== PULSE_MINT_CANDIDATE.pulseRuntimeCodeHash
    || pulseUint(pin.slotCount) === 0n || pulseUint(pin.freeDeadline, 64) <= pulseUint(pin.deployedAt, 64)) throw new Error("Invalid Pulse deployment.");
  const core = getAddress(pin.core), treasury = getAddress(pin.treasury);
  if (/^0x0{40}$/i.test(core) || /^0x0{40}$/i.test(treasury) || treasury === getAddress(contract)
    || (chainId === 11155111n && core !== getAddress("0xfb1Cc26356b1b0361c414Ec1B5fB52c5FEDc3EAC"))) throw new Error("Invalid Pulse binding.");
  generativeCommitment(pin.root);
  const config = [pin.config.k, pin.config.genesisPrice, pin.config.genesisFloor, pin.config.pts].map(v => pulseUint(v));
  const computed = keccak256(encodeAbiParameters([
    { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], ["signatures.gallery/pulse-sale/v1-rc1", chainId, getAddress(contract), core, pin.coreRuntimeCodeHash, rendererIdentity,
    treasury, pin.root, BigInt(pin.slotCount), BigInt(pin.freeDeadline), config[0], config[1], config[2], config[3]]));
  if (pin.saleConfigHash !== computed) throw new Error("Pulse sale configuration commitment mismatch.");
  return Object.freeze({ ...pin, core, treasury, config: Object.freeze({ k: pin.config.k, genesisPrice: pin.config.genesisPrice, genesisFloor: pin.config.genesisFloor, pts: pin.config.pts }) });
}
export function pulseSlotLeaf(slot: string, wallet: string): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [pulseUint(slot), getAddress(wallet)])));
}
export function verifyPulseProof(root: Hex, slot: string, wallet: string, proof: readonly Hex[]) {
  if (!Array.isArray(proof) || proof.length > 64) throw new Error("Invalid Pulse proof.");
  let current = pulseSlotLeaf(slot, wallet);
  for (const sibling of proof) {
    if (!/^0x[0-9a-f]{64}$/.test(sibling)) throw new Error("Invalid Pulse proof.");
    current = keccak256(current < sibling ? `${current}${sibling.slice(2)}` as Hex : `${sibling}${current.slice(2)}` as Hex);
  }
  if (current !== root) throw new Error("Pulse proof does not match the frozen root.");
}
function pulseReader(read: (data: Hex) => Promise<Hex>) {
  return async (name: string, args: readonly unknown[] = []) => {
    const data = encodeFunctionData({ abi: PULSE_MINT_ABI, functionName: name, args } as Parameters<typeof encodeFunctionData>[0]);
    return decodeFunctionResult({ abi: PULSE_MINT_ABI, functionName: name, data: await read(data) } as Parameters<typeof decodeFunctionResult>[0]);
  };
}
/** Identity checks are independent of pause/price. Minted art remains readable
 * while the sale is paused or a future quote is not representable. */
export async function verifyPulseImmutables(pin: PulseDeploymentPin, chainId: bigint, read: (data: Hex) => Promise<Hex>, coreCode: () => Promise<Hex>) {
  const call = pulseReader(read);
  const names = ["pulseCore", "coreRuntimeCodeHash", "treasury", "freeMintRoot", "freeSlotCount", "freeDeadline", "deployedAt", "saleConfigHash", "getPulseConfig", "boundChainId"];
  const values = await Promise.all(names.map(n => call(n)));
  const wire = (v: unknown): string => JSON.stringify(v, (_k, n) => typeof n === "bigint" ? n.toString() : n);
  const expected = [pin.core, pin.coreRuntimeCodeHash, pin.treasury, pin.root, BigInt(pin.slotCount), BigInt(pin.freeDeadline), BigInt(pin.deployedAt), pin.saleConfigHash,
    { k: BigInt(pin.config.k), genesisPrice: BigInt(pin.config.genesisPrice), genesisFloor: BigInt(pin.config.genesisFloor), pts: BigInt(pin.config.pts) }, chainId];
  if (expected.some((v, i) => wire(v) !== wire(values[i])) || keccak256(await coreCode()) !== pin.coreRuntimeCodeHash) throw new Error("Pulse immutable deployment mismatch.");
}
/** Called only inside the configured two-source block-pinned observation. */
export async function observePulse(pin: PulseDeploymentPin, slotIds: readonly string[], read: (data: Hex) => Promise<Hex>, coreCode: () => Promise<Hex>, chainId: bigint): Promise<PulseObservation> {
  await verifyPulseImmutables(pin, chainId, read, coreCode);
  const call = pulseReader(read);
  const status = await call("saleStatus") as { phase: number; paused: boolean; freeMinted: bigint; freeSlotCount: bigint; freeDeadline: bigint; paidStartTime: bigint; endReason: number; lastPaidMintBlock: bigint };
  if (status.paused || (status.phase !== 0 && status.phase !== 1) || status.freeSlotCount !== BigInt(pin.slotCount)
    || status.freeDeadline !== BigInt(pin.freeDeadline) || status.freeMinted > status.freeSlotCount) throw new Error("Pulse sale is unavailable.");
  if (slotIds.length > 2048 || new Set(slotIds).size !== slotIds.length) throw new Error("Invalid Pulse slot read.");
  const slots = await Promise.all(slotIds.map(async slotId => {
    if (pulseUint(slotId) >= BigInt(pin.slotCount)) throw new Error("Pulse slot out of range.");
    const claimed = await call("isFreeSlotClaimed", [BigInt(slotId)]);
    if (typeof claimed !== "boolean") throw new Error("Invalid slot state.");
    return Object.freeze({ slotId, claimed });
  }));
  // Before activation these paid views intentionally revert. A free sale has
  // no paid curve, rather than a fabricated genesis state or a paid quote.
  const values = status.phase === 1 ? await Promise.all([call("getCurrentPrice"), call("getPulseState")]) : [0n, null];
  const state = values[1] as Record<string, bigint> | null;
  return Object.freeze({ deployment: pin, phase: status.phase, freeMinted: String(status.freeMinted), paidStartTime: String(status.paidStartTime),
    endReason: status.endReason, lastPaidMintBlock: String(status.lastPaidMintBlock), price: String(values[0]),
    state: state === null ? null : Object.freeze(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, String(v)])) as unknown as PulseObservation["state"]), slots: Object.freeze(slots) });
}
