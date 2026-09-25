import { type GenerativeInputProfile } from "../generativeProfiles.js";
import canonicalize from "canonicalize";
import { openMintHandleKey } from "../authorization.js";
import { isMbti, canonicalHandle, preservedHandle } from "../identity.js";
import { profileForRenderer, generativeInputDigest, validateGenerativeRendererPin, type GenerativeRendererPin } from "../generativeInputs.js";

export const MAX_BATCH_BLOCKS = 32;
export const MAX_BLOCK_EVENTS = 128;
export const MAX_BATCH_EVENTS = 512;
export const MAX_PAGE_SIZE = 50;
export interface ProjectionPolicy {
  readonly id: string;
  readonly rollbackBlocks: number;
  readonly snapshotRetentionBlocks: number;
}
export interface ProjectionDeployment {
  readonly id: string; readonly namespaceId: string; readonly chainId: string;
  readonly contractAddress: string; readonly manifestHash: string;
  readonly deploymentBlock: string; readonly deploymentBlockHash: string;
  readonly policy: ProjectionPolicy;
  readonly generativeRenderer?: GenerativeRendererPin;
}
interface EventPosition { readonly transactionHash: string; readonly transactionIndex: number; readonly logIndex: number; readonly tokenId: string }
/** These are already decoded and provenance-validated inputs, NOT raw RPC logs.
 * MBTI/evidenceReference are trusted enrichment, not OpenSignatureMinted fields. */
