# Site relay for the Sepolia rehearsal

This is a site-owned read projection, not a mint authority or a new blockchain. The browser reads same-origin pages and APIs; the Node site observes Sepolia and can persist verified public presentation in PostgreSQL. The wallet remains responsible for the user's transaction. No relay endpoint signs or broadcasts a mint.

## Six-step implementation and model sizing

| Step | Result | Suggested tier / effort |
| --- | --- | --- |
| 1. Source deadlines | A slow primary has its own deadline; the secondary gets a chance within the outer read budget. Wrong-chain, binding, and evidence conflicts still halt. | GPT-6.1 Sol / high |
| 2. Relay model | Public-only deployment pins, works, artwork, ownership, observations, and atomic checkpoints. Confirming may be replaced; finalized evidence may not. | GPT-6 Astra / xhigh |
| 3. Durable projection | An opt-in PostgreSQL store backs the existing same-origin read API; a public file cache remains a bounded fallback. No private key, request, or signature is stored in this schema. | GPT-6 Astra / xhigh |
| 4. Demand-driven refresh | Requests coalesce into one head/finality probe per lease. An unchanged head skips the history scan. A changed head performs incremental observation; outages back off. | GPT-6.1 Sol / high |
| 5. Wiring | Gallery/detail/image/collection use cached projection. Transfer logs update ownership. Mint preparation, wallet support, slot, price, pause, and handle admission still use a fresh validated chain read. | GPT-6 Astra / xhigh |
| 6. Failure tests | Test slow primary, fallback, restart, finality conflict, incomplete logs, ownership reorg, and availability independently of mint readiness. | GPT-6 Astra / high |

These are sizing recommendations, not automatic model switches.

## Read policy and request flow

Ordinary runtime reads use **one validated primary, with a separately validated secondary on classified unavailability**. Two-RPC agreement is not a prerequisite for serving the site. A contradiction, wrong chain, wrong contract, or changed finalized anchor is not treated as an outage and cannot select a more agreeable source. Explicit deployment/audit tools may still compare both sources.

The first request after a lease triggers a background head/finality probe. Other requests reuse the in-flight work. If the validated head and finalized anchor are unchanged, no history scan runs. On a new block, the relay checks that the previous head is still canonical and compares the contract mint counter. If the counter is unchanged, it advances the work checkpoint without a mint-log scan; if not, it rebuilds the unfinalized suffix and verifies the complete count. Transfer logs separately rebuild the owner suffix, and sale/price reads remain independent. Viewing stays responsive from the last verified projection; stale or unavailable status is labeled rather than converted into a fresh claim. A chain head probe is unavoidable: without some chain signal, the relay cannot know that the chain is unchanged.

The current Sepolia rehearsal still indexes a bounded deployment range and allows up to 100,000 works. The legacy JSON cache is limited to 100 works and 4 MiB; PostgreSQL is required for larger galleries. Production should use a separately operated database and revisit cold-bootstrap time and RPC rate limits before launch. This implementation does not deploy a production service or migrate the existing runtime database automatically.

## Operator setup

1. Provision a dedicated PostgreSQL database and application role. Put its connection URL in `PULSE_RELAY_DATABASE_URL` in the process environment; do not commit it or expose it to the browser.
2. Apply the schema explicitly with `npm run pulse:sepolia:relay:migrate` using a migration role. Grant the site role only the required schema/table privileges. The site itself does not run migrations.
3. Start the existing Sepolia site with `npm run pulse:sepolia:dev`. Without the URL, it continues to use the bounded atomic file cache. `/health` reports the relay scheduler and whether the PostgreSQL store is enabled or failed.
4. Confirm `/health/ready` for mint readiness separately from gallery availability. A saved projection can keep viewing available through an RPC outage, but it cannot make a mint ready. After restart, the observer revalidates the saved finalized checkpoint before using it as a scan cursor.

Run `npm run test:pulse:sepolia` for the read/site tests. The disposable database integration test additionally needs `npm run test:pulse:sepolia:relay:postgres` and local PostgreSQL binaries. No live Sepolia transaction is sent by these tests.

### Provisioned local instance

The local Sepolia frontend uses a dedicated socket-only PostgreSQL cluster at `.local/pulse-relay/data`, with its socket in `.local/pulse-relay/socket`. It is separate from `.local/rehearsal`. The database is `sg_pulse_relay`; schema ownership belongs to `sg_pulse_relay_admin`, while the site connects as `sg_pulse_relay` with only schema usage and table SELECT/INSERT/UPDATE/DELETE privileges. Local authentication uses a private Unix socket directory (0700); there is no TCP listener or database password.

After initial provisioning and migration, run `npm run pulse:sepolia:relay:dev`. It starts this existing cluster if necessary and supplies its connection URL to the site on port 3004. It never initializes or replaces a database, runs migrations, or sends a chain transaction. Stopping the site leaves the database running and preserves its projection. This is a local launcher, not a production supervisor.

