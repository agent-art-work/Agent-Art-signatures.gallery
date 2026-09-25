# Private future-staging runtime and HTTP — local implementation

September 23, 2026. This increment is developed and tested locally using disposable PostgreSQL, fabricated Sepolia RPC history, mock X/Grok adapters and public test signing keys. It does not activate the application, deploy staging, call paid providers or broadcast transactions. The active rehearsal and retained backups are untouched.

## Composition

`contracts/tools/generative-staging-runtime.mjs` composes the guarded assessment worker and mint controller behind a narrow runtime API. The runtime derives chain/renderer/deployment pins from the reviewed operating plan and certified database profile. It captures the same two server-installed RPC transports for the active-state observer, request eligibility and wallet network context. Operating-plan source references receive stable hashed labels for the narrower eligibility reader; this changes neither the pinned transports nor the independent-source requirements.

No caller supplies an MBTI, model, renderer, Grok response, eligibility witness, transaction plan or nonce. The accepted assessment and verified X casing remain authoritative. Signer and provider adapters are installed by trusted server composition, not discovered from environment files or selected by requests. A reuse-only composition has no provider adapters and cannot reserve a new paid attempt.

The ordinary `GenerativeWalletChain` constructor remains local-only. Its distinct `createStagingWalletChain` factory supports only Sepolia RC1 and exposes just `read`. It reuses the bounded two-source checks: exact current/canonical head, genesis/deployment/runtime/renderer/domain/authorizer, EOA recipient and matching account nonces at the pinned block, latest and pending. Both sources must agree. A discrepancy fails closed; there is no guessed or wallet-supplied fallback nonce. These are observations, not an atomic guarantee that the chain/account cannot change before the wallet broadcasts.

## Explicit write flow

1. Session creation and wallet proof do not request an assessment or mint. Mutations require the exact origin, current authenticated session and CSRF token.
2. An explicit handle-only assessment POST obtains fresh backend eligibility and creates the private request through `createGuardedStaging`. Review and exact live database certification surround admission in the **same owner transaction**. New/joined generation additionally requires the assessment operation review and configured adapters; accepted-result reuse does not require generation credentials. Existing budget policy, wallet/proof, request count, first-result and freshness checks remain in force.
3. After acknowledged creation, the explicit POST schedules one bounded worker run. There is no queue pump, implicit retry or restart recovery. At most one assessment preparation runs at a time. GET/status/reload can inspect it but cannot start it. A disconnect before admission completes prevents scheduling; an already acknowledged/scheduled job owns its bounded lifecycle independently of the response connection.
4. Explicit authorization requires consent, fresh eligibility and the guarded signer path. Eligibility is refreshed after signing. Backend wallet reads then bind one immutable transaction plan to an exact account nonce.
5. Explicit begin rechecks eligibility and wallet context, verifies the saved plan again and releases a permit only through the guarded durable wallet fence. The runtime never sends the transaction. Unknown/submitted dispatches block another permit. Explicit rejection retains the existing bounded same-nonce/same-calldata resend policy.
6. Reports record authenticated private progress, including after issuance is disabled. A reported transaction hash is **not** inclusion evidence. This baseline runtime reports `pending`/`unknown`, never `Confirming`/`minted`. The separately composed [site/projection bridge](generative-staging-site.md) supplies that authority.

Status output uses a strict allowlist: no MBTI, assessment body, provider receipt, signing payload or permit. Signed calldata intentionally contains the eventual inputs once authorization is released; mint-and-reveal is a UI experience, not cryptographic secrecy.

## HTTP harness, not deployment

`contracts/tools/generative-staging-http.mjs` creates an **unlistened, loopback-only test server**, refusing `NODE_ENV=production`. It accepts only an actual constructed runtime and the exact staging Host/Origin. The [bounded staging transport](generative-staging-transport.md) requires one independently trusted local TLS proxy and its exact `X-Forwarded-Proto: https`; all other forwarding headers are rejected. Unsupported methods/routes, GET bodies, extra JSON fields, compressed/oversized bodies and missing session/CSRF proof are refused. Responses are private/no-store/noindex with restrictive security headers, and failures use the existing sanitized private-mint error mapper. Provider/SQL/RPC error bodies are never serialized.

