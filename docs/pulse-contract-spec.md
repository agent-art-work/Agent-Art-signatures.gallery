# C1 — Signatures Pulse mint contract specification

September 25, 2026. C1 design for [the contract refactor](pulse-contract-plan.md).
Baseline: `f22d9d2`. This specifies the new candidate; it does not implement,
deploy or approve it for operation. C2 prepares artifacts, C3 implements Solidity,
C4–C5 test/review it, and C6–C8 integrate and rehearse the application.

Implementation status: [C3](pulse-contract-c3.md), the [C4 campaign](pulse-contract-c4.md)
and [C5 review/interface freeze](pulse-contract-c5.md) are complete. C5 records
the exact candidate lock, full ABI and shared authorization boundary.
[C6 integration](pulse-contract-c6.md), [C7 rehearsal](pulse-contract-c7.md) and
[C8 final review](pulse-contract-c8.md) are also complete for local development.
The C8 record distinguishes verified local behavior from unported R1–R4 hosted
operating bindings; this specification is not a public deployment certificate.

## 1. Identity, dependency and compatibility

| Item | New candidate |
| --- | --- |
| Solidity contract | `SignaturesPulseMintV1RC1` |
| Contract version | `sg-generative-pulse-mint-1.0.0-rc.1` |
| Contract profile | `generative-pulse-v1-rc1` |
| Input profile | `sg-generative-pulse-inputs-v1-rc1` |
| EIP-712 domain name / version | `SignaturesPulseMintRC1` / `1` |
| Authorization reservation version | `sg-generative-pulse-authorization-v1-rc1` |
| Wallet-plan version | `sg-pulse-wallet-plan-v1-rc1` |
| Allowlist format | `sg-pulse-free-slots-v1` |
| Renderer | Existing `SignatureRendererV1RC1`, version `sg-evm-renderer-1.0.0-rc.1`, exact existing runtime |
| Pulse dependency | Tag `pulse-core-v1.0.0`, commit `a08ec26e396b9d3e20ccebd8871f176368bcd713` |

Keep `GenerativeSignaturesV1RC1`, its domains, locks and saved records unchanged.
Use an explicit new deployment/profile; do not infer it from a URL, a matching
event signature or the presence of ETH. The renderer algorithm and artwork
inputs remain unchanged. The new input-profile string deliberately separates
input commitments from RC1 without claiming a new renderer version.

Preserve `handleKey = keccak256(abi.encode("signatures.gallery/open-handle/v1",
canonicalHandle))`, `tokenId = uint256(handleKey)`, 1–15 ASCII handle characters,
case-insensitive identity, verified display casing and the 16 literal MBTI codes.
The invariant is one handle per collection deployment; old local/test collections
are not a cross-contract uniqueness registry or automatically migrated tokens.

Keep the existing renderer-identity/input-digest formulas with the **new input
profile**. Preserve immutable assessment commitment, mint recipient, SVG/metadata
reads and ERC721 transfer behavior. No stored SVG, IPFS, supplied output hash,
reassessment-to-change-artwork, upgrade proxy, owner mint or alternate mint route.

The upstream release pins core runtime hash
`0xfb48657163202d3cdb28060f1eb511fd1f5b93a6e0eb8657242b5632e2200a90`.
Its published Sepolia binding is chain `11155111`, address
`0xfb1Cc26356b1b0361c414Ec1B5fB52c5FEDc3EAC`. These are read from the tagged
release, not freshly verified live-chain observations. C2 checks artifact hashes;
deployment verification later checks actual code and history. Anvil uses a local
deployment of the same core runtime on `31337`. This candidate supports those
two chains only. The core address/hash are immutable; no caller-selected engine.

Pulse's released build uses solc 0.8.24/Shanghai; this repository currently uses
solc 0.8.30/Prague for the consumer. Keep their build identities separate. Do not
recompile Pulse with consumer settings and label the result the released core.

## 2. Construction and fixed configuration

Constructor ABI is the following four arguments, in order. The tuple definitions
are in the interface below:

`constructor(address renderer_, CoreBinding core_, SaleConfig sale_, Authorities authorities_)`

Construction must:

1. Check `core_.chainId == block.chainid` and the supported-chain set. Require
   nonempty exact released core code, and the published address on Sepolia.
   The expected hash is pinned by the build, not accepted from a constructor
   field or computed from arbitrary observed code and then trusted.
