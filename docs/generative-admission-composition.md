# Internal single-operation admission composition

September 22, 2026. **The guards compose through the complete opt-in local RC1 worker, issuer and browser mint/reveal flow. Operator-pinned local review-file loading and bounded startup/recheck are now implemented too.** Disposable PostgreSQL and actual Anvil verify the file-backed flow; earlier headless-browser checks verified the same guarded runtime. Real reviewer custody/evidence, concrete Sepolia database certification and a public entrypoint remain incomplete. Paid X/Grok transport is mocked, signed reviews use ephemeral test keys, and the active site is unchanged. No public startup, paid dispatch, hosted signing service, public deployment or activation was enabled.

This completes the isolated local integration increment within step 3 of the [runtime-admission policy](generative-runtime-admission-policy.md), not public operational admission. Existing public-startup and active-runtime restrictions remain unchanged.

## Implemented components

September 24 R1 follow-up: the separate staging composition now supports an
explicitly reviewed v2 policy with one-use dispatch and bounded response
completion. This supersedes the original short effect lifetime **only** for
already-dispatched paid responses under that policy. It does not lengthen
HTTP/RPC freshness, authorize a second dispatch, change signing/wallet lifetimes
or widen a v1 approval. See [R1 timing and verification](r1-assessment-lifetime.md).

- `src/openMint/staging/admission.ts`: a typed internal orchestration gate. It distinguishes read-only readiness, private saved-result reuse, X dispatch, Grok dispatch, signing and wallet-submission readiness. It returns opaque, single-use, short-lived permits, not serializable approval reports.
- `contracts/tools/generative-admission.mjs`: the release-aware composition. It rebuilds the [operating plan](generative-operating-plan.md), constructs the real [active-state observer](generative-active-state-verification.md), installs its opaque witness reader and cross-binds release, source, limit and current-custody identities. There is no CLI, environment loader, secret resolver or public listener.
- `src/openMint/persistence/assessmentAdmission.ts`: concrete **local-only** database leases for `assessment-x` and `assessment-grok`. They reuse the actual worker's session/proof/request/chain checks and repository's immutable dispatch fences, not an alternative authorization table. Details and evidence follow below.
- `src/openMint/persistence/mintAdmission.ts`, issuer `prepareSigningAdmission` and wallet `prepareSubmissionAdmission`: local-only signing/wallet leases and registered handlers that reuse the existing authorization and wallet-dispatch records. They never call providers, broadcast a transaction or reserve a replacement authorization/nonce.
- `src/openMint/persistence/reuseAdmission.ts`: internal reuse of the exact saved accepted assessment, without provider clients, signing, wallet authority or record mutation. This is not a browser reveal endpoint.
- `src/openMint/staging/localReview.ts`: pinned Ed25519 verification of a current signed **local rehearsal** review, with exact scope, revision, operations, expiry and permanent stop on withdrawal. It does not create approvals, collect evidence or provision reviewer keys.
- `src/openMint/staging/localReviewFile.ts` and `src/openMint/persistence/localAdmissionStartup.ts`: [operator-pinned local file source and startup preflight](generative-local-review-startup.md), with bounded reads, independent key/revision pins, current writer/database audits, withdrawal/rotation refusal and shared controller halt. This is not an operational approval writer or public database certificate.
- `AssessmentExecution.dispatch` and `providerReceipt.ts`: optional trusted live checkpoint and cancellation at the actual X/Grok HTTP boundary. The opt-in local composition registers it; existing paths without the hook retain their behavior.
- `src/openMint/persistence/localAdmissionRuntime.ts`: explicit local RC1 composition binding signed review, the exact restricted writer/database, actual private request eligibility and registered operations. The worker, issuer and browser runtime must share the same instance; missing or crossed wiring is refused rather than falling back to the legacy path.
- Simulated trusted-port fixtures and adversarial tests. These are not operational approvals or real database evidence. The adapter's successful chain tests use synthetic RPC data accepted by the actual observer, not an invented JSON admission witness.

