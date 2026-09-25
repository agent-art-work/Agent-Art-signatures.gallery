# R1 — bounded background assessment, not a long HTTP request

September 24, 2026. Offline implementation and provider-profile proposal.
No live provider call, new paid approval, database migration, active-runtime
change, contract change or deployment is part of this checkpoint.

## Implemented boundary

The HTTP create route already schedules one owned worker and returns 202.
R1 preserves that flow, private status polling, one active job and zero restart
replay. A disconnected browser after a completed 202 does not cancel the owned
assessment; disconnect before request admission commits still prevents work.
Service shutdown or explicit worker cancellation aborts that owned work.

The opt-in `sg-readiness-assessment-policy-v2` adds exact, review-bound timing:

| Clock | Purpose | Proposed value |
| --- | --- | --- |
| Existing HTTP/RPC and witness/lease clocks | Bound preparation and require fresh permission immediately before each external dispatch | Unchanged; still at most 30 seconds |
| `timing.xCompletionMs` | Receive/parse/account for the one already-dispatched X response | 20 seconds, enclosing a 15-second transport |
| `timing.grokCompletionMs` | Receive/parse/account for the one already-dispatched Grok response | 100 seconds, enclosing a 90-second transport |
| `timing.jobTimeoutMs` | Bound the entire claimed job, including eligibility, both dispatch preparations, responses and persistence | 180 seconds |

These are upper bounds, not a promise that every provider response will finish.
The job may reach its own deadline first if preparation consumes its remaining
time. Database statement/lock timeouts and response byte limits remain intact.

Immediately before fetch, `beginDispatch` checks the original unexpired witness,
database lease, live writer, current review and paid window. It is one-use and
starts a separate completion clock. `assertCompletion` cannot authorize another
fetch: it only checks completion of that already-dispatched call. The original
freshness checkpoint remains expired after the witness ages out. Signing and
wallet submission never receive the paid completion extension.

Completion still requires current review, a healthy writer and no cancellation,
halt or deadline expiry. Natural expiry of dispatch-time evidence/paid admission
does not itself invalidate a bounded response already in flight. Each later paid
leg requires a new independent eligibility observation and fence. No expired
permit is refreshed, no receipt grants authority, and no new assessment is
automatically retried.

Observed receipts can be persisted before a withdrawn-review response is
rejected. Cancellation/deadline cleanup preserves durable uncertainty, fences
and exposure; it does not promise complete accounting after a lost reply or
claim an aborted HTTP request cost nothing. Late successful responses cannot
create an accepted result after cancellation.

## Versioning and compatibility

- V1 policies retain their original short timing and exact review hashes.
  Installing R1 does **not** silently widen an existing approval.
- V2 timing is captured immutably, included in the operating assessment-profile
  hash, and reflected in the signed operation scope. Job duration is bound by
  the profile hash; per-leg completion durations are also explicit in the scope.
- Both paused readiness and active assessment/mint compositions understand the
  same policy parser. A v1 review or a modified, unhashed timing field cannot
  authorize v2 execution. Paid work still needs fresh operating/database/review
  evidence and enabled policy at admission.
- No SQL schema/lock change. Existing immutable assessments, receipts, budgets
  and consumed approvals are untouched. Local-only constructors stay local-only.
- Trusted provider adapters must use the new one-shot transport checkpoint;
  returning an apparent success without it is rejected. Actual X/Grok clients
  already carry it through the shared receipted transport.

## Current provider review and proposed profile

