# R4 — staging operator inspection and expired-authorization recovery

September 24, 2026. **Steps 1–5 complete and accepted offline after the final
safety review and fixes.** This is the specification for R4 in
[Release readiness](release-readiness.md). It authorizes no live recovery,
database migration, provider call or deployment.

## Manual checkpoints

| Step | Deliverable | Model / status |
| --- | --- | --- |
| 1 | Recovery rules, permissions, versioned storage/API design and acceptance matrix | Astra · XHigh; design complete |
| 2 | Bounded, sanitized read-only operator inspection and its permission tests | Sol · High; implemented, offline tested |
| 3 | Explicit staging recovery adapter, migration/profile integration and audit ledger | Sol · High; implemented, offline tested |
| 4 | Failure/restart/restore/end-to-end tests, CI command and operator runbook | Sol · High; implemented; regression evidence below |
| 5 | Final invariant review, fixes and offline acceptance decision | Astra · XHigh; complete, accepted offline |

The user selected Astra · XHigh and explicitly clarified this turn as R4 step 5,
not R5. Stop here before R5's separate bootstrap-design checkpoint. No automatic
model switching, subagents or ntfy. Implementation details
may be refined within these boundaries; do not silently widen the recovery action
or weaken its evidence requirements.

## Output and limits

An operator can explain a stuck attempt without exposing its private result,
and explicitly retire one expired, unminted authorization only after fresh
Sepolia evidence and exact database checks. Retirement preserves all history
and the first accepted Grok assessment. It does not mint, sign or retry anything.

R4 delivers internal libraries/composition, disposable fixtures, versioned grant
and migration recipes, tests and a runbook. The deployable credential/file/CLI
bootstrap belongs to R5. Do not create a public recovery endpoint or a generic
SQL console. Inspection is not an authorization to act on the inspected record.

Work only on disposable PG16 and synthetic Sepolia RPC fixtures, with public
test keys. Keep `.env` files, the active `.local/rehearsal`, historical backups,
real records/providers/RPCs and wallet extensions out of scope. No contract or
renderer changes, IPFS, finished-SVG storage, commits/pushes or new paid approval.

## Findings in the current code

| Existing boundary | Implication for R4 |
| --- | --- |
| `generativeRecoveryChain.ts::GenerativeRecoveryChain` constructs a local-only gate and requires chain 31337 | Add a separate Sepolia RC1 reader. Do not change that check to accept more chains. |
| `persistence/generativeRecovery.ts` reuses the local issuer, a process-local plan, a full snapshot and atomic retirement | Reuse its semantics and pure validation where safe, not a fabricated `local-real` namespace or an unchecked staging guard. |
| `generative-recovery-schema.sql` requires `local-real`, `grok`, 31337 and disabled issuance | Leave the historical local migration unchanged; staging gets a separate appended migration. |
| The locked staging database is nine migrations / 35 tables; full catalog and ACL hashes are checked | Adding an operator role or table changes certification. Introduce an explicit database v2; never overwrite v1 hashes or accept “v1 plus some extras.” |
| `stagingRuntimeBinding`, paused readiness and the certifier currently select the v1 lock directly | Wire explicit v1/v2 selection throughout both startup and per-operation checks. A migration without a usable upgraded runtime is not completion. |
| Existing grant audit assumes full-table SELECT and checks extra privileges principally on its supplied table list | Inspector needs a separate column-level profile; v2 audits must also reject unexpected privileges on omitted application objects and effective inherited grants. Do not call the existing audit alone a complete inspector check. |
| Runtime errors already expose `diagnosticReference: request.attemptId` | Use that non-capability reference for bounded operator lookup; never ask for a browser mint code or cookie. |
| `createStagingEligibilityReader` already provides read-only Sepolia RC1 checks; active-state tooling separately verifies declared governance history | Compose both. Current storage getters alone must not excuse an undeclared pause/rotation/restoration history. |
| Local recovery applies one block-age limit to both finalized and latest evidence | Sepolia needs distinct reviewed `maxFinalizedAgeMs` and `maxHeadAgeMs`. Do not enlarge the mint/latest limit to accommodate finality. |
| Issuer rejects an old request once its authorization head is removed | Preserve that rule. Recovery enables consideration of a new explicit request, not reuse of the old browser intent. |

## 1. Recovery policy

The only mutation action is **`retire-expired-unminted`**, for one exact RC1
authorization in the configured `staging-testnet` / `grok` namespace on Ethereum
Sepolia 11155111, at `https://staging.signatures.gallery`.