## Readiness versus an effect

`prepare(intent)` is read-only. The exact intent is `{ operation, requestId, payloadSha256 }`: a v4 durable identifier and digest of the exact saved operation payload. No user-selected callback, prompt, MBTI, approval flag or private mint code is accepted by this gate. The durable adapter must resolve that identifier, verify the digest and enforce access; a syntactically valid identifier/digest proves none of those facts.

Preparation checks current review, obtains fresh chain evidence, inspects durable readiness, and rechecks all evidence after asynchronous work. It returns an empty frozen object whose identity is held in that gate's private WeakMap. Its internal binding includes the captured intent, chain witness, scope digest, wall-clock expiry and monotonic age.

`execute(permit)` consumes the permit **before its first await**, including on a failed execution attempt. It obtains a new durable inspection, checks evidence/review/ownership again, then—for an effectful operation—awaits the exact durable dispatch fence. It rechecks immediately after fence acknowledgment and invokes the captured handler in the same synchronous turn as its final checks. Handlers are registered by trusted composition, never supplied to `execute`.

| Operation | Gate behavior | Required trusted durable behavior |
| --- | --- | --- |
| `read` | Fresh chain/review/durable readiness, no effect fence | Exact read/profile/access rules; no paid credentials or issuance switch required |
| `reuse` | Same, no new effect fence or paid-policy-period requirement | Resolve the exact saved result and valid private session/proof; no reroll, new provider call or signing |
| `assessment-x` | Paid policy period checked before readiness and at dispatch; single-use fence | Existing admitted request, wallet proof, scope, X-leg ordering, generation switch, profile and reserved count/exposure limits |
| `assessment-grok` | Same, separately scoped to the Grok leg | Verified X identity and original attempt, no second Grok dispatch, durable reservation/receipt rules |
| `sign` | Fresh chain/custody/review plus exact signing fence; no new paid-period requirement | Immutable accepted inputs/reservation, recipient/nonce/expiry, session, issuance switch and reserved-before-signing state |
| `wallet-submit` | Fresh chain/review plus durable wallet-dispatch fence | Exact saved transaction plan/session/nonce, unresolved-submission protection; handler releases wallet readiness, never broadcasts a public transaction itself |

Read readiness here is for this future active durable runtime, not a universal artwork-availability gate. The active-state observer requires an unpaused collection and current declared custody. Cached finalized artwork, chain-only recovery and the initial paused readiness stage retain their own separate rules. They must not be disabled merely because a new paid operation cannot be admitted.

## Trusted configuration and adapter boundary

The release-aware factory takes explicit operating JSON, deployment/transition hashes, four history limits, declared source callbacks, three durable/review bindings, and trusted ports. Common RPC deadlines, freshness, future skew and permit lifetime are derived from the validated operating settings, not independently overridden. Source identifiers/operators must match in order; aliased callbacks and unknown source fields are rejected. Decoded responses also obey the operating plan's byte cap. Actual transports must still enforce streaming bytes before decoding and have independently accepted provider evidence.

The immutable scope digest commits:

- The complete operating-plan digest and active-observation policy digest (including release/deployment, sources, limits and all declared governance).
- The reviewed database-binding digest, review-revision digest and exact writer epoch.
- Timeout, permit lifetime and the existing paid-policy validity period.

The public database-binding digest must represent the reviewed exact schema/migration/grant, namespace, deployment, session and request/issuer profiles—not a label invented at startup. The local provider adapter's narrower candidate digest is not that public certification. The review revision must be resolved through a trusted operator-controlled review source that verifies security, custody, provider acceptance and the permitted operation/spending envelope. **The local signed-review verifier checks a supplied current source, but does not resolve evidence references, collect human approvals or implement a public operational source.** A JSON `approved: true`, a hash by itself or the current process knowing a reference is never proof of review.

