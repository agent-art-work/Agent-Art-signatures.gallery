# C7 — complete isolated Pulse mint/reveal rehearsal

Completed September 26, 2026. This is **local development evidence**, not public
deployment approval, a live Grok acceptance test or an independent audit.

## Reproducible output

`scripts/pulse-c7-rehearsal.mjs` starts its own Anvil child, deploys the exact
released Pulse Core and frozen collection/renderer, creates a disposable
PostgreSQL cluster with restricted browser/recovery roles, and drives the actual
site controls in headless Chrome. It never loads `.env.local`, accepts an existing
database/RPC/deployment, touches `.local/rehearsal` or modifies historical backups.
Literal public fixture keys sign only this disposable chain's transactions.

Run after the existing offline contract build:

```sh
npm run open:contract:build
OPEN_MINT_TEST_POSTGRES_BIN=/opt/homebrew/opt/postgresql@16/bin \
  npm run pulse:c7:rehearsal -- \
  --visual-tool /Users/bigu/.codex/skills/visual-dom-cdp/scripts/verify-page.mjs
```

The PostgreSQL binary directory and Visual DOM CDP script path may be adjusted
for the local installation. Chrome, Anvil and PostgreSQL 16 must be available.
The program prints the unique `/tmp/sg-pulse-c7-evidence-*/report.json` path and
retains screenshots there; it closes all writers/listeners, removes only its own
disposable PostgreSQL directory and stops only its own Anvil child.

Final captured evidence: `/tmp/sg-pulse-c7-evidence-l9ggzo/report.json`.
The report binds both rehearsal source hashes and the current integration
inventory. Re-running produces new addresses, clocks, receipts and evidence paths.

Subsequent [C8 review](pulse-contract-c8.md) corrected this rehearsal's losing-handle
hash assertion and extended it with free/paid reorg and stale-quote checks. Use
C8's retained v2 report for the reviewed current runner; this C7 record describes
its original checkpoint and does not alone prove the corrected assertion.

## Browser acceptance

All four paths use SIWE, a read-only quote with **no preselected mint mode**,
explicit free/paid consent, the actual durable authorization/dispatch endpoints,
and genuine local-chain inclusion. Before inclusion the accepted MBTI stays
hidden. Every path shuts down and reopens the backend writer while pending,
reloads, reveals with **Confirming**, and enters the gallery only after the
explicit test finality boundary advances.

| Path | Fixture X / Grok calls | Backend signatures | Wallet send attempts | Actual broadcasts |
| --- | --- | --- | --- | --- |
| First free slot | 1 / 1 | 1 | 1 | 1 |
| Second slot, same wallet | 1 / 1 | 1 | 1 | 1 |
| First paid mint, first wallet attempt rejected | 1 / 1 | 1 | 2 | 1 |
| Later paid mint, wallet response lost after broadcast | 1 / 1 | 1 | 1 | 1 |

For the lost-response path, the client submission and intent journals are removed
before reload. The durable backend still blocks another send. Rejection requires
an explicit Continue action; neither recovery path repeats an assessment or signs
again. Paid transactions fund exactly the chosen ceiling, treasury receives the
receipt's actual ask, and the buyer's balance delta equals ask plus receipt gas:
unused ceiling ETH is refunded.

The Visual DOM CDP skill verified 1024×1200 light and 390×1200 dark layouts.
All four final SVG images decode, there is no horizontal overflow or HTTP error
response, accepted fixture model/source provenance is present, and variations
retain exactly fifteen Preview tiles beside the one minted interpretation.
Screenshots were also visually inspected. This uses an injected fixture wallet,
not an acceptance test of a particular installed wallet extension.

## Economic and recovery matrix

