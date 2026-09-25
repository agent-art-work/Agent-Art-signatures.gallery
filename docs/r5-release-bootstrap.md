# R5 — runnable staging package and operating integration

September 24–25, 2026. **Step 1 complete; steps 2–4 partially implemented and paused at the owner-review pin, not accepted.**
This defines the next bounded implementation after R1–R4's offline acceptance.
It does not deploy, activate, authorize a paid call, approve RC1, choose actual
infrastructure or touch the current app. Keep the user's manual model checkpoints.

September 25 pre-Pulse checkpoint: the user paused R5–R10 before a proposed
limited free-mint allowlist, Pulse Core v1.0.0 integration and website-flow
refinement. Preserve the implementation and test evidence below as the current
RC1 baseline. Reassess exact contract, configuration and database bindings
after the new product design. The owner-review pin issue remains open; the
Pulse proposal does not resolve it. No R5 acceptance is inferred from this
checkpoint.

## Output and boundary

Deliver an installable, explicitly configured **generative staging service**
and separate operator commands, runnable outside the source checkout. It must
compose the existing reviewed guards, not introduce another admission system.
Its acceptance is a fixture-backed package/start/restart/stop campaign with
zero real provider calls, real signing keys or public transactions.

The installed website stays bound to `https://staging.signatures.gallery`,
Ethereum Sepolia and the exact RC1 release/renderer/database profiles. The
local Anvil pilot remains separate. Package existence is not operational
approval: real X/Grok acceptance is R8; hosting/custody/deployment is R9;
independent review and launch remain R10.

Do not change `npm start`, the current local app, contract identity, artwork
algorithm, historical tokens, admission digests or saved records implicitly.
No IPFS, finished-SVG storage/compression, OAuth claiming, new job queue,
automatic paid retry, wallet transaction sender or general-purpose admin API.

## What the code already provides

| Existing boundary | R5's actual missing connection |
| --- | --- |
| `contracts/tools/generative-staging-site.mjs` owns observer/listener draining but imports source TS and refuses production | Package a separately guarded runtime entrypoint; do not set `NODE_ENV=development` to bypass refusal |
| `generative-release.mjs` verifies source/compiler/ABI/bytecode/oracle locks using checkout-relative files | Carry and verify its exact proof inputs in an allowlisted artifact; do not depend on a source checkout, Foundry or runtime compilation |
| Staging operation, paused-readiness and recovery reviews have distinct signed domains | Load current files safely with independent key/revision pins, preserving those domains and their existing validators |
| `ExclusiveWriter.acquire` increments a durable epoch on a dedicated connection | Bind fresh runtime review to the actual acquired epoch; no prediction, automatic repinning or review regeneration |
| R4 checks exact catalog/grants, paused v1→v2 migration and expiry-only retirement | Authenticate the supplied artifacts and actual connection targets; provide separate operator commands, not website controls |
| Paused readiness has a bounded health listener; active site has a phase/observer snapshot | Add active lifecycle health and redacted diagnostics without turning probes into effect requests |
| `openMintSupportUrl` validates an optional static HTTPS URL | Pass an explicitly selected support URL through staging page options; do not invent a contact or append private data |

## 1. Distribution and code layout

Add a distinct build target and entrypoint, proposed
`src/openMint/staging/bootstrap/main.ts` → `release/staging/bin/staging.js`.
The `check`, read-only `inspect` and read-only `verify-backup` installed commands now exist. `serve`,
`migrate-v2` and `recover` remain unavailable pending the review boundary
described below.
Keep ordinary application build/start behavior intact.

Move the reusable staging/release composition into compiled production source,
with compatibility wrappers for the existing tool/test imports. Keep pure
validation separate from file loading, network creation and command dispatch.
First prove identical release, operating, database and admission digests for
existing fixtures; relocation cannot silently change an approval scope.

The artifact includes only:

- Compiled runtime/operator modules and their locked runtime dependency closure.
- Required stylesheet, wallet script, fonts, preview/slogan assets and notices.
- Exact locked SQL/grant recipes and a read-only release-proof input set:
  compiler metadata, ABI/bytecode and the source/oracle bytes needed by the
  existing release verifier. Verification-only source is data, never imported
  as runtime TS. No recompilation or lock regeneration at startup.
