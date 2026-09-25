import type { PublicChainRpc } from "../publicChainRpc.js";

/** Offline tests only. Explicitly simulates a finalized tag at the fixture's
 * block 10; never substitutes elapsed blocks for real public finality. */
export function recoveryFixtureSources(sources: readonly [PublicChainRpc, PublicChainRpc]): readonly [PublicChainRpc, PublicChainRpc] {
  return sources.map(rpc => ({ id: rpc.id, request(method, params, signal) {
    return rpc.request(method, method === "eth_getBlockByNumber" && params[0] === "finalized" ? ["0xa", false] : params, signal);
  } } satisfies PublicChainRpc)) as unknown as readonly [PublicChainRpc, PublicChainRpc];
}