2. Verify the exact existing renderer runtime. Validate nonzero admin, manager,
   pauser, revoker, authorizer and treasury; treasury must not equal this contract.
   Treasury may be an EOA or a contract capable of receiving ETH.
3. Require a nonzero Merkle root, positive slot count N, and `freeDeadline >
   deployedAt`. Both times must fit uint64. **N=0 is rejected** in this candidate.
4. Freeze root, N, deadline, treasury and the four Pulse parameters. There are
   no setters. `N` must match the published manifest's contiguous IDs `0..N-1`;
   release tooling verifies that relationship because a root alone cannot prove
   its leaf count to the constructor.
5. Preflight `initialize(config,deployedAt)` and an immediate `advance` at that
   time, and repeat at `freeDeadline`. Store neither simulation. This checks
   both launch boundaries; it cannot guarantee unlimited numerical headroom.
6. Preserve delayed default-admin transfer and separate manager/pauser/revoker
   roles. Start paused. Unpausing enables the effective current phase; it does
   not change the deadline or reset Pulse.

The Pulse config uses raw wei and integer seconds: `k`, `genesisPrice`,
`genesisFloor`, `pts`, exactly as upstream. `genesisPrice` is an anchor target;
the actual rounded opening quote must be displayed/calculated through the core.
The collection adds no numerical clamps or paid supply cap. Upstream uint64
epoch/uint256 arithmetic limits still exist and propagate explicit failures.
The full core domain is supported, including a zero floor/zero ask if deliberately
configured. Such a transaction is still a Pulse sale and uses the paid block
allowance. Choose a positive floor at deployment if paid asks must stay positive.

Expose `saleConfigHash = keccak256(abi.encode(`
`"signatures.gallery/pulse-sale/v1-rc1", block.chainid, address(this), core address,`
`pinned core runtime hash, rendererIdentity, treasury, freeMintRoot, N, freeDeadline,`
`k, genesisPrice, genesisFloor, pts))`, with the types above (strings are Solidity
`string`; N/chain/prices uint256; deadline uint64; hashes bytes32).
This binds installation/authorization-plan evidence to immutable economics.

## 3. Phase and clock semantics

Pause is independent of sale phase. Both mint entrypoints reject while paused;
reads remain available. The free deadline and Pulse clock keep running during
pause. There is no manual early close, deadline extension, reopening or reset.

| Condition at block timestamp t | Effective phase / state | Permitted mint when unpaused |
| --- | --- | --- |
| `freeMinted < N` and `t < freeDeadline` | Free; no active Pulse state | Eligible free slot only |
| Final free mint succeeds at `t < freeDeadline` | Paid, epoch 0 initialized at t; reason Exhausted | That transaction is free; a later transaction in the same block may be the first paid mint |
| `t >= freeDeadline`, free minting did not exhaust earlier | Paid; epoch 0 starts at exactly freeDeadline; reason Deadline | Paid only; unused slots have expired |
| At least one paid mint has succeeded | Paid; use stored next-state from that sale | Paid, subject to price and per-block checks |

Free equality is exclusive: `t == freeDeadline` rejects free minting. Every
successful free transaction increments the count once; rejected or reverted
transactions increment nothing. N is the sum of slots, not distinct wallets.

Exhaustion persists initialized state in the final free mint atomically. Deadline
activation needs no keeper: views derive epoch 0 at the immutable deadline until
the first successful paid transaction persists it. This is **effective scheduled
activation**, not an uninitialized conditional price presented as zero. The
first buyer cannot choose a later start time or reset the intervening decay.

`saleStatus()` reports the effective phase/start/reason even before that lazy
write. During Free, paidStartTime is zero and endReason None. `getPulseState()`
and `getCurrentPrice()` revert `PaidMintNotOpen()` during Free; after timeout they
use the same derived genesis state as `mintPaid`. No public raw-initialized flag
is provided that contradicts this effective state. Read config/state/time at the
same block hash/tag; chain progression may change any quote before inclusion.

Emit `PaidPhaseStarted` once when state is first persisted. On timeout its
startTime is the earlier configured deadline, not the event block timestamp.
If that paid transaction fails, persistence and event roll back; effective
time-based closure still holds. Deep chain reorgs may rewind state; phase
monotonicity is an invariant along a canonical history, not across all forks.