Three trusted ports must be implemented before runtime use:

1. `requireReview(scopeSha256, operation, now)`: synchronous, throws on missing, revoked, stale or crossed review. It must check real approved material and current local stop policy. An async promise is rejected, not accidentally ignored.
2. `database.inspect(intent, scopeSha256, signal)`: bounded read-only audit returning a short-lived lease bound to the exact database digest, writer epoch and intent digest. Its synchronous `assertCurrent` must check live ownership/configuration/switch state; its `fence` must revalidate relevant database state transactionally and durably commit the exact operation marker before resolving. This must reuse existing transactional session, budget, worker, issuer and wallet fences, not replace them with booleans or process memory. Per-request chain eligibility, nonce/expiry and recipient checks remain necessary; global active-state evidence alone does not establish eligibility for a handle.
3. Registered effect handlers receive `(intent, signal, assertCurrent)`: dispatch only the exact fenced operation and persist outcomes/receipts using existing durable rules, including after caller cancellation. **After every asynchronous preparation step, call the supplied live check synchronously immediately before the actual external action.** It rechecks review, chain evidence, policy period, ownership, halt, cancellation and permit expiry; entering the handler is not reusable authority to dispatch later. A handler must not queue a later unguarded dispatch, accept request-selected payloads/callbacks, retry, or return before its required persistence is complete. Read/reuse handlers must actually be read-only. `effectMayHaveStarted` is deliberately conservative once the handler is entered, even if its later checkpoint prevents the actual external call.

These ports and injected clocks are trusted application code. The gate is not a sandbox against malicious code inside the same process. Fabricating ports that always approve can defeat an internal primitive; it cannot turn the current application into a public runtime because no entrypoint consumes it. The release-aware factory cannot accept a caller-supplied chain reader, and its returned permits cannot be forged by public JSON.

Current-custody comparison is deliberately stricter than active observation. The observer can verify declared signer/manager handovers, but this first admission adapter rejects a final signer or role holder different from the operating plan's original custody bindings. A versioned, reviewed custody-update adapter is needed before admitting rotations; never rewrite the constructor plan or restore a retired signer to make a check pass.

## Failure semantics

- Review drift, stale/crossed evidence, writer/session/policy loss or cancellation before handler invocation produces no external action **by this gate**. A durable fence may nevertheless have committed or have an uncertain acknowledgment. Keep it; do not infer rollback from this error.
- Once an effectful handler is invoked, any failure, timeout or late reply reports `effectMayHaveStarted: true`. The permit stays consumed; reconciliation uses durable records, not another automatic attempt. The gate never deletes a fence, releases spend, resets history or substitutes a new assessment.
- A second permit or a restarted process still requires the existing durable fence to reject duplicate execution. The WeakMap alone is intentionally not a cross-process replay defense.
- `halt()` permanently prevents new work in that gate. Pending checks remain bounded; late completions recheck the halt and cannot dispatch. Restart must reconstruct reviewed configuration, writer ownership and chain observations.
- Deadlines use both wall and monotonic time. Backward clocks, stale leases, copied permits, cross-gate permits and expired evidence fail closed. Timers/listeners are removed and child signals aborted on completion. No new queue, background retry loop or public endpoint was added.

Database transactions and external provider/signing actions are not atomically reversible. The final checks narrow the dispatch boundary; they do not promise that a remote operator cannot change chain/database state immediately afterward. Existing conservative reservation, receipt, unknown-outcome and recovery procedures remain mandatory.

## Local evidence and next integration

```sh
npx vitest run src/openMint/staging/admission.test.ts --coverage --coverage.include=src/openMint/staging/admission.ts
npm run test:generative:admission:coverage
npm run test:generative:active-state:coverage
```