| Observed condition | Operator result |
| --- | --- |
| Queued/running attempt, missing receipt, uncertain X/Grok spend, failed or abstained assessment, or no accepted immutable inputs | Explain the state. No requeue, reassessment, fence deletion, budget release or mint recovery. |
| Reserved, signing, unknown or signed authorization, with or without a wallet plan | Potential recovery target only; every state must meet the same finalized-expiry rule below. “Never saw a signature” is not proof that none exists. |
| Missing transaction/hash, rejected wallet report, revert, elapsed request/session, consumed EOA nonce or wall-clock expiry | Keep blocked. None alone makes the signed authorization unusable. |
| Canonical inclusion / finalized mint | No retirement. Use existing Confirming/finalized observation and reveal. Do not mint another token. |
| Finalized timestamp equals the deadline | Block: deadline equality is still valid to the contract. |
| Both reviewed sources agree on finalized time strictly past the deadline; handle unminted and contract nonce unused/unrevoked at finalized and latest; all other checks pass | Eligible for a separately reviewed, explicit retirement transaction. |
| Wrong deployment/profile, stale or disagreeing RPC, malformed evidence, paused contract, changed authorizer, used/revoked nonce, undeclared governance change or saved projection safety halt | Block for investigation. No alternative “force” route. |
| Missing/incomplete audit outcome after connection loss | Keep disabled; inspect the saved recovery ID and exact retirement state. Do not infer rollback or repeat SQL blindly. |

Paid-attempt reconciliation is deliberately **not** added by R4. The older
file-backed X-402 recovery path is not imported into the staging repository.
An operator explanation, missing receipt or apparent zero cost cannot create a
new spending allowance. Any future paid recovery needs its own reviewed design.

Retirement removes only the active application reservation and its wallet nonce
lease. It cannot cancel an external transaction or erase a signature. A pending
transaction carrying expired authority may still be mined and revert, consuming
gas and an EOA nonce. New requests must use the existing fresh chain/wallet nonce
checks; never prescribe “resend at the old nonce” as a consequence of retirement.
Pause and signer rotation are not substitutes for expiry. Compromised-signer
remediation remains separate; restoring that signer can revive unknown authority.

## 2. Read-only inspection contract — step 2

Proposed module: `src/openMint/persistence/stagingOperatorInspection.ts`.
Accept an already-connected, explicitly configured inspector connection plus
the exact namespace/deployment and a tagged UUID reference: `attempt`,
`authorization` or `recovery`. Do not resolve a database URL from ambient config,
search other namespaces, accept arbitrary SQL or support unrestricted handle lists.

Use a read-only, repeatable-read transaction and a bounded selected-record query.
Do not instantiate `ExclusiveWriter`, a job worker, issuer, signer, provider or
RPC transport. Inspection does not advance the writer epoch. It may run alongside
the site; label its result with the database observation time, not “live chain.”

### Report allowlist

- Report version, exact reference, configured deployment/namespace, observation
  time, canonical handle and relevant internal attempt/authorization/recovery IDs.
- Attempt/job state, dispatch-leg presence and times, terminal kind and a
  validated reason code; no raw exception text or provider message.
- Reserved exposure, receipt presence, reported cost status and known cost as
  exact decimal strings. A missing/uncertain cost stays unknown, never zero.
- Accepted assessment/input **presence and commitments**, not MBTI, raw payload,
  source posts, rationale, provider response IDs or pre-reveal artwork.
- Authorization state/deadline, active-head flag, recipient, wallet nonce lease,
  dispatch/report state and recorded transaction hash. A hash is labelled a
  report, not proof of mining; no signature, typed data, calldata or permit.
- Saved projection health/confidence and recovery status, explicitly not fresh
  verification. Fixed next-action codes such as `wait-for-observation`,
  `operator-reconciliation-required`, `review-expiry` or `already-retired`.
  `review-expiry` is advice, not a mutation permit.

Never select session/challenge secrets, CSRF, browser code/hash, permit/hash or
provider/assessment payload columns for this report. Construct every output field
explicitly; do not spread stored objects. Stored unexpected enums, inconsistent
joins or unsupported versions yield a sanitized blocked result, not guessed success.

Bound defaults: one input reference, at most 32 related requests/authorizations,
up to the schema's five dispatches per request, 64 KiB serialized report and
five seconds per SQL statement. Query one extra row to detect overflow; return
`inspection-incomplete` rather than silently dropping rows and claiming eligibility.
Cancellation must close/drain owned query work before connection reuse. Error
messages and logs must not include SQL parameters, credentials or private rows.

### Inspector role

Add a dedicated `sg_inspector`-style non-owner login with only explicit SELECT
columns on the required metadata/configuration/ledger tables. No `SELECT *`
grants on requests, receipts, authorizations or wallet plans; no session or
challenge access. No writer-epoch update, policy toggle, INSERT/UPDATE/DELETE,
role membership/delegation, ownership, creation, grant options or reachable
security-definer escape. No chain or service credential is supplied to inspection.

Grant SQL is an explicit operator recipe, not code that auto-provisions a role.
Implement a dedicated column-profile auditor rather than loosening the full-table
runtime auditor. Audit effective privileges, including PUBLIC/membership and
unexpected application objects; exercise actual denied SQL as the inspector.
Step-2 grant fixtures are disposable. Granting an inspector on a live v1 database
would change its locked ACLs; activation waits for the v2 integration below.

