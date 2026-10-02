# C3 — free slots and Pulse paid mint contract

September 25, 2026. C3 implementation checkpoint for
[`SignaturesPulseMintV1RC1`](../contracts/src/release/SignaturesPulseMintV1RC1.sol),
following the [C1 specification](pulse-contract-spec.md) and
[C2 dependency/proof tooling](pulse-contract-c2.md).

## Implemented behavior

- Construction binds the supported chain, the exact released Pulse runtime,
  the published core address on Sepolia, and the existing renderer runtime.
  Sale parameters, root, slot count, deadline and treasury are fixed. The
  contract starts paused and preflights Pulse initialization and immediate
  advancement at both deployment time and the free deadline.
- `mintFree` validates the signed free mode/slot, wallet proof, unused bitmap
  bit, handle uniqueness and the backend attestation. Each successful mint
  consumes one slot. Different slots for the same wallet remain independent.
- The final successful free mint initializes Pulse at its timestamp. Otherwise,
  the free deadline closes the free phase without a keeper. Views derive Pulse
  epoch zero at that deadline; the first successful paid transaction persists
  it. A late first buyer receives the already-decayed price.
- `mintPaid` accepts exactly the signed maximum price, pays the actual ask to
  the treasury, refunds the surplus and advances Pulse once. The collection
  allows at most one successful paid mint per block; the final free mint does
  not consume that allowance. There is no paid supply cap. Configured zero asks
  still advance the paid epoch and consume the paid block allowance.
- Both routes bind immutable artwork inputs and assessment provenance to the
  existing case-insensitive handle identity. They preserve direct-wallet
  support, nonce revocation, signer management, delayed admin transfer and
  ordinary ERC721 transfers. Authorization validity is half-open at its
  deadline and at most 900 seconds. Free authorization is clipped to the
  free deadline.
- A shared reentrancy guard covers both mint routes and all fourteen tested
  mint/authority mutation entrypoints. Treasury or refund failure reverts
  reservations, inputs, NFT, Pulse state, block marker, payments and logs.

The implementation also rejects mint execution if the current chain ID differs
from the deployment binding. Existing RC1 source, runtime, interface, build
configuration and release lock remain unchanged. The new candidate is not yet
connected to the website or backend; those integrations belong to C6.

## Verification

Run from repository root:

```sh
npm run test:pulse:c3
npm run test:contract
npm run generative:release:check
```

C3 results:

- **29 focused Solidity tests pass.** They cover both phase endings, a single
  slot with an empty proof, duplicate-wallet slots, replay/expiry/recipient
  checks, rejected proofs and economic fields, payments and surplus refunds,
  both settlement failure paths, guarded treasury callbacks, same-block paid
  competition, selected constructor failures, bounds and read-time artwork.
- **Four Node checks pass.** The literal test deployment bytecode exactly
  matches the vendored Pulse release; all C1 interface functions, errors and
  events match the compiled candidate; the authorization ABI reproduces the
  TypeScript type hash and the independently computed EIP-712 digest checked
  in Solidity; runtime and full constructor bytes fit the chain limits.
- **207 tests pass in the full Foundry suite**, including historical contracts
  and renderer fuzz tests. This is not a claim that C4's new Pulse invariant
  campaign has run.
- **The historical RC1 release lock passes unchanged.** The test harness embeds
  verified released creation bytes so it needs no change to the locked Foundry
  configuration or filesystem permissions.

Tests deploy the actual Pulse Core 0.8.24/Shanghai release bytecode inside
Foundry's isolated EVM. They do not recompile Pulse under consumer settings.
Sepolia binding tests use an emulated chain and the published address; they
are not live-network verification. A test-only mocked refund rejection reaches
the failure branch without adding contract-wallet support to production code.

With solc 0.8.30/Prague and optimizer 200, candidate runtime is **23,819 bytes**
(757 below EIP-170). Creation bytecode is 43,720 bytes, or **44,264 bytes** with
the four constructor arguments (below EIP-3860's 49,152). C4/C5 must preserve
that runtime margin. These are development measurements, not a frozen release
hash or gas-fee estimate.

## Next checkpoint

**C4 — GPT-6 Sol · High:** expand adversarial, fuzz/invariant and gas tests.
Priorities include bitmap word boundaries and larger allowlists; independent
Pulse vector/model comparisons over later epochs and long idle periods;
signature/domain mutation permutations; additional constructor and arithmetic
edge cases; event/state reconstruction; and realistic free/paid gas measurement.
Any defects found should be fixed and rechecked before the C5 contract review.

No provider request, active rehearsal mutation, public deployment or release
activation was performed in C3. Real wallets, sale economics, deadline and
operational role/treasury choices remain later deployment inputs.
