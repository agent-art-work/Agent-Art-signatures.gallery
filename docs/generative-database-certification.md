# Generative staging database certification boundary

September 23, 2026. **Implemented and tested offline. No actual staging database is certified, provisioned or activated.** This closes the structural-check gap in the local role/layout audits; it does not replace independent approval, authenticated database transport, current writer ownership or per-operation admission.

## What is checked

`verifyGenerativeDatabaseCertification` is a read-only internal checker for the exact RC1 browser schema on PostgreSQL 16. Its immutable reference lives in `databaseSchemaLock.ts`:

- The ordered nine migration source paths and their exact SHA-256 bytes. CI verifies the source files still match; this is **source identity**, not proof the files historically ran on a particular database.
- A reproducible structural digest from a clean disposable PostgreSQL 16 installation of those migrations. Object identities are names, not physical OIDs. Definitions cover relations, column types/defaults/nullability/storage/collation, CHECK/unique/foreign-key constraints and validation/deferral, index definitions/readiness, user and internal FK triggers/enabled state, function definitions/configuration/ownership, types, policies, rules and inheritance. Extra objects change the digest; unsupported schema-level operators, collations, extensions and other enumerated features are refused.
- Exact schema, table, column, function, type and migration-owner default ACLs, normalized for the explicitly supplied owner/runtime role names. Database and standard system-schema ACLs plus nondefault system function/table/column ACLs are also pinned; their object owners use a separate normalized label. This detects extra privileges on built-in file-access functions and sensitive catalog tables. PUBLIC and third-party grants are not silently omitted. The existing effective-privilege/role audit runs **inside the same catalog statement snapshot**. Runtime membership/delegation, login loss, ownership and dangerous capabilities refuse admission. Extra user schemas/public objects, event triggers and publication of the application tables are unsupported.
- Exactly one staging namespace and deployment policy set: namespace, budget, session, request, renderer input and issuance profiles, foundation v1 and projection v3. Chain must be **11155111**, origin **https://staging.signatures.gallery**, provenance Grok and input profile RC1. **Generation and issuance must both be disabled.** This is a pre-activation certification boundary, not the live activation policy checker.

All policy JSON is hashed as PostgreSQL-produced **text**. NUMERIC/BIGINT fields never pass through JavaScript Number. A one-unit change above `2^53` is detected. Live assessments, wallet rows, mint projection contents and writer epoch are not part of this static schema/policy digest; their existing integrity and live-ownership checks remain separate.

The supported database profile is deliberately narrow: dedicated UTF-8 database, libc `C` collation/ctype, no collation-version override, explicitly pinned database/schema owner and dedicated login runtime role. Connection settings require `search_path=pg_catalog`, UTC, statement timeout 1–5,000 ms, ordinary trigger execution, fsync, synchronous commit (`on` or `remote_apply`), standard-conforming strings and row security. Different hosted layouts/locales/owner arrangements need explicit review and a versioned extension—not silent normalization or re-pinning.

## Independent inputs and evidence

The trusted caller supplies the exact database/owner/runtime names, namespace/deployment UUIDs and four nonzero SHA-256 pins:

1. The locked ordered migration manifest digest.
2. The operator migration/restore receipt digest.
3. The independently reviewed exact policy-profile digest.
4. The current review revision digest.

These pins must come from trusted reviewed composition, **never a web request or automatic capture at startup**. `observeGenerativeDatabase` exists to collect offline review evidence and always reports `approved: false` / `publicStartup: false`. It can report a mismatching structural digest; observation is not approval. The verifying function compares the schema/grants with the checked-in reference and policies with the independent review, and still returns those false flags. It cannot be used as an admission permit.

The migration receipt/revision are bound into `databaseBindingSha256`, but this checker does **not** authenticate or interpret their supporting documents. A current catalog cannot prove migration order/history, absence of past tampering, backup restorability, host identity, custody, provider billing or independent security review. A matching database name is not authenticated remote-server identity. Those checks belong to separately trusted operational evidence and transport/bootstrap composition. No fictitious real evidence or approved account configuration was created.

