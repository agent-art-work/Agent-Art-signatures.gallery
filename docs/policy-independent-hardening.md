# Policy-independent hardening — October 2, 2026

The user authorized all five follow-ups after checkpoint `33fb02f` was merged
and pushed to `main`. Work is isolated on `codex/policy-independent-hardening`.
Free-mint allocation/policy and paid Pulse parameters are still awaiting input.
No paid provider call, public chain transaction, funded-key custody change or
production deployment is part of this work.

| Item | Output | Verification |
| --- | --- | --- |
| CI selection | Separate bounded Pulse job plus independently bootstrapped core, admission, staging and recovery lanes; every inherited campaign command retained | Exact 44-command preservation guard, YAML validation, selected suite execution; hosted results recorded separately |
| RPC deadlines/fallback | Shared read budgets, browser fetch/body cancellation and validation-flight ownership fences | Slow-primary/healthy-secondary loopback HTTP and client regression; cancellation, stale completions, conflict and no-send guards |
| Mobile/accessibility | Readable guidance, stacked narrow wallet controls, visually wrapped allowlist rows, accessible headings/phase/status | [48-case real Chrome evidence and scope](pulse-ui-accessibility.md) |
| Documentation | Current RC2/port 3007/admin/relay/early-reveal summary; historical RC1 and R1–R5 evidence remain labelled | Updated development/readiness tables without declaring hosted release acceptance |
| Historical backup | Preserve unique pre-formal rollback as fully verified private archive; remove only redundant loose copy | [1,587 entries verified, about 3.51 GiB footprint reduction, restore runbook](preformal-backup-retention.md) |

## RPC/read policy

Action budgets are one source **20 seconds**, complete semantic read
**45 seconds**, and RPC-backed browser API read **50 seconds**. This leaves
space for a timed-out primary, an independently validated fallback attempt,
and HTTP/JSON completion. Background source/pass budgets remain 20/45 seconds;
existing explicit long history/audit limits are retained. No paid-dispatch,
wallet-approval, nonce, receipt, or finality policy was widened.
An initial tighter proposal was rejected after a healthy live background sale
pass took 15.4 seconds: the fix must allow fallback without manufacturing read
failures through an unmeasured ten-second source limit.

Failure of one endpoint permits one **read-only** whole-operation fallback.
Partial evidence is discarded rather than mixed across sources. Contradictory
chain/code/mint evidence still fails closed; signatures and broadcasts never
enter the read retry controller. An aborted shared-validation owner no longer
poisons a still-live waiter, and a late old completion cannot clear a new flight.
The browser deadline includes JSON-body parsing and discards uncooperative late
responses without revealing artwork or unlocking another mint.

Viewing still uses relay evidence without RPC warnings. Loading feedback is
immediate for requested mint checks; genuine mint-affecting failures remain
next to the CTA. A timer is not evidence that an uncertain transaction failed.

## Limits and next input

Mocked browser/RPC/PG and offline contract checks do not certify a hosted
installation, actual wallet-extension matrix, manual screen-reader experience,
live Grok attribution, production economics or independent security review.
Hosted CI is a separate execution check, not acceptance of a staging deployment.
R5–R10 remain paused. The next product inputs are the actual free-mint list/quota
and closure policy plus paid Pulse configuration; do not manufacture them.

## Combined verification

- Full application/HTTP/disposable PostgreSQL coverage campaign: **6,845 passed,
  7 existing non-applicable skips, zero failures** across 6,852 tests.
- Unchanged coverage ratchet passed: statements **94.69%**, branches **91.89%**,
  functions **97.71%** (minimums remain 93/87/97).
- Offline Foundry campaign: **251 passed, zero failures/skips**.
- Dynamically selected Pulse mock/disposable-PG regression: **497 passed,
  zero failures/skips**. Standalone C5 JavaScript/Anvil differential tests remain
  explicitly separate from this mock-only selector, not silently omitted.
- Backup helper: **5 passed**. Full real historical extraction/content/permission
  verification is separate measured archival evidence, not a synthetic test.
- Real Chrome matrix: **48 passed**, with zero failed assets, external fixture
  requests or JavaScript exceptions; representative screenshots inspected.
- Build, typecheck, renderer/slogan locks, Core/RC1/RC2 integration locks,
  CI selection guards and whitespace checks passed.
- Future-staging controller/worker native-coverage campaign: **84 passed**,
  including eight test-harness regressions; **100% lines/functions and 99.34%
  branches**, with its existing 100/98/100 thresholds unchanged.

Local evidence files are `/private/tmp/sg-hardening-final-coverage-20261002.json`,
`coverage/coverage-summary.json`, and `/private/tmp/sg-ui-a11y-final/results.json`.
Synthetic browser screenshots/results are the only evidence selected for the
new CI artifact upload; private backup manifests and real-site screenshots
are excluded. The archived backup and current dev runtime remain local.

The first hosted run exposed two test-portability defects, both corrected without
changing production rules or test thresholds. The RC2 verification fixture now
uses independent, hash-checked offline compilation to resolve semantic immutable
names instead of incidental compiler AST IDs; full runtime bytes and every
reference group remain checked, including renumbering and drift regressions.
Font/license HTTP checks now have separate per-asset cases with the original
exact-byte/header assertions and default five-second limit, rather than putting
all 16 subsets and artwork setup into one timing budget. The Pulse campaign also
passed against a forced clean offline Foundry rebuild.

The next hosted run passed the complete Pulse lane, including its real Chrome
matrix, but the inherited all-in-one verification job reached its 35-minute
ceiling while the staging worker suite waited without producing a result.
Controller tests had passed. Test checkpoints now race the actual operation and
a diagnostic deadline, so an early refusal/completion cannot leave an
unreachable callback waiting forever. Held mocks release in `finally`; close,
drain and teardown also have test-only bounds. A fatal teardown timeout stops
only the private cluster allocated by that suite and remains a test failure.
No application timeout, assertion or coverage threshold changed.

All 44 inherited campaign commands now run exactly once across independent core
(35 minutes), admission (20), staging (25) and recovery (20) jobs. Each fresh
lane installs locked dependencies, PostgreSQL 16 and offline contract
prerequisites; no lane imports another lane's state or artifacts. The separate
Pulse job retains its ten-minute ceiling. Serializing the two assessment test
files was slower in a local benchmark, so their existing concurrency remains
unchanged. Hosted execution of the partition must still be observed; it is not
inferred from these local passes.

After the local restart, read-only `/health` reported `mintReady: true`,
`galleryAvailable: true`, `observerHealthy: true`, no safety halt/conflict, and
the unchanged RC2 free policy (revision 2, quota 4, one successful mint).