## 3. Versioned database and operating integration — step 3

### Compatibility contract

Keep `GENERATIVE_DATABASE_MIGRATIONS`, `GENERATIVE_DATABASE_LOCK`'s existing
semantics, all nine source hashes, existing v1 review bytes, local recovery and
RC1 contract/input/renderer identities unchanged. Add an explicit
**`sg-generative-database-v2`** lock
and manifest: the original nine files followed by a new
`generative-staging-recovery-schema.sql`. Do not append to the v1 exported list.

Version the trusted configuration that selects it:

- `sg-sepolia-operating-settings-v2` / corresponding operating-plan v2 adds
  `database.schemaProfile` and the inspector role/secret reference alongside the
  existing separately named migrator/browser/projection/recovery principals.
  All new names/references remain unique. V1 parsing and hashes stay exact.
- Explicit paused/runtime database-review v2 forms bind schema profile and the
  complete declared role mapping, migration receipt and externally reviewed
  profile pins. Bind the chosen lock into operation/recovery scope digests.
- V2 catalog/ACL normalization uses explicit role identities, not “ignore all
  operator grants.” Audit browser, inspector and recovery capability profiles;
  keep browser mutation grants unchanged. The recovery principal must not be
  a member of the browser/migrator/inspector roles or vice versa.
- V1 rejects an upgraded catalog/ACL; v2 rejects an unmigrated or partial one.
  No automatic detection, fallback between locks, self-pinning or auto-migration.
  Existing ordinary constructors continue to reject public-chain use.

Resolve v1/v2 once from trusted explicit configuration and carry the exact profile
through paused readiness, active database checks, assessment/mint controllers,
read-only site startup, sharing and restored-site composition. Prefer a small
closed profile selector and shared pure helpers, not a second copy of the site.
R4 tests must prove the v2 runtime works after a reviewed upgrade; merely adding
a new recovery table while leaving all site startup checks incompatible is not done.

### Explicit migration

Before mutation, a reviewed migration runner verifies the exact v1 catalog,
disabled generation and issuance, drained site and released writer. The SQL
migration must take the existing two-key advisory transaction lock or fail,
check the supported staging profile, and run atomically. It must reject a mixed
local-recovery layout, wrong source or existing conflicting ledger. No startup
migration, permissive `IF NOT EXISTS` acceptance of arbitrary objects, row
relabeling, backdated authority or destructive down migration.

Create a separate append-only `staging_generative_recoveries` table. Record at least:

- Version/action, recovery ID, namespace/deployment, authorization/request IDs,
  authorization digest, pre-mutation snapshot digest and writer epoch.
- Operator/evidence references, exact approval revision and target digest,
  database binding and active-state policy digest.
- Finalized/latest block numbers, hashes and timestamps, observation/validity
  times, declared source IDs, recorded database time and bounded canonical
  evidence bytes. No raw endpoint, payload, signature or browser capability.

Require unique `(namespace, recovery ID)` and `(namespace, authorization ID)`,
exact foreign-key bindings and immutable UPDATE/DELETE rejection. Do not change
an authorization's original state to “retired”; that remains historical evidence.

Replace only the base immutable-head/plan triggers with staging retirement guards.
They allow precisely a matching head deletion and `nonce_active: true → false`,
after an exact audit row exists, both switches remain disabled, the same backend
holds the writer lock/current epoch, and finalized plus database timestamps are
strictly beyond the saved deadline. Preserve all other plan columns and rows.
A deferred consistency check must prevent committing an audit row without its
matching completed retirement. Missing or extra heads/plans fail the transaction.
Never release a different authorization's lease sharing a wallet/nonce.

SQL enforces consistency and permissions; it does **not** independently authenticate
RPC truth or the operator's approval signature. The separately audited recovery
process and credential custody remain part of the trusted boundary. Do not
present this as protection against a malicious database owner/operator.

### Recovery role

Separate non-owner `sg_recovery`-style login; no membership, policy enablement,
provider/job/budget mutation, session access, new authorization/signature/dispatch,
projection writes, history deletion or migration/grant powers. Give only needed
read access to validate exact private reservation/input/assessment bytes, read
policy flags and saved projection health, append the new ledger, remove the exact
active head, retire its lease and maintain the existing writer fence. Immutable
key-column update permission may be used only where PostgreSQL row locking needs
it; never grant the policy-switch columns. Private bytes stay inside validation.

Generate and audit this profile separately from the local recovery grants.
Browser/inspector principals cannot perform any retirement mutation. Bound SQL
statement/lock/idle timeouts and `search_path=pg_catalog`; retain PG16 durability.

## 4. Fresh Sepolia proof and action approval

Proposed `stagingRecoveryChain.ts` supplies an opaque, process-local witness,
distinct from both local recovery evidence and an exported diagnostic report.
Reusing pure decoding is fine; widening local constructors is not.

