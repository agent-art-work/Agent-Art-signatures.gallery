# Future-staging loopback startup and observer ownership

September 23, 2026. Local implementation and offline rehearsal only. This does
not deploy or activate `staging.signatures.gallery`, provision credentials,
authorize spending, or broadcast to Sepolia. Existing local constructors and
the production refusal remain unchanged.

## Owner API

The caller supplies the same already-opened, certified, exclusively owned
database and independently pinned runtime/review dependencies used by
`createStagingSite`. Construction remains unlistened and performs no RPC or
provider call. It does not acquire/migrate a database or discover secrets.

After composition, call `await site.start(port, ownerSignal)` explicitly. The
port must be an integer from 0 through 65535; zero is for ephemeral rehearsals.
There is no host/proxy/TLS override: the listener binds **127.0.0.1 only**, and
the HTTP adapter requires the exact staging Host/Origin and the
[trusted-loopback proxy policy](generative-staging-transport.md).

Startup performs a fresh, certified two-source observation before listening.
No cached projection row substitutes for that observation. An already-aborted
signal, withdrawn review, bad source, deadline, production mode or bind failure
cannot leave a late listener. Startup is single-use; failure requires a new
composition, not an automatic restart. The bound covers `start`, not the
caller's prior resource acquisition or composition work.

`site.snapshot()` returns an immutable phase/observer snapshot without private
request, wallet, assessment or credential data. `site.close()` is idempotent.
The parent signal remains attached for the owner's entire lifetime. Closing
the listener directly also stops its observer and runtime.

Manual `server.listen` / `site.sync` remain available for existing offline
harnesses before owned startup. Owned startup refuses a manually active
listener/pass; after startup, public `sync` is refused. There is no HTTP route
to start, stop, accelerate or configure observation.

## Scheduling and contention

Cadence derives from the captured operating settings:

- Interval: half the reviewed RPC evidence TTL, bounded to 250–5,000 ms.
- Initial delay: one interval after the successful startup observation.
- Pass deadline: the reviewed hosting request timeout. Startup has the same
  deadline; both startup and poll completion check monotonic elapsed time so
  a delayed timer callback cannot turn a late success into admission.
- Completed unavailable passes back off exponentially, capped at 30 seconds;
  a successful observation resets the delay. No overlap or catch-up burst.
- A hung/error/busy/writer-unavailable pass or finalized contradiction stops
  observation **and admission**, closes the listener and withdraws freshness.

Every pass rechecks review/database bindings before and after observation.
Freshness is withdrawn during a pass and on failure; readers may correctly
return unknown/503 while observation is incomplete. This change does not keep
old evidence fresh or promise uninterrupted gallery availability.

The runtime now has two bounded single-flight lanes: one API operation and one
owner-only **read-only certification**. Both use the same serial, fenced SQL
writer and existing certification checks. A check cannot reject a browser
operation as BUSY merely by occupying its slot. It cannot prepare, sign, release
a permit or dispatch a provider. Neither lane queues or retries effects.
At most one explicitly requested assessment worker remains separately owned.
Cancellation of a check does not poison an unrelated API operation; a runtime
deadline in either lane quarantines the whole instance.

Two concurrent API operations can still return BUSY. The existing bounded
page-read wait and identical-report retry are unchanged; this is not a general
request queue or automatic POST retry.

## Drain and restart

Stop immediately aborts observation and admission and withdraws public reads.
Close waits for the listener, runtime, active observer and pending startup,
bounded by the reviewed drain timeout. The site never closes the caller's
writer. A rejected/incomplete drain is sticky and explicitly says to **retain
writer ownership**. Cancellation or a timer firing does not prove underlying
database cleanup has finished. The owner must reconcile/drain outstanding work
before releasing resources; there is no retry, forced writer takeover or reset.

Restart creates a new site with no freshness. Its first observation is required
again; saved assessment/authorization/dispatch records remain intact. It never
recovers a pending paid job automatically. Reusing the same open fixture writer
in browser tests does not replace the separately tested new-writer epoch and
review-binding requirements.

## Offline evidence

Tests use disposable PostgreSQL 16, synthetic chain history, mocked X/Grok and
public fixture signing accounts. They cover both concurrency orders, duplicate
lane refusal, cancelled checks, effect-count integrity, fresh startup, automatic
transient recovery, Confirming/finalized progression, finality safety halt,
parent cancellation, failed bind, deadlines and incomplete drain.

The [browser-wallet rehearsal](generative-staging-browser.md) now starts the
owned lifecycle. Inclusion/finality only change synthetic chain input; they
never call sync or pause browser forwarding. The observer discovers them on its
own cadence alongside real page/session/wallet API traffic. Restart and explicit
test logout still quiesce forwarded HTTP to make those operator transitions
deterministic; observer ticks do not. All three browser scenarios and four
inspected screenshots pass: exactly one preparation/authorization/begin and at
most one simulated send, even after reload/restart/lost outcome. This is not a
real extension, EVM renderer or hosted TLS acceptance test.

Commands:

```sh
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run test:generative:staging-runtime
npm exec vitest run -- src/openMint/projection/poller.test.ts src/openMint/persistence/generativeSite.test.ts
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run generative:staging-browser -- --visual-tool /absolute/path/to/verify-page.mjs
```

Current-run logs are ignored `staging-lifecycle-*` artifacts under
`.local/generative-renderer/`; browser JSON/screenshots remain `staging-browser-*`.
No paid calls, broadcasts, active rehearsal changes or backup cleanup occurred.

Final results:

- **59 distinct runtime/site tests pass**: 32 runtime tests plus the final
  27-case site suite. The earlier combined coverage campaign ran 58 tests;
  after the final immediate-halt refinement and additional observer-deadline
  case, the entire site suite was rerun on final source. Runtime/HTTP coverage
  remains **100% lines / 96.48% branches / 96.92% functions**, with the existing
  100/94/95 gate unchanged. This percentage does not measure site source.
- **593 client/page/local-site/poller regression tests pass**. The dedicated
  32-case poller suite measures 100% statements/functions/lines and 98.21%
  branches, including deferred startup and delayed-timer monotonic expiry.
- **3 browser flows and 4 inspected screenshots pass**, mobile dark and
  desktop light, with no overflow and loaded artwork. Expected BUSY reports,
  revoked-session reads and withdrawn-review refusals are explicitly checked;
  this is not an all-200 claim. No external browser requests are accepted.
- Typecheck, build, original renderer/slogan locks, RC1 lock, syntax and
  whitespace checks pass. RC1 remains `candidate-not-approved`; hosted CI is
  not claimed. Temporary browser/site/database services have been closed.

Primary logs: `staging-lifecycle-runtime.log`, `staging-lifecycle-site-final.log`,
`staging-lifecycle-terminal.log`, `staging-lifecycle-regression.log`,
`staging-lifecycle-poller-coverage.log`, `staging-lifecycle-browser.log`, and
`staging-lifecycle-{build,typecheck,release}.log`. The focused drain/cancellation
logs are supplementary, not additional distinct test counts.

## Next

The [staging cookie/transport increment](generative-staging-transport.md) now
implements the operating plan's `__Host-sg-staging`/Strict policy and bounded
trusted-loopback HTTP. Hosted TLS/proxy/resource-limit acceptance,
independent custody/RPC/database evidence, provider billing acceptance,
provisioning, deployment and activation remain separate gates. No finished-SVG
storage/compression or IPFS work is proposed.
