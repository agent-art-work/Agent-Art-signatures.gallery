# R3 — RC1 migration and backup/restore rehearsal

September 24, 2026. **Steps 1–5 complete offline, including final invariant
review and runbook verification.** This refines R3 in [Release readiness](release-readiness.md),
not another release milestone or approval to restore a live environment.

## Manual checkpoints and deliverables

The user selected manual model checkpoints. No subagents and no ntfy.
Recommendations are not automatic changes to the running model.

| Step | Deliverable | Model / status |
| --- | --- | --- |
| 1 | Recovery boundaries, state matrix, implementation outline and acceptance criteria below | Astra · XHigh; design complete |
| 2 | Disposable RC1 fixtures covering saved results, interrupted effects, sessions and projection | Sol · High; implemented, local tests passed |
| 3 | Populated migration compatibility and exact backup/restore tests, including permissions | Sol · High; implemented, local tests passed |
| 4 | Restored runtime/projection rehearsal with zero repeated effects and negative cases | Sol · High; implemented, local tests passed; strengthened in step 5 |
| 5 | Final invariant review, verified operator runbook and evidence report | Astra · XHigh; complete offline; findings fixed and eight restore cases passed |

The manual checkpoint after step 4 was honored. The user selected Astra · XHigh
and resumed step 5. That review found and fixed gaps in the test harness and
evidence below; it did not change production authority, schema or runtime
behavior. This accepts the offline R3 package, not a live restore or release.

## Goal and exclusions

Demonstrate that a populated, quiesced RC1 database can be restored into a new,
isolated PostgreSQL 16 cluster without changing artwork authority, reviving
revoked access, or repeating X/Grok, signing or wallet-send effects. Show that
gallery state requires fresh chain verification after restore. Produce a
repeatable command, sanitized evidence and stop/restore/rollback instructions.

- Use only clusters created by `disposablePostgres()`: fresh temporary paths,
  private Unix sockets, no TCP listener and no existing database URL/directory.
- Never read `.env` files or connect to `.local/rehearsal`, the running app,
  public RPCs, X/xAI or the historical `.local/backups/pre-formal-v1-20260910`.
- No real secrets, provider spending, EVM broadcasts, contract changes,
  deployment, enablement, backup deletion, commits or pushes.
- Keep the nine-file staging schema lock, grants, renderer/input identities and
  coverage thresholds. Do not add the local-only recovery migration to staging.
- No IPFS or finished-SVG storage/compression. Do not import the older
  publication architecture merely because it already has a dump test.
- This is a logical-backup rehearsal, not WAL/PITR, live replica failover,
  production RPO/RTO certification, hosted backup configuration or R4's
  authorization-retirement implementation.

## Most important boundary: data recovery is not renewed authority

There are two different restore situations:

1. **Known-complete, stopped-state backup.** Stop admission, disable generation
   and issuance through the existing owner-controlled switches, drain all work,
   close the writer and retain external isolation. Take the snapshot only after
   all effects already started have a durable result or a durable uncertainty
   fence. No process may resume against the source afterward during the test.
2. **Older or completeness-unknown backup.** Some dispatches, issued signatures,
   revocations or reservations may have happened after the snapshot. A matching
   checksum and healthy schema cannot prove those events never happened.
   Keep all effects disabled and do not serve restored private sessions until
   separately reviewed reconciliation establishes what was lost. Missing rows
   are not permission to retry. Replaying chain history cannot recover off-chain
   provider spend or unknown signatures.

