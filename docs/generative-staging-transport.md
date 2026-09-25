# Staging sessions and bounded proxy transport

September 23, 2026. Implemented and rehearsed **locally only**. This is not a
deployment, hosted TLS acceptance, paid-call approval or release approval.
The future-staging harness still refuses `NODE_ENV=production`, discovers no
secrets and never broadcasts transactions. Active rehearsal and backups are
untouched.

## Fixed session boundary

`PostgresWalletSessions.openStaging` requires exactly
`https://staging.signatures.gallery` and chain 11155111, matching the immutable
database session profile. The ordinary factory rejects staging bindings; its
local behavior remains unchanged. Configuration is copied before database
awaits, and the runtime compares the session cookie policy to the operating plan.

Creation uses `__Host-sg-staging=<opaque token>; HttpOnly; SameSite=Strict;
Path=/; Max-Age=86400; Secure`, with **no Domain attribute**. Logout revokes the
durable row and clears that exact cookie with `Max-Age=0`, preserving its other
attributes. The shared local adapter also uses its session object's deletion
policy, avoiding a separate hard-coded cookie string.

There is no fallback to `sg_open_session`, automatic cookie migration or
authority copied from another namespace. An old browser session must reconnect;
private reads/POSTs cannot allocate a replacement session. Explicit session boot
can create a fresh anonymous row. Existing database-backed expiry, proof scope,
CSRF, one-use SIWE challenges, logout and writer fencing remain in force.

## Exactly one independently trusted local proxy

The runtime captures its reviewed transport configuration; request headers,
JSON and environment flags cannot choose it. The adapter currently supports
**trusted-proxy mode with one hop only**. A declared direct-TLS configuration is
refused here until it has its own implementation and acceptance evidence.

The owner binds 127.0.0.1. Ingress requires actual local/remote socket addresses
127.0.0.1, exact Host `staging.signatures.gallery`, and exactly one
`X-Forwarded-Proto: https`. It rejects duplicate headers, `Forwarded`, other
`X-Forwarded-*`, real-IP/original-URL/rewrite headers, proxy chains, upgrades,
CONNECT, Expect, HTTP/1.0, non-origin-form targets and unsupported methods.
GET bodies are refused. POST requires the exact HTTPS Origin; when supplied,
Sec-Fetch-Site must be `same-origin`. Origin checks supplement, not replace,
durable session/CSRF/wallet/admission checks. There are no CORS grants.

**Forwarded headers do not authenticate the proxy.** Any process with access
to the upstream socket can forge them. Before hosting, the operator must isolate
the listener/network namespace from untrusted principals, terminate HTTPS at
the reviewed proxy, reject unexpected public hosts, strip incoming forwarding
headers, and install only its own exact protocol header. Deployment must prove
direct upstream access is impossible. This code does not provision or certify
that infrastructure and does not infer client IPs from headers.

## Resource limits

| Boundary | Limit |
| --- | --- |
| Connections / in-flight callbacks | 32 each, no admission queue |
| Headers | 8,192 bytes, 32 distinct fields, duplicates refused |
| Request target | 4,096 characters |
| Body | Lower of reviewed maximum and 8,192 bytes; declared and streamed JSON size checked |
| Methods | GET/POST only; no compressed JSON |
| Requests | 600/minute across the server, monotonic clock, no IP trust |
| Application lifetime | Reviewed 1–30 second request deadline; abort and close on expiry |
| Incomplete connection | Absolute lifetime: header budget (at most 5 seconds) plus request budget, even with dripping bytes |
| Socket reuse | Connection: close; one request per upstream socket |

Disconnected or timed-out callbacks retain their admission slot until the
underlying handler settles. Cancellation does not prove cleanup or release
writer ownership. [Runtime/observer draining](generative-staging-lifecycle.md)
still controls safe shutdown. Late failures are sanitized; no effect is retried.

The in-memory request counter is only an overload bound and resets with the
server. It is **not** the durable paid-admission budget or protection against a
distributed attack. Database reservations/admission still gate each paid leg.
The hosted edge needs its own reviewed connection/body/rate policies. All
responses retain no-store/noindex and restrictive security defaults, including
rejected Expect requests; public pages install their existing CSP.

## Verification

- All 59 staging runtime/site integration tests pass on disposable PostgreSQL
  and synthetic RPC. Runtime/HTTP measured coverage is 100% lines, 97.17%
  branches and 96.77% functions; the existing 100/94/95 aggregate gate passes.
  These percentages do not measure site source.
- 69 focused tests: 53 transport cases and 16 durable-session unit cases.
  Each measured file has 100% statements/lines/functions; transport branches
  96.66%, sessions 99.23%. CI now enforces a **per-file 100/95/100/100** gate.
- 474 local regression tests pass, with 7 existing profile-inapplicable cases
  skipped. Includes real PostgreSQL staging proof/session continuity through
  new writer epochs, durable revocation, local HTTP, client, pages and observer.
- Three actual-browser scripted-wallet flows pass: success/restart/reveal,
  lost outcome/logout, and withdrawn review. Exactly one simulated wallet send
  for success/lost outcome, zero after withdrawn review; no duplicate paid or
  signing calls. Mock providers are used throughout. Expected BUSY responses,
  revoked-session refusal and review refusal are asserted, not hidden.
- Four screenshots inspected: mobile dark Confirming, signed-out entry,
  revoked-review progress, and desktop light finalized gallery. No horizontal
  overflow; synthetic artwork loads. Browser cookie attributes are preserved,
  preparation carries only the new session name, and JavaScript cannot read it.

Total: **602 passing tests**, 7 inapplicable cases skipped, three browser flows
and four inspected screenshots. Typecheck, build, original renderer/slogan locks,
RC1 lock, syntax and whitespace checks pass. RC1 remains
`candidate-not-approved`. Hosted CI has not been observed. All temporary test
services were closed; no active runtime was stopped or reset.

Chromium accepts Secure cookies on loopback for this rehearsal. This does not
prove domain scoping, cross-site navigation or TLS on the hosted domain. The
artwork in this synthetic transport rehearsal is not an EVM renderer parity
test. Existing renderer/EVM evidence is not relabelled as Sepolia acceptance.

Reproduce without live credentials:

```sh
npm run test:generative:staging-transport
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run test:generative:staging-runtime
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run generative:staging-browser -- --visual-tool /absolute/path/to/verify-page.mjs
```

Ignored evidence lives in `.local/generative-renderer/staging-transport-*` logs,
the `staging-transport-coverage` report and refreshed `staging-browser-*`
JSON/screenshots. No credential, cookie value or private request code belongs
in committed evidence.

## Next bounded implementation

E22's [staging-aware sharing integration](generative-staging-sharing.md) is now
implemented and locally verified. Canonical URLs/cards preserve noindex and
no-store; private/Confirming results and sitemap enumeration remain excluded.
The next safe step is to consolidate release-readiness evidence and remaining
operator decisions before requesting any external deployment action.

E21 remains open for actual custody, independent RPC/database/migration evidence,
hosted TLS/proxy acceptance, operational recovery/support and release-owner
review. RC1 approval, provisioning, Sepolia deployment/funding and activation
retain separate gates. No IPFS or finished-SVG storage/compression is proposed.