export interface ValidatedMint extends EventPosition {
  readonly kind: "OpenSignatureMinted"; readonly handle: string; readonly handleKey: string;
  readonly recipient: string; readonly assessmentDigest: string; readonly artifactDigest: string;
  readonly tokenURIHash: string; readonly nonce: string; readonly authorizationDigest: string;
  readonly mbti: string; readonly evidenceReference: string;
}
export interface ValidatedTransfer extends EventPosition { readonly kind: "Transfer"; readonly from: string; readonly to: string }
export interface ValidatedGenerativeMint extends EventPosition {
  readonly kind: "GenerativeSignatureMinted"; readonly handle: string; readonly renderHandle: string; readonly handleKey: string;
  readonly recipient: string; readonly assessmentDigest: string; readonly inputDigest: string; readonly rendererIdentity: string;
  readonly nonce: string; readonly authorizationDigest: string; readonly mbti: string; readonly evidenceReference: string;
}
export type AnyValidatedMint = ValidatedMint | ValidatedGenerativeMint;
export type ValidatedEvent = AnyValidatedMint | ValidatedTransfer;
export interface ValidatedBlock { readonly number: string; readonly hash: string; readonly parentHash: string; readonly events: readonly ValidatedEvent[] }
export interface ValidatedBatch { readonly chainId: string; readonly contractAddress: string; readonly manifestHash: string; readonly blocks: readonly ValidatedBlock[] }
export type GalleryFilter = { readonly kind: "home" } | { readonly kind: "mbti" | "owner"; readonly value: string };
export interface Position { readonly block: string; readonly transaction: number; readonly log: number; readonly token: string }
export interface ProjectionCursor {
  readonly version: 1; readonly deployment: string; readonly filter: GalleryFilter; readonly limit: number;
  readonly snapshot: { readonly number: string; readonly hash: string }; readonly last: Position;
}
export class ProjectionConflictError extends Error {}
export class ProjectionSafetyHaltError extends ProjectionConflictError {}
export class ProjectionCursorError extends Error {}
export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const stable = (value: unknown): string => canonicalize(value)!;
export function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("Invalid projection fields.");
}
export function quantity(value: unknown, bits = 256, nonzero = false): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** BigInt(bits) || (nonzero && value === "0")) throw new Error("Invalid projection quantity.");
}
export function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0+$/.test(value)) throw new Error("Invalid projection hash.");
}
export function address(value: unknown, zero = false): asserts value is string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value) || (!zero && value === ZERO_ADDRESS)) throw new Error("Invalid projection address.");
}
export function reference(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("Invalid projection reference.");
}
function uuid(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid deployment identifier.");
}
function index(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) throw new Error("Invalid event position.");
}
export function validateDeployment(value: ProjectionDeployment): ProjectionDeployment {
  fields(value, ["id", "namespaceId", "chainId", "contractAddress", "manifestHash", "deploymentBlock", "deploymentBlockHash", "policy", ...(value.generativeRenderer ? ["generativeRenderer"] : [])]);
  if (value.generativeRenderer) {
    validateGenerativeRendererPin(value.generativeRenderer);
    // Structural support is not observation authority. Sepolia witnesses can
    // only be issued by the separate, explicitly selected RC1 observer.
    if (value.chainId !== "31337" && !(value.chainId === "11155111"
      && profileForRenderer(value.generativeRenderer).contractProfile === "generative-v1-rc1")) throw new Error("Unsupported generative projection chain.");
  }
  uuid(value.id); uuid(value.namespaceId); quantity(value.chainId, 256, true); address(value.contractAddress); hash(value.manifestHash);
  quantity(value.deploymentBlock, 63); hash(value.deploymentBlockHash);
  fields(value.policy, ["id", "rollbackBlocks", "snapshotRetentionBlocks"]); reference(value.policy.id);
  if (!Number.isSafeInteger(value.policy.rollbackBlocks) || value.policy.rollbackBlocks < 1 || value.policy.rollbackBlocks > 128
    || !Number.isSafeInteger(value.policy.snapshotRetentionBlocks) || value.policy.snapshotRetentionBlocks < 1 || value.policy.snapshotRetentionBlocks > 100_000) throw new Error("Invalid explicit projection policy.");
  return structuredClone(value);
}
export function validateEvent(value: ValidatedEvent, profile?: GenerativeInputProfile): void {
  const common = ["kind", "transactionHash", "transactionIndex", "logIndex", "tokenId"];
  if (value.kind === "Transfer") { fields(value, [...common, "from", "to"]); address(value.from, true); address(value.to); }
  else if (value.kind === "OpenSignatureMinted") {
    fields(value, [...common, "handle", "handleKey", "recipient", "assessmentDigest", "artifactDigest", "tokenURIHash", "nonce", "authorizationDigest", "mbti", "evidenceReference"]);
    if (typeof value.handle !== "string" || !/^[a-z0-9_]{1,15}$/.test(value.handle) || value.handleKey !== openMintHandleKey(value.handle) || !isMbti(value.mbti)) throw new Error("Invalid mint identity.");
    address(value.recipient); reference(value.evidenceReference);
    for (const key of ["assessmentDigest", "artifactDigest", "tokenURIHash", "nonce", "authorizationDigest"] as const) hash(value[key]);
  } else if (value.kind === "GenerativeSignatureMinted") {
    fields(value, [...common, "handle", "renderHandle", "handleKey", "recipient", "assessmentDigest", "inputDigest", "rendererIdentity", "nonce", "authorizationDigest", "mbti", "evidenceReference"]);
    if (preservedHandle(value.renderHandle) !== value.renderHandle || canonicalHandle(value.renderHandle) !== value.handle
      || value.handleKey !== openMintHandleKey(value.handle) || !isMbti(value.mbti)) throw new Error("Invalid generative mint identity.");
    address(value.recipient); reference(value.evidenceReference);
    for (const key of ["assessmentDigest", "inputDigest", "rendererIdentity", "nonce", "authorizationDigest"] as const) hash(value[key]);
    if (value.inputDigest !== generativeInputDigest(value.renderHandle, value.mbti, value.rendererIdentity as `0x${string}`, profile)) throw new Error("Invalid generative input commitment.");
  } else throw new Error("Unsupported projection event.");
  hash(value.transactionHash); index(value.transactionIndex); index(value.logIndex); quantity(value.tokenId, 256, true);
  if (value.kind !== "Transfer" && BigInt(value.tokenId) !== BigInt(value.handleKey)) throw new Error("Mint token does not equal its handle key.");
}
export function validateBatch(input: ValidatedBatch, deployment: ProjectionDeployment): ValidatedBatch {
  const value = structuredClone(input);
  fields(value, ["chainId", "contractAddress", "manifestHash", "blocks"]);
  if (value.chainId !== deployment.chainId || value.contractAddress !== deployment.contractAddress || value.manifestHash !== deployment.manifestHash) throw new Error("Projection deployment binding mismatch.");
  if (!Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > MAX_BATCH_BLOCKS) throw new Error("Invalid bounded block batch.");
  let total = 0;
  const hashes = new Set<string>();
  for (let i = 0; i < value.blocks.length; i++) {
    const block = value.blocks[i]; fields(block, ["number", "hash", "parentHash", "events"]);
    quantity(block.number, 63); hash(block.hash); hash(block.parentHash);
    if (hashes.has(block.hash)) throw new Error("Duplicate block hash in projection batch.");
    hashes.add(block.hash);
    if (BigInt(block.number) < BigInt(deployment.deploymentBlock) || (i && (BigInt(block.number) !== BigInt(value.blocks[i - 1].number) + 1n || block.parentHash !== value.blocks[i - 1].hash))) throw new Error("Noncontiguous block batch.");
    if (!Array.isArray(block.events) || block.events.length > MAX_BLOCK_EVENTS || (total += block.events.length) > MAX_BATCH_EVENTS) throw new Error("Too many projection events.");
    const transactions = new Map<string, number>();
    for (let j = 0; j < block.events.length; j++) {
      const event = block.events[j]; validateEvent(event, deployment.generativeRenderer ? profileForRenderer(deployment.generativeRenderer).inputProfile : undefined);
      if (event.kind !== "Transfer" && ((event.kind === "GenerativeSignatureMinted") !== !!deployment.generativeRenderer
        || (event.kind === "GenerativeSignatureMinted" && event.rendererIdentity !== deployment.generativeRenderer!.identity))) throw new Error("Projection event/profile mismatch.");
      if (transactions.has(event.transactionHash) && transactions.get(event.transactionHash) !== event.transactionIndex) throw new Error("Transaction hash has conflicting event positions.");
      transactions.set(event.transactionHash, event.transactionIndex);
      const previous = block.events[j - 1];
      if (previous && (event.logIndex <= previous.logIndex || event.transactionIndex < previous.transactionIndex
        || (event.transactionIndex === previous.transactionIndex && event.transactionHash !== previous.transactionHash)
        || (event.transactionIndex !== previous.transactionIndex && event.transactionHash === previous.transactionHash))) throw new Error("Invalid event ordering.");
    }
  }
  if (Buffer.byteLength(stable(value)) > 1024 * 1024) throw new Error("Projection batch byte limit.");
  return value;
}
export function validateFilter(value: GalleryFilter): GalleryFilter {
  fields(value, value.kind === "home" ? ["kind"] : ["kind", "value"]);
  if (value.kind === "owner") address(value.value);
  else if (value.kind === "mbti") { if (!isMbti(value.value)) throw new Error("Invalid MBTI filter."); }
  else if (value.kind !== "home") throw new Error("Invalid gallery filter.");
  return structuredClone(value);
}
export function validateLimit(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new Error("Invalid gallery limit."); }
export function encodeCursor(value: ProjectionCursor): string { return Buffer.from(stable(value)).toString("base64url"); }
export function decodeCursor(text: string, deployment: string, filter: GalleryFilter, limit: number): ProjectionCursor {
  try {
    if (typeof text !== "string" || text.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    fields(value, ["version", "deployment", "filter", "limit", "snapshot", "last"]);
    if (value.version !== 1 || value.deployment !== deployment || value.limit !== limit || stable(value.filter) !== stable(filter) || encodeCursor(value as unknown as ProjectionCursor) !== text) throw new Error();
    fields(value.snapshot, ["number", "hash"]); quantity(value.snapshot.number, 63); hash(value.snapshot.hash);
    fields(value.last, ["block", "transaction", "log", "token"]); quantity(value.last.block, 63); index(value.last.transaction); index(value.last.log); quantity(value.last.token, 256, true);
    if (BigInt(value.last.block) > BigInt(value.snapshot.number)) throw new Error();
    return value as unknown as ProjectionCursor;
  } catch { throw new ProjectionCursorError("Invalid gallery cursor; restart pagination."); }
}
