# Offline future-staging browser-wallet rehearsal

September 23, 2026. This is a **local browser integration test**, not a deployed
Sepolia site, real X/Grok assessment, wallet-extension acceptance test or public
transaction. The existing real disposable-Anvil EVM/parity evidence remains
separate.

## Run

From the repository, with PostgreSQL 16, Chrome and the visual verification
skill installed:

```sh
npm run generative:staging-browser -- --visual-tool /absolute/path/to/visual-dom-cdp/scripts/verify-page.mjs
```

Optional `--scenario success|uncertain|revoked` selects one scenario. Missing or
unknown options and `NODE_ENV=production` are rejected. Nothing reads `.env.local`
or loads real credentials. The script creates its own temporary PG cluster,
restricted writer and loopback listeners, then closes them in `finally`. It does
not use or reset `.local/rehearsal` or the historical backups.

Evidence JSON, browser network records and screenshots are written to ignored
`.local/generative-renderer/staging-browser-*`. A verifier process exit alone is
not a pass: the runner asserts its actual DOM result, counters, API responses,
image loading, viewport overflow and network failures. Screenshots still require
visual inspection.

## Boundaries exercised

| Scenario | Expected result |
| --- | --- |
| Success | Actual connect button and SIWE proof → explicit Mint & reveal → one mocked X lookup/Grok assessment/signature → one durable permit and simulated wallet send. A reported hash does not reveal. Restart without provider adapters and browser reload preserve the pending mint. Verified synthetic inclusion reveals **Confirming**; the home gallery stays empty until verified synthetic finality. |
| Lost wallet response | One wallet invocation throws an unknown-outcome error. Restart and removal of the browser's submission/intent journal cannot bypass the database permit. No second authorization, permit or send. Test-controlled logout through the real session API clears the cookie; re-entry requires a fresh proof and does not restart the assessment. |
| Withdrawn review | The test withdraws its signed operator review between authorization and begin. Begin fails, no wallet dispatch row is created, and the browser never calls the wallet send method. |

Every transaction report must repeat the exact same code, permit and hash. A
reload can replay that idempotent report, including a retry after a read/report
`BUSY` response; this is not another authorization or transaction. Counts assert
one preparation, one authorization, one begin and at most the single intended
wallet invocation. The read-only RPC adapters reject signing/broadcast methods.

## What the harness changes—and does not prove

The relay is test-only. It accepts only its loopback Host and same-origin POSTs,
then rewrites Host/Origin to the private site's pinned staging origin and installs
its own `X-Forwarded-Proto: https`. The real
site still checks its exact Host, Origin, CSRF, session, admission and chain
bindings. A random test-only asset injects the scripted EIP-1193 wallet; another
drives real page controls across navigation. Neither is served by the actual
site. Public test keys sign SIWE and mint authorization; the simulated wallet
returns a fabricated hash or an error and **never broadcasts**.

The actual shared page templates, CSS, client script, session API, preparation,
authorization, permit, reporting and projection are exercised. Cookies stay
Secure/HttpOnly and CSP stays unchanged. The [transport checkpoint](generative-staging-transport.md)
now enforces the exact `__Host-sg-staging`/Strict host-only policy, including
logout deletion. The relay asserts those unchanged Set-Cookie attributes and
checks that preparation carries the new cookie, not the legacy local cookie.
Chromium's loopback secure-cookie exception is **not evidence for hosted TLS or
proxy isolation**.

The [owner-controlled lifecycle](generative-staging-lifecycle.md) now runs the
observer on its own cadence. Synthetic inclusion/finality controls only change
chain input; they do not synchronize or quiesce browser traffic. Test operator
controls still quiesce forwarded requests for deterministic restart and session
revocation. Normal page boot/poll traffic is not globally serialized by the
relay. Browser reports cannot manufacture inclusion/finality. The synthetic SVG
tests image delivery/layout, not the immutable renderer's EVM parity. This is
local concurrency evidence, not acceptance of a deployed production observer.

The rehearsal found a real navigation race: reloading private progress while
the old page's poll was running could return raw `BUSY` JSON. The site now
waits up to about one second for **pre-operation BUSY rejection on page reads
only**, respecting disconnect/abort. Other failures and POST operations are
never retried by this helper. Separate integration tests cover short contention,
deadline exhaustion and disconnect, with no new assessment or signing work.
Sustained contention still returns 503; this is not an unbounded queue.

