/** "confirming" is verified canonical inclusion, never a submitted hash or
 * wallet assertion. "minted" is the adapter's terminal confidence boundary:
 * finalized on staging; the existing confirmation count on isolated Anvil.
 * Both may be displayed with honest labels after authenticated inclusion.
 * Finalized-only sharing/ownership evidence remains a separate read policy.
 */
export type MintConfidence = "unknown" | "unminted" | "pending" | "confirming" | "minted";

/** Presentation only; the caller must authenticate chain and artifact evidence. */
export function canRevealMint(state: unknown): boolean {
  return state === "confirming" || state === "minted";
}