The local launcher defaults its primary read endpoint to `https://eth-sepolia.api.onfinality.io/public`, which was reachable during activation. `SEPOLIA_READ_RPC_URL` overrides it. The fixed Tenderly secondary and all chain/deployment validation remain unchanged; the private deployment RPC configuration is not edited.

To stop only this dedicated database after stopping the site, use `pg_ctl -D .local/pulse-relay/data stop -m fast -w`. Preserve the directory across restarts. `/health` must report `relayStore.enabled: true`; `/health/ready` separately reports live mint readiness.

## Failure semantics

### Viewing, refreshing and mint admission are separate

The visitor-facing boundary is the relay. An RPC failure belongs to operators unless it affects an actual mint action or unfinished transaction.

| Surface / situation | Visitor presentation |
| --- | --- |
| Gallery, previews, permanent details, collection; refresh unavailable | Quietly retain verified relay artwork and status; no network warning. |
| No initial relay projection | Neutral loading or page-unavailable text; never invent an empty gallery or collection. |
| Mint entry; brief background sale refresh failure | Retain the previous verified advisory sale within its original 90-second window; retry quietly. |
| Mint entry; no usable admission evidence | One actionable mint-availability warning beside Mint & reveal; fresh submission checks still refuse. |
| Unfinished mint; brief confirmation retry | Neutral checking text; retain artwork and the submission lock. |
| Unfinished mint; sustained confirmation failure | Retain revealed artwork, show honest status and one transaction-specific warning beside the CTA/result. |
| Submission started but no hash recorded | Explicit wallet-activity recovery message; do not claim the chain is unavailable or assume that no broadcast occurred. |
| Completed finalized mint; ordinary refresh failure | Keep **Minted** and remain quiet. |

- A cached finalized signature stays **Minted** after idle. The 90-second freshness budget applies to live check readiness, not to the existence of a finalized token. Expiry or startup revalidation alone does not display an outage warning.
- `galleryState` distinguishes `checking`, `cached`, `current`, `unavailable` and `halted`. A verified zero-work projection is available; an unknown projection shows a loading message, not an empty-gallery claim.
- **Viewing exposes the relay, not RPC health.** Home, MBTI galleries, previews, permanent signature details and My Collection do not display chain/RPC refresh, ownership or safety-halt warning banners, even during a prolonged outage. The old three-minute gallery-warning grace is removed. `galleryState`, `galleryFailureSince`, lane failures and redacted source diagnostics remain available to operators through `/health`. A successful canonical observation clears the corresponding failure episode; integrity conflicts remain latched. Missing initial relay data shows neutral loading/page-unavailable content, never a false empty-gallery or empty-collection claim.
- `mintState` independently distinguishes `checking`, `ready`, `paused`, `unavailable` and `halted`. Pause is a sale state, not a network outage. Mint-read failures do not warn on home; gallery failures do not automatically disable independently verified mint admission.
- Advisory sale readiness survives classified transient refresh failures only within the original 90-second verified evidence window. `saleReadState: retrying` remains an operator diagnostic; it does not renew the evidence timestamp. Missing binding, bootstrap/service failure, pause, expiry and integrity conflicts still block. A background pass cannot overwrite evidence from a newer successful explicit check. Preparation and submission each perform a fresh mutable-state read regardless of advisory readiness.
- Visitor demand renews sale evidence after 45 seconds independently of ownership synchronization. Recovery is single-flight and honors outage cooldown; successful relay synchronization receives a completion lease to avoid continuous back-to-back scans.
- A collection uses the last verified owner index without requiring its head to match the latest gallery head exactly. Missing ownership is loading, not “you own no works”; owner-index failures remain operator diagnostics. Ownership changes can refresh the collection independently of gallery changes.
- A failed browser capability poll may retain the last successful readiness flag for at most 15 seconds, never beyond the backend's original sale-evidence expiry. Explicit false readiness, pause, conflict and wrong-chain responses revoke it immediately. A transport warning appears only after at least three consecutive failures sustained for 15 seconds. Passive viewers retry silently. A failed HTML gallery refresh does not revoke successful capability evidence. These are browser-to-site failures, not proof of a chain/RPC outage.
- Active mint results own confirmation warnings separately from general admission polling. Verified inclusion reveals the artwork immediately as **Confirming**. Brief failed status checks use neutral progress; at least three consecutive failures sustained for 15 seconds produce one transaction-status warning. Explicit integrity conflicts warn immediately and are not erased by a later timeout. Finalized results are quiet on ordinary read outages. Passive detail monitors retain the last verified status through transport failures; actual changed/disputed evidence still changes the status honestly. General readiness polling cannot overwrite a confirmation-owned warning. Static provenance caveats remain informational and are not network warnings.
- Transaction status uses verified relay evidence or that transaction's validated receipt, not a fresh complete gallery scan. Tracking distinguishes `not-submitted` (no row/prepared), `submission-unknown` (begin committed but no reported hash), `pending` (reported hash), `confirming`, `minted` and `reverted`. Public absence cannot unlock a browser marker: no-submission recovery requires a matching unexpired wallet proof. Timeout, request expiry or a missing receipt never unlock ambiguous broadcast. New browser references bind wallet, chain and collection; legacy references retain conservative recovery.
- One physical limiter per RPC endpoint still allows at most two active reads with one-second dispatch spacing. Action reads may overtake queued scans, with a background turn after at most four competing action dispatches. Canceled queued reads are removed immediately. Explicit receipt/history indexing lag may try fallback without revoking deployment validation or declaring endpoint failure; actual transport failures and integrity checks are unchanged.