## 4. Slots and Merkle convention

Use OpenZeppelin StandardMerkleTree with ABI fields `["uint256","address"]`,
standard double-hashed leaves, sorted leaves and sorted-pair internal hashing:

`leaf = keccak256(bytes.concat(keccak256(abi.encode(slotId, wallet))))`

Example: slot `0`, wallet `0x1111111111111111111111111111111111111111` produces
`0x53d1ea11c02bccf00efa13950923d7ec0991024794dcc0a5de4788c13baf062c`.

Normalize addresses without deduplicating wallet rows. Assign IDs from ordered
input rows before tree sorting; a slot ID is not the tree's internal leaf index.
Reject invalid/zero addresses and duplicate/out-of-range IDs. Freeze N, root,
canonical slot list and tree dump/proofs together with content hashes. No random
salts, changing roots, tree trimming, multiproofs or batched mint entrypoint.

Require `slotId < N`, `recipient == msg.sender`, valid proof for that wallet and
an unused bitmap bit. Use `word = slotId >> 8`, `bit = slotId & 255`. Claim only
after all authorization/phase checks; failed minting reverts the bit. At most
256 proof siblings are accepted, including a valid empty proof for N=1. The
tooling checks the actual generated tree depth, which is much smaller in practice.

Entitlements are assigned to wallets and cannot be transferred independently.
An NFT can still be transferred after mint. Preserve RC1's direct-wallet mint
rule `msg.sender.code.length == 0`; it is a support restriction, not proof a
caller is human or a comprehensive bot barrier. Do not add tx.origin checks or
silently extend contract-wallet/relayer support in this refactor.

## 5. Authority and exact typed message

All mints require the backend's trusted-authorizer signature plus the caller's
transaction. The contract validates a backend attestation; it does not verify
a cryptographic signature issued by Grok itself. Mint MBTI continues to come
from the accepted controlled Grok assessment. Preview URLs supply no authority.

EIP-712 domain includes the name/version above, actual chainId and collection
verifyingContract. The primary type and exact member order are:

```text
PulseMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 inputDigest,address recipient,bytes32 nonce,uint64 issuedAt,uint64 deadline,uint8 mintMode,uint256 slotId,uint256 maxPrice)
```

Type hash: `0x65be64491ba939c2eb80eaa1c34208acaa5fc27c5d6b40889da86cce405f7150`.
Mint modes are `0=Free`, `1=Paid`; other uint8 values reject. `PAID_SLOT` is
`type(uint256).max` and is not a valid free slot. Field rules:

| Check | Free | Paid |
| --- | --- | --- |
| Entry | mintFree | mintPaid |
| Signed mode | 0 | 1 |
| Signed slot | ID in `[0,N)` | PAID_SLOT |
| Signed maxPrice | 0 | uint256 wei ceiling; may be zero only when the executed ask permits it |
| Attached ETH | 0; nonpayable function | Exactly maxPrice |
| Extra eligibility | Wallet-slot Merkle proof, unused bit | Effective Paid phase, paid block allowance |
| Authorization expiry | deadline no later than freeDeadline | Normal bounded authorization window |

For both: nonzero commitments/nonce; correct handle/input digests; recipient is
the caller; current trusted signer with canonical ECDSA; nonce neither used nor
revoked; handle not minted. Preserve a maximum 900-second authorization window.
Use `0 < issuedAt < deadline`, `deadline-issuedAt <= 900`, and half-open validity
`issuedAt <= block.timestamp < deadline`. This new candidate intentionally makes
expiry exclusive; legacy RC1's inclusive boundary remains unchanged. New recovery
adapters may retain the existing stronger finalized-time `> deadline` criterion.

The signed mode prevents a free signature being used for paid minting. The signed
slot prevents substitution between one wallet's slots. The signed ceiling and
exact msg.value prevent changing the payment without new authority and user
consent. No separate unsigned maxPrice argument duplicates the signed value.
Signature/domain/nonce checks remain necessary even with a Merkle proof.

## 6. Normative interface for C2/C3

