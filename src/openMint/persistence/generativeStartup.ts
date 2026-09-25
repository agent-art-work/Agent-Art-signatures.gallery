import { getAddress } from "viem";
import { isGenerativeProfile } from "../generativeProfiles.js";
import type { PublicChainGateConfig } from "../publicChain.js";
import type { DurableMintRuntime } from "./runtimeService.js";

/** Reject crossed durable/chain/session configuration before any projection
 * write or listener. A plan/report/approved-looking flag cannot waive the
 * existing public-startup refusal. Public admission needs a separate design. */
export function assertIsolatedGenerativeBinding(runtime: DurableMintRuntime, c: PublicChainGateConfig): void {
  const p = runtime.requests.profile, ns = runtime.requests.repository.namespace;
  if (!isGenerativeProfile(runtime.contractProfile) || c.contractProfile !== runtime.contractProfile
    || ns.profile !== "local-real" || c.chainId !== 31337n || p.chain_id !== "31337" || p.session_chain_id !== "31337"
    || c.namespaceId !== ns.id || c.deploymentId !== p.deployment_id
    || runtime.sessions.origin !== p.origin
    || getAddress(c.contract) !== getAddress(p.contract_address)
    || c.genesisHash !== p.genesis_hash || c.runtimeCodeHash !== p.runtime_code_hash
    || getAddress(c.authorizer) !== getAddress(p.authorizer)
    || String(c.deploymentBlock.number) !== p.deployment_block || c.deploymentBlock.hash !== p.deployment_block_hash) {
    throw new Error("Mismatched isolated deployment configuration; public startup remains disabled.");
  }
}