Fresh mutable chain preflight remains mandatory at mint preparation and submission. Wrong-chain, immutable binding and finalized-evidence conflicts are not ordinary failures and never select a more agreeable RPC. No contract, spending, free-slot or transaction-retry policy is relaxed here.

- One source unavailable: retry the entire read at the other validated source, with no partial evidence mixing.
- Both unavailable: serve last verified public data quietly with honest token status; fresh mint preflight refuses and the mint flow warns.
- PostgreSQL unavailable: keep the process-local and bounded file presentation path; `/health` reports the store error. Do not grant mint eligibility from storage.
- Finality or immutable evidence conflict: halt the affected observation path, do not overwrite the checkpoint, and require operator review.
- Ownership catching up: retain the last verified collection quietly; missing initial data shows loading. Never guess ownership from the wallet address or a pending transaction.

### Permanent halts require explicit integrity evidence

A generic assertion, malformed response, filesystem error, or unknown exception is **not** automatically a chain conflict. Read lanes have three distinct outcomes:

- Classified transport/data unavailability: `unavailable`, bounded backoff and validated fallback. Gallery presentation stays quiet; affected mint admission and unfinished mint confirmation warn.
- Unknown/service failure: `blocked`, no autonomous or visitor-demand retry of that lane. Preserve the verified checkpoint and unrelated capabilities. An explicit operator refresh may retry after diagnosis.
- Explicit `MINT_EVIDENCE_CONFLICT`: `safety-halted`, persist the gallery safety marker. This includes contradictory chain/genesis, pinned runtime code, mint authority, immutable mint inputs, or previously finalized evidence. Do not retry against a more agreeable provider. An `OWNERSHIP_EVIDENCE_CONFLICT` halts ownership, not unrelated gallery evidence.

A moving **unfinalized** head is retryable data unavailability; a changed previously verified **finalized** anchor is an integrity conflict. Assertions still refuse the affected operation; removing automatic assertion-to-conflict promotion does not make an unvalidated read acceptable.

`.local/pulse-sepolia-v1/read-diagnostics.json` keeps at most 32 redacted failure records across restart. Records contain a lane, timestamp, failure category, allowlisted error/check identifiers and numeric transport status. No raw messages, assertion values, stacks, URLs, credentials, requests or response bodies are stored. `/health` exposes the latest safe diagnostic. Diagnostic corruption is not chain evidence.

### Reviewing an existing persisted halt

`npm run pulse:sepolia:safety:review` is a read-only operator review; it is never called by startup, a timer or an HTTP request. It verifies the deployment, every saved finalized receipt/input/SVG, the prior finalized anchor and the collection's current mint counter using validated primary/fallback reads. It refuses corrupt evidence, missing or conflicting receipts, incomplete sets, outages and new unaccounted-for works. No key is unlocked, no transaction is signed or sent, and no two-provider runtime quorum is introduced.

To apply a successful review, stop the site and run `npm run pulse:sepolia:safety:review -- --apply` with the same read-only RPC environment as the launcher. This reruns the review and accepts only an in-process approval, unchanged input files and evidence no more than 90 seconds old. It takes the site lock for the replacement and durably archives the original cache, halt marker and review in `.local/pulse-sepolia-v1/safety-review-*`. It replaces the cache and removes the halt marker **last**. Restart and check gallery and mint readiness separately. The PostgreSQL data, wallet requests, active rehearsal and contract are unchanged.

If interrupted or refused, do not delete the marker by hand. Inspect the safe diagnostic and perform an appropriate full review. The archived originals can restore the previous halted presentation with the site stopped; they cannot grant mint readiness without chain validation.

The request writer is scoped to the site's explicit runtime directory too. A disposable test or study must not write `.local/pulse-sepolia-v1/web-records.json` when it supplies a different directory. Startup still refuses a mismatched request/deployment digest. During the 2026-10-01 recovery, an already-empty fixture request file with a foreign test digest was archived before resetting the local request book for the correct deployment; no test requests were imported. The four finalized on-chain works and dedicated PostgreSQL projection were preserved.