- A versioned content manifest with sorted paths, byte sizes and SHA-256 hashes;
  dependency-lock digest, exact tested Node/OS/architecture, application source
  snapshot digest, contract lock and both database profile identities.

Generate from explicit entrypoints/locked file lists, not a workspace-wide copy.
Exclude `.env*`, `.local`, `.git`, credentials, test fixtures, generated approval
signatures, test keys, logs and development routes. Reject escaping paths and
links. Never copy the whole `node_modules` or compiler output tree blindly.
Native dependencies must be installed/tested for the recorded target; this
step does not claim a portable artifact across operating systems.

An independently supplied artifact digest must be checked by the installer or
trusted launcher **before running artifact code**. In-process manifest checks
detect drift; a package verifying its own checksum is not a root of trust.
The current dirty tree may produce a development snapshot, not a clean release
identified only by HEAD. R7 owns the clean revision and observed CI campaign.

Extract common site composition behind an internal bootstrap capability.
Existing local/harness entrypoints retain their production refusal; only the
new entrypoint may construct the installed service after all bootstrap checks.
No exported `allowProduction`, `approved`, fixture or skip-check switch. Test
dependency injection remains in test composition, not a CLI-selectable adapter.

## 2. Explicit installation inputs and trust

Use one versioned, strict, non-secret bootstrap manifest supplied by an absolute
path. Its expected digest and trusted issuer public-key fingerprints come from
the operator's independent installation configuration, never from the artifact
or the envelope being verified. Reject unknown fields and implicit defaults.

| Manifest section | Required binding |
| --- | --- |
| Artifact and installation | Expected content digest, installation ID, namespace/deployment, fixed origin/chain and command mode |
| Reviewed inputs | Exact operating JSON, deployment transaction/history evidence, assessment policy, database reviews and migration receipts; path, size bound, digest, purpose and independently pinned issuer/revision where signed |
| Connection identities | Database resource/endpoint/database/TLS trust; two RPC identities/endpoints/operators; exact secret references matching operating settings |
| Review files | Predeclared root/filename/UID and separately pinned Ed25519 public keys for readiness, operations, recovery and backup completion; no private review keys |
| Owner policy | Listener port, private health port, review-attachment wait, existing request/RPC/drain limits; no arbitrary host override |
| Operations | Support reference plus optional validated HTTPS destination; diagnostic policy and backup/isolation evidence references |

This manifest is an installation binding, not a replacement for operating v1/v2
or their signed approvals. Capture nested data before awaits. Never derive
expected evidence from observed current database state and label it reviewed.

Reuse the filesystem safety rules of
[local review startup](generative-local-review-startup.md): canonical trusted
local root, pinned directory identity/UID, regular unlinked files, no symlinks,
bounded reads, exact JSON and checked metadata around reads. Keep credential
files and mutable review files separate from immutable distribution files.
Set per-kind limits rather than imposing the small review limit on bytecode or
archives. Review envelopes retain 32 KiB file / 16 KiB signed-payload bounds.

Read the current review pathname at every existing effect checkpoint; do not
cache authority behind a watcher. Withdrawal, wrong revision, expiry or unsafe
replacement permanently halts that composition. Rotation needs a stopped/new
composition. Same valid signed bytes may be atomically replaced. Filesystem
checks do not defend against hostile root/same-UID code or network-mount stalls.

## 3. Credentials, connections and effect adapters

Start with a provider-neutral **mounted-file resolver**, not cloud discovery.
An exact reference maps to one operator-configured, permission-checked secret
file. No `.env.local`, home-directory scan, inherited `PG*`/provider defaults,
shell command, arbitrary module import, HTTP-supplied endpoint or credential
value in command arguments. Reject unrequested/mismatched references. Resolve
only what that command needs; keep secrets out of errors, health and manifests.

