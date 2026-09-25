# Paused Sepolia readiness control surface

September 23, 2026. **Implemented and tested with disposable PostgreSQL, loopback HTTP and synthetic chain responses. Not deployed, not a public mint runtime and not approval to activate.**

This is the first separate Sepolia entrypoint, deliberately limited to inspecting a pristine **paused** RC1 deployment. It uses the existing operating-plan, exact-database and actual release-aware deployment checkers. None of the local-only mint/session/provider/signer constructors were relaxed or imported. The running website remains unchanged.

## Composition and authority

`contracts/tools/generative-staging-readiness.mjs` exports:

- `pausedReadinessScope(input)`: offline, recomputes the locked release and operating plan, validates database review/policy/transaction bindings and hashes the exact read-only scope. Always `approved: false`, `minting: false`. It does not sign or approve anything.
- `createSepoliaReadiness(input)`: a programmatic, opt-in lifecycle with `start`, `close`, `address`, and `snapshot`. It accepts explicit trusted connections and review inputs; there is no startup environment flag, secret discovery, migration, CLI auto-start, provisioning or configuration file written by this work.

The scope commits the operating-plan digest; locked database schema/migrations and independent profile/receipt/review pins; both CREATE transaction hashes; the assessment-policy descriptor; port and bounded deployment span; and fixed HTTP limits. A canonical Ed25519 review in the **distinct `sg-paused-readiness-review-v1` domain** binds this scope, supporting-evidence digest and a validity interval of at most 31 days. The public-key SPKI fingerprint and exact review revision are independently supplied trust pins. The signed envelope cannot nominate its own trusted key/revision. A local review cannot authorize this entrypoint, and this review cannot authorize a mint, paid request or signature.

The current review source is checked before work, after awaits, before listening and before readiness responses. Withdrawal, invalid signature, revision rotation, expiry, clock regression or an observation failure quarantines that instance permanently. Restoring the file/value does not silently resume it; a fresh reviewed instance is needed. Callers must implement `readCurrent` as a bounded trusted read, not a network fetch or unbounded synchronous operation. No readiness-domain disk loader is provided yet.

An authentic signature demonstrates possession of the independently pinned review key, **not** factual correctness of its evidence documents. Actual custody, RPC independence, remote database identity, migration/restore history and operating acceptance still need independent verification. Tests use ephemeral review keys and wholly invented evidence. They never establish real approval.

## Startup and subsequent checks

Before opening any socket, and on each admitted `/_health/ready` request:

1. Verify the current signed readiness review and bounded clock window.
2. Use the caller-owned restricted, serialized PostgreSQL connection to check the exact PG16 schema, grants, owner/runtime roles, disabled staging profiles and independently pinned digests. No writer lease is acquired.
3. Observe the actual locked deployment using two declared independent RPC transports: Sepolia genesis, signed CREATE transactions/receipts, all runtime bytes/immutables, pristine role history, paused state, canonicality and finality.
4. Cross-bind the **same database snapshot's** exact profiles to the operating plan and fresh opaque chain witness: namespace/deployment, collection address/runtime/authorizer/creation block and hash, session origin/chain, renderer profile/address/hash/identity, model/profile version, budget/exposure/window, disabled generation/issuance and freshness/deadline policy.
5. Recheck current review and witness freshness before listening or returning readiness.

`readCertifiedDatabaseProfiles` exposes numeric-preserving SQL profile text only from the private identity of an actual successful database check, not a copied/serialized report or an unverified observation. Numeric lexemes remain exact strings through the cross-check. This reader is still not an operation permit, and snapshots cannot prevent later privileged DDL or state changes.

For this entrypoint, `assessment.profileSha256` binds a descriptor with schema `sg-readiness-assessment-policy-v1`, `model`, `profileVersion`, and current `policyVersion`. This checks agreement with the disabled database profile; it is **not** a complete paid-provider request profile or a spending authorization. The declared assessment window is inspected and bound, not renewed or activated. Unsupported DB budget declarations are rejected rather than clamped (total attempts at most 100,000, queue at least one).

The pristine observer limits the creation-to-head span to a reviewed 1–512 blocks. This entrypoint is therefore **initial paused-deployment acceptance**, not long-lived readiness for an active/old staging service. Later governance/activation needs the separate active-state observer and operation admission. Do not increase the range or accept enabled flags to repurpose this surface.