The new core has **81 tests**, **100% statements/lines/functions and 98.63% branches**. The release-aware adapter has **27 tests and 100% line/branch/function coverage**, with dedicated CI thresholds. The active observer now also accepts a zero future-skew tolerance (already valid in operating settings); negative skew remains rejected. Its **70 tests** pass with **100% lines/functions and 98.45% branches**. This changes no contract or release lock.

The pristine observer's 83 tests, 38 operating-plan tests, 119 release-tool tests, 177 Solidity tests, typecheck, build and renderer/slogan/candidate locks pass. Ignored logs are `.local/generative-renderer/admission-*.log`. The broader selected application run has **553 passes and 80 PostgreSQL-dependent skips** across nine files, including startup refusal, writer, worker, repository, role-audit and authorization tests. No real database, real RPC/provider or independent-review claim is made. Hosted CI is configured, not observed.

### Local provider-leg PostgreSQL adapter — September 22

`observeLocalAssessmentBinding` audits the real PG16 runtime role and returns a candidate configuration digest. `prepareLocalAssessmentAdmission` requires that exact independently supplied pin plus scope digest, expected runtime role, model, leg and a current private request/session/wallet proof. It returns the exact immutable operation intent and a database port; it neither claims a queued job nor runs a provider. The attempt must already be running under this writer epoch.

Every inspection checks the actual dedicated owner connection, role/grant/layout audit, namespace and deployment/session/request profiles, RC1 renderer pins, exact request eligibility, wallet proof/generation/CSRF/origin, enabled unexpired generation policy, reserved exposure and prior dispatch state. Grok additionally requires the actual stored successful X receipt and verified identity. Its payload digest includes that identity, not a browser-supplied MBTI or prompt. Leases expire no later than the session, request, proof, chain evidence or policy deadlines. A permanent adapter halt and the live writer check apply synchronously immediately before the registered effect.

Fencing redoes the inspections inside the same exclusive-writer transaction, calls the existing `beforeDispatch`, rechecks controls and proof, and resolves only after COMMIT acknowledgment. Existing `dispatch_fences` are the cross-process authority. Cancellation before COMMIT rolls back; a lost acknowledgment after COMMIT makes the writer unavailable and preserves the committed marker. Both cases leave the claimed job unavailable for automatic reclaim. Two independently prepared gates cannot dispatch the same leg twice. No marker, reservation or result is deleted or reset by this adapter.

The candidate binding includes the actual database name/user, persisted namespace, session/request/renderer/budget profiles and schema/projection versions. Policy quantities remain PostgreSQL JSON text so large integers are not rounded in JavaScript. The separately checked generation switch is intentionally not part of the immutable digest. Role/layout auditing **does not certify every constraint/trigger, migration provenance or remote database identity**; nor does the digest itself prove review. Those are still required for a public database adapter. Database policy is checked transactionally; synchronous post-COMMIT checks cover the process halt, ownership and expiry, not an impossible atomic lock over PostgreSQL and a remote provider. Operators must coordinate policy changes with stopping/draining the runtime.

This adapter refuses non-`local-real` namespaces, non-Grok provenance, non-Anvil chains and non-RC1 renderers. It does not wire itself into the current site, widen the public observer to accept Anvil, or pretend its synthetic review/chain-global test ports satisfy Sepolia admission. The registered production provider handlers and trusted review source remain work to compose. Issuer/wallet adapters are implemented in the next checkpoint below; private reuse still uses the **existing** worker without provider clients, not a newly implemented `reuse` port.

Reproduce with PG16 installed (set `OPEN_MINT_TEST_POSTGRES_BIN` to its binary directory if needed):

```sh
npm run test:generative:assessment-admission
```

