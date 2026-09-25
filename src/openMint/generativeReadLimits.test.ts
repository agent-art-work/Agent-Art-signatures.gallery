import { describe, expect, it } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem";
import { decodeArtworkDataUri, decodeBoundedRead, GENERATIVE_READ_LIMITS as L } from "./generativeReadLimits.js";

const abi = parseAbi(["function tokenURI(uint256) view returns (string)"]), prefix = "data:image/svg+xml;base64,";
const uri = (value: string | Uint8Array) => prefix + Buffer.from(value).toString("base64");
describe("shared generative read ceilings and canonical decoding", () => {
  it("freezes the read-only policy without changing input-only mint limits", () => {
    expect(Object.isFrozen(L)).toBe(true); expect(L.artworkGas).toBe(30_000_000); expect(L.scalarGas).toBe(2_000_000);
    expect(L.version).toBe("sg-generative-read-limits-v1");
    expect(64 + 32 * Math.ceil((29 + 4 * Math.ceil(L.metadataJsonBytes / 3)) / 32)).toBeLessThan(L.artworkAbiBytes);
  });
  it("accepts exact ABI size, rejects one byte too small", () => {
    const raw = encodeFunctionResult({ abi, functionName: "tokenURI", result: "svg" }), n = (raw.length - 2) / 2;
    expect(decodeBoundedRead(abi, "tokenURI", raw, n)).toBe("svg");
    expect(() => decodeBoundedRead(abi, "tokenURI", raw, n - 1)).toThrow();
  });
  it.each([NaN, Infinity, -1, 0, 1.5, 65_537])("refuses an invalid or unbounded ABI limit %s", cap => {
    const raw = encodeFunctionResult({ abi, functionName: "tokenURI", result: "svg" });
    expect(() => decodeBoundedRead(abi, "tokenURI", raw, cap)).toThrow();
  });
  it.each([NaN, Infinity, -1, 0, 1.5, 30_001])("refuses an invalid or unbounded data limit %s", cap => {
    expect(() => decodeArtworkDataUri(uri("<svg/>"), prefix, cap)).toThrow();
  });
  it.each([undefined, null, {}, "0x", "0x0", "0xGG", "0x" + "00".repeat(L.artworkAbiBytes + 1)])("rejects malformed/oversized ABI", raw => {
    expect(() => decodeBoundedRead(abi, "tokenURI", raw, L.artworkAbiBytes)).toThrow();
  });
  it("rejects trailing bytes and altered dynamic padding even when the ABI decoder is permissive", () => {
    const raw = encodeFunctionResult({ abi, functionName: "tokenURI", result: "svg" });
    for (const bad of [raw + "00".repeat(32), raw.slice(0, -2) + "01"])
      expect(() => decodeBoundedRead(abi, "tokenURI", bad, L.artworkAbiBytes)).toThrow("Noncanonical");
  });
  it("accepts exact decoded byte limits, not character-count limits", () => {
    expect(decodeArtworkDataUri(uri("a".repeat(L.svgBytes)), prefix, L.svgBytes)).toHaveLength(L.svgBytes);
    expect(() => decodeArtworkDataUri(uri("a".repeat(L.svgBytes + 1)), prefix, L.svgBytes)).toThrow();
    expect(decodeArtworkDataUri(uri("×".repeat(4)), prefix, 8)).toBe("×".repeat(4));
    expect(() => decodeArtworkDataUri(uri("×".repeat(4)), prefix, 7)).toThrow();
  });
  it.each([undefined, null, {}, "ipfs://x", prefix, prefix + "!!!!", prefix + "YQ", prefix + "YR==", prefix + "YQ==\n",
    uri(new Uint8Array([0xff]))])("rejects malformed, external, noncanonical or non-UTF8 data", raw => {
    expect(() => decodeArtworkDataUri(raw, prefix, L.svgBytes)).toThrow();
  });
  it("retains a BOM so exact-byte comparisons cannot silently normalize it", () => {
    expect(decodeArtworkDataUri(uri("\uFEFF<svg/>"), prefix, L.svgBytes)).toBe("\uFEFF<svg/>");
  });
});
