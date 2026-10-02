# C4 — adversarial and gas test record

September 25, 2026. Applies to the unchanged
[`SignaturesPulseMintV1RC1`](../contracts/src/release/SignaturesPulseMintV1RC1.sol)
candidate from [C3](pulse-contract-c3.md). This checkpoint adds tests and
measurements, not a deployed contract or revised economic policy.

September 26 update: [C5 review is complete](pulse-contract-c5.md). Its actual
transaction-receipt gas measurements supersede the execution-only samples below
for transaction costs; the C4 results remain historical test evidence.

## Reproduce

From the repository root:

```sh
npm run test:pulse:c4
(cd contracts && forge test --offline --match-contract PulseMintC4GasTest -vv)
npm run test:contract
npm run generative:release:check
```

`test:pulse:c4` reruns the C3 release-bytecode/ABI/size checks and 29 contract
tests, independently replays all **67 pinned Pulse release vectors**, and runs
the C4 Solidity tests. C4 adds **18 passing tests**, including two 512-run fuzz
properties (Foundry reported 513 runs for the slot state machine). The full
Foundry suite passes **225 tests**. The historical RC1 release lock remains
unchanged and passes.

The isolated tests deploy the exact pinned Pulse Core creation bytes, not a
consumer-compiler reconstruction. The separate BigInt model implements prices,
state transitions, rounding, invalid inputs and arithmetic bounds from the
released semantics; it matches all 67 upstream success/error vectors. The
collection is additionally checked against a separately calculated five-epoch
sequence, including long idle periods and ETH balances. A 512-run property
checks the initial quote over 100,000 possible second offsets.

## Invariants and adversarial coverage

- A proof for another wallet or slot does not spend a right. Duplicate-wallet
  slots are independently usable. The seeded state-machine test mixes valid,
  repeated and contended slot/handle attempts, checking the bitmap, minted
  count, nonce, balances and `freeMinted <= N` after each step.
- Signed fields, wrong signer, recipient, contract domain and chain cannot be
  substituted. Replays fail; case-insensitive handle identity is not reopened.
  The paid price ceiling and slot are signed, so a free signature cannot be
  turned into paid authority or a lower ceiling silently raised.
- The final free slot ends the free phase immediately. Deadline equality also
  closes it, with no reopening after pause/unpause. A free mint never consumes
  the paid block allowance. A failed or second same-block paid attempt cannot
  advance the Pulse epoch, spend a nonce/handle, move ETH or consume the block.
- Underpayment, rejecting treasury, rejected refund and callback reentrancy
  are covered across C3 and C4. The rejecting-treasury path rolls back
  collection/treasury/wallet balances, mint/provenance and paid state; retrying
  the same authorization succeeds and emits one paid-phase start. Foundry's
  `recordLogs` observes attempted logs even inside reverted traces, so those
  traces are **not** used as evidence of a successful transaction receipt.
- A zero ask after extreme idle time remains a paid sale. One mint was exercised
  at `uint64.max - 1`; authorization expiry at exact `uint64.max`, time bounds
  and constructor arithmetic rejection were checked without wraparound.

No candidate source defect was found in C4. This is targeted testing, not a
formal proof or independent audit. The subsequent [C5 review](pulse-contract-c5.md)
reviews the money-moving code and freezes the integration boundary.

## Measured execution gas

Measurements come from `gasleft()` around a single call in Foundry 1.5.1,
solc **0.8.30**, optimizer **200**, EVM **Prague**, using the actual pinned
Pulse release bytecode. The 1,024/1,025-slot tests build valid padded Merkle
trees with 10/11 proof elements; they are stress fixtures, not production
allowlist manifests. The list is represented on-chain by one root and `N`;
duplicate wallets use separate slot IDs without extra per-wallet storage at
deployment. Proof generation and signing happen outside measured calls.

| Scenario | Execution gas |
| --- | ---: |
| Deploy collection with 1,024 slots | 5,190,124 |
| Deploy collection with 1,025 slots | 5,246,058 |
| First free mint in bitmap word, 1-char handle, 1,025-slot proof | 263,833 |
| Subsequent free mint in same word, 15-char handle, 1,025-slot proof | 210,434 |
| First free mint in a new bitmap word, 1-char handle, 1,025-slot proof | 223,086 |
| Subsequent mint in that second word, 1-char handle | 203,641 |
| Same-word free mint, 1-char handle, 1,024-slot proof | 194,555 |
| Same-word free mint, 15-char handle, same setup | 206,287 |
| Final free mint, one-slot proof, including Pulse activation | 325,552 |
| First paid mint after exhaustion, same-block test context | 248,263 |
| First paid mint after deadline, fresh 1-char handle setup | 348,063 |
| First paid mint after deadline, fresh 15-char handle setup | 359,765 |
| Later paid mint with 15-char handle, warmed test context | 232,106 |

The controlled short/long comparisons are **+11,732 gas** for a same-word
free mint and **+11,702 gas** for a first paid mint in these fixtures. Other
rows have different state warmth, bitmap writes, proofs or phase work and
should not be subtracted to attribute a single cause. The 1,024/1,025
deployment difference is not a linear charge per allowlisted wallet: the
constructor stores only root/count. The shared harness's memory growth and
warm access context affect these measurements, including memory expansion
during creation after large test arrays. Do not attribute the deployment
delta to allowlist storage or immutable byte patterns. C5 measures separate
actual transactions with production-format proofs instead. The manifests/proofs should be produced by
the [C2 tool](pulse-contract-c2.md), not these padded test trees.

These are **EVM execution-gas samples**, not transaction gas limits or fiat
fees. A real wallet transaction adds intrinsic/calldata gas, may have different
warm/cold access and fork behavior, and pays a fluctuating gas price. The Pulse
Core and renderer are separately deployed dependencies; their deployment gas
is not included in the collection-deployment row. No live chain, provider,
paid API or treasury was touched.

## Next checkpoint at C4 completion

**C5 — GPT-6 Astra · XHigh:** review the contract and C1/C4 evidence,
especially callbacks/refunds, authorization and domain binding, phase consent,
the one-block rule, Pulse math boundaries, the 757-byte EIP-170 runtime margin
and remaining integration risks. Fix findings, rerun affected checks, and only
then freeze the ABI/authorization boundary for C6. R5–R10 remain paused.

This has now been completed in [C5](pulse-contract-c5.md). The active next
checkpoint is **C6 — GPT-6 Sol · High** for backend/wallet/observer integration.
