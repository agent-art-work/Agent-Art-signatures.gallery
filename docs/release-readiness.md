# Release readiness — current execution order

Audited September 23, 2026; updated for the September 25 pre-Pulse checkpoint. This is the cross-cutting view of
[E00–E24](development-plan.md), not a replacement architecture, deployment
approval or another operating-policy validator.

**Verdict:** the generative mint/reveal feature is integrated and locally
rehearsed. It is **not yet a deployable, operationally accepted staging release**.
The next work should close the concrete gaps below, not keep adding generic
admission layers. Real Grok acceptance is still missing; Sepolia is not needed
to establish it.

## Evidence and its limits

**September 24 update: R1 is implemented and verified offline.** The new opt-in
reviewed policy separates background-job and paid-response lifetime from short
dispatch-time freshness; v1 hashes/behavior are preserved. Current official
provider pricing was reviewed and a new profile proposed, not enabled.
[R1 implementation, limits and test results](r1-assessment-lifetime.md).
**R2 is also complete offline:** exact accepted assessment evidence is now
optionally joined after verified inclusion, with honest chain-only fallback,
bounded reads and provider-free restart. [Implementation and verification](r2-generative-provenance.md).
**R3 is complete offline:** the final Astra · XHigh review strengthened source
pinning, verification-before-open, interrupted-state behavior and cleanup safety.
Eight cross-cluster restore tests pass, including transfer/reorg, stale-revocation
refusal and zero repeated effects. The reviewed runbook retains completeness
and original-source isolation requirements. Existing 14 populated-migration and
60 runtime/site tests passed in steps 2–4. [Scope and evidence](r3-backup-restore.md).
**R4 is complete offline. R5 steps 2–4 are partially implemented and paused.**
The [R4 specification](r4-staging-recovery.md) separates read-only diagnosis from
one explicitly approved expired-authorization retirement, with a versioned DB
upgrade, distinct finalized/latest freshness bounds and preserved uncertainty.
The separate inspection/recovery roles, staging-only v2 catalog, signed exact
action and atomic retirement are exercised on disposable PG16 and synthetic
Sepolia; v1 restore still passes. The final review fixed revision pinning,
operator-role checks, expiry at commit and guarded v1→v2 migration. The 17-case
integration campaign and targeted final reruns pass; recovery preserves the
first assessment and resumes only through a separately approved fresh request.
The [R5 checkpoint](r5-release-bootstrap.md#implementation-checkpoint--september-25) records the detached
distribution, authenticated inputs/adapters, fresh-epoch review handshake,
read-only operator commands and package/restart acceptance matrix. Packaged
`check`, `inspect` and `verify-backup` exist. Installed `serve`, `migrate-v2`
and `recover` are unavailable; the fresh-epoch review revision-pin design
remains unresolved. R5 implementation and acceptance are incomplete. The
user has paused R5–R10 to design the limited free-mint allowlist, Pulse Core
v1.0.0 integration and associated website flow before resuming release work.
No paid approval, live call, active-runtime change or staging deployment occurred.
R3's test-only completion witness is not production backup authentication or
live-restore approval.

- September 23 audit base: `codex/execution-table`, HEAD `7d66666`. That
  commit alone does **not** reproduce the later renderer, staging integrations
  and tests. The September 25 pre-Pulse checkpoint captures that later tree;
  earlier hosted passes cannot certify the checkpoint.
- The latest E22 campaign passed 216 focused tests, 711 regressions and 59
  runtime/site tests: **986 distinct tests**, three scripted-wallet browser
  flows, two PNG checks and six inspected screenshots. This is reused evidence
  from [the sharing checkpoint](generative-staging-sharing.md), not a new full
  campaign or the total coverage of the entire application.
- Existing disposable-Anvil evidence covers the distinct RC1 contracts,
  input-only mint, chain-generated metadata, restart and recovery. The recorded
  6,080 exact SVG comparisons are finite samples, not universal fidelity/security
  proof. The staging browser suite uses synthetic RPC and wallet sends; it is
  not a substitute for that EVM evidence or an installed wallet extension.
- `generative:release:check` still reports `candidate-not-approved`. Upstream
  signature v2.0.0, slogan-only v2.0.1 and EVM renderer RC1 remain distinct.
- [E10's original and approved recovery](validation/e10-pilot-2026-09-20.md)
  both recorded X HTTP 402. Neither reached Grok. A successful paid assessment,
  live provenance or measured successful-call cost is **not established**.

The core invariants already have implementation evidence: handle-only token
identity, preserved verified casing, first accepted assessment, wallet intent,
durable provider fences, no automatic paid retries, immutable input authority,
one-send guards, verified Confirming reveal, finalized galleries/sharing, and
staging privacy. Reuse them. No IPFS, finished-SVG storage/compression, OAuth
claiming or browser-supplied authoritative MBTI returns to the plan.

## Concrete gaps found in code — September 23 audit

The timing, provenance, restore and local-only recovery findings below are
historical: R1–R4 close their offline implementation gaps. R5 has since
partially implemented package/operations work, as recorded above. Real-provider acceptance and activation remain
separate; the old v1 policy is intentionally not widened, and chain-only
recovery without saved evidence still does not invent Grok attribution.

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Paid-job lifetime is coupled to short HTTP/RPC admission budgets | `generative-staging-worker.mjs` passes `hosting.requestTimeoutMs` to the worker; `generative-staging-assessment.mjs` uses it around each admitted leg. `operatingPlan.ts` caps it at 30,000 ms. The inner `generative-admission.mjs` gate additionally uses RPC timeout/evidence TTL around effects. `GROK_PILOT_PROFILE.timeoutMs` is 90,000 ms; X defaults to 15,000 ms. | A valid slower assessment can hit an enclosing deadline before its provider timeout. The tighter inner gate also needs design, not just the worker timer. Mock success does not prove real latency compatibility; not every Grok call necessarily fails. |
| Old pilot generation is date-disabled | `generationPolicy(false, {}, new Date('2026-09-23T00:00:00Z'))` returns `enabled: false`, `disabledReason: pricing-review-required`; the recorded review boundary is September 21 at 19:00 UTC. | Credits or keys alone do not enable a new attempt. Review current official pricing/profile and account association, then obtain a fresh bounded paid envelope. Do not simply move the date or widen the consumed approval. This observation concerns the local pilot policy, not every supplied staging policy. |
| Generative provenance omits saved assessment details | `projection/generativeArtwork.ts::detail` returns chain inputs/commitments but no `assessmentProvenance`, model, time or sources. `provenance.ts` correctly displays “Not recorded” without them. | E11's shared presentation exists, but its generative data integration is incomplete. Chain-only recovery must remain honest; optional validated stored evidence can enrich ordinary minted pages. |
| Restart evidence is not a complete RC1 disaster restore | Generative tests cover restart, migrations and database-free artwork recovery. The explicit `pg_dump` restore test found in `persistence/publication.test.ts` belongs to the older publication path. | Need a populated RC1 database dump/restore rehearsal that preserves paid fences, pending wallet dispatches, revocations and immutable data. A database certification hash is not a restore test. |
| Expired-authorization retirement remains local-only | `GenerativeRecoveryChain` requires 31337. `generative-recovery-schema.sql` requires 31337 and `local-real`; that recovery migration is outside the nine-file staging schema lock. | Do not claim Sepolia operator recovery is complete or merely relax a chain check. It needs a distinct reviewed adapter/migration, role and certification integration. |
| Normal application startup is still the older local path | `src/main.ts` calls `startOpenMintApp`; it uses file-backed records and `startIsolatedLocalChain`. The staging composition is in `contracts/tools`, imports source TS and explicitly refuses production. | A green `npm run build` does not package a hosted generative service. Need an explicit bootstrap/distribution path with real adapters and reviewed configuration; never use `NODE_ENV=development` to evade refusal. |
| Operations are declared more than they are deployed | Operating settings contain support/custody/backup references; paused readiness has its own health listener. Site options do not yet pass the shared `supportUrl`. | Need active-site diagnostics/health, selected support wiring, runbooks, alert delivery and authenticated infrastructure evidence. Labels/digests do not prove the referenced service exists. |
| Product acceptance remains open | `home-guidance` uses `min(16px,3.1cqi)` and `nowrap`; the prior mobile audit recorded 8–10px text. Wallet checks use scripted providers. The About priority-claim decision is unresolved. | Complete readable mobile/keyboard/theme/zoom checks, actual wallet acceptance and approved claim scope. Do not call the selector screenshot matrix full site QA. |

## Ordered work packages

These refine existing E-items; they are not extra release milestones. Finish
one bounded increment at a time and update its evidence. “Ready” means local
development can proceed without a new user decision, not permission to spend
or activate a service.

| Order | Package / E-items | Next deliverable and acceptance | Gate |
| --- | --- | --- | --- |
| R1 | Assessment timing and current provider profile — E09/E21 | Implemented versioned job/response budgets, fresh one-use dispatch, fast 202/private polling and no replay. Slow responses, timeout/uncertainty, disconnect, withdrawal, shutdown, legacy behavior and review-hash compatibility are tested. Current official pricing reviewed; new provider profile proposed, not enabled. [Evidence](r1-assessment-lifetime.md). | **Complete offline, September 24.** Fresh operational profile/account review and paid acceptance remain R8; old approvals are unchanged. |
| R2 | Generative provenance integration — E11 | Both site compositions optionally join the exact accepted namespace/handle/assessment commitment after verified inclusion, rechecking spelling/MBTI/input bindings and projection freshness. Only existing public fields are exposed; missing/mismatched/unavailable evidence leaves verified art usable without inferred attribution. Privacy, cancellation, restart, SQL and light/dark browser checks pass. [Evidence](r2-generative-provenance.md). | **Complete offline, September 24.** Real saved-provider evidence remains R8; no schema change or paid call. |
| R3 | RC1 migration and backup/restore rehearsal — E17/E21 | [Steps 1–5 verified offline](r3-backup-restore.md). Eight cross-cluster tests cover exact rows/permissions, private revocations, interrupted authorization/dispatch, fresh writer/review, transfer/reorg, chain-only rebuild and stale/unknown refusal. Reviewed runbook; zero repeated fixture effects. | **Complete offline, September 24.** Live manifest custody, source isolation and hosted recovery remain operational acceptance; no active data or historical backup touched. |
| R4 | Staging operator recovery and support — E03/E04/E21 | [Steps 1–5 complete offline](r4-staging-recovery.md): restricted inspection, exact v2 upgrade, independently pinned action, fresh finalized-expiry proof, atomic retirement, lost-commit inspection and fresh-request resumption without reassessment. Final review fixes and rollback/restore evidence recorded. | **Complete offline, September 24.** No live-operation authorization. R5 still owns artifact/backup authentication, DB identity/custody and runnable integration; real-record recovery and public support remain separate. |
| R5 | Runnable release package and operating integration — E16/E19/E21 | [Steps 2–4 partially implemented](r5-release-bootstrap.md#implementation-checkpoint--september-25): detached compiled artifact, exact reviewed files, authenticated adapters, read-only maintenance, backup authentication and private health. Installed owner startup, effect-capable maintenance and the full acceptance campaign remain. | **Paused before Pulse integration; not accepted.** Resolve the fresh-epoch review-pin boundary and update exact contract/configuration bindings after product design. Astra · XHigh step 5 remains pending. |
| R6 | Product acceptance — E12/E13/E14 | Finish About wording after claim-scope choice; allow readable mobile guidance after the deliberate one-line policy is resolved. Complete 320/375/390px and desktop, light/dark, keyboard/status announcements, 200% zoom/reduced motion and actual declared wallet/version matrix. Keep approved slogan, caption/navigation and reveal behavior. | Routine testing is **ready**; wording/layout reversals and wallet support scope are user decisions. |
| R7 | Pin and verify the complete release tree — E00/E24 | Review all accumulated tracked/untracked work, preserve history, capture a reproducible revision/distribution, run complete clean-checkout app/PG/contract/tool checks and the browser matrix. Observe hosted CI for that exact revision after an authorized push. Collect review scope and unresolved findings. | Local verification is **ready**; checkpoint/publish actions follow the user's applicable authorization. Do not label current HEAD as the tested dirty tree. |
| R8 | Real X → Grok → local Anvil acceptance — E10/E11 | Confirm the configured X token belongs to the funded account; reconcile prior attempts. Use a newly reviewed explicit one-attempt envelope and the selected generative flow, not just the superseded file-backed launcher. Record a real accepted or truthful unsuccessful outcome, costs/latency, mint/reveal if accepted and provider-free restart/reuse. | **External account evidence + paid approval.** Can run once R1/R2 and the necessary isolated runner are ready, alongside R3–R7; not blocked on Sepolia. |
| R9 | Hosted Sepolia acceptance — E23 | Select actual infrastructure/custody/sources; deploy the approved exact candidate paused, verify independently, certify DB/hosted proxy/TLS/read limits, then separately review activation. Exercise installed wallets, transfer/collections, support, reload/recovery and hosted sharing. | **Deployment/funding/provisioning and activation approvals**, plus release evidence. Network/origin selection alone is insufficient. |
| R10 | Independent review and launch decision — E24 | Resolve findings against the exact release and prove operational owners, emergency stop, backups, retention/support and claim evidence. Record go/no-go; production indexing/cache policy is a separate explicit choice. | **Independent review and explicit launch approval.** Review preparation starts earlier, not only after Sepolia. |

R1 must not be “fixed” by raising every HTTP/RPC deadline, increasing witness
freshness, weakening cancellation tests or trusting an expired permit. HTTP
response time, admission/observation validity, paid transport lifetime and
cleanup ownership are different concerns. The existing async assessment
scheduling already returns 202; extend that bounded worker design rather than
introducing Redis, an unbounded queue or automatic paid restart.
Inspect both admission `prepare`/`execute` and controller/worker timers. Separate
fresh authority required immediately before dispatch from bounded completion
and receipt accounting for an already-dispatched call; an expired witness may
not authorize another effect. Cancellation or review withdrawal must never
turn possible spend into a safe retry or permit a late mint/sign operation.

R4's reviewed migration/profile revision and populated-data evidence now exist
offline. They do not permit startup to regenerate a database lock, authenticate
a backup by checksum alone or expose a public “clear pending” control. R5 must
preserve those boundaries in its runnable operator/bootstrap integration.

## Decisions to collect, when their work reaches the boundary

1. **Provider retry:** account/app association and billing evidence, current
   profile and maximum accepted exposure, exact handle/attempt and no-retry
   scope. Previous approval was consumed; xAI credits do not prove X access.
2. **About:** retain worldwide “First” only with an agreed definition and
   supporting evidence addressing the recorded contrary examples, or approve a
   narrower interpretation. This audit does not redo the dated research or
   silently change the slogan.
3. **Mobile/wallets:** recommended desktop one-line guidance with readable
   small-screen wrapping; initial injected EOA desktop scope, actual Rabby and
   MetaMask candidates. WalletConnect/smart accounts are not implied scope.
4. **Operators/infrastructure:** hosting/PG owner, two genuinely independent
   RPC sources/accounts, reviewed separated key custody, review-key ownership,
   backup destination/retention and support/incident contact. Do not infer that
   a personal email mentioned earlier is approved public support.
5. **Release actions:** exact code/contract candidate, deployment wallet and
   funding envelope, paused deployment versus activation, and eventual launch.

These decisions do not block R1–R5's offline development. Ask at the relevant
boundary with a concrete proposal; do not repeat a broad “approve?” after every
ordinary implementation step.

## Separate backlog and exclusions

The [Inbox](../INBOX.md) retains the disk-cleanup request for
`.local/backups/pre-formal-v1-20260910`. Its reported size is not remeasured here;
retention is not decided, and no backup or `.local/rehearsal` was opened, changed,
archived or deleted for this audit. It is housekeeping, not evidence that the
new generative database can be restored. Handle it separately with the original
exact-target and recovery/health checks.

D01 (xAI subscription integration) remains external and nonblocking; D02
(multi-account assessment quality/cost study) remains optional and separately
budgeted. No new scheduler, account registration, message, paid lookup,
deployment, wallet signature, key discovery or environment switch occurred.

## Verification of this audit

Read code paths, locked release metadata, existing plan/runbooks and local E22
logs; reproduced the date-closed pilot policy using an **empty supplied config**
and a fixed timestamp, not `.env.local`. Rechecked typecheck and the RC1 release
lock. No full campaign, hosted CI, current pricing research or live account
entitlement is claimed by this documentation audit. Historical logs retain
their original scope/date; future acceptance belongs to the new pinned release.
