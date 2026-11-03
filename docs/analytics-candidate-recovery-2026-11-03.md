# Analytics-OFF reconstruction and staging workload — November 3

Local-only DEV handback to central OPS, under its November 3 operator-authorized
restoration request. No publication, deployment or collection activation.

## Recovery identity

The November 1 temporary checkout and artifacts are absent. No byte-for-byte
restoration is claimed: this is a freshly reconstructed, re-reviewed candidate
from the retained source/requirements in the DEV chat. The old branch and its
prunable registration were NOT removed, reused or overwritten.

- Durable checkout: `/Users/bigu/Projects/Agent-Art-signatures.gallery/.local/dev-candidates/gallery-analytics-off-20261103`.
- Branch: `codex/gallery-analytics-off-restored-20261103`, HEAD/base
  `8db7332ee66ce0d1add80705bb041629d17eeb9c`. Uncommitted.
- Base is the unchanged protected main independently verified by OPS November 3.
  Locally, its application/build/lockfile files equal recorded deployed source
  `7646fbd`; later base commits are documentation.
- Seven modified code/test files: `src/preview/analytics.ts`,
  `analyticsMarkup.ts`, `analyticsUi.ts`, `analytics.test.ts`,
  `worker.ts`, `worker.test.ts`; and
  `contracts/tools/preview-cloudflare.node-test.mjs`. This handback is new.
- Durable full source patch: `.local/qualification/20261103/source.patch`,
  SHA-256 `47aaf1c8afabe179fc4e47a726e11cc96d4e9bcf9023a02415db097f125be7ab`.
- Machine-readable per-source/per-artifact file inventory:
  `.local/qualification/20261103/source-artifact-manifest.json`.
  Source patch and all candidate artifacts are local, not backed up to GitHub.
  The durable location avoids temporary-directory expiry; it is not a backup.

This is NOT the missing November 1 diff `cd2a7369…` or Worker `794b14b6…`.
Fresh code has a strict string check for beaconToken, reconstructed comments
and reorganized fixtures (316 current tests, not the historical 318).

## Re-reviewed scope and collection contract

GA4 script/queue/cookie writer and the consent notice/modal are removed.
Quiet Privacy information and explicit browser-exclusion controls replace them.
Preserved: `signatures.analytics.excluded.v1` semantics, legacy saved analytics
choices/history, saved works, auth/functional storage and all locked artwork,
compiler, contract and release inputs. Only explicit exclusion/include clicks
write the existing exclusion boolean. No consent inference, new visitor ID,
custom collector/proxy, geolocation service, paid plan or notification test.

Cloudflare REST `site_token` maps to frontend `beaconToken`, then native
`data-cf-beacon.token`. REST reporting `site_tag` is separate and absent from
real frontend config. Account reporting API credentials are a third,
server-only secret type. Distinct inert synthetic token/tag fixtures check the
mapping and reject a tag as fallback. No real value is inserted.

Every real production/staging/local/CI configuration is OFF:
`enabled=false`, `beaconToken=""`, and manual regional, document boundary and
withdrawal qualification flags all false. Legacy Allow cannot enable it.
Default CSP keeps `connect-src 'none'` and removes Google permissions.
Only an independently qualified future owner configuration could allow the
exact CF native script/endpoint; no wildcard or automatic-injection bypass.
All six frontend-only readiness values and HTML `no-transform` are preserved.

The hypothetical loader additionally requires exact HTTPS production origin,
readable/nonexcluded preference, no known automation, a literal approved public
path and safe actual referrer. Eligible list: /, /about, /explore, 16 uppercase
MBTI category routes. Handles /p/ and /s/, variations/SVGs, collection /me,
mint/wallet/auth/admin/API, unknown paths, queries/fragments and sensitive or
unknown referrers stay OFF. Coarse event labels are NOT URL sanitization.

Regional/manual restrictions remain unqualified; `lite=true` proves neither
manual-beacon exclusion nor residence. Native unload/visibility/SPA/hash
handling and referrer-policy compatibility remain unqualified. `spa:false`
is prepared, but no supported immediate-stop proof exists. Script removal
cannot stop vendor handlers. No history patching or automatic reload of
unsaved work: an already-loaded document is told to save/reload after exclusion
and warned of final in-flight events. Gates MUST remain false pending separate
qualification. An OFF removal release is independent of these ON blockers.