1. Bind the exact reviewed operating/deployment/release/database identities,
   Sepolia genesis, collection bytecode/domain/authorizer, renderer address/code/
   identity, RC1 input/reservation profile and the two declared source/operator IDs.
2. Use the existing active-state observer for exact deployment and declared
   governance history. Retain its conservative refusal of unsupported role or
   custody changes, paused state and restored-signer ambiguity. Source-independence
   declarations are not proof of actual independent hosting.
3. Read both sources' canonical finalized and latest anchors; require agreement,
   sane ordering and finalized timestamp **strictly greater** than the saved deadline.
4. Use the existing read-only staging eligibility reader at each exact anchor to
   verify collection/renderer/code/domain, unminted handle, unused/unrevoked signed
   nonce and the supported recipient checks. Use separate explicitly bound
   configurations for finalized and latest age limits: finalized derives from
   `rpc.maxFinalizedAgeMs`, latest from `rpc.maxHeadAgeMs`. Do not reuse the
   request/issuance `max_block_age_ms` latest limit as a finalized limit, or change
   it to a larger number. All other identity and skew/TTL pins must agree.
5. Recheck anchors/history coherence after reads. Disagreement, changing anchors,
   timeout, cancellation or unsupported history fails without automatic retries.
   No wall-clock/elapsed-block finality fallback, state override or mutating RPC.

The new witness binds both freshness bounds and all identity/digest fields. Its
validity is the minimum remaining lifetime of its underlying observations;
check wall and monotonic time, database time at apply, and cancellation after
awaited work. A caller cannot substitute arbitrary JSON or a cached boolean.

### Separate approval domain

Do **not** add retirement to v1 `ADMISSION_OPERATIONS` or treat a browser
`reuse`/`sign` review as recovery authority. Add a distinct
`sg-staging-recovery-review-v1` verifier using the established independently
pinned Ed25519 public-key/current-revision pattern. Test signatures use fixture
keys only; no approval generator or private-key resolver ships in R4.

Approval binds one action/recovery ID, namespace/deployment, authorization ID/
digest, snapshot digest, operator and evidence references, writer epoch,
database/profile/migration/operating/release/active-policy identities and a
validity window of at most 15 minutes. Reject wildcards, added operations,
unknown fields, changed/currently withdrawn review, forged/cross-domain envelope
or wrong key. Recovery authority does not inherit the paid-attempt validity
window; an expired pricing review cannot disable read-only diagnosis, nor can
this recovery review authorize spending. Do not silently extend either window.

Human review can take longer than RPC witness validity. The plan's stable target
and snapshot are approved; **apply obtains fresh chain observations**. If the
snapshot/epoch/config changed, create and approve a new plan; do not refresh an
expired witness and call the old payload unchanged. One ledger identity prevents
double retirement. Lost COMMIT acknowledgment always takes the outcome path.

## 5. Recovery API and transaction sequence

Proposed `persistence/stagingGenerativeRecovery.ts` and
`contracts/tools/generative-staging-recovery.mjs` expose a narrow internal
composition, not HTTP or a catch-all callback. No signer/provider/wallet-send
dependency is accepted. Reuse/extract exact reservation/input decoders; do not
open an unrestricted staging issuer with a no-op guard merely to inspect data.

1. **Open:** verify explicit v2 configuration, exact role/catalog/profiles and
   disabled switches before acquiring a fresh restricted `ExclusiveWriter`.
   Recheck afterward. Require the site/observer drained and original process
   isolated; do not steal a lock, reconnect automatically or infer cross-cluster
   isolation from the epoch. Halted projection or unknown restore completeness
   prohibits mutation. The ownership epoch change is explicit; ordinary inspection
   uses no writer and remains entirely read-only.
2. **Plan:** `plan(authorizationId, reasonCode, operatorReference, signal)`
   reads/validates the exact active reservation, accepted assessment/input bytes,
   signature if present, request identity, wallet plan/lease and all reports.
   Include relevant policy/profile/projection-halt state in the snapshot digest.
   Acquire a read-only chain witness for the eligibility summary; make a frozen,
   process-local plan with a fresh recovery UUID, but no retirement writes.
   Use bounded reason codes/references, not uncontrolled free text. Record the
   recovery ID externally before apply.
3. **Approve:** verify the separately supplied signed action envelope against
   that stable plan and current review source. Planning is not approval. Serialized
   reports or plans cannot be reconstructed into an apply capability.
4. **Apply:** single-flight for one plan; verify current approval, obtain fresh
   active/finality/eligibility proof outside the SQL transaction, then enter the
   serial writer transaction. Lock both policy rows against enablement and the
   exact target head/plan; check epoch, role/catalog, snapshot and valid evidence
   with database time. Append the immutable ledger, retire exactly the matching
   lease if present and delete exactly one head. Recheck approval/liveness/time
   before mutation and immediately before transaction completion. Any mismatch
   rolls back all changes; no retry/sign/send or policy change follows.
   A repeated apply after a confirmed commit may return the verified saved
   outcome without mutation. It must never reuse an old witness for another
   transaction; lost/uncertain outcomes first require the next step.
