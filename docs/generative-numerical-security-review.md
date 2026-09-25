# Generative candidate: internal numerical and security review

September 22, 2026. **Internal review with executable checks, not independent audit approval or public admission.** Applies only to the unchanged `generative-v1-rc1.json` release lock, SHA-256 `508eefdca3073b8ba97d8a56bc407b9c5c3a6cd8e85a009ad483949d47c386b4`. No candidate code, historical artwork, compiler settings or release identity was changed.

## Scope and reproduction

```sh
npm run test:contract
npm run generative:release:check
npm run generative:numerical-review
npm run test:generative:numerics
```

`contracts/tools/generative-numerics.mjs` verifies the complete release/source/build lock, then evaluates a manually derived BigInt worksheet. It enumerates **every digit/non-digit topology** for lengths 1–15, not every character string. The report has no admission authority. It does not implement symbolic execution, automatic range analysis, formal verification, universal floating-point equivalence, a worst-case gas proof or a provider benchmark. The arithmetic premises below still require reviewer scrutiny.

The deployed port uses signed fixed-point `Q = 10^18`. Integer division truncates toward zero. Most arithmetic is checked, but `_mul`, `_div`, `_cubic` and `_derivative` include unchecked operations, so their ranges matter; checked division still rejects zero. See the compiler's [division semantics](https://docs.soliditylang.org/en/v0.8.30/types.html#division) and [checked/unchecked arithmetic](https://docs.soliditylang.org/en/v0.8.30/control-structures.html#checked-or-unchecked-arithmetic).

## Structural bounds

For length `L`, digit count `D` and digit-run count `R`, digit-layout allocation uses `L + D + R` points. Since `R <= L - D + 1`, this is at most `2L + 1 <= 31`. Without digits, there are `max(2,L)` points. An independent push-count simulation checks all **65,534** length/mask combinations against this bound. This exhausts layout topology only; digit values and letter seeds still affect geometry.

| Quantity | Derived upper bound |
| --- | ---: |
| Points | 31 |
| Outline-centering evaluations, `(points - 1) × 65` | 1,950 |
| Samples on one side before the endpoint | 252 (29 points, nine samples/segment) |
| Sampled-path vertices, including both endpoints | 506 |
| Bézier curve fragments | 60 |
| Bézier-path offset evaluations | 242 |

All geometry arrays are nonempty; all segment routines see at least two points. Centering min/max sentinels are replaced before arithmetic. Sample divisions have `n >= 8`; other sample denominators are fixed positive constants. `_append` checks capacity before `mcopy`; the shortened bytes/point arrays never exceed their original allocations under these counts. These observations do not prove every memory operation safe independently of compiler correctness.

## Denominators and arithmetic premises

1. `_unit` uses at most 53 hash bits and gives `[0,Q)`. Raw seed lengths stay within 120Q. `_gap` is at least 0.45Q and at most 2Q. The nondigit total is positive when there is more than one letter. A digit layout has at least one digit and `Q <= total <= 43Q`; its scale is at most 300Q. Positive, downward-truncated advances sum to no more than the span, itself at most 300Q. Digit pulses are at most 90Q.
2. For the perceiving Y transform, magnitude and inverse lie in `[0,Q]` and sum to Q. At least one is `>= Q/2`, so its nested fixed-point cube is `>= Q/8`; `a+b` cannot be zero. Its ratio is at most Q. Letter Y shifts stay within ±40Q, underscore shifts within 0–50Q, and digit Y anchors within 140–280Q.
3. `_sin` reduces its argument to ±PI and evaluates 21 terms. A triangle-inequality recurrence using the same positive truncations bounds the absolute sum by `11.548739357257748363Q`, strictly below 12Q. This loose bound is about safety, not the approximation error versus mathematical sine.
4. Anchors are within 360Q in absolute coordinate value. With 120Q control lengths and the sine bound, raw controls are within 1,800Q. First centering adds at most 2,010Q, giving 3,810Q. Cubic Bernstein coefficients are nonnegative with sum at most Q after downward truncation; cubic positions stay inside this symmetric bound. Derivative coefficients sum to at most 3Q, so each component is bounded by six times the control-coordinate bound.
5. `floor(sqrt(dx²+dy²)) >= max(abs(dx),abs(dy))` for integer components. When both components are zero, the explicit Q fallback applies. Thus each normalized component is at most Q. Smoothstep remains in `[0,Q]`; width interpolation remains between endpoint widths, including a negative width difference under toward-zero rounding. Half-width is at most 7.5Q.
6. Outline centering therefore leaves controls within 7,837.5Q, rounded conservatively to **7,838Q**. Final offsets fit **7,846Q**. `_through` has `abs(a),abs(b) <= 36B`, numerators at most 108B and controls at most 6B; emitted Bézier controls fit **47,076Q**.
7. A conservative envelope of **1,000,000Q = 10^24** contains geometry operands and post-division intermediate sums, including `_through`'s numerator (`108 × 7,846Q`). Pre-division products and square sums fit `2 × 10^48`, far below signed int256 maximum. This envelope excludes raw cryptographic hash words, addresses, memory pointers and temporary min/max sentinels, which have separate handling. The 53-bit cast, fixed small counters, positive sqrt result, coordinate negation/absolute-value and decimal formatting stay within their respective integer domains.

