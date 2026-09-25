# Locally developing the future staging assessment worker

September 23, 2026. **Implemented and tested locally with disposable PostgreSQL, mocked X/Grok transports and synthetic chain history. Nothing is deployed to Sepolia or staging.signatures.gallery.** The word “staging” names the eventual configuration target, not where development or verification runs.

This increment wraps the [guarded assessment ports](generative-staging-assessment.md) in an explicit job runner. It does not start the website, expose HTTP, poll a queue, create requests, load credentials, sign authorizations or send mint transactions. Grok remains an external model; the backend worker runs authorized assessment jobs; the user's wallet eventually sends the mint. Real X/Grok requests would cost real credits even with a testnet contract, and none were made here.

## Entry point and lifecycle

`contracts/tools/generative-staging-worker.mjs` exports `createStagingAssessmentWorker(input, dependencies)`:

- `input` is the release/operating/database/review/source composition already required by the assessment controller.
- `dependencies` contains the server-owned provider, X identity resolver and fresh eligibility callback, or none of them for saved-result reuse. Partial configuration, mismatched model/provenance, unknown properties and getter-selected dependencies are refused. The eventual runtime must install approved bounded transports; this module does not discover keys or endpoints.
- `run(intent, signal?)` handles one explicit, already-admitted private request. One run is allowed per instance; there is no internal queue or automatic restart/retry. Session, wallet proof, CSRF, origin, canonical handle and chain checks apply before job ownership.
- `halt()` permanently aborts this instance. `close()` also waits for the current run's bounded ownership/outcome cleanup. A fresh instance does not erase persisted jobs, fences, receipts or accepted results.

Before **and after** the initial job claim inside the same writer transaction, the mandatory staging port checks current operation review, exact restricted-role SQL certification, static operating/profile bindings, live generation state and model. Refusal rolls back the claim. Actual release-aware chain observation and durable provider fences remain effect-adjacent checks for each X/Grok dispatch. Claim validation does not make a network call or pretend a SQL snapshot is a lock over external systems.

After ownership is acknowledged, the sequence is:

1. Refresh request-specific eligibility, pass X dispatch admission, commit its fence, then call X.
2. Persist the bounded receipt and verified account identity, retaining verified handle casing.
3. Refresh eligibility again; pass Grok admission, including the saved successful X receipt/identity, current review, generation and wallet proof; commit its separate fence before calling Grok.
4. Persist the receipt before interpreting the outcome. Save the first valid assessment or a truthful abstention/invalid/uncertain terminal record. Do not manufacture an MBTI on failure.
5. For an already accepted handle, use guarded private reuse. Provider credentials and enabled generation are unnecessary, but current review and wallet/session/request/chain eligibility remain necessary. No new paid dispatch or budget reservation is created.

## Shared worker, unchanged local refusal

The established receipt, identity, accepted-result and recovery machinery is shared through an internal core. `new PostgresAssessmentWorker(...)` still refuses non-local profiles exactly as before. A separate internal factory requires the staging origin/chain/Grok namespace and mandatory admission/claim ports; the release-aware composition constructs those ports. These are trusted code boundaries, not protection from malicious code already controlling the server process.

The local runtime's admission-object identity check is preserved. The refactor does not replace it with an equivalent-looking object, relax public startup or add a development-mode bypass. Existing local callers without the new claim hook retain their behavior.

## Failure, cancellation and accounting

September 24 R1 update: v1 policies retain the reviewed hosting request lifetime. An explicitly reviewed v2 assessment policy instead bounds the whole job with `timing.jobTimeoutMs`, and each already-dispatched response with its own completion budget. HTTP/RPC deadlines and dispatch-time evidence freshness remain short and unchanged. No previous approval is widened by installing this support. See [R1 timing and verification](r1-assessment-lifetime.md) for the exact protocol, current provider-profile proposal and tests. Actual latency/profile suitability still needs operational validation before activation. Cancellation invalidates late callbacks, and only work claimed by the current writer can be closed by cleanup.

Failure classification uses **durable fences**, not just whether the provider callback was entered. A fence can commit immediately before review withdrawal. Such work remains uncertain even when no callback was observed; it is never labelled safe for automatic replay. Lost claim/fence/receipt/result COMMIT acknowledgements preserve durable ownership and poison the writer when appropriate. Accepted data committed before a lost reply is recovered unchanged after explicit restart.

A validated semantic failure remains distinguishable from transport uncertainty through the admission layer's sanitized error. Only a boolean classification is retained, and a durable successful receipt is still required to record semantic invalidity. No raw model response, posts, secret or free-form diagnosis is added to diagnostics. Unknown provider cost remains unknown; local execution and mock costs do not prove a real billing ceiling.

Generation disablement, review withdrawal or wallet-proof invalidation between X and Grok stops the latter. Existing X cost/receipt and the permanent handle guard remain. There is no user reroll, automatic retry, budget reset or new recovery authorization.

## Verification and next step

```sh
# Disposable PG16 tools on PATH, or OPEN_MINT_TEST_POSTGRES_BIN set explicitly.
npm run test:generative:staging-assessment
```

This command covers both the worker and its admission composition; CI uses the same tests with unchanged coverage thresholds. Tests include complete accepted/reuse flow, casing, abstention, malformed responses, HTTP/transport failures, review/grant/generation refusal before claim, changes between legs, lost commits, cancellation, concurrent runs, shutdown and exact reuse after restart without provider clients. The broader persistence/local-runtime regression must also pass after shared-core changes. Fixtures create and remove only their own databases; no existing `.local/rehearsal`, backup, credential, live provider or public chain is changed.

September 23 local evidence:

- **68 integration tests passed** (41 admission + 27 worker). The controller and new worker wrapper each have **100% measured line/branch/function coverage**; including the SQL adapter, the combined result is **100% lines, 99.21% branches, 100% functions**, above the unchanged 100/98/100 ratchet.
- **1,771 regression tests passed, seven intentional skips across 41 files**, covering persistence, staging, provider transports/receipts and chain eligibility. This includes 38 shared-worker unit tests and the unchanged local-runtime admission identity guard.
- A subsequent focused rerun passes after extending the happy path with caller-supplied handle, MBTI, model and prompt overrides: the stored request and server-owned policy still determine the accepted result. This is an internal runner test, not a claim that a staging HTTP route exists.
- Typecheck, build, original renderer/slogan locks, release-candidate lock and whitespace checks pass. The release remains `candidate-not-approved`. No full-app coverage, new browser/Anvil rehearsal, live-provider acceptance or hosted-CI result is claimed for this increment.

Ignored logs under `.local/generative-renderer/`: `staging-worker-final-coverage.log`, `staging-worker-final-regression.log`, `staging-worker-input-check.log`, `staging-worker-final-build.log` and `staging-worker-release.log`.

Next: locally implement the future staging input-journal, authorization and exact wallet-submission integration, preserving existing local-only constructors and the distinct signed review. Then connect site/projection/sharing and rehearse the complete mint/reveal flow offline. Actual provider acceptance, independently verified custody/database evidence, provisioning, deployment and activation remain separate gates. No SVG storage/compression or IPFS work.

Follow-up, September 23: the [guarded input/authorization/wallet-permit ports](generative-staging-mint.md) are now implemented and locally verified. Runtime/private HTTP orchestration, fresh backend wallet-network reads and site/projection wiring are the next integration boundary; there is still no deployed staging service.