5. **Outcome:** after a lost reply, halt/close the uncertain writer and call a
   separately read-only `outcome(recoveryId)` through the inspector under the
   exact configured namespace/deployment. Report `retired` only when the canonical
   audit record, absent old head and inactive/absent matching lease agree. Missing
   evidence is `not-recorded`, not proof of rollback while prior work might still
   commit. Inconsistent or unavailable data stays `unknown/blocked`. Outcome
   lookup requires neither a still-valid mutation review nor a provider/RPC call.
6. **Resume separately:** drain/close the recovery process, review the result,
   re-certify v2 startup and obtain fresh browser-operation authority. Only the
   policy owner may re-enable issuance/generation as appropriate. A user must
   start a new explicit mint request with current proof. The old request remains
   retired; first accepted assessment/inputs remain exact, and standard wallet
   approval/nonce/finality rules still apply.

Cancellation or review expiry while COMMIT is already in flight can leave an
unknown outcome. Do not promise that a cancelled caller means no commit occurred.
Read-only outcome is the reconciliation mechanism; preserve audit and evidence.

## 6. Test matrix and completion criteria — step 4

| Area | Required evidence |
| --- | --- |
| Inspection | All relevant attempt/authorization states, exact reference/namespace binding, no accidental enumeration, overflow/timeouts/cancellation and malformed joins. Assert unchanged full-table inventory and epoch. Canary values in private columns never appear in reports/logs; inspector cannot SELECT them or mutate anything. |
| Chain boundary | Wrong network/genesis/deployment/renderer/domain/authorizer; minted/used/revoked/paused; undeclared history; unequal or changing heads; deadline minus/equal/plus; realistic older finalized block accepted only under its own bound; stale finalized/latest, clock skew, timeout, cancellation, copied witness and no mutating methods/retry. |
| Approval | Missing/forged/withdrawn/expired/wrong-domain review; wrong action/record/snapshot/epoch/key; v1 browser review not recovery authority; post-plan changes and delay beyond RPC TTL; fresh apply observation and expiry during DB work. |
| Storage and roles | Real PG16 inspector/recovery/browser role denial, PUBLIC/membership/extra-object grant drift, owner/trigger/schema drift, both kill switches and policy-row locking, exact atomic ledger/head/lease transition, deferred incomplete-transaction rejection, immutable histories. |
| Interrupted authority | Reserved, signing, unknown and signed authorizations; no wallet plan, unreported dispatch, rejected report, submitted/reverted observation, late report, conflicting lease and repeated apply. No state is treated as unsigned merely because no signature row is present. |
| Commit/restart | Inject failures before/after ledger insert, lease change and head deletion; confirmed rollback vs lost COMMIT acknowledgment; new owner outcome lookup, expired review, old process-local plan refusal and no duplicate audit row. |
| Compatibility | Populated v1 → v2 upgrade preserves all existing rows/bytes and source hashes; wrong/partial/mixed source fails atomically. V1 refuses upgraded catalog; explicit v2 certification/startup works. Historical local experimental/RC recovery behavior is unchanged. |
| Runtime after recovery | Actual future-staging site with synthetic RPC: old request still denied; explicit fresh request reuses exact assessment/inputs and normal current wallet nonce; fresh sign/send only in this separately enabled test phase. Confirming → finalized gallery and saved provenance still work. |
| Restore | R3 v1 campaign remains intact; explicit v2 inventory/role recipe includes the new ledger and column grants. Restore completed retirement and outstanding uncertainty; no head/lease resurrection, duplicated audit, automatic job/sign/send or self-approved profile. Saved safety halt stays blocked. |
| Effect accounting | Recovery-phase X/Grok/sign/wallet-send counters all zero; no imports invoking those dependencies. Compare budgets/fences/jobs/sessions/assessment/input/signature/dispatch/report history byte-for-byte. Separate original setup and explicitly resumed-flow counters. |

Add bounded opt-in PG/node commands and CI wiring for this package. Run affected
unit/PG/schema/certification/operating-review suites plus existing local recovery,
R3 restore, staged runtime/site and R2 provenance regressions. Do not weaken
coverage thresholds or relabel fixture passes as public-network acceptance.
Typecheck, build, renderer/source locks, RC1 release lock and whitespace checks
must pass. Record commands, counts, skips, tool versions, allowed mutations and
limitations; reuse unchanged broader evidence instead of repeating unrelated campaigns.

R4's acceptance runbook must include: inspect → stop/disable/drain → exact backup
and migration prerequisites → separate restricted owner → plan/review → fresh
apply → outcome/restart → separate user-driven resumption. R3's stopped-state
and rollback limits still apply. Never clear records to make a test or UI pass.

