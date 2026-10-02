# C5 — contract review and frozen integration boundary

September 26, 2026. **Complete for C6 integration**, with no unresolved blocking
contract finding. This is a local engineering review, not an independent audit,
public deployment approval or acceptance of the complete application.

Reviewed the [C1 specification](pulse-contract-spec.md), C2 allowlist/dependency
tools, C3 consumer, C4 evidence and the pinned Pulse Core v1.0.0 semantics.
No production Solidity change was needed. Historical RC1, renderer bytes,
Foundry settings and the active `.local/rehearsal` environment are unchanged.

## Findings and resolution

| Review issue | Resolution and evidence |
| --- | --- |
| C4 compared all upstream vectors with an independent JavaScript model, not directly with the released EVM core. | C5 executes all **67** successful/error vectors against the exact released creation/runtime bytes on disposable Anvil; decoded results and exact revert data match. The independent-model test remains. |
| C4's large padded Merkle trees were stress fixtures, not the production C2 format. | The C2 builder now supplies real 1,024/1,025-slot proofs to local transactions, including repeated wallets, slots 0/1/255/256/257/1,024, stolen proofs and case-insensitive handle contention. |
| C4 execution-gas samples included shared-test effects and were unsuitable as wallet transaction totals. | Added actual receipt-gas measurements below. C4's deployment comparison was affected by test-memory growth; its explanation is corrected. No per-wallet deployment-storage growth is inferred. |
| Attempted trace logs do not prove whether reverted receipts expose events. | Actual rejecting-treasury and losing same-block transactions have **zero receipt logs**. Rejected settlement preserves nonce/epoch/block state and balances except the sender's gas. Retrying unchanged authority succeeds after the test treasury accepts payment. |
| C6 needed one explicit, drift-checked ABI/build/authorization boundary. | Added the frozen candidate lock and complete ABI, shared deeply frozen typed-data fields, and a read-only verifier with mutation tests. |

Additional Solidity checks cover malformed/compact/high-s signatures, invalid
`v`, historical-domain rejection, signer rotation/restoration, permanent nonce
revocation, transfers while minting is paused, self-treasury/zero-authority
rejection, later Pulse arithmetic exhaustion and the block-zero paid-mint guard.
Existing C3/C4 checks cover callbacks/refund rejection, phase boundaries,
attestation substitution, per-slot/handle uniqueness and rollback.

## Frozen boundary

- [Candidate lock](../contracts/releases/generative-pulse-v1-rc1.json):
  `sg-pulse-candidate-lock/v1`, status `reviewed-for-c6-integration`,
  `publicDeploymentApproved: false`.
- Canonical-JSON lock SHA-256:
  `029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8`.
- [Complete ABI](../contracts/releases/generative-pulse-v1-rc1.abi.json):
  149 members, including errors, events, inherited functions and constructor.
- [Shared candidate/typed-data identity](../src/openMint/pulseCandidate.ts):
  contract/profile/input/domain/reservation/wallet-plan versions remain the
  C1 choices. The authorization field order is frozen, not reconstructed
  independently by each consumer.
- The lock includes function selectors/event topics, exact source/compiler
  metadata, ABI and bytecode hashes, immutable placeholder ranges, constructor
  size, Foundry configuration, pinned core bundle and historical renderer/RC1
  identity. Source freshness includes transitive OpenZeppelin imports.

Consumer: solc **0.8.30**, optimizer **200**, **Prague**. Released Pulse Core:
solc **0.8.24**, **Shanghai**, used as released bytecode rather than recompiled.
Consumer runtime is **23,819 bytes**, leaving **757 bytes** below EIP-170.
Creation is **43,720 bytes** plus **544 bytes** of constructor arguments,
or **44,264 bytes** total initcode. The runtime-template hash is not the actual
deployed runtime hash: C6/deployment verification must bind all immutables.

The verifier refuses stale sources, code/settings/ABI/domain drift, unexpected
source paths and size-limit violations. It has no write/update/deploy mode.
Creating this lock does **not** register or activate a live contract profile.

## Verification

From the repository root, with the existing dependencies and Foundry installed:

```sh
npm run test:pulse:c5
npm run test:pulse:c5:evm
npm run test:contract
npm run typecheck
npm run pulse:candidate:verify
```

All passed. The full Foundry suite has **230 passing tests**. C5 adds five
Solidity tests and five candidate-lock test groups; C3/C4 and the two shared
candidate TypeScript tests also pass. The separate disposable-Anvil campaign
passes all 67 released-core vectors, production proofs, payment/refund receipt
accounting, both free-phase endings and a real block containing two paid
attempts with exactly one success. Historical RC1 verification still passes.

The Anvil runner selects a new loopback port, deploys to a new chain using
public test keys and fake ETH, then terminates its own child. It accepts no
external RPC destination or saved deployment and reads no environment secrets.
No live provider call, paid credit, public transaction or active-runtime change
is part of these results. Full website/database flow remains C6–C7 work.

## Actual transaction gas

One successful local run using Anvil/Foundry **1.5.1**, Prague and the builds
above. These are receipt `gasUsed` values, including intrinsic/calldata gas,
not estimates, transaction gas limits or fiat fees.