This compiles as a standalone interface using the released IPulseCore definition.
The constructor uses CoreBinding, SaleConfig and Authorities below in that order.
Inherited ERC721/AccessControl APIs, existing artwork/digest reads, role constants,
trusted-authorizer management and nonce revocation also remain available. No old
`mint(...)` entrypoint is retained on the new contract.

<!-- c1-interface:start -->
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPulseCore} from "IPulseCore.sol";

interface ISignaturesPulseMintV1RC1 {
    enum Phase { Free, Paid }
    enum EndReason { None, Exhausted, Deadline }
    struct CoreBinding { uint256 chainId; address core; }
    struct SaleConfig {
        bytes32 freeMintRoot;
        uint256 freeSlotCount;
        uint64 freeDeadline;
        address payable treasury;
        IPulseCore.Config pulse;
    }
    struct Authorities {
        uint48 adminDelay;
        address admin;
        address manager;
        address pauser;
        address revoker;
        address authorizer;
    }
    struct Authorization {
        bytes32 handleKey;
        bytes32 assessmentDigest;
        bytes32 inputDigest;
        address recipient;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 deadline;
        uint8 mintMode;
        uint256 slotId;
        uint256 maxPrice;
    }
    struct SaleStatus {
        Phase phase;
        bool paused;
        uint256 freeMinted;
        uint256 freeSlotCount;
        uint64 freeDeadline;
        uint64 paidStartTime;
        EndReason endReason;
        uint64 lastPaidMintBlock;
    }

    function mintFree(string calldata handle, string calldata mbti,
        Authorization calldata a, bytes calldata signature, bytes32[] calldata proof)
        external returns (uint256 tokenId);
    function mintPaid(string calldata handle, string calldata mbti,
        Authorization calldata a, bytes calldata signature)
        external payable returns (uint256 tokenId);
    function authorizationDigest(Authorization calldata a) external view returns (bytes32);
    function saleStatus() external view returns (SaleStatus memory);
    function getPulseConfig() external view returns (IPulseCore.Config memory);
    function getPulseState() external view returns (IPulseCore.State memory);
    function getCurrentPrice() external view returns (uint256);
    function freeSlotLeaf(uint256 slotId, address wallet) external pure returns (bytes32);
    function isFreeSlotClaimed(uint256 slotId) external view returns (bool);
    function pulseCore() external view returns (address);
    function coreRuntimeCodeHash() external view returns (bytes32);
    function boundChainId() external view returns (uint256);
    function treasury() external view returns (address);
    function freeMintRoot() external view returns (bytes32);
    function freeSlotCount() external view returns (uint256);
    function freeDeadline() external view returns (uint64);
    function freeMinted() external view returns (uint256);
    function deployedAt() external view returns (uint64);
    function saleConfigHash() external view returns (bytes32);
    function PAID_SLOT() external view returns (uint256);

    event CoreBound(address indexed core, uint256 chainId, bytes32 runtimeCodeHash);
    event SaleConfigured(bytes32 indexed saleConfigHash, bytes32 freeMintRoot,
        uint256 freeSlotCount, uint64 freeDeadline, address treasury, uint64 deployedAt);
    event PaidPhaseStarted(uint64 startTime, EndReason reason, uint256 freeMinted);
    event MintEconomics(uint256 indexed tokenId, bytes32 indexed nonce,
        uint256 indexed slotId, uint8 mintMode, uint256 price,
        uint256 maxPrice, uint64 epochIndex);
    event Sale(address indexed buyer, uint64 indexed epochIndex, uint256 price,
        uint64 timestamp, uint64 nextAnchorA, uint256 nextFloorB);