| Command family | Permitted dependencies |
| --- | --- |
| `check` | Artifact/config/review public material only; no credential resolution, connection, writer or listener |
| `readiness` | Restricted browser-catalog connection, two RPC transports, paused-readiness review; no writer, provider credentials or signer |
| `serve` | Browser-role writer/session/projection; two RPCs; authorizer only when signing is configured; X/xAI pair only when generation is configured |
| `inspect` | Column-restricted inspector connection and one exact tagged reference; no writer, RPC, provider or signer |
| `migrate-v2` | Exact source/target reviews, authenticated stopped backup, owner connection and browser-catalog connection; no provider/signer/site |
| `recover` | Separate browser-catalog reader, restricted recovery writer, two RPCs and exact recovery review; no provider/signer/site |

Disabled features may omit their effect credentials. A partially configured
X/xAI pair or enabled feature without its required adapter fails closed; it
does not substitute a development provider. Never resolve deployer/admin/pauser/
revoker keys in the website. Reference presence is not proof of account funding.

Database adapters use dedicated authenticated PG16 connections, verified TLS
server identity and explicitly pinned database/login/resource mapping. Check
`session_user`, `current_user`, exact namespace/deployment/catalog and stable
session ownership. No transaction pooling, replica fallback, reconnect or
credential fallback. A matching database name or copied schema is insufficient.
Multi-connection operations target the same reviewed primary; retain R4's
cross-connection advisory-lock check as well as authenticated target binding.
The co-located observer uses the existing browser writer serially: do not open
a competing projection writer or claim separate privilege isolation it lacks.

RPC adapters use two separately configured authenticated HTTPS transports,
normal certificate/hostname validation, bounded responses/timeouts, abort and
no redirects/fallback/retries. Enforce the read-method allowlist; reject all
transaction submission and wallet methods. Preserve chain/code/history/read
budget checks. Distinct endpoint labels do not prove independent operators;
actual account/resource evidence remains a deployment prerequisite.

Reuse the real X identity and xAI assessment adapters under the R1 policy,
one-leg dispatch fences and current account/profile reviews. Construction and
health must never make a test paid call. The initial authorizer adapter may
load one explicitly mounted private key only under a reviewed custody policy;
check its public address and expose only guarded typed-authorization signing,
not raw signing or transaction sending. Key custody is not being selected here.
An unsupported HSM/KMS is refused pending its own adapter; never export its key
to work around that boundary. Memory cleanup is best effort, not guaranteed
key erasure in JavaScript.

## 4. Startup, restart and shutdown

Two modes are distinct: **paused readiness** observes an already installed,
disabled database/pristine paused deployment; **serve** requires the current
reviewed runtime/active-history bindings. A green readiness probe never switches
modes, unpauses the contract or changes generation/issuance flags.

For `serve`, use this owner sequence:

1. Verify installed bytes and static configuration. Keep the application
   unlistened. Resolve only required read/database dependencies, authenticate
   targets and certify the selected existing v2 database/profile. No role
   creation, migration, profile initialization or flag change during startup.
2. Acquire exactly one dedicated writer using the existing fencing code. Record
   the actual epoch and a fresh owner-session nonce. Emit an **unsigned scope
   request** binding that epoch, installation/artifact/config/database/chain
   policy and allowed operations. This is a request for review, not approval.
3. Wait unexposed for the externally issued operation review and its independent
   revision pin. Use a single-use trusted local input descriptor supplied by
   the operator/supervisor, not an HTTP endpoint. Accept one bounded attachment
   record (at most 4 KiB) matching the owner nonce and scope; the review file
   path/key are already configured. Set an explicit wait of at most 15 minutes.
   No polling for any conveniently valid revision, self-signing, predicted
   epoch, interactive wallet or automatic reviewer. EOF/timeout/mismatch closes
   the unused owner cleanly and leaves the site unlistened.
4. Verify the exact signed review/current pins, construct only the configured
   effect adapters, and open the existing repositories/sessions without
   initializing them. Re-certify after asynchronous work. Run the owned fresh
   two-source observation, then bind only `127.0.0.1` and the configured port.
