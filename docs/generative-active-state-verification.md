# Sepolia active-state observation

September 22, 2026. **Implemented and locally tested; not public runtime admission, activation approval or actual Sepolia evidence.** This is the second local component in the [runtime-admission policy](generative-runtime-admission-policy.md). It preserves the separate [pristine paused-deployment verifier](generative-deployment-verification.md), which still rejects an activated collection.

## What it verifies

`contracts/tools/generative-active-state.mjs` rebuilds the locked candidate deployment plan, checks both signed CREATE transactions, then compares complete collection history and current state with an explicit list of declared governance transactions. It does not discover an acceptable history by trusting whatever privileges happen to exist today.

| Evidence | Checks |
| --- | --- |
| Deployment | Published Sepolia genesis, chain 11155111, finalized signed CREATE transactions, ordered renderer/collection deployment, exact initcode and constructor logs |
| Complete history | Bounded, paginated all-topic collection logs; canonical order; complete receipts for every log-bearing transaction; matching block membership and log positions; strict ABI event encoding |
| Activation and subsequent governance | Exact declared chronological transaction hashes, recovered signed senders, calldata, chain, zero value, successful receipts, expected events and current role authority at each transition |
| Finalized and latest state | Exact renderer/collection runtime with all immutables; renderer/profile/version/domain; unpaused state; expected signer and tracked role membership; unchanged delayed admin; no pending admin/delay changes; declared nonce revocations |
| Consistency | Two separately declared sources agree; freshness and deadline checks; numeric block/header pins, chronological timestamps and adjacent-parent links; re-read complete receipts, all log pages and finalized/latest tags before returning |
| Output | A short-lived in-process witness plus an immutable audit report bound to the complete observation policy; no permission to sign, spend, broadcast, start a public runtime or activate |

Privileged events not in the declaration stop verification. This includes an unexpected grant/revoke or pause/resume pair that leaves current state looking normal. Unfinalized privileged changes also stop verification. Ordinary `Transfer`, `Approval`, `ApprovalForAll` and `GenerativeSignatureMinted` events are decoded and receipt-bound, but token semantics/finality/ownership remain the projection's responsibility; this observer does not certify a mint by itself.

Two agreeing RPC sources are not a consensus proof or proof of source independence. The verifier does not obtain cryptographic log-completeness proofs or reconstruct every intervening block's ancestry. Provider trust, independent operation and historical-state acceptance remain explicit operational requirements.

## Explicit API

`createActiveStateObserver({ config, transactions, transitions, sources, policy, root?, now? })` returns `{ plan, policySha256, observe(signal?) }`.

- `config`: the existing explicit constructor-planning input, including six principals/owners, selected origin and published Sepolia genesis. The release/source/compiler/build lock is reverified; no environment inference.
- `transactions`: exactly `{ renderer, collection }`, containing the two known deployment transaction hashes. Initial deployment is checked afresh; a saved or expired pristine-observer report cannot substitute for it.
- `transitions`: 1–16 exact `{ transactionHash, sender, functionName, args }` declarations in chronological order. Addresses and hashes use lowercase hex. The first action must be the initial pauser's `unpauseMinting`.
- `sources`: exactly two `{ id, operatorReference, request }` objects with distinct identifiers, declared operators and callbacks. `request(method, params, signal)` supplies read-only RPC results and honors cancellation. These are injected trusted transports, not user-supplied endpoint URLs.
- `policy`: all nine safe-integer limits in the table below, positive except that future skew may be zero; no operating defaults are selected.

The immutable policy digest commits the freshly checked deployment-plan digest, both CREATE hashes, the complete ordered transition list, all observation limits and both source/operator identifiers. Caller mutations cannot change a constructed observer's declarations. The API does not itself consume the [offline operating plan](generative-operating-plan.md): the next trusted admission composition must cross-bind its source identifiers, limits, deployment identity, policy digest and reviewed governance/custody changes to that plan.

`readActiveStateObservation(witness, { policySha256, now? })` accepts only a witness issued by this module, for that exact digest, during its validity window. Serializing, copying or inventing a witness/report provides no capability. Its deeply frozen report uses `sg-generative-active-observation-v1` and `observed-declared-active-state-not-admitted`. `transitionApprovalVerified`, `custodyVerified`, `readLimitsValidated`, `paidDispatchAllowed`, `signingAllowed`, `publicBroadcastAllowed`, `runtimeAdmissionAllowed` and `activationAllowed` are all **false**. Source independence is explicitly `operator-declared-not-proven`.

The observer has no network CLI, credential resolver, signing callback, database access or runtime entrypoint. Observation errors are sanitized. Configuration errors may contain public declaration values, and reports contain public addresses/transaction hashes and operational references: neither is a place for secrets or untrusted public request input.

## Supported governance and limits

This first version supports only directly signed EOA **type-2, empty-access-list, zero-value** calls:

