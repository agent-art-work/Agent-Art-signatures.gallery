/** One complete action read can validate and use either RPC source. The browser
 * must leave room for both attempts plus HTTP/render overhead; it must not abort
 * a healthy fallback while the primary's own deadline is still running.
 * Background relay refreshes retain their longer, independent read allowance.
 * These are read-only budgets, never wallet-signing/broadcast retry policies. */
export const SEPOLIA_READ_BUDGETS = Object.freeze({
  sourceMs: 20000,
  semanticMs: 45000,
  browserMs: 50000,
  backgroundSourceMs: 20000,
  backgroundSemanticMs: 45000,
});
