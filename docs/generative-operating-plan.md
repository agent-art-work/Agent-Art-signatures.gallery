# Offline Sepolia operating-plan validation

September 22, 2026. **Implemented, offline only. A valid plan is not deployment approval, verified evidence, or runtime admission.** This completes the first implementation step in the [runtime-admission policy](generative-runtime-admission-policy.md). The active app and all local/public-startup restrictions are unchanged.

## Entry points

```sh
npm run generative:operating-plan -- --input /absolute/path/to/operator-declarations.json
npm run test:generative:operating-plan
npx vitest run src/openMint/staging/operatingPlan.test.ts
```

The input is exactly `{ "deployment": ..., "settings": ... }`:

- `deployment` is the constructor-planning input accepted by `deploymentPlan` in `contracts/tools/generative-release.mjs`: explicit chain, origin, genesis, delay, CREATE nonces and six role addresses/owner references. The new adapter additionally requires the published Sepolia genesis and rejects obvious local/rehearsal owner labels.
- `settings` has the explicit TypeScript shape `OperatingSettings` in `src/openMint/staging/operatingPlan.ts`. Its `deploymentPlanSha256` must match a freshly recomputed deployment plan. Its six custody addresses and owner references must exactly match that plan too. Unknown and missing fields are rejected at every object boundary.

Use the existing offline `deploymentPlan` API to obtain the constructor-plan digest after the actual public identities are chosen. There is deliberately no ready-to-deploy sample configuration or environment-inference shortcut. Test fixtures contain fabricated, unowned addresses and references with **no real accounts, credentials, evidence or custody** behind them; never promote them to staging settings.

The release-aware adapter verifies the unchanged complete candidate build/source lock and computes the collection's expected runtime hash with **all immutables substituted**, not masked. CREATE nonces must also fit the signed-transaction observer's safe-integer range, even though the lower-level constructor planner accepts a broader uint64 range. The output contains both the deployment plan and operating plan. The operating digest covers its settings, release hash, exact expected runtime hash, shared read limits and all false authority flags, and commits the deployment plan through its digest. Changing a valid declaration changes its digest. Both outputs are deeply frozen and detached from input objects.

## Checked declarations

| Section | Checks |
| --- | --- |
| Identity | Exact Ethereum Sepolia target and `https://staging.signatures.gallery`; `sepolia-staging` namespace; explicit v4 UUID deployment ID; exact locked constructor plan |
| Session | Same origin, chain 11155111, secure `__Host-sg-staging` cookie, strict SameSite and required CSRF |
| Hosting | Explicit account/service/ingress-policy references; direct TLS with zero trusted proxy hops or TLS proxy with exactly one; bounded request body, request time and drain time |
| Database | Separate migrator/browser/projection/recovery role names and connection references; exclusive writer; no startup migration; generation and issuance initially disabled; migration-plan and backup-evidence references |
| RPC | Exactly two distinct source/operator/account references; separate endpoint-secret references; shared read-limit version; bounded streaming-envelope capacity, timeout, head/finality age, future skew and evidence lifetime |
| Custody | All six roles exactly bound to planned addresses/owners; explicit custody-policy and distinct signer-secret references |
| Assessment | Request-profile reference and digest; separate X/xAI credential references; pricing/spending references; bounded validity period, counts, queue, positive integer USD ticks and exposure; one active attempt, zero automatic retries, uncertainty preserved |
| Operations | Support/incident/security/compatibility/finality references; canonical-inclusion Confirming, finalized-only gallery, stop-new-effects on stale evidence and never restore a compromised signer |

References use a kind prefix such as `secret:gallery/database/browser`, `owner:gallery/steward`, `policy:gallery/ingress` or `evidence:rpc/alpha/limits`. They are inventory identifiers, **not URLs, credentials, file paths, secret-manager implementations or evidence themselves**. Deployment owner references retain the existing constructor planner's syntax. Duplicate secret references are rejected across database, RPC, custody and provider settings; this does not prove two references resolve to different values.

The conservative implementation ceilings are not selected operating values or a capacity promise:

- Requests: 1–64 KiB, 1–30 seconds, draining between request timeout and 120 seconds. Only zero or one explicitly trusted proxy hop is supported by this plan version; the ingress policy must later identify the actual trusted ingress, not trust headers globally.
- RPC JSON response envelope: 132,096–1,048,576 bytes, at least twice the 65,536-byte ABI ceiling plus framing allowance. Observation timeout is 1 second up to the HTTP request timeout. Head age is at most five minutes, finality age at most one hour and not less than head age; future skew at most 30 seconds; witness lifetime at most 30 seconds and not greater than head age. These are structural limits, not verification of actual source behavior or approval of those maxima.
- Assessment declarations: 1–1,000 daily attempts, total at least daily and at most 1,000,000, one active attempt and at most 100 queued (not above total). Positive decimal USD ticks use at most 15 digits, and exposure must cover one reservation. One USD is 10,000,000,000 ticks. A reservation/exposure threshold is **not a guaranteed provider billing cap**. The declared review window must be positive and no longer than 31 days.