5. Continue all existing per-operation checks. Startup, GETs and restart never
   resume paid jobs, retry a signer or release a new wallet permit. Restart has
   no cached chain freshness and requires a new epoch-bound review, even when
   the previous review has time remaining. Pending/unknown records stay intact.

If current repository factories initialize missing rows, add an open-existing
mode for this entrypoint; do not turn initialization into an accepted side
effect of `serve`. The owner handshake may attach authority once, never renew
it. A second attachment or an attempt to rotate pins requires restart. External
trusted configuration must retain current revisions; the restored database
cannot itself establish which historical review is latest.

SIGTERM/SIGINT and terminal observer/review/database failure stop admission and
withdraw freshness immediately, then drain listener/worker/observer/SQL before
closing the writer and credential transports. Shutdown is idempotent and does
not reconnect or restart. If draining is incomplete, keep admission closed and
retain the owner session while reporting a sticky failure; do not release the
lock and announce a clean stop. A forced kill/lost connection cannot retain a
lock: record that limitation and require external reconciliation before a new
owner. Durable uncertainty is never cleared by supervisor restart.

Retain the existing one-hop trusted-loopback proxy policy and secure cookie
semantics. Direct TLS is unsupported, not an alternate flag. Host/protocol
headers do not authenticate a proxy; R9 must prove upstream network isolation,
edge limits, real HTTPS and hostname handling. No new public deployment here.

## 5. Maintenance and authenticated backups

Package R4's existing one-shot operations, not a generic SQL/repair console.
`inspect` is safe diagnosis by exact reference; `migrate-v2` and `recover` are
explicit operator actions with both issuance/generation disabled and the site
drained. A host installer supplies roles/database separately; `serve` never
creates them. Ship the exact setup recipes/runbook for later reviewed installation.

For backup evidence, add a domain-separated signed completion envelope binding
the exact archive digest/size, source installation/database binding, stopped
point, schema/migration/profile pins, role recipe, table inventory and external
isolation/completeness evidence. Verify a separately trusted backup issuer and
revision, stream-check an explicitly selected archive without extracting it,
and pass only authenticated bindings into R4's migration preflight. Missing,
stale, crossed or incomplete evidence refuses mutation. Do not generate/sign
completion evidence inside the restore or migration command.

A valid signature proves the issuer attested those bytes, **not** that no later
effects occurred. R3's external latest-completion witness and source-isolation
requirements still apply. Bootstrap can authenticate the evidence and require
an explicit isolated-target binding; it cannot fence a restored clone using
the clone's own database lock. Where original-source isolation or completion
is unknown, permit isolated inspection only—no effect-capable startup. Backup
destination, retention, issuer custody and infrastructure-level isolation must
be selected and proven before live use. No general live restore command or
historical-backup cleanup is part of this increment.

`recover` must retain the exact opaque R4 plan in the owning process while the
operator supplies the separately signed, revision-pinned action. Never accept
an exported JSON plan as an execution capability. If the process exits, inspect
and re-plan under a new owner. Recheck current reviews and obtain fresh chain
evidence at apply, including strict finalized expiry. Execute once. Unknown
COMMIT means inspect the saved recovery ID, not run again. Migration's
`unknown`/`committed-unverified` outcomes also leave services stopped.

## 6. Health, diagnostics and support

- Use a separately bound **private loopback health listener** with the existing
  bounded transport protections. Do not expose it through public routing or
  turn it into an operator API. Public pages retain no-store/noindex.
- Liveness reports process/owner-loop responsiveness only. Readiness reports
  the current mode and whether its required checks are fresh; waiting for
  review, stale evidence, terminal failure or draining returns unavailable.
  Paused readiness never advertises mint capability. Active diagnostics show
  generation/signing availability separately from site health.
- Active probes read an immutable redacted snapshot and local review/expiry
  state; they do not trigger assessment, signing, a new observation, a writer
  acquisition or a database mutation. No stale 200 after observed withdrawal.
  Preserve the separate paused-readiness verifier's bounded read-only probing;
  its result is not a cached active-runtime permit.