## HTTP and resource contract

It listens **only on `127.0.0.1`**, behind one separately configured trusted local TLS proxy. The operating plan must specify trusted-proxy mode and exactly one hop. The proxy must strip caller-supplied forwarding headers and inject only the expected Host and HTTPS protocol header. No TLS terminator is provisioned here. Any local process able to reach the loopback socket is inside that ingress trust boundary; these headers do not authenticate arbitrary clients or users.

| Surface/limit | Behavior |
| --- | --- |
| `GET /_health/live` | Fixed 200 process-health response; remains live while quarantined |
| `GET /_health/ready` | Fresh full check; 200 `ready-paused`, never mint-ready |
| All other paths/methods | 404/405; no session, paid-provider, signer, authorization or mint route |
| Connections / headers | At most 32 connections, 8 KiB headers and 32 unique header names |
| Body | None; reject transfer encoding and nonzero content length; no body parser |
| Requests | Global 60/minute fixed window, no per-client allocation; 16/socket ceiling and connection-close responses |
| Expensive probes | One in flight, zero queued, starts at least 10 seconds apart; 429 with Retry-After |
| Timeout/drain | Independently reviewed 1–30 s request budget; drain at least request budget and at most 120 s |
| RPC | Actual decoded response ceiling from plan; existing call/range bounds and cancellation; supplied transports must also enforce streaming byte limits |
| Failure | Fixed sanitized response; no profiles, SQL, secrets, evidence or exception details |

HTTP/1.1, exact Host `staging.signatures.gallery`, HTTPS forwarded protocol and loopback peer are required. Duplicate headers, Forwarded/X-Forwarded-For/X-Forwarded-Host, foreign Origin, upgrades, CONNECT, expectation handshakes and malformed/oversized headers are refused. There is no CORS, cache, cookie or arbitrary URL fetch. The control responses always include `mode: paused-readiness-only` and `minting: false`.

Incomplete headers/sockets, asynchronous probe work, disconnects, startup cancellation and shutdown are bounded separately. Every connection also has an **absolute lifetime from acceptance**, so dripping header bytes cannot indefinitely extend an idle timeout. A disconnect during a probe quarantines rather than leaving reusable uncertain evidence. This favors safety over availability; the proxy should restrict access to these control endpoints. The transport callbacks and database connection remain caller-owned; aborted remote work may run until their own enforced timeout. Shutdown does not close the supplied database connection or retry anything. An HTTP 200 indicates a fresh read-only check, not continuous validity between checks.

## Verification

```sh
npm run test:generative:readiness-http
# PG16 tools must be on PATH, or set OPEN_MINT_TEST_POSTGRES_BIN.
npm run test:generative:staging-readiness
npm run test:generative:database-certification
npm run test:generative:deployment:coverage
```

The integration fixture creates its own Unix-socket-only PG16 cluster, with a non-superuser migration owner distinct from the cluster owner and a restricted browser role. It installs only the locked migrations; all test databases/listeners are removed. RPCs are synthetic, review keys ephemeral and transactions signed only inside the existing offline fixture. No real provider requests, public-chain writes, live credentials, active-runtime/database changes or backup cleanup.

Coverage and validation results for this increment are recorded in the development-plan checkpoint. CI runs these tests, but hosted CI is not claimed without observing a run.

## Next boundary

Implement the **staging effect-capable composition separately**, first against synthetic providers/chain and disposable PostgreSQL: select explicit reviewed stage bindings for the database adapters, compose active-state observation with current writer/session/budget/fence admission, and test refusal/restart/revocation at every effect boundary. Preserve local-only constructors and the disabled-only readiness checker. Then integrate the site/projection/sharing surfaces against those ports and rehearse offline. Real deployment/custody/database/provider acceptance, paid envelopes and activation remain separate operational gates; this read-only review cannot satisfy them. No SVG storage/compression or IPFS work is reintroduced.

September 23 follow-up: the first [staging assessment/reuse port](generative-staging-assessment.md) now has a distinct operation-review domain and runtime database binding. Its integration is offline-only; no staging worker, signer, wallet or public website was enabled. This paused-only checker and its review domain remain unchanged.