## Fresh local checks and artifacts

- Typecheck PASS; 316/316 preview unit fixtures PASS (227 Worker, 89 analytics).
- 77/77 packaging/local runtime checks PASS, including actual staging and
  production workerd. Repeated after correcting a reconstructed host regex.
- Build PASS; all three renderer/slogan lock checks PASS; both preview build
  CLIs PASS; diff whitespace check PASS. No thresholds or timeouts weakened.
- No dependency install/download. Isolated copy of the existing other
  checkout's dependencies used; its lockfile exactly equals the base lockfile:
  SHA-256 `79a3394886445f367593dc311bb0823698fec3d5eafdcc955320b8296d0af010`.
  Dependencies, renderer/compiler/release inputs unchanged.
- No fresh full-suite, CI, visual/browser or live service qualification claimed.
  The source/DOM tests mock script appends; workerd uses loopback only.
- Two explicit retained artifact builds (one per environment); test suites
  additionally build disposable fixture packages. One TypeScript build.
  Uploads=0, CI dispatch/runs triggered=0, live HTTP/SVG/browser/analytics
  requests by this task=0. No authentication command or provider read performed.

| Artifact | Relative directory | Manifest SHA-256 |
| --- | --- | --- |
| Staging | .local/preview-cloudflare/staging-j505oD | 9a60f59ab648349fcef43336d86b8c78809f972d8892e7a470685ec497e69e69 |
| Production | .local/preview-cloudflare/production-npwaGe | eed86ef6f4b72d3556f5231b30ab6c1d2462ecbc493690d5d133401d27889a30 |

Each artifact inventories 26 files: Worker/config/metafile plus 23 public-tree
files, including nonserved _headers (22 served assets). Shared Worker SHA-256:
`af456fc0daa694fe1f1996028605dca50241f90f515121062bef8386f107dce6`.
Shared client: 7,072 bytes,
`d971b399407ae940b992750ed0817dc8cf30c60f7ffafda6cc22d2d51467b064`.
Every listed artifact byte count/hash has been rechecked offline.

## Access and capacity: current limits

Recorded retained Gallery account: `a54e5847cc16e612aa3ad45a5dadb563`.
Staging Worker `signatures-gallery-staging`, custom hostname
`staging.signatures.gallery`, PUBLIC_ORIGIN
`https://staging.signatures.gallery`, only ASSETS/PUBLIC_ORIGIN bindings.
Production is separate Worker `signatures-gallery` / signatures.gallery.
Wrangler config remains in each packaged `wrangler.json`.

Existing preserved Claude checkout has readable Wrangler 4.147.0 files, plus
the exact test/build dependencies; an isolated local copy now exists here.
This is file availability, NOT an executed CLI/native login/target-account
permission check. OPS's unavailable main-checkout CLI finding is not silently
superseded by an installation. No new authentication/grant was requested.
OPS must reconcile the intended inshell-profile identity with this exact
Gallery account and confirm existing staging upload/rollback access, live
version, account capacity/plan/quota before a separately approved release.
Preserve old Agent Art access until actual target staging/recovery qualifies.
Stop on wrong account, missing permission or stale login; do not expand grants.

OPS's November 3 8/8 public GET/HEAD/TLS/readiness checks are retained supplied
evidence, not rerun here. No live SVG/load test or provider CPU metrics queried.
Free-plan CPU/request headroom, current errors/usage and deployment permission
remain unknown. Local wall time and HTTP200 do not prove hosted CPU compliance.

## Proposed bounded staging workload — NOT executed or authorized yet

Use the existing Worker-artifact release path, NOT an invented staging Git
branch. Review the patch then obtain source publication/PR/CI and staging
deployment approval. Protected-main rules remain. This task created no PR and
triggered no workflow. A future single qualifying workflow has eight jobs;
branch/PR/main events may each trigger another run: budget only explicitly
approved runs rather than assuming they are free or already passed.