The official [Grok 4.3 model page](https://docs.x.ai/developers/models/grok-4.3)
still lists structured output, tool calling and low reasoning. Retain
`grok-4.3` for the next compatibility pilot; a new model would add a separate
quality question. This is our recommendation, not an account-entitlement check
or proof it is globally the cheapest suitable model.

The [current xAI price table](https://docs.x.ai/developers/pricing) lists short
context Grok 4.3 input/cached/output at $1.25/$0.20/$2.50 per million tokens;
at 200k context the listed rates double. X Search costs $0.005 per fetched post
and $0.010 per fetched profile, in addition to tokens. Do not reuse the old
per-search-call estimate.

[X Search documentation](https://docs.x.ai/developers/tools/x-search) describes
`usage.server_side_tool_usage_details.x_posts_fetched` and `x_users_fetched` as
accumulated, non-deduplicated item counts, including posts fetched in threads.
Our existing receipt retains provider-reported total USD ticks, not these item
counts. Missing total cost remains unknown; citation count is not a substitute
for billing. Itemized reporting can be added with its own compatible storage
review if needed; it is not required to pretend an unknown total is known.

The separate [X API pricing page](https://docs.x.com/x-api/getting-started/pricing)
lists user reads at $0.010 per resource. That lookup uses X credits, not the xAI
balance. This tariff is not an observed bill for the application's token.
The previous X HTTP 402 attempts remain unresolved account-access evidence.

Proposed **new** profile: `sg-grok-mbti-2026-09-24-v2` (not selected/enabled).

- Keep one authenticated X username lookup, then at most one Grok Responses
  request. No retry, repair request, fallback model or reassessment on reload.
- Keep `grok-4.3`, low reasoning, 1,024 output-token limit, three turns, fixed
  global endpoint and native X Search filtered to the verified handle; image
  and video understanding disabled. Keep the existing strict accepted/abstained
  response validation and account-ID/casing checks.
- Use the proposed timing values above; old profile dates are not edited.
- R8 must bind a fresh profile/budget review, explicit handle/attempt/time window,
  actual funded-account association and user-accepted exposure before dispatch.
  A suggested $1 application reservation is **not** a guaranteed provider
  billing cap. Turn/output/time limits do not bound fetched resource charges,
  and cancellation does not guarantee provider-side cancellation/refund.
- Check prices again at that operational boundary. This dated review does not
  authorize an indefinite paid window or mutate console billing controls.

## Verification

The R1 campaign uses mocked X/Grok HTTP responses, synthetic Sepolia evidence,
test-only signed reviews and isolated disposable PostgreSQL. It proves code
behavior, not real-provider latency, billing, quality or staging deployment.
| Campaign | Result |
| --- | --- |
| Staging policy/admission and provider regression | 773 passed; 72 opt-in HTTP cases intentionally skipped |
| Legacy local admission and shared worker, disposable PostgreSQL | 70 passed |
| Staging assessment controller/worker, disposable PostgreSQL | 74 passed in the combined campaign; one subsequent old-review/v2-hash rejection test also passed |
| Assessment coverage | 100% lines/functions, 99.29% branches; existing 100/98/100 thresholds unchanged |
| Release-aware admission | 29 passed; 100% lines/branches/functions |
| Runtime/mint HTTP integration, disposable PostgreSQL | 66 existing cases passed; the new slow-response/disconnected-browser case passed after correcting its test expectation for the existing busy response (503, not 409) |
| Paused-readiness policy compatibility | 29 passed without external IO; the opt-in database/listener suite was not run in this command |
| Typecheck, build and renderer/slogan locks | Passed; RC1 release lock remains `candidate-not-approved` |

The runtime/mint aggregate above combines the suite run and focused corrected
test, not a claim of a single all-green rerun. The HTTP case verifies fast 202,
continuation after the connection closes, private status polling, no duplicate
job and no automatic signing. Both actual provider client implementations also
pass a worker test with mocked X and Grok responses slower than the short HTTP
and admission windows. Other cases cover hung transport, cancellation,
withdrawal, shutdown, stale dispatch, whole-job expiry and provider-free reuse.

Local campaign logs are `/tmp/sg-r1-regression.log`,
`/tmp/sg-r1-legacy-regression.log`, `/tmp/sg-r1-assessment-coverage.log`,
`/tmp/sg-r1-review-binding.log`, `/tmp/sg-r1-admission-coverage.log`,
`/tmp/sg-r1-runtime-tests.log`, `/tmp/sg-r1-http-timing.log`,
`/tmp/sg-r1-readiness-policy.log`, `/tmp/sg-r1-build.log` and
`/tmp/sg-r1-release.log`. These temporary logs are not a retained release bundle.
This checkpoint is not full-application, installed-wallet, hosted-CI or live
provider acceptance. R7 must verify the complete pinned release tree.

Per-step model recommendations: boundary design/implementation — GPT-6 Astra
XHigh; test implementation — GPT-6 Sol High; pricing/profile review — Astra
High; final concurrency/safety review — Astra XHigh. These are task-based
recommendations, not automatic model switches.