## 7. Files and implementation order

Names below are proposed new files unless identified as existing; implementation
may consolidate pure helpers without changing the boundaries.

| Step | Principal files / changes |
| --- | --- |
| 2 | `persistence/stagingOperatorInspection.ts`, column-grant/audit helper and focused tests; no runtime mutation path |
| 3a | New `generative-staging-recovery-schema.sql`, explicit database v2 lock/catalog/profile/reviews and operating-settings v2; preserve existing v1 exports and hashes |
| 3b | `stagingRecoveryChain.ts`, `staging/recoveryReview.ts`, `persistence/stagingGenerativeRecovery.ts`, `contracts/tools/generative-staging-recovery.mjs`; narrow pure decoder extraction if needed |
| 3c | Explicit v2 support in existing readiness, runtime database/assessment/mint/site bindings and fixtures; no new default or automatic upgrade |
| 4 | New chain/review/PG/composition tests; extend R3 with a separately selected v2 fixture; CI/package commands, this runbook and current plan status |
| 5 | Review all resulting changes and fault evidence against this specification; accept offline only after fixes and verification |

Do not claim step 3 finished at 3b if browser restart on the migrated database
still fails. If a pure helper extraction touches the old local path, run its
existing compatibility tests immediately. A broader action (paid retries,
pre-expiry revocation recovery, force clearing uncertainty, live migration or
public administration) needs a new design/authorization, not a quiet scope extension.

## Step 1 verification record

Read-only inspection covered local recovery SQL/chain/application code, exact
reservation/input validation, writer locking, role grants/audit, database catalog/
certification/source lock, operating/review/admission bindings, site diagnostics,
existing recovery tests and R1–R3 records. No database, RPC, provider, listener,
secret or backup was accessed. Only this specification and current execution
status documentation changed. Implementation, measured tests and R4 acceptance
remain pending; the next manual checkpoint is **Sol · High, steps 2–4**.

## Steps 2–4 implementation and operator sequence

This section describes the implemented internal R4 boundary. It is **not** a
live operations authorization or a deployable credential/CLI bootstrap. R5 must
still supply authenticated connections, stopped-state evidence and independently
reviewed artifacts. The final review and offline acceptance are recorded below.

1. Use the separately authenticated, column-restricted inspector connection to
   call `inspectStagingOperation` with one tagged UUID and the exact configured
   namespace/deployment. Treat its report as saved database metadata, **not**
   live-chain proof. Do not pass a browser cookie, mint code, provider payload,
   wallet permit or arbitrary SQL.
2. Disable both generation and issuance through the existing policy owner;
   drain/stop the site, workers, projection writer and any signer. Preserve
   uncertain X/Grok and wallet records. Confirm the old writer lock is gone;
   do not steal it. Confirm the projection is available, not safety-halted.
3. Take an exact stopped-state PG16 backup under R3's completeness and external
   isolation rules. Record source identity, archive hash, table inventory,
   migration receipt, role recipe and independently pinned review revisions
   outside the database. The source v1 catalog/roles/profiles must certify under
   the **v1 paused review** before the appended staging migration is considered.
   Provision distinct restricted inspector/recovery logins separately. Invoke
   `migrateStagingDatabaseV2` with explicit owner/browser connections, independently
   pinned source/target reviews, exact locked SQL and authenticated stopped-backup
   evidence. It checks owner identity and operator-role restrictions, takes the
   advisory migration lock and shared table locks, verifies exact paused v1,
   then atomically applies only the locked v2 source and its grant recipes.
   It never creates roles or runs at startup. The resulting
   database must certify under an **explicit v2 review**; v1 must reject it.
   A partial or mismatched upgrade stays stopped and is handled with the R3
   restore procedure, not by repinning the observed state automatically.
4. Connect a separate browser-catalog reader and call
   `PostgresStagingGenerativeRecovery.open` with a restricted writer-acquisition
   callback. Opening first certifies v2 and both disabled switches; only then
   does it acquire the fresh recovery writer and recheck its role and policy.
   Bind the configured Sepolia RC1 sources, active-state history and
   release/operating plan before opening. `plan` reads one
   exact authorization and obtains a fresh read-only chain witness. Save the
   generated recovery ID and snapshot/target digest externally.
5. Have a distinct operator review and sign the exact
   `sg-staging-recovery-review-v1` target for no longer than 15 minutes. The
   inspection report, plan alone, browser-operation review and prior RPC witness
   cannot authorize mutation. Re-plan if the epoch, snapshot, profile or review
   target changes.
6. `apply` obtains **fresh** two-source finalized/latest and active-history
   evidence, checks finalized time strictly after the signed deadline, and
   atomically appends the immutable ledger, retires the exact wallet nonce lease
   if one exists and deletes the exact active head. Keep both kill switches off.
   Do not retry a failed or uncertain transaction automatically.
