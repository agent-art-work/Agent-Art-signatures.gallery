# Pulse contract refactor — manual implementation checkpoints

Planned September 25, 2026. Baseline: `f22d9d2` on `codex/execution-table`.
This is the active contract-development sequence before resuming paused R5–R10.
C1–C8 are complete locally; next is the website/flow discussion. The user requested one checkpoint
at a time to select model and effort manually. Finish the selected checkpoint,
record evidence and the next recommendation, then stop. Do not switch models
automatically or treat this plan as permission to run all checkpoints now.

## Accepted product rules

- Token identity remains the canonical X handle, minted once. Preserve verified
  casing, immutable accepted MBTI/renderer inputs, on-chain rendering and the
  current Confirming/finality policy.
- Use the released **Pulse Core v1.0.0** mathematics. This collection owns sale
  state, eligibility, payment and minting; the core receives no payment.
- Free rights are numbered wallet slots, each permitting one successful free
  mint. Duplicate wallets are intentional and permit minting different handles.
- The Merkle root is frozen at deployment. `N` equals the total published slots.
  Verify `(slotId, wallet)` proofs and track consumption with a claim bitmap.
- Free mint ends at N successful free mints or a fixed deadline, whichever comes
  first. Unused slots expire. A reverted transaction consumes no entitlement.
- The project pays for the controlled Grok assessment during free mint; the
  minter pays network gas. The contract does not call Grok.
- Paid mint uses native ETH, deployment-fixed Pulse configuration, a buyer's
  maximum-price guard, no overall paid supply cap, and at most one successful
  **paid** mint per collection per block. Free mints do not consume that allowance.
- Preview-link MBTI collection is deferred and outside this implementation.
  User-editable preview values never become authoritative mint assessments.

## Output and scope

Deliver a distinct reviewed contract candidate, reproducible Pulse/allowlist
artifacts, compatible authorization/wallet/observer adapters, measured gas and
an isolated Anvil mint/reveal rehearsal. Preserve RC1 and its evidence as the
historical candidate. Broader website/flow redesign follows a separate discussion.

This establishes local development readiness, not public deployment or launch.
R5's fresh-writer review-pin issue remains open. Existing R1–R4 mechanisms are
reusable, but their exact RC1 bindings and old evidence do not certify new bytes.

## Checkpoints

| Step | Work and concrete output | Model / effort | Status |
| --- | --- | --- | --- |
| C1 | Contract and authorization specification, transition rules, invariants and test matrix | GPT-6 Astra · XHigh | Specification complete; [design and checks](pulse-contract-spec.md) |
| C2 | Pinned Pulse artifacts, candidate identity and deterministic allowlist/proof tooling | GPT-6 Sol · High | Complete; [evidence and usage](pulse-contract-c2.md) |
| C3 | Free-slot and ETH/Pulse contract implementation with focused tests | GPT-6 Astra · XHigh | Complete; [implementation and evidence](pulse-contract-c3.md) |
| C4 | Adversarial, fuzz/invariant and gas tests with measured results | GPT-6 Sol · High | Complete; [evidence and gas](pulse-contract-c4.md) |
| C5 | Contract review, fixes and stable ABI/authorization boundary | GPT-6 Astra · XHigh | Complete; [review, frozen boundary and receipt gas](pulse-contract-c5.md) |
| C6 | Versioned backend/DB/wallet integration and new release/observer bindings | GPT-6 Sol · High | Complete; [integration and evidence](pulse-contract-c6.md) |
| C7 | Isolated Anvil/PostgreSQL mint/reveal rehearsal and relevant regressions | GPT-6 Sol · High | Complete; [rehearsal and regressions](pulse-contract-c7.md) |
| C8 | Final integration review and candidate/evidence handoff to product/release work | GPT-6 Astra · XHigh | Complete locally; [review and product/release handoff](pulse-contract-c8.md) |

These are engineering recommendations. Astra covers economic design, money-moving
code and review; Sol covers bounded implementation, tooling and test campaigns.
The current [OpenAI model-selection guide](https://developers.openai.com/api/docs/guides/model-selection),
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) documentation support
the model roles and available efforts. Model review is not an external audit.
Each implementation step includes relevant tests; C4 adds adversarial coverage.

## C1 — specify economics and asynchronous mint boundaries

1. Define reads, free/paid entrypoints, errors/events, constructor inputs, roles,
   ETH settlement/refunds, pause policy and core/renderer binding. Use the pinned
   pure core interface; do not inherit its consumer test harness.
2. Specify deadline equality, Pulse start time for exhaustion and timeout, quotes
   before/after activation, pause across expiry, zero-slot handling and final-free/
   first-paid behavior within one block. Proposed timeout anchor: the deadline,
   even if initialization is persisted lazily by the first paid transaction.