- Emit structured, bounded events/counters for startup/refusal, observation,
  review failure, lost writer, uncertain effects and drain failure. Use fixed
  categories, not dynamic request URLs/handles/wallet labels. Metrics are not
  durable spend accounting. Unknown exposure remains in its existing ledger.
- Never log credentials, DSNs, RPC tokens, cookies, CSRF/proofs, mint codes,
  permits, raw provider bodies, signing material or pre-reveal MBTI. Exact
  diagnostic UUID lookup belongs to the authenticated inspector, not public
  health. Redact exception causes and transport URLs, not just top-level text.
- Resolve `operations.supportReference` to an explicit static URL and validate
  it with `openMintSupportUrl` (HTTPS, no credentials). Missing means no link;
  unsafe configured values fail startup. Keep `Request help` and its existing
  private diagnostic reference; do not append references/codes to the URL.
  A personal email from this chat is not approved public support.
- Output diagnostics locally for an operator-managed collector. Define alert
  categories/runbook ownership, but do not register a service, choose contacts,
  send ntfy or claim alert delivery was tested. That delivery is R9 acceptance.

## 7. Acceptance matrix for steps 2–4

All fixtures use disposable paths/PG16 and mock providers/signers/synthetic RPC,
not `.env.local`, `.local/rehearsal` or existing backups. Separate passive
packaged-startup tests from explicit effect-enabled synthetic flow tests.

| Campaign | Required evidence |
| --- | --- |
| Detached artifact | Build/copy into a fresh directory; run without checkout/tsx/Foundry/source imports. Test assets and native dependencies. Missing/tampered bytes, lock mismatch, unexpected files and wrong platform refuse. Same captured inputs reproduce the content manifest. |
| Trust/file loading | Wrong issuer/purpose/revision, duplicate JSON fields, expired review, symlink/link/path escape, mutation during read and withdrawal fail. No self-derived pins, fixture flag or environment bypass. |
| Adapter identity | TLS/hostname/authentication failure, crossed DB/roles, split migration connections, duplicate/crossed RPC identities, oversized/redirected responses and partial provider setup refuse. No fallback, implicit reconnect or leaked credential. |
| Owner startup | Certify before writer/listener; actual epoch handshake; absent/replayed/wrong-scope attachment; timeout/bind failure/late completion. Two owners cannot run. Production-mode detached startup exercises the new guarded path, not a development-mode bypass. |
| No-effect operation | `check`, readiness, inspection, startup and active health have zero X/Grok/sign/send calls. Disabled switches stay disabled. Credential access matches each command's allowlist. |
| Runtime integration | Explicit synthetic wallet intent through accepted assessment → input authorization → one simulated send → Confirming → finalized gallery/provenance; exact counters and no regression to preview authority. Existing EVM evidence remains separate. |
| Restart/failure | New process/epoch/review; preserve sessions/revocations, paid fences, uncertainty, saved inputs and authorizations. Lost provider/sign/COMMIT/wallet responses never replay. Review expiry, owner loss and uncooperative drain close admission. |
| Maintenance | Authenticated exact stopped-backup binding; unsafe clone/stale completion refused; guarded v1→v2 once; same-process recovery plan/action; lost outcome inspected. Preserve R3/R4 byte-for-byte and privilege checks. |
| Operator UI/privacy | Health status remains truthful with effects off; support omission/validation; diagnostic/log redaction, cardinality bounds, SIGTERM and restart runbook. No claim of real alert or proxy acceptance. |

Do not weaken existing coverage gates or regenerate locks to pass. Run focused
new coverage plus staging readiness/runtime/site/transport/sharing, R1–R4,
historical local-startup and release-lock regressions; typecheck/build/import
closure checks. R7 still owns the full clean-tree campaign. Record exact commands,
platform, counts, exclusions and outcomes; do not add historical totals together.

## 8. Manual implementation checkpoints