The suite creates and removes only its own disposable, Unix-socket-only PostgreSQL cluster. It uses restricted runtime grants, real wallet-proof signatures from public test scalars and the actual request/repository/worker code. Global chain/review evidence and provider effects are offline fixtures. Tests cover changed/expired configuration, real permission drift, invalid sessions/proofs, immutable-policy corruption injection, exposed cost beyond reservation, concurrent permits, cancellation, actual COMMIT with a lost client reply, restart refusal, and accepted-result reuse with generation disabled. No paid/provider, actual chain transaction, pilot-record mutation or operational-approval evidence is claimed. CI runs this focused coverage ratchet as well as the broader application suite; hosted execution has not been observed for these changes.

Observed: **33 adapter tests passed, 100% statements/branches/functions/lines**, enforced by the focused CI command. The broader persistence/admission run passed **866 tests in 21 files**. The separate opt-in HTTP-listener run then passed **47 tests**, with seven profile-specific skips: **913 distinct passing tests overall** across those two runs. This includes actual disposable-database worker, input-only authorization, wallet/recovery, projection/reveal and restart regression tests for both renderer profiles. Typecheck, build, original renderer/slogan locks and the unchanged RC1 lock pass. Local logs are `.local/generative-renderer/assessment-admission-regression.log` and `assessment-admission-http.log`; focused coverage is under `.local/generative-renderer/assessment-admission-coverage/` (ignored).

### Local signing and wallet admission — September 22

`observeLocalMintBinding` adds the immutable issuance policy to the existing local candidate database digest; the separately checked enabled switch remains outside the digest. This pin has the same local-only limitations as the assessment pin, not public migration/custody certification. `prepareLocalMintAdmission` binds a server-owned operation, audited database, scope, writer epoch and short-lived proof; its handler releases a result only after the exact fence COMMIT was acknowledged. It enforces single-use fence/release and supplies the gate's live checkpoint through to the real signer boundary.

- **Signing:** `prepareSigningAdmission` reads an existing reserved authorization and revalidates the exact accepted assessment, frozen compact inputs, original request/session/generation, recipient, renderer/domain, nonce, proof and expiry. Preparation does not reserve or sign. Its transaction transitions the existing row from `reserved` to `signing` under the current writer epoch. The handler then checks that committed row and fresh controls, signs the exact captured typed data, verifies canonical ECDSA and persists the signature using the existing issuer completion path. There is no asynchronous gap between its final checkpoint and signer invocation. Cancellation reaches the signer; timeout/invalid/uncertain results preserve the reservation and forbid another signing attempt. A signed-result COMMIT with a lost reply is recovered byte-for-byte through the existing issuer, without calling the signer again.
- **Wallet readiness:** `prepareSubmissionAdmission` reads the exact saved plan and uses the issuer's read-only `prepareSignedInspection` to revalidate the signature, accepted inputs, original wallet proof and current authorization eligibility. It binds the exact calldata, wallet nonce, authorization and next dispatch attempt. Fencing inserts the existing `wallet_mint_dispatches` marker, never a new table or broadcaster. After acknowledged COMMIT and final live checks, the handler releases only the matching private permit. Unknown submission remains blocked across restart. A reported rejection permits only the existing bounded explicit resend at the same saved nonce/calldata, at most five attempts. No automatic replacement, resend or nonce-gap repair was added.

Both operations require current enabled issuance and valid private proof. Neither needs a new paid-generation period, provider credential or enabled generation switch. Previously saved results remain stored on any refusal. These stricter release checks do **not** revoke a signature/transaction already released to a caller; contract pause/revocation and chain reconciliation remain separate. The existing read/recovery APIs retain their own policies; this increment does not claim a new private `reuse` gate or disabled-issuance read port.