1. Verify exact source/diff and artifact inventory, fresh native account,
   staging version, capacity and recovery access. No new registration, DNS,
   binding, secret, collector/provider setting or plan. Rebuild once if the
   approved source/config differs; never overwrite an existing artifact.
2. Propose ONE staging artifact upload/deployment, collection OFF. One logical
   deploy may involve multiple provider requests/asset batches; this candidate
   has 22 served asset paths plus headers. Do not invent a one-request cost or
   assume every asset will upload. Record actual version/deployment IDs.
   No production upload in this step.
3. Propose <=34 sequential ordinary staging requests: GET+HEAD on eight fixed
   paths (/, /about, /explore, /health/ready, /agent-index.json, /robots.txt,
   /assets/preview.js, /assets/preview.css) =16; one 15-character numeric
   handle across 16 MBTI SVGs plus one locked reference SVG =17; one font GET.
   Use the existing runbook's preview SVG route/locked reference and manifest
   font path, no new generator or external handle/provider lookup.
   No loops beyond this finite list, cache-busting flood or parallel load.
4. Propose two normal stable-Chrome checks (Home and preview variations),
   <=60 total requests including document/assets/SVGs, <=60 seconds per
   document. No broad SDK execution/collection test. Check no outbound
   vendor request, wallet/mint controls or overflow; Privacy/exclusion stays
   functional. Do not clear storage or overwrite user work; close only owned
   tabs. Unexpected request fanout reaches cap: stop, do not retry.

Total planned ordinary HTTP/browser ceiling=94 requests, not proof of Worker
invocation count: served assets can bypass user Worker, while dynamic SVG
misses consume rendering CPU and traffic outside this sample continues.
CPU milliseconds and cost are UNKNOWN until bounded hosted observation; no
paid upgrade. Suggested active review window <=20 minutes, not a billing or
execution-time guarantee. Stop processes/tabs after review. A staging Worker
release persists after the window until an authorized rollback/next release;
there is NO automatic expiry, background monitor or new scheduled task.

Stop at first analytics send, auth/account/config mismatch, unsafe data/path,
5xx, CPU/quota termination or failed readiness/header/lock check. No blind
upload retry on ambiguity: read actual saved version/deployment once, report
partial state, obtain direction. For a clearly transient ordinary read, at
most one retry after checking its cause, within the request cap. No load test,
provider quota probe, credential fallback or expanded CI rerun loop.

## Existing recovery targets — artifacts freshly verified, versions dated

Offline validation today passed 26/26 files in EACH surviving old package:

- Shared checkout `.local/preview-cloudflare/staging-rvRd1V`, manifest
  `54328e26602685eb3269d6f8d37a5dda01a74707d793403e306d1485e17d0cb7`;
  recorded staging version `437d0660-a805-43c0-b996-a855a7efd14d`,
  deployment `42f83710-cd54-4601-8100-34861c6467eb`.
- Shared checkout `.local/preview-cloudflare/production-RjU8Qr`, manifest
  `0ad7691102fb6262d56b5edd776747484da51a9d1034299f62dee2c844c32e7b`;
  recorded production version `7b5a8084-1ab3-4b1c-8d34-a1f8d3f302c3`,
  deployment `4d0aa35e-70ff-469e-abb1-91e5a58aa821`.
- Shared recorded Worker digest
  `9a0120dd8907b263a7c85c73ea82e00414fc789dd06c429ee90ca9becdfd7fb3`.
  Source `7646fbd`; source-only rollback base `8db7332`.

Before approved staging upload, OPS must freshly verify the staging target
version still exists and access can recover it. Roll back ONLY staging to that
version after an approved failed staging acceptance; no production, DNS or
binding deletion. These packages restore GA4-capable source/CSP, not an OFF
release: disclose that consequence and obtain the appropriate rollback decision.
Never claim the old dates/version IDs are a fresh provider read.

## Preservation and next boundary

Shared about-the-work checkout/two dirty OPS docs and the Claude checkout
remain untouched. Combined OPS-doc diff digest remains
`d66628a3263060c29f79381e634521cfe0d170090d13c4922d7a81b6e5abd7bd`.
Absent worktree registration remains intact. Pulse functionality batch saved;
Lab email/contact, provider accounts/settings/credentials and source main unchanged.