7. If the COMMIT reply is lost, close the uncertain writer and use a separate
   inspector connection with `inspectStagingRetirementOutcome(recoveryId)`.
   `not-recorded` is not proof that a still-running transaction rolled back;
   `unknown` requires investigation. Never clear rows, reuse the old browser
   request, replay a paid call, re-sign, send a wallet transaction or re-enable
   policy from this outcome alone.
8. After a confirmed outcome, stop the recovery process. Re-certify explicit v2
   startup, obtain fresh ordinary site-operation review, then let the policy
   owner separately decide when to re-enable. A user must make a **new explicit
   request**. The first accepted assessment, original signature, all receipts,
   dispatches and provenance remain immutable.

The internal modules resolve no environment variable, secret, provider key,
HTTP route or wallet signer. The code does not automate a live backup, migration
or role creation. Those remain R5 operational work; no current rehearsal data or
real Sepolia state has been changed.

### Disposable evidence recorded September 24

Tooling: Node.js 22.16.0, npm 11.4.2 and disposable PostgreSQL 16.15.
These commands ran offline against synthetic Sepolia sources and test keys;
they did not touch the active rehearsal, historical backups or live provider.

- `test:generative:staging-recovery-unit`: 19 unit cases for the separate
  Ed25519 review and synthetic two-source proof, including identity/source
  disagreement, expired evidence and copied-witness refusal.
- `test:generative:staging-recovery-pg`: 6 PG16 cases for bounded redacted
  inspection, forbidden secret/table access, v2 catalog/grants, v1 refusal and
  atomic ledger/head/lease checks. Cancelled, malformed and cross-namespace
  references do not advance the writer epoch.
- `test:generative:staging-recovery-flow`: 3 integration cases. Explicit v2
  runtime starts, and open cannot acquire the writer before v2 disabled-policy
  certification; a still-live authorization is refused; an expired unminted
  authorization is retired only after finalized evidence and exact approval.
  An injected failure before head deletion rolls back the ledger and lease;
  copied/repeated plans fail. A stopped backup of the completed retirement
  restores its one ledger entry, absent head and preserved assessment. A
  separate v2 stopped backup restores the ledger schema, private inventory and
  grants without automatic owner acquisition.
- `test:generative:staging-restore`: 8 historical R3 v1 cases still pass after
  the explicit v2 restore fixture was added. No version inference or silent
  migration was introduced.
- Targeted historical local recovery regression: 26 cases pass, 10 unrelated
  pipeline cases skipped by the explicit `-t recovery` filter. Both experimental
  and RC1 local durable recovery remain local-only.
- `test:generative:database-certification`: 190 cases pass with 100% statements,
  lines and functions and 99.16% branches (98% required) after adding the v2
  paused/runtime selectors; the old threshold was not weakened.
- `test:generative:staging-readiness`: 57 cases pass with the existing 100%
  line/branch/function gate, including explicit v2 paused startup.
- `test:generative:staging-assessment`: 76 cases pass; 100% lines/functions,
  99.34% branches across its covered admission/worker/controller files.
- `test:generative:staging-mint`: 34 cases pass with its unchanged coverage
  gate (100% lines, 98.82% branches, 97.96% functions).
- `test:generative:staging-sharing`: 227 pass, 24 fixture-inapplicable cases
  skipped; its unchanged per-file 100% line/function and 95% branch gate passes.
- `test:generative:staging-runtime`: 60 private runtime/site cases pass with
  100% covered lines, 97.17% branches and 96.77% functions; the existing
  100/94/95 gate passes. Its synthetic observer and site never broadcast or
  call paid providers.
- `npm run typecheck` and `npm run build` pass. Build verifies the frozen
  renderer/source/slogan locks. `generative:release:check` still reports
  `candidate-not-approved`; `git diff --check` passes. All tests use disposable PG16 and synthetic
  Sepolia RPC; they are **not** public-network acceptance.

The preceding results record the steps 2–4 checkpoint. The final review below
supersedes its pending status; neither record authorizes a live operation.

## Step 5 safety review and offline acceptance

**Decision: R4 accepted offline.** This is a repository safety review, not an
external audit or live deployment approval. R5 remains unimplemented here.

### Findings fixed

- The action verifier now captures its revision and immutable target instead of
  rereading a caller-mutable revision pin. The ledger records that verified
  revision. Changed/withdrawn reviews and cross-domain approvals fail closed.
- Recovery composition binds database, operating and release identities together;
  opening also checks the acquired connection's exact database and recovery role.
  Nested chain configuration is captured, not shared with mutable caller input.
- V2 certification checks both operator roles' login/power flags and trigger
  bypass/creation powers. Inspector/recovery auditors reject effective extra
  grants, membership and omitted-table mutation rights. No v1 lock was loosened.
- Saved wallet calldata, expiry, recipient and nonce must match the verified
  authorization exactly. A late report changes the snapshot and invalidates the
  old plan; it does not become evidence of mining or failure.
