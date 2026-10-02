# C6 — versioned Pulse pipeline integration

Completed 2026-09-26. This is a **local adapter checkpoint**, not a public
deployment approval, a hosted R5 package, or the C7 complete-flow rehearsal.

## Delivered

- Separate Pulse input, EIP-712 authorization, reservation and wallet-plan
  versions. Historical seven-field authorizations and zero-value transactions
  keep their original meaning.
- Explicit free-slot or paid-ceiling consent saved with the wallet/session,
  handle, proof, configuration hash and observed quote. Paid wallet transactions
  send exactly that ceiling; the contract refunds unused ETH. A response cannot
  silently change the ceiling. Preview MBTI is not accepted as mint authority.
- Repeated-wallet slots, durable slot heads and one sponsored assessment attempt
  per slot. Eligibility is checked before reservation, each provider dispatch,
  signing and wallet submission. Existing exposure accounting remains in force.
  Older admission controllers are refused for Pulse rather than bypassed.
- First accepted assessments survive phase changes. An explicit new paid intent
  can reuse an unsigned accepted result without another provider call. Started
  signing/submission authority cannot be silently replaced or cancelled.
- Restart-safe unknown wallet submissions and restricted operator recovery.
  Finalized-expiry evidence, authority retirement and slot release commit
  together; sponsorship records remain. Recovery never enables issuance.
- Two-source, block-pinned Pulse configuration/core reads; exact new-runtime
  reconstruction across all immutable positions, without masking bytes.
  MintEconomics/Sale/phase events are joined to canonical mint receipts and
  persisted in projection payloads. Existing Confirming/finalized presentation
  is retained.
- Additive, explicitly installed PostgreSQL migration and distinct browser/
  recovery grants. Local profile opening checks the full PostgreSQL 16 catalog
  against a new local schema digest. The old release certificate is not reused.
- A 44-file raw-byte integration inventory, with
  `publicStartupApproved: false`. This inventory is evidence, not an operation
  permit or a hosted distribution.
- Minimal opt-in mint options, read-only quote checking, explicit mode selection
  and ETH ceiling. No quote/provider request is initiated merely by loading the
  page. About-page fee copy is conditional on this profile.

## Identities

- C5 candidate lock remains:
  `029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8`.
- Local schema SHA-256:
  `e804e32948c2b4cb999d839144e326846bd461094d75229bc192187f5b540a87`.
- Integration inventory digest at this checkpoint:
  `a7b68e8f285033c015e2a26f4e2cc8994c3d201d3b9492900ddc1107d8b712f6`.

The schema check binds the catalog (columns, constraints, indexes, triggers,
function bodies, ownership and policies), not proof of historical migration
execution. Privileges are separately audited. Installation remains explicit;
the adapter does not migrate an existing database automatically.

The certified disposable installation applies, in order: `schema.sql`,
`requests-schema.sql`, `generative-input-schema.sql`,
`generative-release-profile-schema.sql`, `generative-authorization-schema.sql`,
`wallet-submission-schema.sql`, `generative-recovery-schema.sql`,
`pulse-schema.sql`, then projection schema/v2/v3. Connections use
`search_path=pg_catalog`; the database check is deliberately limited to this
local PostgreSQL 16 installation. Hosted/staging installation needs a new
explicitly reviewed package and certificate.

## Verified evidence

| Check | Result |
| --- | --- |
| TypeScript and C5 candidate lock | Pass; unchanged 23,819-byte contract |
| C6 wire, browser, page and economic-event tests | 405 passed |
| C6 inventory/runtime-layout tests | 2 passed |
| Pulse disposable PostgreSQL integration | 6 passed |
| Historical durable pipeline | 12 passed |
| Historical HTTP pipeline, explicitly enabled | 47 passed; 7 existing skips |
| Read/authorization/projection regressions | 590 passed; 89 PostgreSQL-gated skips |
| Released-renderer EVM campaign with exact Pulse runtime binding | 67 vectors passed, including the 1,025-slot fixture |
| Static desktop light / mobile dark layout | No horizontal overflow; no preselected mode; two radio controls; screenshots inspected |

The PostgreSQL scenarios cover free/paid, repeated-wallet reservation, slot
contention, accepted-result reuse after phase change, a phase change between
provider legs, unknown submission after restart and actual-expiry operator
recovery. Disabled slot guards and removed price constraints fail schema
certification. Browser tests caught and fixed the old zero-value-only check;
economic-event tests caught and fixed an indexed-nonce join mismatch.

Reproduce the focused checks with `npm run test:pulse:c6` and
`npm run test:pulse:c6:postgres`. The latter needs PostgreSQL 16 binaries;
`OPEN_MINT_TEST_POSTGRES_BIN` can name their directory. All database fixtures
create their own temporary cluster and cannot take an existing data directory.
`npm run test:pulse:c5:evm` supplies the released-renderer/runtime campaign.

## C7 boundary

Next: **GPT-6 Sol · High**, complete isolated Anvil/PostgreSQL/browser rehearsal.
Build the new-profile fixture composition explicitly; include wallet slot IDs
when refreshing eligibility before worker dispatch. Exercise actual phase
endings, changing prices, one-paid-mint-per-block competition, rejection/reload,
and Confirming-to-Minted observer persistence. C6’s database/provider mocks,
browser-script harness and static screenshots are not that complete rehearsal.

The installed-startup review-pin issue from R5 remains unresolved and is not
waived here. Public startup, Sepolia deployment, live provider calls, staging
activation and production migration remain separate boundaries. The active
`.local/rehearsal` environment and historical backups were not modified.