Verification: **39 focused PostgreSQL tests** pass; `mintAdmission.ts` has **100% measured statements/branches/functions/lines**, enforced by the dedicated CI command. Core admission now has **82 tests** including the asynchronous-handler checkpoint; the release-aware adapter's **27 tests** still have 100% coverage. The broader persistence/HTTP/admission run passed **952 tests, seven profile-specific skips** before the final saved-signature-COMMIT recovery case was added and passed in the focused run. Build, typecheck and renderer/slogan/RC1 locks pass. A fresh disposable Anvil/PostgreSQL RC1 rehearsal also passed actual mint, canonical Confirming reveal, finalized-only gallery and automatic observation. That rehearsal verifies the refactored existing issuer/wallet path; the new gate adapters are tested with offline global chain/review fixtures and are **not yet connected to the running site or a reviewed public entrypoint**. No provider request, public transaction, existing database/chain mutation or credential use occurred. Hosted CI is configured, not observed.

```sh
# Set OPEN_MINT_TEST_POSTGRES_BIN to the PG16 binary directory if needed.
npm run test:generative:mint-admission
```

Ignored evidence: `.local/generative-renderer/mint-admission-focused.log`, `mint-admission-regression.log`, `mint-admission-anvil.log` and `mint-admission-coverage/`.

### Saved-assessment reuse, signed local review and provider checkpoints — September 22

`prepareLocalReuseAdmission` binds an exact accepted assessment to its original private request/session, current wallet generation/proof, deployment and fresh opaque eligibility. It reuses the worker's real access checks and repository's saved-payload validation. Every execution rereads the saved bytes and rechecks the intent digest; it does not return the preparation-time object. Inspection and release make no application-record writes, and the lease explicitly refuses a dispatch fence. A repeated explicit read needs a new permit, never another assessment. New-generation and issuance switches, provider keys and the gate's paid-generation period are not needed.

This operation is **internal assessment reuse during a still-valid mint request**, not general historical recovery, mint authorization or an early reveal API. It deliberately retains the worker's request/proof expiry rules. Existing `requests.get` recovery remains readable after request/proof expiry under its own active-session/same-wallet policy. No UI endpoint exposes an unrevealed MBTI, and finalized-artwork availability remains independent of this gate.

`createLocalAdmissionReview` takes a trusted pinned Ed25519 public key, an exact scope/review revision and a synchronous `readCurrent` source. It verifies the signature over bounded canonical JSON and checks scope, allowed operation, validity interval and the digest of the reviewed material. The review payload binds the scope **without** its review-revision field; hashing that payload supplies the field without a circular commitment. Writer epoch, database/operating/chain policies and the paid-period boundaries remain part of the signed scope. Missing, changed, expired, invalid or withdrawn material permanently stops that instance; putting old bytes back cannot revive its permits. New startup must obtain the trusted current source and revision again. The verifier does not prevent an operator from misconfiguring that source or prove the contents of referenced evidence. There is no private reviewer key, approval-writing command, file loader or public review implementation in this increment. Test signatures use freshly generated, disposable keys and are **not user approval**.

The optional `AssessmentExecution.dispatch` hook forwards a gate checkpoint and cancellation signal to both existing provider clients. `receiptedJsonRequest` invokes the checkpoint synchronously immediately before `fetch`, with no intervening await. A denied pre-dispatch check makes no HTTP request and fabricates no receipt. Cancellation in flight aborts the transport and preserves unknown-cost accounting; observed receipts are persisted before withholding a result on a final withdrawn/expired check. A fence is never cleared because a checkpoint or receipt failed. Trusted registered handlers still own identity, terminal and accepted-assessment persistence; the hook alone is not the complete worker orchestrator.

Offline PostgreSQL composition now exercises a signed fixture review, both actual X/Grok client implementations with mocked HTTP, committed provider fences, verified case-preserved identity, receipts and exact accepted-assessment persistence. A second case withdraws review after fence acknowledgment and an awaited handler step: the real client refuses its HTTP call, while the fence remains. No paid/remote request or live API credential is involved.

