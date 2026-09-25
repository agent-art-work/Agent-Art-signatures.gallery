# Staging assessment admission port

September 23, 2026. **Offline-tested internal integration, not an enabled staging website, worker or paid-call approval.**

`contracts/tools/generative-staging-assessment.mjs` composes the first effect-capable Sepolia port: dispatch of one X identity leg, dispatch of one Grok leg, and private reuse of an already accepted assessment. The existing local worker, signing, wallet-submission, HTTP and runtime constructors continue to reject public profiles. No environment switch, credentials, listener, deployment or signer was installed.

## Authority and composition

The constructor takes an exact release/operating plan, CREATE transactions, declared active-state history, two explicitly bound RPC sources, an existing restricted PostgreSQL writer/request repository, a runtime database review, a model/profile descriptor, and an independently pinned review source. These are trusted application dependencies, never request-body fields. The controller supports one in-flight operation and has no queue, request creation, worker claim loop or automatic retry.

Each operation checks:

1. A canonical Ed25519 review in the distinct **`sg-staging-operation-review-v1`** domain. The externally pinned key fingerprint and revision bind the operating-plan, active-observer policy, database review, writer epoch, limits, exact permitted operations and supporting-evidence digest. The review body contains the scope excluding its own revision to avoid a circular digest. Withdrawal, invalid signature, expiry or clock regression remains revoked in that instance. Paused-readiness and local reviews cannot authorize these operations.
2. Actual PostgreSQL schema/grants/role certification and static profiles, followed by live session, CSRF, origin, wallet proof, request ownership and request-specific chain eligibility. The exact signed wallet identity must still be current; an outstanding replacement-wallet challenge invalidates it.
3. Actual release-aware active-state observation on both synthetic/real supplied transports, including signed deployment/history, runtime/renderer, current authorizer/roles and freshness. Collection creation block/hash must also match the request profile. No plain report or serialized `approved` flag creates a witness or permit.
4. For paid legs, the existing durable budget, active-job ownership and provider-leg ledger. Grok requires the saved successful X receipt and verified X identity. Generation must be enabled; issuance need not be. Accepted-result reuse requires no new provider/signature or enabled generation.
5. A fresh owner transaction rechecks the conditions, writes the existing leg fence, checks again, and commits **before** invoking the transport callback. The final synchronous guard rechecks the current review, writer, evidence and deadlines. Transport code must call the supplied guard immediately before dispatch and after asynchronous preparation; the existing X/Grok clients already support this protocol.

The callback persists the existing provider receipts and validated outcomes. This increment tests those clients with mock `fetch` and private SQL persistence; it does **not** implement or start a staging worker around them. Reconstructing a controller after writer restart requires a newly pinned review for the new epoch. It does not erase or replay a claimed/fenced attempt.

## Runtime database binding versus paused readiness

The new `sg-generative-runtime-db-review-v1` binding is separate from paused readiness. Its SQL profile digest omits **only** `generation_enabled` and issuance `enabled`; both booleans are returned independently from the **same SQL snapshot** and checked for the requested operation. Every other static profile, migration-source/catalog/ACL lock and independent review/receipt pin remains bound. Existing disabled-only readiness is unchanged and still refuses enabled switches.

Offline observation can collect review evidence; it is not certification or approval. Production must not auto-pin a fresh observation. Tests deliberately create their own temporary database, migration history and ephemeral review keys. These fabricated reviews establish no real custody, billing authorization, database identity or operational acceptance.

Profile parsing preserves SQL numeric lexemes as strings, including values above JavaScript's safe-integer limit. Cross-bindings use certified profile text from a process-private successful certification object. Serialized copies and unverified observations cannot supply it.

`createStagingEligibilityReader` is a separate read-only Sepolia RC1 entry point. It exposes only `preflight`; the ordinary `PublicChainGate` still rejects public generative profiles. The reader produces request-specific opaque evidence, not permission to call a provider, sign or mint. The release-aware controller independently verifies the actual locked release before an effect.