- Freshness is checked again after SQL work, including head/finalized age and
  monotonic lifetime. SQL mutation guards require the writer lock and unexpired
  evidence; the deferred commit guard rechecks epoch, switches and expiry. The
  stored validity is capped by both chain evidence and action-approval expiry.
- Inspection validates retirement consistency, redacts saved halt reasons and
  prioritizes safety-halted projection state. Cancellation drains through rollback;
  related-row overflow produces no misleading partial-success report.
- Added the internal guarded v1→v2 migration above. It requires reviewed source,
  target and stopped-backup bindings before DDL, preserves historical data and
  never retries an uncertain COMMIT. Lost acknowledgment reports `unknown`;
  committed but uncertified target reports `committed-unverified`. Both stay stopped.

### Final verification

| Campaign | Result / concrete evidence |
| --- | --- |
| R4 chain/review unit | 28 passed; includes fixed revision, target/key/epoch/action mismatch, separate realistic finalized/latest ages, stalled source, nested config capture and monotonic expiry |
| R4 inspection/SQL | 13 passed; real denied SQL and effective role/PUBLIC/membership escalation; drained cancellation, overflow, redaction, exact v2/v1 rejection, incomplete retirement and expiry at deferred COMMIT |
| R4 recovery + upgrade | Full 17-case campaign passed; final changed unreported/submitted flows and all 8 migration cases rerun successfully. Reserved/signing/unknown/signed authority; no plan/unreported/rejected/submitted wallet states; rollback before/after ledger, lease and head; withdrawn review, expired evidence, late report, copied/repeated plan, lost COMMIT and restored retirement |
| Populated upgrade | V1 sessions, requests, attempts, budget reservations and jobs preserved byte-for-byte across upgrade, alongside every other existing table. Wrong source/schema, enabled policy, held writer, wrong backup binding and grant failure cannot commit a partial upgrade; lost reply is inspected, not replayed |
| Separate resumption | Old request refused; fresh request gets a new authorization/nonce with the exact original assessment/input commitment. X/Grok counters remain one from setup, with zero recovery-phase calls; one new test signature is produced only after separate re-enable/approval/request |
| Database certification | 198 passed; 100% statements/lines/functions, 99.16% branches; unchanged 98% branch gate |
| R3 restore | All 8 passed again; source completeness, revocations, uncertainty, transfer/finality and safety-halt behavior unchanged |
| Active governance observer | All 70 passed again, including declared rotation/revocation/pause/resume and rejection of unlisted or unfinalized governance even when latest state is restored |
| Historical local recovery | 26 passed; 10 unrelated pipeline cases deliberately skipped by `-t recovery`; both local profiles remain local-only |
| Static/release checks | Typecheck, build, renderer/slogan locks and whitespace checks pass; RC1 release lock unchanged and still `candidate-not-approved` |

Use the step-2–4 readiness/assessment/mint/sharing/runtime-site results above for
unchanged full-site and Confirming→finalized/provenance behavior. The new resumed
request is tested through real SQL/controller boundaries with synthetic sources,
not a second complete browser/wallet/public-chain acceptance campaign. Interrupted
authorization states are reconstructed only in disposable fixtures; this is not
an operator repair procedure. R4 recovery has no provider, signer or sender dependency.

### Explicit v2 lock review

The pre-acceptance v2 draft changed intentionally for the reviewed SQL expiry/
writer guards and inspector outcome-binding column. No live v2 installation is
being silently repinned. Measured with disposable PG16:

| Pin | Reviewed value |
| --- | --- |
| Migration source SHA-256 | `717c9a317408739926c2d62096d02697e1632a3ee71b4aaa51b68b7684fb313b` |
| Schema SHA-256 | `dfe31d5d01a1ee56bcdb4678c62b71ed74c4cfe89732a95280d75c0582a42e0e` |
| Grants SHA-256 | `3681279ffb2774661e41f57c961ebf78f9463045570086ea6bb154bc06d7f38e` |

The original nine v1 sources/exported manifest remain unchanged. Future changes
to an installed/reviewed schema require explicit versioned migration and review,
not startup self-pinning.

### Remaining operational gates belong to R5/later acceptance

The internal migration guard binds supplied backup hashes; it does **not**
authenticate a backup issuer, establish external database host identity, prove
custody or isolate a restored clone. R5 must authenticate reviewed artifacts,
bind both connections to the same installation, enforce source isolation and
resolve credentials. A test completion witness is never production approval.
Real-record recovery, hosted restore/migration, independent public RPC behavior,
actual wallet interaction, paid provider acceptance and public support remain
separate gates. No active `.local/rehearsal`, backup, secret, live provider/chain
or deployed database was accessed or changed. No commit/push or ntfy was performed.

Next manual checkpoint: **R5 step 1 — bootstrap/credential/operating boundary
design, Astra · XHigh**. Then choose the bounded implementation steps before
switching to Sol · High; return to Astra · XHigh for final operational review.
