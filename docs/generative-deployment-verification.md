# Generative candidate: observed deployment verification

September 22, 2026. **Implemented and locally tested; no actual Sepolia deployment observed.** This is a read-only verification stage for the [locked release candidate](generative-release-candidate.md), not public runtime admission or permission to deploy/unpause.

## Boundary

`contracts/tools/generative-deployment.mjs` consumes the explicit offline deployment configuration, two known deployment transaction hashes, bounded observation policy and two injected read sources. It rebuilds the plan through the existing release-lock verifier before any RPC request. There is no automatic discovery, `.env` loading, credential handling, signing, deployment, funding, database migration or activation command.

The result is `observed-paused-not-admitted`. It always states:

- `publicBroadcastAllowed: false`
- `runtimeAdmissionAllowed: false`
- `activationAllowed: false`
- `custodyVerified: false`
- `readLimitsValidated: false`
- `sourceIndependence: operator-declared-not-proven`

An offline plan alone still proves nothing about deployed state. An observation report is descriptive, not reusable authorization. The current backend's public-chain refusal is unchanged.

## What must agree

| Check | Required evidence from each source |
| --- | --- |
| Network | Chain 11155111 and the fixed published Sepolia execution genesis, not an arbitrary operator-supplied hash |
| Canonical/finalized state | Fresh `latest` and `finalized` headers; both deployments finalized; canonical numbered headers, receipts, history and tags unchanged on recheck |
| Creation | Successful direct CREATE receipts and the exact signed EIP-1559 transactions, reconstructed hash and recovered deployer, predicted addresses, nonces and locked initcode |
| Executable identity | Every byte of the renderer and collection runtime, including all deployment-specific immutable occurrences, at finalized and latest block-hash pins |
| Initial authority | Exact constructor events, intended exclusive role memberships/admin hierarchy, at least 48-hour configured admin delay, no pending admin/delay change, expected signer and complete EIP-712 domain |
| Initial state | Still paused; deployer and authorizer have no code; complete collection-address event history contains only the constructor events |
| Agreement | Both normalized observations agree; missing, malformed, oversized, conflicting, stale or changing evidence rejects the whole observation |