Next: OPS read-only review of this fresh candidate/source-artifact manifest and
workload; reconcile existing native staging/recovery access and capacity.
Source publication/PR/CI, staging deployment, production promotion and any
collector-ON qualification each remain separate approval boundaries. Nothing
in this handback authorizes any of them or a new provider access grant.

## CI/publication workload precision — November 3 addendum

Static review of the unchanged `.github/workflows/verify.yml` confirms both
`push` on `codex/**` and `pull_request` triggers. The first feature-branch push
followed by opening its PR normally creates TWO Verify runs, eight jobs each:
**16 jobs before staging**, not eight. Their concurrency groups use different
refs; do not assume one cancels the other. A later authorized main merge
triggers another eight-job run, separate from staging. Further pushes/PR
synchronizations can add runs and cancel older in-progress groups; no blind
update/rerun loop is proposed. No workflow edit, dispatch or run occurred here.

Concrete proposed path, pending the existing approval boundaries:

1. Operator approves publication of this checked source: commit only the
   candidate files on its isolated `codex/gallery-analytics-off-restored-20261103`
   branch, push once, open ONE PR targeting main. Preserve unrelated files.
2. Wait for both ordinary push and PR CI runs: all eight jobs must pass at the
   intended SHA; resolve any different PR merge-ref/source identity explicitly.
   If main moved or source/config changes, review/rebuild/recheck rather than
   assuming these local packages still match. Do not merge or bypass protection.
3. After OPS account/access/capacity/rollback preflight and explicit staging
   approval, perform ONE manual Worker-artifact staging upload/deployment from
   the source-bound staging package. There is no staging Git branch, CI deploy
   workflow or production upload in this step. Preserve all OFF settings.
4. Conduct the already bounded staging review. Only after its outcome and
   operator approval consider protected-main merge (eight more jobs), then
   separately approved production promotion of the checked production package.
   No merge or production authority is implied by the feature PR or staging.

CI safety distinction: the reviewed workflow clears XAI/X bearer keys, uses
fixture/mock providers, disposable Anvil/PostgreSQL and local workerd. Explicit
`--execute-local-test-transactions` rehearsals start Anvil on 127.0.0.1 with
locally generated/funded test accounts; fixture mint also targets loopback.
The `staging`, `mint`, `runtime` and `recovery` job names do NOT denote a hosted
staging deployment or a live signing/mint operation. These simulated contract
transactions and PG/workerd effects are local to disposable runners. They
grant no public RPC/chain, real wallet/signing, external provider, paid Agent,
analytics or deployment authority. Dependency/action/tool downloads and GitHub
evidence uploads do use network traffic: “local transactions” does not mean
the entire CI workflow is network-free or has zero compute cost. No credential
or signing-provider fallback is permitted on a failure.

Configured job timeout minutes are verify35, preview10, admission20, staging25,
mint20, runtime30, recovery20, pulse10: 170 summed job-minutes per full run,
340 for the initial two runs, plus a later 170 configured main-run budget.
These are configuration ceilings/planning figures, NOT measured duration or a
billing quote. Jobs can run in parallel; allow roughly 30–60 minutes of active
CI wall time for the two initial runs **if runner capacity permits**, with
unknown queue/setup/cancellation overhead and no promised completion deadline.
There is no fresh full-CI timing for this reconstructed SHA. Queue waiting
does not consume the <=20-minute product/staging review window; excessive
queue or failures need a status/decision, not repeated dispatches or weakened
timeouts/checks.

The staged product-check ceiling is unchanged: 34 ordinary requests (including
17 SVG requests) plus two browser documents capped at 60 total requests =94,
with <=20 minutes active review. CPU/capacity/cost remain unknown before bounded
hosted verification. Existing one-retry-within-cap ordinary-read rule and
stop-on-ambiguity/no-blind-upload-retry rules remain. This addendum changes only
the local handback: seven source hashes, patch and artifact identities above
are unchanged. Collection stays OFF; publication/deployment remain on hold.