| Scenario | Verified outcome |
| --- | --- |
| Repeated wallet slots / exhaustion | Distinct slots consumed once; two free successes close free mint; first and later paid epochs advance |
| Assessment crosses the free deadline | Old free authority is refused before signing; explicit paid request reuses byte-identical accepted inputs with no extra X/Grok call; unused slots remain unclaimed and paid start is anchored to the deadline |
| Phase changes before Grok dispatch | One completed identity lookup, zero Grok/signing/send effects; no automatic paid fallback |
| Price changes after preparation | Stale ceiling is rejected without signer/provider effects; an explicit larger ceiling reuses the accepted assessment |
| Two paid transactions in one block | Exactly one succeeds, one reverts; one epoch advance and one treasury payment; losing handle and authorization nonce remain unused |
| Restricted recovery after the genuine revert | Refuses recovery without finalized expiry evidence; after expiry retires the unused authorization atomically; preserves accepted inputs and sponsorship history; issuance remains disabled; no new provider/sign/send effects |

The two read adapters deliberately point to the **same disposable Anvil node**.
Finalized observations read genuine blocks but use an explicitly controlled test
boundary to demonstrate Confirming versus Minted. This is not evidence of
independent public RPC providers or Ethereum Sepolia consensus finality.

## Defects found and corrected

1. **Free-phase chain reads:** C6 tried `getCurrentPrice`/`getPulseState` before
   paid activation; those contract views intentionally revert. Free observations
   now have mint price `0` and paid state `null`. Paid observations still read the
   actual effective curve. The chain fixture now reproduces the free-phase
   reverts, and both phase branches have regression coverage.
2. **Public copy in the isolated Pulse composition:** its page factory omitted
   the Pulse flag and `/about` incorrectly advertised no mint fee. The factory
   now carries the selected economic profile; a page regression and each browser
   path check the corrected free/paid explanation. This file is now in the
   integration inventory.
3. **Historical-profile regression assumptions:** registry order no longer
   determines the experimental default. Profile tests explicitly retain the
   historical bytes and reject crossed Pulse/historical authorization domains,
   calldata and renderer pins. Pure Sepolia Pulse encoding does not activate
   any public runtime.
4. **Existing operating-settings regression:** version detection accessed a
   caller-supplied `schema` getter before descriptor validation. Detection now
   reads the own data descriptor; the existing adversarial test passes without
   invoking the getter. This does not certify or activate staging settings.

No contract bytecode, ABI, renderer lock or economic policy was changed.

## Verification and identities

- Application suite: **5,995 passed**, 624 gated tests skipped; final run used
  `npm test -- --maxWorkers=2 --minWorkers=2`.
- Pulse PostgreSQL suite: **6 passed**, including real-clock expiry recovery.
- Historical generative pipeline, durable HTTP and projection PostgreSQL suites:
  **114 passed**, 7 existing skips, with both PostgreSQL/HTTP flags enabled.
- Foundry: **230 passed**, no failures/skips.
- Pulse allowlist/model/candidate/inventory tools: **15 passed**; separate
  released-bytecode campaign also passed all **67 vectors**, 1,025-slot proofs,
  receipts, payment atomicity and same-block limits.
- Type checking, candidate freeze verification, renderer/slogan locks and
  whitespace checks passed.

An initial sandboxed full-suite run could not bind local test listeners; it was
rerun with loopback access. A high-concurrency run timed out the existing
subprocess-heavy assessment CLI test; the final bounded-concurrency suite passed
without relaxing its assertions or timeout.

Contract candidate lock remains
`029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8`.
Current **45-file** integration inventory is
`19e053b49329a6d6ba969b36b0c85ba77abe011378252c09d9afbe82b38dc94a`.
The C6 inventory is historical evidence, not a certificate for these fixed bytes.
The local database schema remains unchanged; public startup remains refused.

## Next checkpoint

**C8 — GPT-6 Astra · XHigh:** final cross-layer integration review, evidence
review and candidate handoff. Review the defects/fixes, asymmetric free/paid
observations, signature/slot/payment/recovery invariants, the test-only wallet and
finality boundaries, and release inventory coverage. Stop for the user's manual
model checkpoint. R5–R10 remain paused, including the unresolved fresh-writer
review-pin boundary; real provider and Sepolia operating acceptance remain
separate. No commit, merge, push, live provider request or public deployment was
performed for C7.