| Step | Work and stop condition | Recommended model / effort |
| --- | --- | --- |
| 1 — this checkpoint | Bootstrap/distribution/trust/owner design and explicit acceptance plan; documentation only | **GPT-6 Astra · XHigh** |
| 2 | Compiled runtime extraction, compatibility wrappers, deterministic allowlisted artifact, strict input/review loader and passive `check`; stop with detached no-effect smoke tests | **GPT-6 Sol · High** |
| 3 | Mounted-secret/DB/RPC/provider/signer adapters, two-phase owner startup, separate maintenance commands, authenticated backup input, health/support and drain wiring; bounded sub-increments with focused tests | **GPT-6 Sol · High** |
| 4 | Disposable package/lifecycle/failure/restart/integration campaign, regression checks, operator runbook and recorded evidence; stop before acceptance | **GPT-6 Sol · High** |
| 5 | Adversarial review of authority/epoch/credential/backup/SQL/transport boundaries; resolve findings and accept or block R5 offline | **GPT-6 Astra · XHigh** |

Steps 2–4 may share the user's next Sol · High session but are executed in order,
not delegated or silently model-switched. If implementation reveals a change to
these trust boundaries, stop that sub-increment for a design review rather than
inventing new approval semantics. Actual hosting, support contact, accounts and
custody choices are deferred until real installation; none blocks fixture work.