## Failure behavior and limits

Lost COMMIT acknowledgements poison the writer and preserve any committed fence without calling the provider. Known rollback does not silently make the previously claimed attempt replayable. Transport failure, cancellation or timeout preserves uncertainty and existing exposure; no new assessment or paid retry is scheduled. A caller must not interpret an exception as proof that a remote effect did not happen.

Per-gate deadlines, evidence/proof expiry and the writer's SQL timeouts apply independently. September 24 R1 adds an explicitly reviewed v2 policy: preparation and actual dispatch keep the original short freshness checks, while a one-use `beginDispatch` starts a separate bounded response-completion clock. `assertCompletion` cannot authorize another request. The worker separately bounds the whole job. V1 timing/hashes remain unchanged. See [R1 timing and verification](r1-assessment-lifetime.md). Outer timeout permanently halts the controller. Callbacks and transports remain responsible for their own cancellation and resource bounds: JavaScript cannot undo a committed transaction or dispatched request. Review loading must be a bounded synchronous trusted read; no staging-domain disk loader is provided here.

Checks are snapshots, not a distributed atomic lock over chain, SQL and provider infrastructure. Privileged SQL or chain changes can occur after a snapshot; short evidence lifetime and effect-adjacent checks limit but do not remove that gap. RPC streaming-byte limits and actual provider credential/profile/spend policy must be enforced by the eventual runtime. The model/profile descriptor is not, by itself, proof of the complete request prompt or provider billing terms.

## Verification and next boundary

```sh
# PG16 tools must be on PATH, or set OPEN_MINT_TEST_POSTGRES_BIN.
npm run test:generative:staging-assessment
npm run test:generative:staging-review
npm run test:generative:database-certification
npm run test:generative:staging-readiness
npm run test:generative:admission:coverage
```

Integration tests use a Unix-socket-only disposable PG16 cluster, real restricted-role writer/fences, synthetic signed Sepolia history, ephemeral review keys and mocked provider transports. They exercise wrong identity/review/policy/grants, generation disablement, cancellation, concurrent dispatch, lost commit, restart and exact saved-result reuse. No real provider, public transaction, active rehearsal or backup is touched.

Verification: **41 integration tests passed**. Controller coverage is **100% lines/functions, 97.37% branches**; the database adapter is **100% lines/functions, 98.46% branches** (combined 98.06% branches, ratchet 100/98/100). **67 review/parser/eligibility tests passed**, with 100% measured coverage of the review and parser. **183 database-certification tests** retain the existing ratchet (100% statements/lines/functions, 98.93% branches). Existing paused-readiness **55 tests** and release-admission **28 tests** remain at 100% measured adapter coverage. Broader affected regression: **1,769 passed, seven intentional skips across 41 files**. Typecheck, build, original renderer/slogan locks and RC1 release lock pass. CI is configured; no hosted run or full-application/browser verification is claimed for this increment. Logs are ignored under `.local/generative-renderer/staging-assessment-*`, `staging-review-final.log`, `runtime-db-coverage.log`, `paused-readiness-regression.log` and `staging-admission-regression.log`.

Next: build the guarded staging worker around these ports, then connect input persistence, issuer, exact wallet-submission context, site and Confirming/finalized projection. Rehearse the full path offline before operational review. Real provider acceptance, independent custody/database evidence, deployment and public activation remain separate gates. No finished-SVG storage/compression or IPFS work is introduced.

September 23 follow-up: the [worker composition](generative-staging-worker.md) is now implemented **locally for the future staging backend**. It adds current database/review checks around initial job ownership, orchestrates both guarded provider legs, and preserves receipts, terminal outcomes and saved-result reuse. Shared local constructors still refuse public profiles. There is no deployed staging worker, HTTP activation or paid call; input/issuer/wallet and complete site integration remain next. The coverage command now includes worker and admission cases together.