The harness exercises the fixed host-only `__Host-sg-staging` Secure/HttpOnly/Strict cookie over a loopback test connection. It is **not** a deployable TLS/reverse-proxy configuration. It mounts no public pages, projection, broadcast endpoint or operator/reset route. Creating it does not call `listen`, load credentials or enable paid work.

| Method | Private routes |
| --- | --- |
| GET | `/api/session`, `/api/assessments/:code`, `/api/mints/status/:code`, `/api/wallet/context[?address=…]` |
| POST | `/api/wallet/challenge`, `/api/wallet/verify`, `/api/session/logout` |
| POST | `/api/assessments` (handle only), `/api/mints/authorize`, `/api/mints/begin` (code + explicit consent) |
| POST | `/api/mints/report` (code + permit + hash), `/api/mints/reject` (code + permit) |

The request-body reader and error mapper are shared with the existing local HTTP implementation. Its local-only startup guards and behavior are unchanged.

## Failure and shutdown

Request admission withdrawal/cancellation rolls back request and budget reservation together. A lost COMMIT acknowledgement instead poisons the writer; no provider is scheduled and no operation is automatically retried. Durable provider/signing/wallet uncertainty rules remain owned by the existing guarded controllers.

One API operation runs at a time, alongside at most one explicitly scheduled assessment. The [owner lifecycle](generative-staging-lifecycle.md) adds a distinct single-flight read-only certification lane, sharing the same serial fenced writer, so observer certification does not occupy the browser API slot. It cannot execute effects or retry requests. Runtime operations have the reviewed hosting deadline plus monotonic elapsed-time checks. A deadline in either lane quarantines the instance. Halt rejects new work; close waits for outstanding database/worker/controller cleanup before the owner may close the writer. No deadline is increased to make a failed operation succeed. Restart alone never reruns pending assessment work. Private saved-result recovery still requires valid review, database bindings, original session and the relevant live issuance switch.

## Verification and next boundary

```sh
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/postgresql/16/bin npm run test:generative:staging-runtime
```

The new Node coverage gate covers the runtime and private HTTP harness at 100% lines / 94% branches / 95% functions, ratcheted to the final measured result. Existing coverage thresholds are unchanged. The wallet reader and legacy request/HTTP paths are also regression-tested. CI is wired to the same isolated suite; hosted CI has not been run for this checkpoint.

Final local results: **28 runtime/HTTP integration tests passed**; combined coverage is **100% lines / 94.87% branches / 95% functions**. Individually: runtime 100/96.15/98.11; HTTP harness 100/92.31/71.43. **102 existing staging-controller tests** and **244 request/local-HTTP/chain-reader regression tests** passed, with seven intentional skips in the latter. Typecheck, build, original renderer/slogan locks, RC1 release lock and whitespace checks passed. The release remains `candidate-not-approved`.

Evidence under ignored `.local/generative-renderer/`: `staging-runtime-verified-coverage.log`, `staging-runtime-controller-regression.log`, `staging-runtime-verified-regression.log`, `staging-runtime-monotonic.log`, `staging-runtime-build.log` and `staging-runtime-release.log`. An earlier parallel coverage run encountered a bounded service refusal under load; the final current-source campaign passes without increasing application deadlines. An earlier fixture-corruption test was corrected to simulate privileged drift: the ordinary UPDATE was already correctly rejected by the immutable-profile trigger. No failed intermediate run is treated as completion evidence.

Follow-up implemented: the [read-only site and projection](generative-staging-site.md) now compose with this runtime, retaining canonical inclusion as the only authority for `Confirming` and finalized-gallery visibility. That document records the synthetic-chain HTTP rehearsal and next browser/startup boundary. Actual provider/billing acceptance, independently reviewed RPC/custody/deployment bindings, hosting/TLS/proxy operations, public transactions and activation remain separate gates. No finished-SVG storage/compression or IPFS work.