Focused evidence: **29 reuse PostgreSQL tests**, **32 signed-review tests** and **11 provider-checkpoint tests** pass. The provider-leg PostgreSQL suite now has **35 tests**, including the two composed-client cases. Reuse, local-review and provider-leg adapter modules each have **100% measured statements/branches/functions/lines**, with dedicated CI thresholds. The broader persistence/HTTP/admission/provider run passed **1,236 tests with seven profile-specific skips in 29 files**. Build/typecheck, renderer/slogan locks and the RC1 lock pass; the release-adapter suite has 27 passing tests and 100% coverage. Hosted CI is configured, not observed. No new Anvil/browser or hosted-operation evidence is claimed in this checkpoint.

```sh
npm run test:generative:reuse-admission
npm run test:generative:local-review
npm run test:generative:assessment-admission
```

Ignored logs: `.local/generative-renderer/reuse-admission-focused.log`, `local-review-focused.log`, `reuse-provider-regression.log`, `reuse-provider-composition.log`, `reuse-admission-regression.log`; focused coverage directories are `reuse-admission-coverage/` and `local-review-coverage/` under that directory.

The next checkpoint below completes the local orchestration work proposed here. Operational review, public admission and a separately authorized real-provider pilot remain separate.

### Complete guarded local mint/reveal integration — September 22

`LocalAdmissionRuntime` composes the existing adapters without introducing another authority store. It is accepted only for a matching local-real/Grok/Anvil RC1 runtime. Its immutable review bindings capture the writer epoch and exact candidate database pins. Each operation validates real opaque private-request eligibility, not an invented always-current global witness; the release-aware public observer remains unchanged and still refuses Anvil.

The worker now optionally routes saved assessment reuse and each actual X/Grok client call through this controller. Fresh eligibility is obtained before each provider leg; the gate stays alive around the call, receipts and transport checkpoint. Existing durable identity, terminal and accepted-result persistence remains authoritative. Timeouts, provider uncertainty, invalid responses and shutdown preserve fences and never retry automatically. Runtime drain halts the shared controller and aborts an in-flight transport.

Signing now selects either a fenced signature operation or an exact saved-signature read operation. That read has no new signing fence and cannot call the signer. An unsigned reservation may be created before a later review refusal; it is preserved but confers no released authority. Current private proof, issuance, accepted inputs and authorization expiry still apply. This is not the general historical-recovery policy or permission to revive an uncertain signature.

The browser submission boundary now delegates through the same runtime/controller after fresh authorization-nonce eligibility. Only the exact saved wallet plan receives a private permit after its durable marker is acknowledged. The controller never sends a transaction; the isolated browser test wallet does that once. Missing admission wiring cannot silently use an unguarded fallback. The existing application launchers have not been switched to this opt-in composition.

The actual Anvil run exposed an EVM address-casing comparison bug: real renderer pins were checksummed, while earlier fixtures used digits-only addresses. Provider and reuse checks now compare both address strings case-insensitively, while keeping the exact database-binding digest intact. The new runtime tests use a checksummed pin. This does not lowercase X rendering handles or change renderer bytes, commitments or release locks.

Evidence:

- **14 new full-runtime PostgreSQL tests**, with **100% measured statements/branches/functions/lines** for `localAdmissionRuntime.ts`. They cover all six operations, exact saved reuse, missing/withdrawn/asynchronous review, wrong provider leg, invalid response/signature, timeout, shutdown in flight, proof invalidation, crossed components and no automatic retries. CI enforces the dedicated threshold.
- **40 mint-adapter PostgreSQL tests** with **100% measured coverage**, including read-only saved-signature release and explicit refusal to fence/re-sign it.
- Full application coverage: **5,852 passing tests, seven intentional skips in 178 files**; **96.40% statements/lines, 92.24% branches, 98.47% functions**, thresholds unchanged. Provider/reuse adapters also retain their dedicated 100% coverage checks. Typecheck, build, renderer/slogan locks and the unchanged RC1 release lock pass. Full log: `.local/generative-renderer/guarded-runtime-full-coverage.log`.
- The RC1 rehearsal passes with actual disposable Anvil, restricted-role PostgreSQL, real client implementations with mocked X/Grok HTTP, ephemeral signed review fixtures, one signer call and exact signature reuse across writer restart. It confirms canonical inclusion → **Confirming** → finalized-only gallery, automatic observation and byte-exact chain-only artwork recovery after removing its own temporary database. No SVG is stored or submitted with the mint.
- The optional real headless-browser rehearsal clicks the production client CTA with a simulated test wallet: **one begin call, one local wallet send, one report call**. All **nine browser views** pass DOM/network/geometry assertions and screenshot inspection at desktop light/dark and mobile dark sizes, with no horizontal overflow or failed HTTP requests. It covers pending submission, Confirming, Minted, gallery, variations, preview, collection and About. This is not Rabby/MetaMask extension or device-matrix certification. Finality lag is deliberately simulated against the same local node; two independent public RPC operators are not validated here.