| Scenario | Receipt gas |
| --- | ---: |
| Deploy released Pulse Core | 640,793 |
| Deploy renderer | 3,238,394 |
| Deploy collection, 1,024 slots | 5,814,032 |
| Deploy collection, 1,025 slots | 5,814,044 |
| First free mint, 1-char handle, 1,024 slots | 293,962 |
| First free mint, 15-char handle, matching 1,024-slot setup | 305,849 |
| First free mint, 1,025 slots | 294,082 |
| Reused bitmap word, slot 1 | 242,710 |
| Slot 255, another wallet | 267,260 |
| Slot 256, new bitmap word | 264,758 |
| Slot 257, reused bitmap word | 249,330 |
| Last slot in 1,025-slot list | 265,612 |
| First paid mint after deadline | 333,662 |
| Subsequent paid mint | 276,672 |
| Final free mint, including exhaustion transition | 364,320 |
| First paid mint after exhaustion | 278,782 |

The controlled 1/15-character comparison is **+11,887 gas**. Collection setup
differs by only **12 gas** between these 1,024/1,025-slot samples: it stores root
and count, not every wallet. Other rows differ in handle, proof, bitmap/owner
state and phase work; do not subtract them to isolate one cause. Signatures,
calldata bytes and timestamps can cause small variation between runs.
The tiny test-curve wei values are fixtures, not launch economics. Core and
renderer deployments are separate from collection deployment. These figures
supersede C4's execution-only samples for transaction-cost discussion.

## Remaining limitations and operational responsibilities

- A trusted backend attestation authorizes accepted inputs; it is not a
  cryptographic proof that Grok itself signed an MBTI. Preview inputs remain
  untrusted and cannot enter the authoritative mint path.
- Recipient `code.length` checking is not general anti-bot protection. A
  constructing contract can have no code, but still needs valid authority and
  its own free proof. Code-bearing/delegated accounts are rejected by this
  candidate; supported-wallet acceptance remains separate work.
- Restoring an old signer restores its unused, unexpired authorizations.
  Do not restore compromised signers. Revoked nonces stay revoked; pausing
  stops minting but does not invalidate signatures or stop ERC721 transfers.
- Treasury is immutable. A rejecting treasury blocks paid settlement; verify
  the actual address and receiving behavior before deployment. There is no
  mutable treasury escape hatch. Forced ETH is not a sale or authority.
- Launch preflight does not guarantee unlimited arithmetic headroom. Later
  unrepresentable Pulse advances revert atomically; the contract cannot promise
  infinitely many representable epochs. No paid supply cap was introduced.
- The root cannot prove that the published list matches N. Deployment must
  independently verify the canonical contiguous slot manifest, root and count.
  Actual economics, deadline, role custody/separation and addresses remain
  deployment inputs, not values approved by these fixtures.
- Callbacks can read reserved intermediate state before the NFT is minted;
  off-chain projection must use complete successful canonical receipts/events,
  not a callback read or attempted trace. Monotonic phase claims apply to a
  canonical chain history and must still handle reorgs.
- Runtime headroom is small. Any contract change requires a new review/lock
  and size check, not a silent artifact refresh. No external audit is implied.

## C6 handoff — GPT-6 Sol · High

1. Use the frozen ABI and shared identities. `mintFree` is `0x1cc08a94`;
   `mintPaid` is `0x4f2e209c`. Keep the old zero-value RC1 pipeline unchanged.
   Treat large integers as `bigint`/canonical decimal strings, not JS numbers.
2. Use the exact typed fields: handle/assessment/input commitments, recipient,
   nonce, issuedAt, deadline, mintMode, slotId and maxPrice. Free is mode 0,
   value/maxPrice 0; paid is mode 1, slot `uint256.max`, value exactly signed
   maxPrice. Settlement charges the current ask and refunds the surplus.
3. Keep validity `issuedAt <= timestamp < deadline`, maximum window 900s;
   free authority must be clipped to the free-phase deadline. A free request
   crossing phases needs new explicit paid consent and reconciliation of old
   authority/possible submissions. Reuse its accepted assessment, never silently
   reassess, raise the ceiling or convert the transaction to paid.
4. Reserve free sponsorship durably by slot **before** X/Grok dispatch; check
   eligibility again before signing. Preserve uncertain wallet submissions and
   restart/recovery semantics separately from on-chain slot consumption.
5. Match `GenerativeSignatureMinted` and `MintEconomics`, plus `Sale` for paid
   minting, from the selected verified collection. Record actual paid price,
   not maxPrice. A lazy `PaidPhaseStarted` deadline timestamp can precede its
   event block. Preserve early Confirming reveal and finalized-gallery policy.
6. Add explicit profile/schema/deployment/observer bindings with focused tests;
   verify deployed immutables, core and renderer. Do not auto-activate the new
   candidate or bypass R5's unresolved installed-startup review-pin boundary.

Stop at this checkpoint for the user's manual model switch. C7 owns the full
isolated application rehearsal; C8 owns final integration review. R5–R10 remain
paused until the revised product is ready for release work.
