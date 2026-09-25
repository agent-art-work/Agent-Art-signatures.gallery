import { decodeFunctionResult, encodeFunctionResult, type Abi, type Hex } from "viem";

/** Application ceilings, not proof that an arbitrary public RPC supports them.
 * Shared by chain recovery and the disposable full-metadata read campaign.
 * Rendering/decoding remains read-only and never enters mint authorization. */
export const GENERATIVE_READ_LIMITS = Object.freeze({
  version: "sg-generative-read-limits-v1",
  artworkGas: 30_000_000,
  scalarGas: 2_000_000,
  artworkAbiBytes: 65_536,
  scalarAbiBytes: 2_048,
  metadataJsonBytes: 30_000,
  svgBytes: 16_384,
});

/** Reject permissive ABI decoding (alternate offsets, padding or trailing data).
 * Transport must additionally cap the streaming JSON-RPC envelope. */
export function decodeBoundedRead(abi: Abi, functionName: string, raw: unknown, maxBytes: number): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > GENERATIVE_READ_LIMITS.artworkAbiBytes
    || typeof raw !== "string" || raw.length > maxBytes * 2 + 2 || !/^0x(?:[0-9a-f]{2})+$/.test(raw)) {
    throw new Error("Invalid bounded artwork read.");
  }
  const result = decodeFunctionResult({ abi, functionName, data: raw as Hex });
  if (encodeFunctionResult({ abi, functionName, result }) !== raw) throw new Error("Noncanonical artwork read.");
  return result;
}

export function decodeArtworkDataUri(uri: unknown, prefix: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > GENERATIVE_READ_LIMITS.metadataJsonBytes
    || typeof uri !== "string" || !uri.startsWith(prefix)
    || uri.length > prefix.length + 4 * Math.ceil(maxBytes / 3)) throw new Error("Invalid artwork data URI.");
  const encoded = uri.slice(prefix.length), bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== encoded) throw new Error("Invalid artwork data URI.");
  // Retain a BOM instead of silently discarding it; exact metadata comparison
  // (and JSON.parse) must see the actual decoded bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