The fixed genesis is `0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9`, published in the [Ethereum clients' Sepolia reference](https://github.com/eth-clients/sepolia/blob/main/README.md). An Anvil node with chain ID 11155111 cannot pass this check merely by using Sepolia's chain ID.

The collection's exact expected runtime is assembled from its locked compiler template. The release-specific immutable layout is checked before inserting the renderer address/identity and EIP-712 name, version, chain, collection address and cached hashes/domain separator. **No immutable bytes are masked or ignored.** Future releases require their own reviewed layout and actual-EVM regression; changing this mapping cannot bless a different compiler build.

## Explicit API and operating limits

The exported entrypoint is `createDeploymentObserver({ config, transactions, sources, policy })`. `config` is the reviewed offline-plan input from the candidate document. `transactions` has exactly `renderer` and `collection`, containing distinct creation transaction hashes. Each of the two sources has exactly `id`, `operatorReference` and `request(method, params, signal)`. Distinct source IDs, operator references and callback functions are required; these declarations do **not** establish independent infrastructure or human custody.

An operator must separately select and review transports before any real use. An adapter can compose the existing bounded `createPublicChainHttpRpc` read transport; its approved-host/DNS/egress, streaming-byte, timeout, cancellation and no-retry requirements still apply. Only read methods are used. `eth_getTransactionByHash` was added to that transport's read allowlist; wallet, signing and broadcast methods remain refused. No concrete public transport or operator CLI is connected by this checkpoint.

All policy fields are required positive safe integers; there are no inferred operating defaults:

| Field | Maximum permitted | Meaning |
| --- | ---: | --- |
| `timeoutMs` | 30,000 | Whole observation deadline, including both sources |
| `maxHeadAgeMs` | 300,000 | Latest-head freshness |
| `maxFinalizedAgeMs` | 3,600,000 | Finalized-head freshness |
| `maxFutureSkewMs` | 30,000 | Permitted future timestamp skew |
| `validityMs` | 30,000 | Maximum observation lifetime; also limited by head freshness |
| `maxDeploymentSpan` | 512 | Maximum distance in blocks from each deployment to latest |

Each source is capped at 256 RPC calls; the normal distinct-head test uses 118 per source (236 total). Individual decoded responses are capped at 1 MiB and view results at 16 KiB. View calls are pinned with `{ blockHash, requireCanonical: true }` and capped at two million gas. These small authority getters **do not validate the much heavier artwork/metadata read path**. Transport-level streaming caps are still necessary before JSON decoding.

`observe(signal)` returns an opaque process-local witness. `readDeploymentObservation(witness, { planSha256 })` checks plan binding and freshness before returning its immutable report; copied JSON, fabricated witnesses and expired reports are refused. Clock injection exists for tests only; operational consumers must use a trusted clock. Neither the report nor the witness is connected to public startup or unpause authority. Source failures are redacted and cancellation is propagated; there is no automatic retry.

## Deliberately narrow acceptance

- Direct CREATE, zero-value, type-2/EIP-1559 transactions with empty access lists only. Legacy/type-1/type-3/authorization-list transactions, factories and CREATE2 are not silently adapted. Deployer nonces must fit the verifier's safe-integer encoding.
- This is **initial pristine paused-deployment verification**, not a general audit of an existing running collection. Any subsequent collection event, including an unpause/re-pause or a restored signer/role, blocks this verifier and requires review.
- A deployment outside the bounded recent-block window is rejected, not scanned without a bound. Moving heads or unsupported finalized/EIP-1898 reads also reject; an operator may perform a fresh manual observation, but the verifier does not retry or weaken the checks.
- Two agreeing RPC sources are a bounded trust model, not a light client or cryptographic proof of consensus, header ancestry or complete receipt/log inclusion. Shared upstreams or colluding/dishonest providers remain a risk. The operator must establish actual source independence separately.
- Separate on-chain role addresses and owner references do not prove private-key custody, distinct human control, multisig policy or hardware security. Public test material used by local fixtures is never acceptable operational custody.
- This observation does not resolve numerical/security review, marketplace compatibility, artifact-read gas/time/response limits, deployment approval, runtime admission or activation policy.

## Reproduction and evidence

Build the locked artifacts before running verifier tests:

```sh
npm run test:contract
npm run generative:release:check
npm run test:generative:deployment
npm run test:generative:deployment:coverage
npm run generative:deployment:rehearsal -- --execute-local-test-transactions
```

The last command is limited to its own newly started disposable loopback Anvil. It has no configurable RPC URL, operational key or existing-chain target. It deploys the candidate using public synthetic test keys, verifies the actual signed CREATE transactions and **exact deployed immutable bytes**, checks the initial pause/admin/delay, then proves the public observer rejects the node's non-Sepolia genesis. It never unpauses or mints and stops its child node afterwards. The shared-node read callbacks in this rehearsal do not count as independent providers.

Observed local results:

- **83 verifier tests passed**: runtime/each immutable mutation, forged signed transactions, role/domain/pause changes, event omissions/additions, reorgs, stale/future/changed heads, source disagreement, byte limits, cancellation/deadlines, caller mutation, forged/expired witnesses and error redaction.
- Dedicated verifier coverage: **100% lines, 97.87% branches, 100% functions**. CI now enforces 100/95/100 minima for this module separately from application coverage.
- Actual Anvil deployment-byte rehearsal passed, remained paused and was correctly **rejected as Sepolia**. No public deployment was performed or observed.
- Application regression: **5,329 passed, seven non-applicable skips across 169 files**; coverage **96.25% statements, 92.02% branches, 98.35% functions**, above unchanged 93/87/97 thresholds.
- **170 Solidity tests**, **119 release-tool tests**, typecheck, build and existing renderer/slogan/release locks pass. No release lock or active data was changed. Hosted CI is configured, not observed.

Ignored evidence is under `.local/generative-renderer/`: `deployment-rehearsal.json`, `deployment-unit-coverage.log`, `deployment-coverage.log`, `deployment-contract.log`, `deployment-release.log` and `deployment-build.log`. Provider assessments/billing, real wallet-extension certification, public RPC performance and actual Sepolia deployment are outside this evidence.

## Next

1. Continue the [separate runtime-admission policy](generative-runtime-admission-policy.md): [offline operating-plan validation](generative-operating-plan.md), the [distinct active-state observer](generative-active-state-verification.md) and [internal admission core/release adapter](generative-admission-composition.md) are implemented; concrete reviewed-policy and PostgreSQL lease/fence integration is next. This pristine observer still refuses an activated collection. The [internal numerical/security worksheet](generative-numerical-security-review.md) adds conditional structural/arithmetic/output bounds; the [shared read-limit campaign and startup checks](generative-read-limits.md) add local evidence. Neither is independent approval or public-provider acceptance. Paused/active observations and validated plans must not themselves enable signing, public startup or minting.
2. Resolve approved operating sources/custody/hosting/database/budget and support/finality choices. Real provider read-limit evidence and extension/device QA remain required.
3. Only with scoped approval, provision/fund/deploy the locked candidate paused; perform real observations, then make a **separate activation decision**. Preserve rejection rather than fall back to finished-SVG storage/compression or IPFS publication.