Visual review also found misleading pre-wallet copy. If the durable begin step
fails before `eth_sendTransaction`, the page now says it has not sent a wallet
transaction; it no longer describes that failure as a wallet response. The
unknown-outcome guard remains in place. Actual wallet-invocation failures retain
the wallet-uncertainty message. Four client cases and the withdrawn-review
browser scenario enforce the distinction.

## Previous manual-observation checkpoint

- **3/3 browser scenarios pass**, plus the separate finalized-home snapshot.
  Mobile dark (390×844) Confirming/revoked/signed-out and desktop light
  (1280×960) finalized gallery screenshots were inspected. Artwork loads and
  all four views have no horizontal overflow. The home screenshot is scrolled
  to show the complete card, caption and Minted label.
- Success: one SIWE proof, preparation, authorization, begin and simulated send;
  two identical hash reports (initial and reload). Lost outcome: the same
  single invocation and no hash report. Withdrawn review: one rejected begin,
  zero wallet invocation and zero durable dispatch rows.
- Expected HTTP failures are explicitly checked: recoverable read `BUSY`, an
  old status poll denied after session revocation, and rejected begin after
  review withdrawal. No unexpected HTTP failure or external browser request is
  accepted. These are not claimed to be all-200 network runs.
- **46/46 runtime/site integration tests**, including two new contention cases,
  pass. Existing runtime/HTTP coverage ratchet remains 100/94/95; measured result
  is **100% lines / 96.35% branches / 96.92% functions**. This measurement does
  not include site/fixture/test-driver source.
- **477/477 client/page regressions**, build, typecheck, original renderer/slogan
  locks, syntax and whitespace checks pass. No hosted CI run is claimed.

Final evidence: `staging-browser-final.log`, `staging-browser-evidence.json`,
`staging-browser-{success,uncertain,revoked,finalized}.{json,png}`,
`staging-browser-runtime-regression.log`, `staging-browser-regression.log`,
`staging-browser-{build,typecheck}.log` under `.local/generative-renderer/`.
Earlier failed development runs are not acceptance evidence. The visual skill
runner is imported unchanged; its wrapper exits only after the skill has
finished Chrome/profile cleanup, avoiding a lingering DevTools handle. The
rehearsal exited cleanly and its Chrome/listener/temporary-PG processes were
closed. Active rehearsal, backup, credentials and paid services were untouched.

The subsequent lifecycle run updates the browser JSON/screenshots with
`scheduledObserver: true`; see `staging-lifecycle-browser.log` and the
[lifecycle evidence](generative-staging-lifecycle.md). The success run recorded
three report attempts including a rejected BUSY response, all for the same
code/permit/hash, and still exactly one simulated wallet send. The historical
manual-run counts above are not relabelled as the new run.

## Sharing integration checkpoint

The runner now also asserts that the three flow endpoints have no canonical,
OG or X metadata while Confirming or private. After finality it visits one
editable preview and the minted detail, checks their distinct staging canonical
URLs and metadata, fetches each image **through the loopback relay only**, and
decodes both PNGs in Chrome. Both are 1080×1080, no-store and noindex. These reads
leave provider/signing counters unchanged. The two additional desktop/light
screenshots, `staging-browser-card-{preview,minted}.png`, are inspected alongside
the original four; all six have no horizontal overflow. Three scenarios and
both card checks pass. [Detailed scope and coverage](generative-staging-sharing.md).

This is browser verification of emitted metadata and served PNGs, not an X/OG
crawler fetching a hosted site. The synthetic minted SVG checks integration,
not EVM rendering parity; the preview uses the actual locked preview renderer.

## Next

Bounded [observer/startup coordination](generative-staging-lifecycle.md) is now
implemented and tested with concurrent browser reads, cancellation, restart and
incomplete drain. The exact staging cookie/transport policy is now implemented
and rehearsed locally; hosted TLS/proxy isolation acceptance remains required.
Provider spend, custody/independent-RPC evidence, provisioning,
deployment and activation retain their separate approval gates. No IPFS or
finished-SVG storage/compression work is included.