PostgreSQL can produce a consistent database snapshot during concurrent use,
but that does not capture future commits or external effects. We deliberately
choose the stricter stopped-state procedure for the successful rehearsal.
[PostgreSQL 16 dump documentation](https://www.postgresql.org/docs/16/app-pgdump.html).

The stale-backup test must deliberately restore an older valid archive while
keeping a later test witness outside it. Compare the restored inventory with
that witness and refuse recovery acceptance. Also cover missing completion
evidence. **Do not claim the application automatically detects an unknown
missing tail:** there is no such independent durable system implemented here.
The rehearsal/runbook must withhold activation, not invent an always-current
watermark, silently reset the budget, or build another general admission layer.

An exclusive writer lock only protects its own database. A restored clone can
acquire a different lock while the original database still exists. A larger
restored epoch is not cross-cluster fencing. The procedure must keep the original
runtime stopped and isolated; the test must not run two effect-capable sites.
Signed authorizations already outside the database can remain usable after a
restore. Neither a database restore, policy disablement nor signer rotation
retroactively cancels them.

## Existing implementation to reuse

| Boundary | Existing code / implication |
| --- | --- |
| Disposable PG16 | `src/openMint/persistence/fixtures/postgres.ts`; accepts no live target |
| Exact migration order | `databaseSchemaLock.ts::GENERATIVE_DATABASE_MIGRATIONS`; nine exact source hashes |
| Dedicated owner and browser role | `contracts/tools/fixtures/generative-staging-readiness.mjs`; owner `sg_migrator`, runtime `sg_browser`, exact generated browser grants |
| Schema/grants/profile certification | `databaseCertification.ts`; paused certification requires disabled switches; runtime certification separately returns their current values |
| Durable owner | `writer.ts::ExclusiveWriter`; session advisory lock, incremented epoch, no automatic reconnect/replay |
| Accepted evidence and paid fences | `repository.ts`; accepted record lookup, one-time initial claim, preserved reservations/receipts/terminals |
| Immutable render/mint authority | `generativeInputs.ts`, `generativeAuthorizations.ts`, `walletSubmissions.ts`; first inputs, signing fence, exact signature and dispatch record |
| Integrated site fixture | `contracts/tools/fixtures/generative-staging-site.mjs`; mocked providers, synthetic chain, public test signer |
| Verified reads | `projection/coordinator.ts`, `projection/postgres.ts`, `projection/generativeArtwork.ts`; a saved checkpoint does not establish current canonicality |
| Existing compatibility tests | `projection/migration.test.ts`, `persistence/generativePipeline.postgres.test.ts`; extend/reuse rather than duplicate unrelated campaigns |

The old `publication.test.ts` dump uses `--no-owner --no-privileges`; it proves
payload restoration only. Do not copy those exclusions for R3 permission
evidence. The existing site restart test also reuses the same database/writer;
R3 must actually restore into a different cluster and acquire a new writer.

## State matrix to seed and verify

Use distinguishable handles/requests with exact saved IDs. Build through the
existing repositories, controllers and fixture transports wherever practical.
Fault injection may construct interrupted boundaries, but never disable guards
in the successful restore path. Compare data before re-opening any component.

| Saved state | Required result after restore/restart |
| --- | --- |
| Accepted Grok assessment and RC1 inputs | Identical payload bytes, digests, verified spelling, MBTI, model, sources and identity; R2 provenance still matches only its exact verified mint |
| Abstained assessment | Same terminal reason and reservation; no generated artwork or automatic reroll |
| Uncertain X or Grok dispatch, including missing receipt | Preserve fence, attempt, budget exposure and unknown cost; zero provider calls |
| Queued assessment without dispatch | Startup/reload must not launch it automatically; do not erase it or label it paid |
| Interrupted running job | Old ownership does not become a new initial claim; preserve the interrupted evidence and require explicit recovery |
| Reserved authorization | Same immutable payload, recipient, input/assessment commitment, nonce and expiry; no signing merely from startup/status |
| Signing/unknown authorization | Stay blocked; no second signer call, replacement reservation or nonce-head removal |
| Signed authorization | Exact saved signature and active head survive; any explicit permitted reuse returns existing bytes without signing |
| Wallet dispatch without response | Keep unknown/blocked with the same active wallet nonce lease; no second send |
| Submitted wallet report | Preserve exact hash and dispatch; reporting or reload alone does not prove inclusion |
| Revoked session and consumed challenge | Old cookie/proof/challenge cannot regain access; no session-generation reset |
| Confirming and finalized projection, including transfer | Fresh observation required; same original recipient/current owner, finalized-only galleries and confidence policy |
| Safety-halted projection | Restore cannot clear halt or launder a finalized contradiction by rebuilding |

A submitted transaction may become canonically included while the application
is stopped. Advance only the synthetic chain after the dump; catch up by reads
after restore, without provider/sign/send effects. A transaction that disappears
from an unfinalized branch stays unresolved; this is not retirement permission.

## Implementation outline for steps 2–4

### Step 2 — fixtures and external inventory

1. Build a reusable, bounded fixture setup from the existing staging fixtures.
   Separate **seed a new database** from **open an existing restored database**.
   The restore branch must never call initialization that recreates or reseeds
   records. Preserve public test configuration and synthetic chain state apart
   from source connections.
2. Use a dedicated staging namespace/deployment and RC1 profile for the main
   campaign. Use independent cases/clusters where active-job/nonce uniqueness
   makes combining states artificial. Do not weaken those constraints.
3. Capture a deterministic, explicit table inventory outside the dump: primary
   keys, row counts and exact row/payload hashes. Represent BYTEA as hex and
   NUMERIC/BIGINT/timestamp values as exact database text; no JavaScript Number
   conversion or locale-dependent sorting. Keep private rows out of logs.
4. Record all application tables, not only immutable assessment tables. Include
   policies, budgets, jobs/fences, sessions/challenges, request/profile data,
   input/authorization/head/signature rows, wallet plans/dispatches/reports, and
   all seven projection tables. Assert inventory coverage against the locked
   schema so adding a table cannot silently escape backup verification.
5. Record source PG/client versions, migration hashes, schema/grants/profile
   pins, candidate lock, namespace/deployment and original writer epoch. Mark
   the run as synthetic and unapproved. Bind an archive hash and a stopped-state
   completion record into a test restore receipt stored outside the database.

### Step 3 — migrations, archive and restoration

1. Retain the existing migration order. In a separate compatibility case, seed
   historical experimental input rows before the release-profile migration and
   populated projection v2 rows before v3. Verify exact old rows survive each
   explicit upgrade; existing profiles are never relabelled RC1. This mixed
   historical fixture is not the single-namespace staging certification target.
   A full archive already includes its schema: do not rerun migrations on it.
2. For the main RC1 case, disable both effect switches and complete shutdown and
   writer close before recording the pre-dump inventory. If drain fails, abort
   the successful-backup procedure; do not force takeover or claim quiescence.
3. Create a full custom-format dump of the dedicated disposable database. Keep
   owner and object ACL records. Supply the exact fixture socket/user/database,
   bounded process duration/output, and a sanitized subprocess environment that
   cannot inherit a live PG service/password/target. Only the existing optional
   test-binary directory is an operator-selected tool path; check PG16 versions.
4. Create a second isolated cluster and fresh empty destination database with
   matching UTF-8/C locale, owner, database privileges and explicit role recipe.
   A database dump does not include cluster roles. Recreate only the fixture's
   reviewed roles/attributes, never import global roles or credentials from the
   user's machine. Restore preserving object owners/ACLs, with exit-on-error and
   a single transaction. No `--clean`, live target, trigger-disabling option or
   permissive fallback. [PostgreSQL restore options](https://www.postgresql.org/docs/16/app-pgrestore.html).
5. Before a writer or site opens, compare every row inventory exactly and run
   existing schema/grants/profile certification with disabled effects. Check
   runtime effective privileges as the actual restricted role. Verify immutable
   updates/deletes and privilege escalation still fail.
6. Missing roles, altered grants/profiles, damaged/truncated archive, wrong hash,
   missing completion evidence or a failed restore must stop acceptance. No
   listener/effect-capable runtime opens; preserve diagnostic reason without
   dumping private contents. A checksum proves archive integrity only relative
   to a trusted manifest, not authenticity of an arbitrary backup.

### Step 4 — new ownership and read-only recovery

1. Acquire a new restricted-role `ExclusiveWriter`; it must advance the restored
   epoch. Bind a newly created **test-only** review to the destination restore
   receipt, database binding and new writer scope. Reusing old review/permit
   objects or the old signed review must fail. Never derive real approval from
   inspecting the restored database.
2. Keep generation and issuance disabled. Attach throwing/counting provider and
   signer substitutes, and a scripted send counter. Open existing repositories,
   sessions and the actual site composition without reseeding. All post-restore
   provider/sign/send counters must remain zero, including error paths.
3. Verify private status, reload, revoked/consumed session cases, saved evidence
   lookup, duplicate wallet reports and denied old dispatch/signing attempts.
   Capture original counts separately; seeding necessarily uses mocked effects.
   Compare immutable rows again afterward; explicitly account for allowed
   changes such as writer epoch and projection catch-up, never ignore all
   mutable tables wholesale. Do not renew proof/authorization expirations.
4. Before new chain observations, detail/gallery endpoints must not trust
   restored freshness. After fresh synthetic two-source canonical/finalized
   observations, recover Confirming/finalized pages and R2 provenance without
   new assessments. Exercise unfinalized reorg and finalized contradiction.
5. Demonstrate projection rebuild in a **third, fresh disposable projection-only
   target** from exact deployment pins and synthetic logs. Compare observable
   mint/owner/gallery results with the restored target. No deleting a halted
   checkpoint, changing deployment ID to evade a halt, or manufacturing missing
   private assessments. Chain-only detail must retain honest missing provenance.
6. Exercise the deliberately stale archive/completeness-unknown cases above.
   They may restore for isolated inspection, but must not acquire effect
   approval or expose resurrected private sessions. Do not implement a general
   automatic stale-backup reconciler in R3.

Implementation uses a small `contracts/tools/fixtures/generative-staging-restore.mjs`
helper and `contracts/tools/generative-staging-restore.node-test.mjs` for inventory,
roles and actual composition recovery. Existing populated-migration tests were
reused rather than adding the separately proposed persistence test file. The
opt-in package command and CI wiring are present. There is no public restore endpoint.

## Acceptance and step-5 review

- Two genuinely separate PG16 clusters; fresh restricted writer, exact restored
  bytes and permissions; negative cases above fail closed.
- Zero X/Grok/sign/send effects **after restore**, with no automatic queued-job
  execution, lost uncertainty or budget reset. No namespace/renderer relabel.
- Current chain evidence controls reveal/finality; safety halts survive;
  chain-only rebuilding cannot create private Grok attribution.
- New targeted tests, existing populated migrations, writer/repository/session/
  authorization/submission, staging site/runtime and projection/R2 tests pass.
  Run typecheck, build, schema-source and RC1 release-lock checks; keep existing
  thresholds. Record exact commands, counts, skips, versions and limitations.
- Report backup size and measured rehearsal dump/restore/check durations, not
  promises of production recovery time or acceptable data loss. Test records are
  small and providers/chain are synthetic; no real wallet, Sepolia or paid claim.
- Runbook covers stop/drain, backup prerequisites, explicit role/DB recreation,
  archive/row verification, fresh review/ownership, no automatic activation and
  rollback limits. Returning to an older database after any new external effect
  is not a safe ordinary rollback. Keep both sides disabled if completeness is
  uncertain and escalate for reconciliation; preserve forensic evidence.
- Temporary cleanup targets only paths allocated by this run, after all child
  processes/connections are stopped. A failed cleanup is reported, not broadened
  to another path. Active environments and historical backups stay untouched.

## Step 1 verification record

Read-only inspection of the current migrations, writer, fixtures, repository,
issuer, wallet dispatch and projection boundaries informed this design. No
database, listener, backup archive, provider call or test campaign was started.
Only this design and current execution-status documents were edited. R3's
implementation, measured outcomes and final acceptance were pending at that
checkpoint. Steps 2–4 were performed afterward as recorded below.

## Implementation and final verification — steps 2–5

`contracts/tools/fixtures/generative-staging-restore.mjs` contains the
test-only archive, exact 35-table inventory, PG16 tool check, isolated restore,
paused certification and restored-site opener. The inventory enumerates the
tables named by all nine pinned migration sources, rejects any added/missing
table, and compares sorted full-row text hashes without printing private rows.
It uses a read-only repeatable-read snapshot, canonical UTC/date/bytea settings
and exact JSON text without converting database numbers through JavaScript.
The subprocess is bounded, uses only the temporary fixture's private Unix
socket, explicitly names `readiness_test`, and discards inherited PG service
variables. It preserves the fixture owner/ACLs and recreates only the two
reviewed fixture roles in the destination cluster.

`contracts/tools/generative-staging-restore.node-test.mjs` has **eight cases**:

| Case | Verified behavior |
| --- | --- |
| Populated authority and projection | Saved assessment/input/signature/report, revoked session, consumed challenge, queued/interrupted jobs, abstention and uncertain X/Grok fences survive exactly. A fresh restricted writer advances the epoch; the source signed review fails in the new scope. Before fresh observation the gallery is unavailable; Confirming stays out of it. Post-backup finalization and transfer recover the original recipient and new owner. Duplicate wallet reports are idempotent; repeat mint dispatch is refused. A third projection-only target rebuilds the same public mint/ownership without inventing Grok provenance. |
| Negative archives and ownership | A stale archive missing a later session revocation cannot open private sessions or acquire a writer when compared with the external later witness. Missing completion, changed checksum, truncated archive, missing owner role, extra grant, wrong source-profile pin and verification-to-open mutation all fail. Failed restore leaves pre-existing destination databases/roles intact. |
| Reserved authorization | Lost commit acknowledgment leaves the exact reserved payload/head; restore and repeated private status/begin do not sign or issue another permit. |
| Signing authorization | Lost commit acknowledgment preserves the signing fence and active head; no new signer call after restore. |
| Unknown signature | Invalid signer outcome remains unknown/blocked through restoration and reload; no replacement reservation or retry. |
| Unknown wallet result | Durable dispatch without a report keeps the same wallet nonce lease. Restored Confirming state is rechecked; an unfinalized reorg removes its public mint and leaves the dispatch unresolved. Repeated begin returns `SUBMISSION_UNRESOLVED`, not another send permit. |
| Historical upgrades | Experimental input profile and populated v2 projection rows retain exact values through explicit profile/v3 upgrades and archive/restore. This mixed-history fixture is not a single-profile staging certification. |
| Saved safety halt | Fresh observation cannot clear the restored halt; no repeated provider/signing effects. |

Every restored-site case uses throwing/counting X/Grok/signer substitutes.
The four interrupted-authorization/wallet cases also use a scripted send sentinel
that would increment if a new dispatch permit were returned. Counts remain zero.
Post-recovery comparisons cover all 35 tables, with only explicit per-case
writer-epoch and observed projection changes allowed; budgets, private access,
assessment/authorization/dispatch evidence are not silently exempted.

Local September 24 final evidence: `npm run test:generative:staging-restore`
passed **8/8 tests, no skips**, in approximately 49.2 seconds. The final run
recorded a **148,031-byte** custom archive, **44 ms** dump, **65 ms** restore
and **35** inventoried tables. Node was v22.16.0; PostgreSQL dump/restore clients
were 16.15 (Homebrew). Source server version is captured in the test completion
witness and client versions in the archive result. These are tiny synthetic
fixture measurements, **not** production RTO/RPO or a billing guarantee.
Existing populated migrations passed **14/14** tests in steps 2–4 via
`OPEN_MINT_TEST_POSTGRES=1 npx vitest run src/openMint/projection/migration.test.ts src/openMint/persistence/generativePipeline.postgres.test.ts --maxWorkers=1 --minWorkers=1`.
`npm run typecheck`, `npm run build`, `npm run generative:release:check`, and
`git diff --check` passed; typecheck/build/locks were rechecked in step 5.
The release checker still reports
`candidate-not-approved`. CI now runs the opt-in disposable restore suite.
The existing `npm run test:generative:staging-runtime` passed **60/60** cases in steps 2–4,
including unfinalized reorg, finalized contradiction and restart freshness;
its enforced coverage thresholds passed. Those campaigns are reused evidence,
not rerun or added to a new full-release total: step 5 changed only the R3
test/helper and documentation. CI wiring is present; hosted CI was not observed.

### Step-5 findings resolved

- Verification previously relied too much on destination-derived profile pins.
  Completion evidence now binds the stopped **source** profile, archive and
  all-table inventory; verification runs again before writer acquisition.
- Opening previously depended on call order alone. The helper now refuses
  unverified opening, clears acceptance on any failed check, and generates only
  a new destination-bound **reuse-only test review**. This WeakMap ordering guard
  is test infrastructure, not production authorization or a concurrent-writer fence.
- Interrupted states needed behavioral proof beyond preserved rows. Four
  isolated cases now exercise private reload/begin with exact outcomes and zero
  effects; source review rejection and consumed-challenge replay are explicit.
- Projection recovery lacked restored transfer/reorg evidence. Both are now
  exercised, with exact owner comparison and no private provenance on rebuilding.
- Backup evidence could depend on session timezone; canonical snapshot settings
  remove that dependency, tested with an Asia/Shanghai source session.
- Failed-restore cleanup could target a pre-existing database. It now tracks
  only databases/roles created by that invocation, with collision tests.
- Test deadlines are now actual node:test options, and HTTP calls are bounded.

### Acceptance and remaining limits

**R3 is accepted offline.** The reviewed runbook below matches the disposable
rehearsal. The completion record is an external **test witness**, not an
authenticated production manifest or proof that an unknown missing tail does
not exist. The test closes the effect-capable site and writer before dumping;
hosted stop/drain, source isolation and manifest custody remain operational work.
The send sentinel is a protocol assertion, not an installed wallet test. No live
backup, historical backup, real provider, public RPC or wallet was used.
Temporary resources are confined to clusters created by the test helper;
the active rehearsal and historical backup remain untouched.

Next is R4's sanitized operator inspection and separately reviewed staging
recovery design. R3 does not authorize retirement, release budgets, enable
generation/issuance, or change the release candidate's unapproved status.

## Reviewed operator procedure — not approved for a live restore

1. Identify the exact namespace, deployment, PG16 source and destination,
   migration manifest, schema/grants/profile pins and current writer owner.
   Stop admission. Disable generation **and** issuance with the existing
   owner-controlled switches. Stop schedulers and all effect-capable writers,
   drain outstanding work, record pending/uncertain fences and close the writer.
   A recorded uncertainty/fence can be backed up and restored for read-only
   recovery; it remains blocked, never permission to retry. If an effect lacks
   a durable fence/result, drain fails, or completeness cannot be established,
   stop the successful-recovery procedure and preserve evidence for reconciliation.
2. Produce an independently stored completion record stating the last accepted
   database state and that no source effect-capable process can resume. Record
   the full table inventory and source schema/grants/profile/server/client pins.
   Take a full custom-format dump with owner/ACL records; record its checksum
   outside the archive and confirm the source inventory has not changed. For
   any old or completeness-unknown backup, do not infer completion from its checksum.
3. In a new isolated PG16 cluster, create only the reviewed owner and restricted
   runtime roles and an empty target database with matching encoding/locale.
   Refuse an existing database/role collision rather than replacing anything.
   Restore once, preserving owners and ACLs, with
   `--exit-on-error --single-transaction`. Never use `--clean`, disable triggers,
   run startup migrations against this archive, or silently relax privileges.
4. **Before any writer/listener**, verify checksum against the trusted external
   completion record, all table inventories/row hashes, source migration pins,
   resulting schema/grants/profile hashes, disabled switches, effective runtime
   permissions and immutable-row denial. Recheck before acquiring ownership;
   keep all other writers excluded throughout. A mismatch means no activation.
5. Keep the original cluster isolated. Acquire a fresh restricted writer and
   record its epoch, then issue a new destination-bound, test-only review in the
   rehearsal. An old review or permit is not renewed authority. Open restored
   repositories without seeding or retrying X/Grok/sign/wallet effects. Confirm
   old revoked sessions remain invalid and unknown effects remain fenced.
6. Start read-only chain observation. Until it produces fresh canonical/finality
   evidence, gallery/detail reveal is unavailable. Compare recovered mint,
   owner, R2 provenance and private status with the backup and chain. Keep
   generation and issuance disabled until a separate operational approval.
7. If any integrity check, halt, completeness witness or external-effect
   reconciliation fails, stop the destination and retain both source and archive
   for investigation. Returning to an older database after new external effects
   is **not** an ordinary rollback. Do not launch two effect-capable clusters,
   erase uncertainty, reset budgets or treat a chain replay as proof of
   off-chain provider spend/signing history.