Reproduce without credentials or active runtime data (PG16 and Anvil required):

```sh
npm run test:generative:local-runtime
npm run generative:rehearsal -- --execute-local-test-transactions --release-candidate --quick --mint --backend
# Optional browser checks: append --visual-tool /absolute/path/to/visual-dom-cdp/scripts/verify-page.mjs
```

Ignored evidence: `.local/generative-renderer/guarded-runtime-focused.log`, `guarded-runtime-mint-regression.log`, `guarded-runtime-anvil.log`, `guarded-runtime-browser.log`, `guarded-runtime-regression.log`, `release-quick.json` and the screenshot/coverage files in that directory. Hosted CI is configured, not observed.

The next checkpoint below completes the local review-file loading/startup work proposed here. Real custody/evidence and public admission remain separate.

### Operator-pinned review-file startup — September 22

The [file-source and startup implementation](generative-local-review-startup.md) now reads only explicitly named, size-bounded, owner-only local files, verifies a separately supplied Ed25519 key fingerprint/revision and checks current material at every gate checkpoint. Missing, unsafe or changed material permanently stops the observed source; startup/recheck failure stops the shared controller. No automatic key/revision selection, approval creation, listener, database initialization or credential loading is added. New epochs and key/revision rotation require independently trusted pins, never auto-repinning.

Preflight/recheck audits actual local role/layout/profile/writer bindings and required review operations before/after asynchronous work, supports cancellation/deadlines and rejects late completion. Tests verify the complete file-backed worker/issuer/wallet path, refusal after X/before wallet release, policy corruption detection, unsafe paths/file races and explicit rotation. The existing public observer and active startup are unchanged. Same-UID/root, hostile filesystem behavior, external anti-rollback state, already released signatures and public migration/custody certification are explicitly outside this local file-source guarantee; see the linked trust-boundary notes.

**50 file-source tests** pass (100% statements/functions/lines, 98.07% branches); **32 guarded-runtime PostgreSQL tests** include **18 new startup cases** and give the new startup module 100% coverage. Dedicated CI thresholds enforce these results. The broader persistence/HTTP/admission/provider run passes **1,319 tests with seven intentional skips in 32 files**. Build, typecheck, renderer/slogan/RC1 locks and 27 release-adapter tests pass. A fresh `--review-files` Anvil rehearsal verifies two startup epochs, one signer call, exact saved reuse, HTTP mint, Confirming/finalized gallery and chain-only recovery. No new visual/extension, full-application coverage or hosted CI run is claimed by this checkpoint.

**Next, local first:** implement the public database certification boundary against exact migration/constraint/trigger/grant/profile evidence, with offline mutation/refusal tests; then compose resource-limited, separately gated Sepolia startup. Actual reviewer custody, approved evidence and provider-account acceptance remain required before activation. The real X/Grok → Anvil pilot still needs resolution of E10's billing/account evidence and an available paid envelope; none was spent here. Public deployment, custody changes and activation remain separate approvals.