The offline validator deliberately does not consult the clock. An old but well-formed plan can still be inspected; its policy period must be checked again during future live admission and at each effect boundary. It does not renew the existing pilot's pricing review, change its model/profile, enable its generation flag or expand any previously approved paid envelope.

## What validation does not establish

Every output explicitly says `declared-only-not-admitted`, with observed deployment, verified evidence, custody, provider independence, paid dispatch, signing, public broadcast, runtime admission and activation flags **false**. Setting an environment variable, adding an approval field, supplying a saved report or successfully parsing a plan cannot change this.

No references are fetched. A different owner label does not prove different human custody; separate RPC accounts do not prove independent upstream nodes. Known Anvil/scalar-key addresses and obvious fixture labels are rejected, but no denylist can discover all public test keys or prove private keys are controlled safely. Operators must never put secret values inside reference labels; syntax checks cannot recognize every possible encoded secret.

The declaration can name a proposed migration/profile/evidence reference, but this does **not** prove its content exists, has been reviewed, matches deployed schema, or is accepted for public use. Current database/runtime gates still require their local profile. The next admission layer must verify exact content hashes, audit live roles/schema and bind the approved policy through a trusted configuration path. A supplied JSON `approved` flag is never that path.

Deployment transaction/block hashes and activation history do not exist at constructor-planning time. They are intentionally **not fabricated in this pre-deployment plan**. The fresh paused-deployment witness and [separate active-state observer](generative-active-state-verification.md) supply them as observations; trusted admission must still cross-bind them to this plan and reviewed policy before public admission.

## Input and diagnostic safety

The CLI accepts only `--input FILE`, reads at most 32 KiB plus one oversize-detection byte, requires a regular file, refuses a final-component symlink, decodes strict UTF-8 and parses JSON. It does not load `.env`, resolve secrets, fetch RPC, connect to a database, mutate a file, sign, deploy or provision anything. Errors contain only a fixed section/field name; parse/file/build errors never echo submitted values or file paths. Output consists of the validated declarations and public plan, so treat even reference identifiers as operator information, not public website content.

## Next implementation boundary

September 23 update: the [separate paused-readiness composition](generative-staging-readiness.md) now verifies exact database bindings, fresh pristine deployment observations and a signed readiness-only scope before starting bounded loopback health endpoints. It cannot activate or mint. This first entrypoint supports only one trusted local TLS proxy and disabled policies; direct-TLS/effect-capable site composition remains separate. Local guarded adapters were integrated in the intervening checkpoints; the remaining adapter work below concerns staging, not reopening completed local work.

The [distinct active-state observer](generative-active-state-verification.md) and [internal admission core/release adapter](generative-admission-composition.md) are now implemented and locally tested. The latter cross-binds the operating plan, declared source/limits and fresh observation digest, but its trusted review and concrete PostgreSQL lease/fence adapters remain to be integrated. Those must verify actual reviewed custody, profiles, sessions, budget and ownership, not accept references as facts. Preserve the pristine paused-deployment verifier and isolated startup refusal. Only after these components and actual operating choices/evidence are reviewed should a separate Sepolia entrypoint be introduced. Public provisioning, spending, deployment and activation remain separate decisions; no such action was taken here.

## Validation evidence

- **214 core-validator tests** cover section/field validation, crossed bindings, secret/reference misuse, limits, hostile object shapes, immutable digests and no-authority output. Focused statement/branch/function/line coverage is **100%** for the new core validator, with the existing thresholds unchanged.
- **38 release-adapter/CLI tests** cover actual locked-build derivation, exact immutable substitution, known test identities, all six custody bindings, observable nonce limits, malformed/oversized/non-UTF-8 input, symlink refusal, environment/flag attempts and redacted failures. These are fabricated offline declarations, not real operational evidence.
- **332 focused application tests** passed, including the validator plus both profiles' existing startup-refusal tests and read-limit decoder tests. The **119 existing release-tool tests**, typecheck, build, original renderer/slogan locks, unchanged candidate lock and whitespace checks passed. No contract source or active runtime was changed, and the full PostgreSQL/application campaign was not rerun for this offline-only increment.
- CI now runs the adapter/CLI suite; core tests are included in normal application coverage. Hosted CI was configured, not observed. Local logs are `.local/generative-renderer/operating-plan-{focused,build,release,tooling}.log`.