3. Specify signed intent and wallet-plan fields for phase, slot and spending
   ceiling. A free request crossing the deadline cannot automatically become a
   paid transaction. Preserve its accepted assessment for an explicitly chosen
   paid mint rather than requesting Grok again.
4. Specify backend slot reservation across assessment/preparation, preventing
   one unused slot from sponsoring many concurrent Grok calls. Only successful
   chain minting consumes a slot; cover abandonment, contention and uncertain
   wallet submissions separately from temporary backend reservations.

Exit: concrete specification, candidate/domain choices, field-level integration
changes and acceptance matrix. Launch numbers may remain explicit parameters.

Completed September 25: [C1 specification](pulse-contract-spec.md) fixes the
new candidate/domain, fixed-clock transition including lazy deadline activation,
signed phase/slot/ceiling, exact-ceiling ETH funding/refund, and durable slot
reservation/sponsorship rules. Its normative interface compiles; typed-message,
sample leaf and upstream runtime/interface hashes were verified. The acceptance
matrix is assigned across C2–C8. C1 itself supplied specification checks;
subsequent implementation evidence is recorded under C3 below.

## C2 — pin dependencies and generate allowlist artifacts

1. Verify the upstream tag, release manifest, interface, compiler settings,
   bytecode, license and vectors. The local tag currently resolves to
   `a08ec26e396b9d3e20ccebd8871f176368bcd713`; record verified identity and hashes
   in a dependency lock. No floating imports or implicit core upgrades.
2. Scaffold the new candidate/profile/domain from C1 without relabeling RC1.
   Prepare reproducible local deployment inputs with explicit test values.
3. Implement an importer/exporter that normalizes addresses, preserves duplicate
   wallets, assigns unique contiguous IDs, derives N, generates root/proofs and
   records manifest digests. Reject malformed/zero addresses, duplicate IDs and
   out-of-range slots. Proof artifacts must be independently reconstructible.

Exit: deterministic artifacts, Solidity-compatible proof vectors and passing
tool tests. Final real wallets/economics are not prerequisites for this work.

C2 complete. The pinned bundle, example inputs, importer/exporter, independent
proof checker and Solidity vector test are documented in
[the C2 record](pulse-contract-c2.md).

## C3 — implement the contract

1. Implement root/count/deadline, claim bitmap, successful-free counter and the
   one-way phase transition. Preserve handle uniqueness, signed assessment
   authority, nonce replay controls and immutable input-based rendering.
2. Integrate ETH payment, current quotes, price ceiling, proceeds/refunds, paid
   state/events and one successful paid sale per block using the pinned core.
3. Protect callback-sensitive writes and make minting/settlement atomic. Any
   failure rolls back slot, count, handle, nonce, Pulse advance and ETH effects.
   Add normal-path and immediate-rejection tests while implementing.

Exit: compiled candidate and focused tests covering both phase endings, duplicate
wallet slots, successful payments and rollback.

C3 complete. The candidate implements the C1 ABI and economics; 29 focused
Solidity tests, four bytecode/ABI/signature/size checks and all 207 Foundry tests
pass. The historical RC1 release lock is unchanged. See
[the C3 record](pulse-contract-c3.md). **Next: C4, GPT-6 Sol · High.**

## C4 — adversarial tests and gas measurements

- Test invalid/stolen/replayed proofs and signatures, wrong recipients, cross-domain
  replay, handle contention, deadline equality, final-slot races, pause/expiry and
  same-block paid competition.
- Test underpayment, refunds, rejecting treasury/receivers and reentrancy. Compare
  prices/epochs with upstream vectors and an independent model, including long
  idle periods and arithmetic representability limits.
- Assert each slot/handle is used once, free count never exceeds N, free mint
  cannot reopen, failed calls preserve state, ETH accounting balances, and only
  successful paid minting advances Pulse/consumes the block allowance.
- Measure setup and mint gas for 1,024 and larger lists, repeated wallet slots,
  first/subsequent writes to bitmap words, both transitions, free/paid minting
  and short/15-character handles. Record compiler/settings; distinguish gas
  units from changing network-currency prices.

Exit: reproducible reports; unresolved failures block C5. No SVG storage,
compression or IPFS work is added.

C4 complete. The candidate source did not change. The C4 suite adds 18 tests,
replays all 67 upstream Pulse vectors through an independent BigInt model,
and records 1,024/1,025-slot deployment and mint gas. All 225 Foundry tests
and the historical release lock pass. See [the C4 record](pulse-contract-c4.md).
**Next: C5, GPT-6 Astra · XHigh.**

## C5 — review the contract and freeze its interface

Review against C1 and upstream semantics, especially phase consent, proof and
authorization composition, ETH callbacks, activation time, replay and immutable
configuration. Fix findings and rerun affected tests. Finalize the ABI, typed
authorization, events and candidate locks for C6. Record residual limitations.