    error InvalidCore();
    error WrongChain();
    error InvalidSaleConfiguration();
    error TimeOutOfRange();
    error BlockOutOfRange();
    error FreeMintClosed();
    error PaidMintNotOpen();
    error InvalidMintMode();
    error InvalidSlot();
    error SlotAlreadyClaimed();
    error InvalidSlotProof();
    error InvalidPriceLimit();
    error ValueMismatch(uint256 expected, uint256 actual);
    error PriceAboveLimit(uint256 ask, uint256 maxPrice);
    error PaidMintAlreadyInBlock();
    error TreasuryPaymentFailed();
    error RefundFailed();
}
```
<!-- c1-interface:end -->

`isFreeSlotClaimed` rejects IDs outside `[0,N)`; a false bit is not evidence of
wallet eligibility or of an open free phase. `freeSlotLeaf` is a pure encoding
helper, not an eligibility oracle. Return the actual epoch index from
`getPulseState`; lastPaidMintBlock is zero when no paid mint has succeeded.

Retain `GenerativeSignatureMinted`'s current event signature for artwork evidence.
Every mint emits it and MintEconomics with matching tokenId/nonce. Free economic
fields are mode 0, actual slot, price/maxPrice/epoch all zero. Paid fields are
mode 1, PAID_SLOT, executed ask, signed ceiling and the **new** epoch index.
Emit Sale only for paid mints, with upstream semantics: first paid sale emits
epoch 1, nextAnchorA/nextFloorB describe the next state. Events are authoritative
only from the verified candidate address in a canonical receipt.

## 7. Atomic execution and settlement

Both routes share the same reentrancy guard and ordinary pause/authority checks.
Validate narrowing before using chain time/block as uint64; never wrap or clamp.

Free route: check phase, signed free fields/authority, slot range/proof/unused
bit and artwork uniqueness. Reserve nonce/handle, set bitmap and increment count,
write inputs/provenance, and initialize epoch 0 if count reaches N. Mint the NFT
using the existing direct-wallet `_mint` behavior and emit artwork/economic events.
No ETH transfers, Pulse Sale event or paid block-marker update occurs.

Paid route:

1. Require effective Paid phase, signed paid fields/authority and handle/nonce
   eligibility. If a paid mint already succeeded in this block, reject. Guard
   the block check with epoch>0 so a zero sentinel is not mistaken for a sale.
2. Use stored state, or derive epoch 0 at the timeout deadline. Call `advance`
   once with stored config and chain timestamp. Require `ask <= a.maxPrice`
   and `msg.value == a.maxPrice`. No browser-supplied state, epoch or timestamp.
3. Commit next state, paid start/reason when needed, current block marker,
   nonce/handle reservations and immutable artwork/provenance before callbacks.
4. Send exactly ask to the immutable treasury; skip a zero-value transfer.
   Refund `msg.value-ask` to msg.sender when nonzero. Use checked low-level calls;
   any failure reverts the whole mint. Never retain a surplus or pay the core.
5. Mint the NFT, emit artwork/MintEconomics and Sale. A successful transaction
   leaves the contract's ETH balance unchanged from entry, excluding externally
   forced ETH. The minter's net payment is ask plus network gas, not maxPrice.

This sends the user's ceiling with the transaction and returns any surplus
within that transaction. Quotes reserve no price or position in a block. Price
above the ceiling or another paid mint in the block causes a revert; the app
does not silently increase the ceiling or automatically send a replacement.

No payable receive/fallback, withdrawal, owner sweep or fallback treasury is
added. Forced ETH does not affect pricing or count as revenue. A rejecting
treasury blocks paid settlement until it can receive; there is no config setter
to route around a bad deployment choice. Validate the actual treasury before
deployment. Preserve inherited ERC721 approvals/transfers; pause gates minting.

Guard authority mutations against callbacks during a mint too: pause/unpause,
setTrustedAuthorizer, revokeNonce, and inherited grant/revoke/renounceRole,
begin/cancel/acceptDefaultAdminTransfer, change/rollbackDefaultAdminDelay.
Keep their existing role/delay restrictions. Read callbacks may observe reserved
state before the NFT exists; do not use such provisional reads as final receipts.

Legacy input, signature, nonce and recipient errors remain explicit. Invalid
mode is checked before mode-specific fields, phase before the route's economic
effects, then authority/slot/block/price as above. Tests for individual errors
make other preconditions valid; do not establish a general precedence promise
for arbitrary multiple-invalid-input combinations. Core domain errors propagate.

## 8. Backend reservation, sponsorship and consent

The contract consumes a slot only on successful free mint. Backend admission
must separately prevent duplicate assessment spending while the slot is unused.
Reuse the existing writer, budgets, request, provider-dispatch and authorization
fences; this does not introduce another approval framework or job queue.

At an explicit free request, authenticate the wallet/session, validate the handle,
and read current phase, pause, root, slot bit and handle status. In one transaction,
reserve an eligible slot for `(namespace, deployment, wallet, request, handle)`.
Enforce at most one active reservation per slot and existing per-handle/per-wallet
work limits. Pick the lowest available wallet slot when none was selected. Bind
the exact slot before any provider dispatch; another tab returns the same work
or a contention result rather than funding a second request.

| Reservation condition | Permitted next action |
| --- | --- |
| Before any provider dispatch/signing, definitely cancelled | Atomically release reservation; no sponsorship consumed |
| Provider work has started | Preserve dispatch/accounting evidence; no concurrent sponsor use or automatic retry |
| Accepted assessment, no authorization yet | Keep result; resume preparation or explicit phase change with that same result |
| Signing, signed, staged, submitted or unknown | Keep slot/request association; a session timeout or claimed wallet rejection cannot release authority |
| Canonical mint included | Provisional claimed status and Confirming; finalization settles it |
| Reorg removes inclusion | Restore chain-derived status; retain assessment, spending ledger and dispatch uncertainty |
| Expired unused authorization retired with existing finalized reconciliation | Release active reservation; retain accepted assessment and consumed spending history |

Default sponsorship rule: **one automatic bounded X→Grok attempt per slot**,
at most one X lookup and one Grok call under the existing policy. Record a durable
slot sponsorship reference when the first provider leg is dispatched; cancellation,
abandonment, restart, receipt uncertainty or reorg never replenishes that budget.
Before dispatch, a definitively unused reservation can be reused. Cached accepted
assessments require no new provider spend and do not consume a sponsorship attempt.
A failed/abstained/uncertain attempt does not burn the on-chain mint right; another
paid attempt requires the existing explicit bounded operator recovery. This is a
cost-control default, not an additional on-chain mint condition or a guarantee
of one successful Grok answer per slot. No new approval is needed for each normal
free mint once its ordinary operating budget is enabled.

Recheck eligibility before each new provider leg and before signing. A provider
response already dispatched before closure may finish within the existing R1
completion policy and be stored. If the deadline passes before an undispatched
leg, do not start that leg under free intent. A completed accepted result survives
closure; an unfinished result is not fabricated or called a completed assessment.
Before dispatch, require current operational budget/freshness in addition to a
slot; completion follows R1's separate bounded completion checks.

After closure, an explicit paid intent may reuse accepted assessment evidence.
If no authorization was issued/staged, that intent can proceed with a new paid
request immediately after fresh checks. If old signing/authority/dispatch is live
or uncertain, reconcile it using the existing finalized-expiry path first. Free
expiry alone is not permission to erase a transaction or issue competing authority.
Reuse requires exact accepted identity/model/profile evidence, not browser MBTI.

Paid requests remain funded through the service's existing provider account and
bounded budgets. Anticipated mint proceeds are not deposited credit and do not
authorize unbounded Grok spending. This refactor adds no assessment-fee transaction.

User consent has mode and maximum wei amount, captured in the private request
with wallet/session generation, deployment and saleConfigHash. A paid request
must present that ceiling before authorization; never derive consent from a GET.
The backend creates the typed fields from saved intent/evidence. It must not
accept caller-supplied assessment, domain, nonce, curve state or recipient changes.

## 9. Durable field changes and integration mapping

| Area | Required new-candidate binding |
| --- | --- |
| Profiles and input journal | New profile/input/domain/reservation identities; unchanged renderer bytes and first accepted assessment |
| Deployment/operating record | Core chain/address/hash, saleConfigHash, root/N/deadline, treasury and Pulse config; immutable evidence for each |
| Request intent | mode, chosen slot or PAID_SLOT, maxPriceWei, wallet/session generation, accepted quote block/time and immutable config identity |
| Slot reservation | namespace/deployment/slot unique active owner; wallet, request, handle and sponsorship-attempt reference; append-only outcome evidence |
| Authorization payload | Exact new EIP-712 fields, profile and signature; preserve one live authorization head per handle and per reserved free slot |
| Wallet plan | New version, exact selector/calldata/proof and `value=0x0` for free or canonical hex(maxPrice) for paid; existing from/to/chain/wallet nonce guards |
| Eligibility snapshot | Same-block verified phase/pause, slot bit when free, handle/nonce, core/config/state, quote, block number/hash/time; existing two-source/freshness policy |
| Observer/projection | Match artwork and MintEconomics; paid also matches Sale and new epoch. Verify calldata/receipt/deployment context and reconcile reorgs |
| Recovery | Extend checks for signed mode/slot/ceiling and slot availability. Preserve existing conservative finalized-expiry and unknown-submission rules |
| Release/DB locks | New explicit candidate/schema/artifact revisions; old payloads continue to decode only under their original profile |

Numeric wire values use canonical decimal strings in persisted JSON and minimal
hex quantities for RPC; do not round wei through JavaScript Number. Preserve
exact-key parsing. The immutable wallet plan must survive reload/restart byte for
byte. A new quote alone does not change it. Increasing a cap or changing mode
requires explicit intent and a new authorization after prior authority is safely
resolved. Displayed gas is separate from the signed mint-price ceiling.

Existing change points include `generativeProfiles.ts`, `generativeInputs.ts`,
`generativeAuthorization.ts`, `persistence/generativeAuthorizations.ts`,
`persistence/walletSubmissions.ts`, the authorization/request/schema certification
files, `publicChain.ts`, projection decoders and `contracts/tools/generative-*`.
Today walletSubmissions reconstructs `value: "0x0"` in both stage and dispatch;
updating only the browser cannot produce a valid paid flow. R5 packaging also
pins RC1 ABI/code/constructor inputs and must receive separate new bindings.

Minimal product adaptations in C6 show eligibility/phase, actual ask and ceiling,
gas separately, and an explicit paid action after free closure. Preserve private
assessment access, reveal only after canonical inclusion, Confirming status,
finalized gallery promotion and provenance. Broad layout/copy changes and preview
MBTI collection remain deferred.

## 10. Acceptance matrix

No scenario below is claimed passed by documenting it. C3 supplies focused tests,
C4 the extended contract campaign, C6 adapter tests and C7 the complete rehearsal.

| ID | Scenario / required result | Step |
| --- | --- | --- |
| D01 | Wrong chain/core/address/hash/renderer rejects construction; historical profile cannot impersonate new candidate | C2–C3 |
| D02 | Zero root/N, past/equal deadline, zero roles/treasury, self-treasury or invalid Pulse preflight rejects | C3 |
| D03 | Config/root/deadline/treasury/core cannot be changed; starts paused; unpause preserves clock | C3–C4 |
| M01 | Deterministic 1,024+ leaves/proofs; duplicate wallet slots remain distinct; reordered tree leaves retain slot IDs | C2–C4 |
| M02 | Wrong wallet/slot, invalid/malformed/oversized proof and claimed bit reject; N=1 empty proof works | C3–C4 |
| M03 | Multiple slots mint different handles; same canonical handle across casing variations rejects | C3–C4 |
| M04 | Bitmap word boundaries 255/256 and last slot; failed transaction restores all state/events | C3–C4 |
| T01 | Deadline minus one allows free; equality/plus one reject free and expose derived paid state | C3–C4 |
| T02 | Nth success before deadline initializes once at its timestamp; final free is not a Sale | C3–C4 |
| T03 | Timeout with unused slots: view quote equals first paid execution at the same timestamp; start stays deadline | C3–C4 |
| T04 | First paid attempt after timeout fails: no persisted state/event, but effective paid phase remains | C3–C4 |
| T05 | Last free and first paid can succeed in one block; second paid fails; failed paid attempt does not consume block allowance | C3–C4 |
| T06 | Paused across deadline, resume after long idle: no free reopening or epoch/time reset | C4 |
| A01 | TS/Solidity typed hashes match; old domain, other chain/contract and tampered handle/MBTI/mode/slot/ceiling reject | C2–C4 |
| A02 | Auth at issuedAt accepted; at deadline expired; 900-second maximum and clipped free deadline enforced | C3–C4 |
| A03 | Wrong sender/signer, used/revoked nonce and unsupported code-bearing minter reject | C3–C4 |
| P01 | Exact ceiling attached; actual ask to treasury; surplus returned; equal ceiling accepted | C3–C4 |
| P02 | Wrong value, ask above cap or bad payment reverts nonce/handle/curve/block marker/balances/events | C3–C4 |
| P03 | Treasury callback cannot enter either mint route or authority mutators; refund failure unwinds transaction | C4 |
| P04 | Independent model/upstream vectors match first/later epochs, rounding, zero ask if configured and long-idle decay | C4 |
| P05 | Arithmetic/time/block/epoch bounds explicitly reject; no clamping or artificial paid supply cap | C4 |
| P06 | Sale event reconstruction matches config/curve; free events never advance epoch | C4 |
| B01 | Two tabs using one slot create at most one active reservation and sponsored provider attempt | C6 |
| B02 | Cancel before dispatch can release; after dispatch never restores spending; cached accepted work avoids provider calls | C6 |
| B03 | Deadline crossed between X and Grok blocks a new free-funded leg; an already-dispatched bounded reply is handled under R1 | C6 |
| B04 | Accepted free assessment after closure stays available; paid signing requires fresh explicit paid consent | C6–C7 |
| B05 | Prepared free authorization/unknown send cannot be replaced by paid authority on timeout or browser rejection alone | C6–C7 |
| B06 | Changed cap/quote, stale block, signer failure, lost COMMIT and restart preserve exact records and no automatic effects | C6–C7 |
| B07 | New paid values pass only the new profile; RC1 value-zero and old domain checks are unchanged | C6 |
| E01 | Real disposable EVM/PG: free sellout and deadline paths, two slots per wallet, first/subsequent paid mint | C7 |
| E02 | Canonical inclusion → Confirming → finalized gallery/provenance; reorg rewinds chain projection but never refunds API budget | C7–C8 |
| E03 | Reload/restart/recovery reuses inputs and saved authority without repeated Grok/sign/send effects | C7 |
| G01 | Measure setup/free/paid/transition gas, 1,024+ list sizes, bitmap first/reused words, short/15-char handles | C4 |
| R01 | Renderer parity/locks, immutable historical records, new deployment/code/schema bindings and active rehearsal isolation | C6–C8 |

Refund-failure/callback tests must respect the current direct-wallet policy;
use clearly test-only adversarial instrumentation where a production path is
unreachable, never broaden production wallet support merely to reach a branch.
All price/fund properties are assertions on the consumer, not inherited guarantees
from the stateless core. No contract tests require real X/Grok requests.

## 11. C1 completion and remaining decisions

C1 settles the engineering defaults above: fixed clocks, half-open deadlines,
lazy timeout state, no zero-slot launch, direct-wallet support, immutable treasury,
signed phase/slot/ceiling, exact-ceiling funding with same-transaction refund and
bounded slot sponsorship. These are reviewable choices in the new candidate;
they do not silently change existing contracts or operating policies.

Before deployment, the user still selects the actual slot list/deadline, Pulse
economics, treasury/roles and launch timing. Decide whether a positive floor is
desired when choosing those economics. None blocks fixture development. Real
provider acceptance, staging deployment/activation and the paused R5 owner-review
pin issue remain separate. No production keys or live environments are needed
to complete C2–C5.

C1 validation completed September 25:

- The normative 20-function interface compiles with solc
  `0.8.30+commit.73712a01`, importing the tagged released IPulseCore interface.
- EIP-712 member order extracted from that compiled ABI reproduces the documented
  type string/hash. Mint selectors are `mintFree=0x1cc08a94` and
  `mintPaid=0x4f2e209c`.
- The ABI library independently reproduces the documented double-hashed leaf.
- Tagged IPulseCore SHA-256 and runtime-bytecode Keccak-256 match the tagged
  release manifest. No live chain endpoint was queried.
- Phase/clock rules were reviewed against the upstream historical initialization,
  rounding, quote and advance rules. Repository documentation changes pass
  whitespace checks.

These are specification checks, not a claim that the unimplemented consumer has
passed the acceptance matrix. No dependency, runtime, contract implementation,
database, provider call or active environment was changed in C1.

Sources: [Pulse Core release](https://github.com/inshell-art/pulse/releases/tag/pulse-core-v1.0.0),
[frozen core API](https://github.com/inshell-art/pulse/blob/pulse-core-v1.0.0/docs/evm/pulse-core-api.md),
[consumer guide](https://github.com/inshell-art/pulse/blob/pulse-core-v1.0.0/docs/evm/pulse-core-integration.md),
[OpenZeppelin StandardMerkleTree](https://github.com/OpenZeppelin/merkle-tree),
[EIP-712](https://eips.ethereum.org/EIPS/eip-712), and the local RC1 contract,
authorization, wallet-submission and recovery code referenced above.