These are task-specific recommendations, informed by official
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) and
[reasoning-effort guidance](https://developers.openai.com/api/docs/guides/reasoning),
not a benchmark claim or automatic setting change. The OpenAI Docs skill informed
the tier guidance only; repository inspection determined this design.

## Implementation checkpoint — September 25

The new `scripts/build-staging-release.mjs` creates a detached, platform-bound
candidate with bundled runtime/source imports, exact RC1 proof inputs, locked
v2 SQL, the current platform's Sharp binary, only the four served Instrument
Sans fonts and their license, a dependency-lock digest and a content manifest.
`contracts/tools/generative-staging-bootstrap.mjs check` accepts an externally
supplied package digest plus an independently pinned installation JSON digest.
It verifies every installed byte, rejects extra/link files, rechecks RC1 and
v2 SQL identities, parses strict canonical configuration and makes no network,
secret, writer or provider call. The trusted installer must check the expected
package digest *before* executing package code; the internal verifier does not
establish its own authority.

Mounted secret/review readers, authenticated-TLS browser/inspector connection
factories, bounded read-only RPCs, current-pilot X/Grok adapter,
address-bound typed signer, actual-epoch owner challenge/one-shot attachment,
private snapshot-only active health and signed stopped-backup/archive
verification are implemented. A **draft, unexposed** `serve` composition
connects pre-writer certification, actual writer epoch, unsigned challenge,
external review attachment, reviewed adapters, preexisting projection and
loopback listeners. The local
staging harness and its HTTP path still refuse `NODE_ENV=production`; only the
package/config-rechecking installed path can compose in production. `inspect`
uses only the restricted inspector credential and an exact UUID reference.
**Only `check`, read-only `inspect` and read-only `verify-backup` are packaged commands.** The complete installed service
epoch/restart campaign, live TLS/RPC target evidence, effect-capable maintenance
commands and backup handoff are absent. The historical pilot pricing profile
expired on September 21, so enabled generation currently refuses a real
assessment rather than silently selecting another model or billing envelope.

Offline evidence so far: two independently built packages had identical
manifest digests; detached import/check and tamper/config-symlink/unknown-field
refusals passed; mounted permission/review withdrawal, adapter no-effect,
epoch/replay/timeout, inherited-descriptor, private health withdrawal and
signed-backup archive and disabled-owner tests passed (8 cases). One additional source-level
production-mode site composition test checked a detached package against
disposable v2 PostgreSQL and synthetic
chain/providers: it refuses unprovisioned projection state, wrong package pin
and the legacy production harness without paid/signing work. The targeted
restricted projection suite passed 114 cases.
The staging-site disposable-PG/synthetic-chain suite passed 27 cases on this
checkpoint,
including mint → Confirming → finalized reveal and restart withdrawal. The
release/operating suite passed 157 cases; `npm run typecheck`, `npm run build`
and `git diff --check` passed. The package/health and site tests required
disposable loopback socket permission. No live X, xAI, Sepolia, production DB,
secret, signer, active rehearsal or backup was used. These are focused results,
not the full Step-4 matrix or Step-5 acceptance.

The combined staging-runtime coverage campaign then passed 61 behavior tests
(33 runtime, 27 site and one source-level installed-composition case). Its
measured runtime/HTTP coverage was 100% lines, 98.12% branches and 96.88%
functions, above the unchanged 100/94/95 gates. This does not exercise an
installed `serve` process: that command remains unavailable for the trust
reason below.

The next step requires a trust-boundary decision: the static installation file
pins the operation-review revision before the writer obtains its fresh epoch,
but the signed operation review includes that epoch. Precomputing/predicting
an epoch would violate the fresh-owner intent. The current attachment merely
echoes a challenge; it is not the independent revision authority. One candidate
is to pin the reviewer public key statically and supply the newly signed
revision through a separately trusted, one-shot local supervisor channel after
the epoch challenge, then recompute and verify the final admission scope. That
changes how authority is pinned and needs explicit design/safety review; it is
**not implemented or assumed approved**. The packaged CLI therefore refuses
`serve` rather than exposing a path that relies on a predicted epoch.

After that decision, run the full installed `serve` process through fresh
epoch/review attachment, stop/restart/failure scenarios on disposable TLS PG16
and synthetic two-source RPC; finish separate authenticated stopped-backup,
`migrate-v2` and same-process `recover` commands and their campaign. The
read-only `inspect` command is **not** a substitute for those effect-capable
operations. Stop before the user's Astra · XHigh step-5 safety review.

### Candidate command and owner runbook — not a live deployment procedure

1. An independently trusted installer computes and checks the package digest
   before invoking its code. It installs exact bytes on the recorded Node/OS/
   architecture; the operator supplies an absolute canonical installation
   JSON path and its independently pinned SHA-256. Never copy `.env.local` or
   a test review key into the package.
2. `node bin/staging.cjs check <package-sha256> <config-path> <config-sha256>`
   checks package/config/proof bytes only. It creates no connection, listener,
   writer or provider call. A green result means `checked-only-not-admitted`.
3. Do not invoke `serve`: the command is intentionally absent from the
   installed package pending the fresh-epoch revision-pin design. The draft
   composition is source-only, not an accepted runnable owner procedure.
4. `inspect` takes the same three external pins followed by exactly one of
   `attempt`, `authorization`, `recovery` and a UUID. It resolves only the
   inspector credential, reports a bounded redacted record, then closes. It
   does not initiate recovery, migration, review signing or provider calls.
   `verify-backup` takes the same three pins, an absolute archive path and a
   decimal maximum byte count. It checks the separately signed current backup
   completion and streams the exact archive hash; its status deliberately says
   `authenticated-only-isolation-not-proven` and grants no restore or migration.
5. Once an installed owner path has been separately reviewed, stop via
   SIGTERM/SIGINT and verify drain/owner release externally. An
   incomplete drain retains ownership where possible; a force-killed process
   cannot retain its DB lock and requires reconciliation before any restart.
   Every restart needs a new writer epoch and independently issued review;
   saved uncertainty must never be replayed. A private health `200` is not
   proof of provider billing approval, deployment correctness or proxy safety.

This runbook currently covers passive check, read-only inspection and backup
authentication only;
the owner steps are a design reminder, not a runnable sequence. No
live staging database, RPC, key custody, paid assessment or public proxy is
approved by these commands. `migrate-v2` and `recover` are intentionally not
offered by the installed CLI yet; use neither a manual SQL shortcut nor a
self-issued fixture review in their place.

## Step-1 verification and status

Step 1 reviewed actual build entrypoints, release proof dependencies, site/runtime and
readiness composition, review/file trust, writer ownership, R3 restore and R4
migration/recovery limits. Updated this specification and current execution
status only. No live connection, secret read, active-data change, commit/push or
ntfy occurred in that checkpoint. **R5 is not complete; the implementation
checkpoint above supersedes the former “no implementation” status.**