Exit: reviewed integration boundary with no unresolved blocking findings. This
is not launch approval or a substitute for later independent release review.

C5 complete September 26. No blocking contract defect was found; the ABI,
typed authorization, events and build/dependency identity are frozen for C6.
All 230 Foundry tests pass. All 67 upstream vectors also pass against released
EVM bytecode, alongside production-proof and actual receipt tests on disposable
Anvil. Receipt gas supersedes C4's execution-only cost samples. See the
[review and C6 handoff](pulse-contract-c5.md). No public deployment or active
environment change occurred. **Next: C6, GPT-6 Sol · High.**

## C6 — adapt the mint pipeline and candidate bindings

1. Extend versioned profiles, durable slot/authorization reservations and wallet
   plans for phase, proof, spending ceiling and exact ETH value. Current saved
   plans require `0x0`; retain historical interpretation and use a new schema
   version where needed.
2. Check free eligibility before sponsoring Grok and again before signing.
   Preserve the first accepted assessment, no automatic paid retries and
   uncertain-submission guards. Requotes cannot silently raise user consent or
   trigger a new assessment.
3. Update new-candidate reads, projection/events, deployment verification,
   recovery, database certification and distribution bindings. Reuse existing
   Confirming reveal and finalized-gallery behavior. Add only the controls and
   messages needed to exercise this contract, using isolated profiles.

Exit: compatible adapters and targeted integration tests. Do not bypass R5's
unresolved installed-startup review-pin boundary to claim a hosted package.

Completed with [C6 integration evidence](pulse-contract-c6.md). The candidate
contract lock is unchanged. No active runtime, staging deployment or real
provider request was used. **Next: C7, GPT-6 Sol · High.**

## C7 — rehearse the complete flow locally

Use disposable Anvil/PostgreSQL and fixture assessment providers, preserving
the active `.local/rehearsal` and historical backups. Exercise repeated-wallet
slots, both phase endings, a free assessment crossing the deadline, first/later
paid mints, price changes, same-block competition, wallet rejection, reload and
restart, then Confirming-to-Minted projection. Verify allowances, payment,
provenance and provider/signing/send counts across recovery. Run relevant app,
contract/tool and renderer-lock regressions.

Exit: reproducible local flow evidence. Real-provider and public-network
acceptance remain separate from fixture results.

C7 complete September 26: four real browser mint/reveal paths and six economic/
recovery scenarios passed on disposable Anvil/PostgreSQL. The rehearsal found
and fixed free-phase paid-view reads and isolated-site fee copy, with regression
coverage. The frozen contract candidate is unchanged. See [C7 evidence](pulse-contract-c7.md).
**Next: C8, GPT-6 Astra · XHigh.** Stop at the manual model checkpoint.

C8 subsequently completed; the C7 result above is historical checkpoint evidence.

## C8 — review the complete candidate and update the release plan

Review cross-layer invariants and C7 evidence; fix remaining defects and rerun
affected checks. Record candidate/source/artifact identities, gas, dependency
and allowlist tooling, and remaining operational inputs. Mark which R1–R4
mechanisms were reused and which new bindings were actually verified.

Exit: contract refactor locally ready for the website/flow discussion. Resume
R5–R10 against the chosen revised product after that work. Real provider calls,
staging deployment/activation and launch retain existing operational boundaries.

C8 complete September 26. The [final review](pulse-contract-c8.md) fixed independent
wallet-plan identity checks and stale free-block paid quotes, corrected a rehearsal
handle-hash assertion, and added real free/paid reorg coverage. The refreshed
four-browser/eight-scenario rehearsal passes, as do 496 focused application tests,
120 database/HTTP/projection tests (7 existing skips), candidate locks and typecheck.
Contract bytes are unchanged. R1–R4 reuse and remaining exact operating bindings
are explicitly distinguished. **Stop here for website/flow discussion; R5–R10
remain paused.** No deployment or active-runtime change is implied.

## Inputs needed before deployment

Final slot list, deadline, Pulse parameter values, treasury/role addresses and
actual chain/core bindings. C1 specifies their schema/ranges; fixtures use
explicit test values. Do not invent production economics to advance a step.

September 27 exception: the user separately approved disposable Sepolia inputs
(two slots for the existing operator, seven-day deadline, nominal test prices,
separate mint authorizer). Both contracts were deployed and byte-verified, and
free/free/paid mints passed. See [test-only evidence and remaining website checks](pulse-sepolia-test.md).
This is not selection of production economics/custody or R5–R10 acceptance.

Sources: [Pulse release](https://github.com/inshell-art/pulse/releases/tag/pulse-core-v1.0.0),
[tagged integration guide](https://github.com/inshell-art/pulse/blob/pulse-core-v1.0.0/docs/evm/pulse-core-integration.md),
current `GenerativeSignaturesV1RC1.sol` and [paused R5 evidence](r5-release-bootstrap.md).