- `unpauseMinting` and `pauseMinting` by the currently authorized pauser.
- `grantRole` and `revokeRole` for the authorizer-manager, pauser or nonce-revoker role by the unchanged delayed admin. The complete grant/revoke handover must leave exactly one member per role.
- `setTrustedAuthorizer` by the currently authorized manager. Same-signer updates and restoring any previously retired signer are rejected. This conservative rule is stricter than the contract; it includes signers not known to be compromised.
- `revokeNonce` by the currently authorized nonce revoker, without duplicate declarations.

Admin transfers, admin-delay changes, role renunciation, unknown roles, nested/multisig calls, code-bearing governance senders and other transaction types require a separately reviewed extension. They are not silently accepted or claimed as supported. This restriction is not a recommendation to replace an intended multisig with an EOA merely to pass this verifier.

Role/signer handovers can introduce new addresses. Matching those transactions does **not** prove the new addresses' custody, safe keys, owner separation or approval. The next admission layer must verify updated custody/operating bindings; the constructor plan's original principal list cannot automatically bless a rotated signer. A declaration from a web request or a JSON `approved` flag must never become the trusted transition policy.

| Policy field | Implementation ceiling |
| --- | --- |
| `timeoutMs` | 30,000; wall and monotonic time bounded |
| `maxHeadAgeMs` | 300,000 |
| `maxFinalizedAgeMs` | 3,600,000 and not below head age |
| `maxFutureSkewMs` | 0–30,000; zero tolerance is supported |
| `validityMs` | Minimum of 30,000 and head age; actual expiry further bounded by observed block ages |
| `maxHistorySpan` | 65,536 blocks, including deployment age checks |
| `logBlockRange` | 2,048 blocks per query |
| `maxLogs` | 2,048 collection logs |
| `maxTransactions` | 128 collection-log-bearing transactions, including constructor history |

There are also ceilings of 32 tracked principal addresses, 2,048 requests per source and 1 MiB per decoded RPC response. The shared bounded scalar ABI/gas reader is used. The transport must separately cap streaming bytes **before** allocating/decoding the response; a post-decode size check is not that transport protection.

This is a bounded full-history rescan, not an incremental durable checkpoint or a long-running service capacity claim. Crossing a history/transaction/log/time limit stops verification; no history is truncated to make it pass. Stable latest/finalized tags are required during one observation, so a moving tip can conservatively reject a pass. Do not automatically retry paid work, restore a signer, unpause, erase history or extend limits in response. Readiness, durable checkpoints and operational recovery need their own reviewed composition.

## Local validation

```sh
npm run test:generative:active-state:coverage
npm run test:generative:deployment:coverage
npm run generative:active-state:rehearsal -- --execute-local-test-transactions
```

- **70 active-state tests** pass, with **100% lines, 98.45% branches and 100% functions**. CI enforces separate 100/95/100 minima. Tests include omitted privileged history, forged transaction signatures/calldata/receipts, unexpected admin events, signer restoration, crossed current state, unfinalized activation, incomplete/changed logs, source disagreement, copied/stale witnesses, hostile timing/cancellation, hard history limits and zero/negative future-skew policy.
- The existing pristine observer's **83 tests** pass unchanged, retaining **100% lines, 97.87% branches and 100% functions**.
- The disposable-Anvil rehearsal uses only its own newly spawned chain and publicly derived test keys. Both actual CREATE transactions and all seven governance transactions verify: initial activation, manager grant/revoke, authorizer rotation, nonce revocation, pause and resume. Final state and exact deployed runtime match.
- The public observer correctly rejects that Anvil chain's non-Sepolia genesis. The full successful observer tests use synthetic RPC fixtures; the real local-chain rehearsal validates actual signed transactions/state, not actual Sepolia or independent RPCs. No genesis override was added.
- Regression: **332 focused application tests** (operating-plan, both profiles' startup/refusal and bounded read decoding), **177 Solidity tests**, **119 release-tool tests**, **38 operating-plan tests** and **16 numerical-tool tests** pass. Typecheck, build, original renderer/slogan locks, the candidate lock and whitespace checks pass. The complete PostgreSQL/application coverage campaign was not rerun for this read-only tooling increment.

Ignored evidence: `.local/generative-renderer/active-state-tooling.log`, `active-state-pristine.log`, `active-state-rehearsal.json` and `active-state-rehearsal.log`. CI is configured, not observed on a hosted runner. No public transaction, paid provider request, active database change, existing-chain reset, contract-source change or release-lock rewrite occurred.

## Next

The [internal single-operation gate and release-aware chain adapter](generative-admission-composition.md) are implemented. Next, integrate concrete trusted review and PostgreSQL lease/fence adapters: exact database/profile/role audit, writer ownership, session/spend state and kill switches, rechecked at each effect boundary. Keep read readiness distinct from paid preparation, signing and wallet submission. Only then introduce a separately gated Sepolia entrypoint. Real accounts, custody, provider acceptance, independent review and public deployment/activation remain separate decisions.