The worksheet recomputes the numerical envelopes; the callsite classification and inequalities above are **manual premises**, not discoveries made by the tool. No input supplied by a browser bypasses handle/MBTI validation in the locked renderer. Changing validation, constants, source, compiler or dependencies requires renewed analysis under a new reviewed lock; do not regenerate the current lock to make checks pass.

## Output-size derivation

After hundredth rounding, sampled coordinates need at most eight characters including sign and decimal point; Bézier coordinates need at most nine. Thus the sampled path is at most `506 × 18 + 1 = 9,109` bytes, below its 16,384-byte scratch buffer. Sixty Bézier fragments plus the initial/end commands require at most 3,641 bytes.

The worksheet counts static UTF-8 string literals in the exact locked render/metadata functions, adds worst-case legal dynamic values and applies base64/ABI expansion. The literal counter is deliberately not a general Solidity parser; escaped literals require review. No arbitrary handle/MBTI characters, dynamic description or supplied SVG can enter these templates.

| Read payload | Conditional bound | Application ceiling |
| --- | ---: | ---: |
| SVG | 9,506 bytes | 16,384 |
| Metadata JSON | 13,259 bytes | 30,000 |
| Token URI | 17,709 bytes | Bounded by ABI envelope |
| Canonical tokenURI ABI return | 17,792 bytes | 65,536 |

These are conservative, source-bound size estimates **conditional on the manual geometric derivation**, not observed maxima. The [176-case metadata campaign](generative-read-limits.md) supplies separate measurements. Neither size bounds nor loop counts prove a 30m-gas ceiling for every handle or actual RPC acceptance. Whole-request deadlines and streaming JSON caps remain required.

## Security findings and operating consequences

| Finding / test characterization | Required treatment |
| --- | --- |
| Existing code-bearing callers are rejected, but a contract has zero code during construction. A constructor mint succeeds with a valid operator signature explicitly issued to that future address; a forged signature still fails. | Do not describe `code.length` as proof of EOA/private-key control. Keep recipient-bound backend wallet proof and issuance policy. If contract-level exclusion of construction-time callers becomes a requirement, it needs a new reviewed design, not a silent RC patch. |
| Changing authorizer A→B rejects A's signatures; restoring A revives unused, unexpired, unrevoked signatures. | Rotation is not permanent revocation. Reconcile each known outstanding authorization by verified mint, nonce revocation or strictly-past-deadline finalized evidence. |
| A dishonest signer can pre-sign a future 900-second window. Restoring it a day later can make that authorization valid. | **Never restore a compromised authorizer. Waiting 900 seconds is not a compromise remedy.** A window-duration cap does not constrain its future start. Unknown signatures cannot be exhaustively reconciled from the application's journal. |
| Pause/unpause preserves signed authorizations. Pause stops minting, not transfers or reads. | Use pause as containment, not retirement or rollback. Recovery preserves uncertainty; the existing operator API deliberately supports only its exact finalized-expiry route. |
| The contract checks the authorized signer and input commitments; it cannot establish Grok's authorship, X-account existence or psychological truth. | Backend assessment integrity, wallet proof and signer custody remain explicit trust boundaries. Authorizer-manager powers are immediate; delayed default-admin transfer is not a delay on every privileged operation. |
| Token identity is case-normalized handle, while rendering inputs and metadata are fixed and case-preserved. | No reassessment, owner transfer, signer rotation or renderer alias may rewrite a minted output. A new renderer needs a distinct reviewed deployment/profile. |
| SVG path bytes are deterministic, but the caption names system fonts. | Do not claim byte equality implies identical caption pixels on every viewer. Marketplace/device rendering is a separate compatibility check. |

The constructor counterexample assumes valid authority deliberately issued to a nonstandard recipient. It is **not** evidence that an ordinary user can forge backend authority or bypass the current wallet-proof flow. No `tx.origin` restriction or unreviewed contract change was added to mask it.

## Evidence and remaining work

The new Solidity cases exercise construction with valid/forged authority, signer restoration, persistent nonce revocation, pause/unpause and future-window restoration. Legal-input rendering fuzz checks successful canonical ABI, the conditional SVG-size bound and an explicit 30m local call budget; it is finite randomized evidence, not proof. Existing oracle, input-only mint, packed-input, uniqueness, role and replay tests remain intact.

Validation for this increment: **177 Solidity tests passed**, including **512 runs** of the new legal-artwork fuzz test; **16 numerical-tool tests** and the existing **119 release-tool tests** passed. Typecheck, build, original renderer/slogan locks, unchanged RC lock and whitespace checks passed. CI now includes the numerical worksheet and its tests; hosted CI was not observed. Application runtime code was unchanged this increment, so the full application/PostgreSQL suite was not rerun; its preceding checkpoint remains documented in [read-limit regression evidence](generative-read-limits.md#regression-evidence). Ignored logs: `.local/generative-renderer/numerical-contract.log`, `numerical-release.log`, `numerical-build.log`.

Remaining: independent review of these premises/trust boundaries; broader numerical/rounding and gas adversarial work as warranted by review; actual independent-provider reads and wallet/device compatibility; the [separate runtime-admission implementation](generative-runtime-admission-policy.md). Nothing here grants provisioning, deployment, signing, public startup or activation permission. No paid provider request, public RPC request or public transaction was made.