## Bounded read lifecycle

The caller owns an already authenticated, **serialized** restricted-role connection and its statement timeout. This module never discovers credentials, connects, migrates, grants, starts a writer/listener, signs, submits or requests a provider. Do not concurrently change session settings on that connection.

A built-in-only probe first verifies safe resolution and statement limits. The next statement captures definitions, ACLs, effective privileges, deployment profiles and identity/settings together under one MVCC snapshot. Wire text is limited to 1 MiB schema, 512 KiB ACLs and 64 KiB profiles, with independent receiver byte checks. Server work is subject to the existing statement timeout; the output limits are not a hard bound on server planning/allocation. The application deadline is 1–10,000 ms (default 5,000), checks both monotonic and wall clocks, supports cancellation and suppresses late observations. It does not close a caller-owned connection or retry after uncertainty. Errors expose no SQL, paths, profiles or credentials.

This is a snapshot, **not a lock against later privileged DDL or policy changes**. A reviewed startup must recheck before listening and bind its result into fresh admission evidence. Ongoing activation, kill switches, writer epochs, durable fences and effect-boundary checks must not be replaced with a cached successful certification. An activated policy needs its own reviewed lifecycle; this disabled-only checker is intentionally not weakened to accept it.

## Verification

```sh
# PG16 tools must be on PATH, or set OPEN_MINT_TEST_POSTGRES_BIN explicitly.
npm run test:generative:database-certification
```

The tests create their own Unix-socket-only disposable cluster and databases, install the pinned migrations, and use real restricted-role connections. Every database is removed by its fixture. None accepts a live DATABASE_URL or existing directory.

**164 tests pass**: 76 source/PostgreSQL cases and 88 transport/configuration cases. Structural and permission mutations include removed/weakened/unvalidated constraints, FK changes, partial-index changes, trigger disabling/replacement, function/configuration changes, RLS/rules, added tables/views/types/functions/sequences/collations, ownership, PUBLIC/column/function/default/system grants, runtime escalation and early activation. Profile tests include oversized exact numeric changes and model/renderer/origin drift. Malformed/oversized responses, settings, immutable configuration capture, cancellation and a timeout queued behind real database work are covered. Measured checker coverage is **100% statements/functions/lines, 98.57% branches**, with dedicated 100/98/100/100 thresholds. CI is configured; hosted execution is not inferred.

The broader persistence/staging/provider/loopback-HTTP regression passed **1,483 tests, seven intentional skips in 34 files**. Typecheck/build, original renderer/slogan locks and the RC1 release lock pass. Evidence is in ignored `.local/generative-renderer/database-certification-focused.log`, `database-certification-regression.log` and `database-certification-coverage/`. No new full-application coverage, Anvil/browser/extension, real provider or hosted-CI run is claimed for this read-only increment.

September 23 follow-up: the [separate paused-readiness entrypoint](generative-staging-readiness.md) now cross-binds this checker to fresh release-aware Sepolia observations and signed read-only review. A private-identity profile reader preserves the exact same snapshot's numeric text; forged/copied/unverified records are refused. Updated checker tests: **169 passed, 100% statements/functions/lines and 98.64% branches**, existing thresholds unchanged. This is not a public mint runtime. Preserve all local-only startup refusals. Real public database provisioning, authenticated migration/custody evidence, paid-provider acceptance, deployment and activation remain separate operational requirements. No finished-SVG storage/compression or IPFS work is introduced.

September 23 runtime-binding increment: `observeGenerativeRuntimeDatabase` and `verifyGenerativeRuntimeDatabase` add a distinct `sg-generative-runtime-db-review-v1` domain for the [staging assessment adapter](generative-staging-assessment.md). Static profile text omits only generation/issuance enablement, returning both switches separately from the same snapshot. Every other catalog, grant and static profile pin remains enforced. The paused API still requires both switches disabled. Updated certification verification: **183 tests, 100% statements/functions/lines and 98.93% branches**, thresholds unchanged. Neither runtime observation nor matching certification grants an operation permit or factual approval of supplied evidence.
