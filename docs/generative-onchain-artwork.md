# Generative on-chain artwork

Selected September 21, 2026. This supersedes IPFS/HTTPS canonical storage **and finished-SVG storage/compression**. Do not resume either finished-SVG path. Existing historical tokens, locked renderer sources, local wallets, chain and app data remain untouched. Local development is authorized; paid calls, public deployment, provisioning and migration are not.

## Contract boundary

- The mint contract stores the case-preserved handle, Grok-authorized MBTI and compact provenance/authorization state. Identity remains one lowercase literal handle per collection. No client-selected seed, MBTI, geometry or prompt is admitted.
- A separate immutable EVM renderer, with immutable dependencies, generates the SVG from those inputs. `tokenURI()` generates self-contained metadata with an embedded SVG. The contract needs no website, database, IPFS or provider-held artwork files to recover an already minted work.
- The collection fixes its renderer address/code identity. No proxy, updater, renderer setter, mutable trait or external-state dependency may change existing work. Future renderer releases require separately reviewed version/deployment rules, never implicit relabelling.
- New EIP-712 input authority binds the canonical and preserved handle, MBTI, assessment digest, renderer/input-format identity, recipient, deployment/chain, nonce and expiry. Do **not** run renderer, SVG hashing, Base64 or complete metadata construction in `mint()` to check an old output-hash field. The old raw-SVG ABI/commitment profile cannot be reused unchanged.
- Grok inference remains off-chain, via our controlled backend. On-chain rendering does not independently authenticate the external model; the trusted signer and durable assessment workflow remain authority boundaries.

## Feasibility checkpoint and execution order

1. Correct the plan; retire the raw-SVG design (done in this change).
2. Build an isolated experimental Solidity renderer, without changing the locked TypeScript/Python oracle or live app. First candidate: high-precision scaled integers for geometry, explicit trig/square-root/rounding, identical SHA-256 scope serialization and MBTI semantics.
3. Compare exact SVG bytes and numerical differences separately. All 16 MBTIs, case, digits, underscores and 1–15-character bounds; fixed regressions plus deterministic generated cases. Finite passing samples are not a proof over the full input domain. No reduced coordinate precision or silently altered geometry to improve gas.
4. Measure deployed code per module, deployment gas, read execution gas/time/output size and failure bounds. EIP-170 limits runtime per deployed contract to 24,576 bytes; splitting into fixed modules is allowed. `eth_call` has no transaction fee but RPC gas/time/response limits still apply. A `view` renderer invoked inside a transaction is paid execution.
5. Only after the fidelity/feasibility checkpoint, implement compact input-only minting and measure receipts. Reuse authorization/session/nonce/recipient/budget protections, not old SVG-publication requirements. A deliberate visual-only approximation requires a user-approved version change first.
6. Compose durable input issuance, observer/read adapter, Confirming reveal and galleries; prove recovery from chain without the private database on fresh disposable Anvil. Then prepare separate Sepolia deployment/release approval.

## Evidence and prohibited assumptions

The earlier 653k–3m gas figures describe the abandoned finished-SVG storage experiment. They do not estimate this generative mint. New renderer read cost and input-only mint cost must be measured separately. An inexpensive mint does not prove the read call fits ordinary RPC/marketplace limits.

Prototype names/version identifiers must say experimental. Neither fixed-point arithmetic nor sampling tests alone establish exact equivalence to Python/JavaScript floating-point output. If parity breaks, record representative diffs, magnitude and cause; investigate without changing the oracle and bring unresolved output changes to the user before adopting them.

## Local feasibility checkpoint — September 21

Contracts are isolated under `contracts/src/experimental/`, with a separately selected backend input-only profile. There is no active runtime/browser or production ABI switch, public deployment or historical-token migration. The mint candidate constructor refuses every chain except 31337 and accepts only the exact compiled renderer runtime (not a proxy or arbitrary address).

- `SignatureRendererCandidate`: fixed-point geometry at 18 decimal places; same SHA-256 scope encoding and 53-bit seed extraction, case-sensitive inputs, all MBTI rules, digit/underscore layout, curve sampling and two-decimal SVG serialization. Canonical token output is the locked 1080×1080 SVG. Responsive preview sizing remains the unchanged off-chain renderer's responsibility.
- **6,080 / 6,080 exact SVG byte matches**, no errors, each read limited to 30m gas. Includes all MBTIs, all 63 permitted single characters, lengths 1–15 across five structured families, handles from the Python golden set, and 256 deterministically generated mixed handles (deduplicated). The TypeScript oracle's source and Python golden lock are verified first. This is finite compatibility evidence, not exhaustive mathematical proof.
- Renderer SHA-256: `6af0fc0f12fd6576b2d750ced4e9de2be4b5dee15343c0ee26ab847befad80e1`. Solc 0.8.30, optimizer 200, Prague, normal pipeline (not via-IR). Runtime **14,736 bytes**, deployment **3,238,454 gas**. No shared external geometry tables or mutable dependencies.
- Output-preserving optimization removed duplicate centering computations and unused vectors, bounded private arithmetic checks, and repeated whole-path buffer copying. Maximum-digit INTJ sample fell from ~107m to ~19.2m rendering gas-equivalent. Sample positions, coordinate precision, oracle source and output bytes were not changed.
- `GenerativeSignaturesCandidate`: one packed artwork-input slot (`bytes15` handle + length + four literal MBTI bytes), separate immutable provenance/ownership and replay state, fixed renderer identity, new experimental EIP-712 domain. There is **no SVG argument, output hash or URI in mint authorization**. Input identity is bound to the renderer deployment/code/profile; canonical handle still controls token uniqueness.
- Ten real local mint receipts and chain-only `tokenURI` decodes pass. A regression forces all renderer calls to revert: mint still succeeds, but reading SVG correctly fails until that test-only mock is removed. Transfer, pause and authorizer rotation leave already minted metadata unchanged.

| Handle | INTJ mint gas | INFP mint gas | INTJ tokenURI execution estimate | INFP tokenURI execution estimate |
| --- | ---: | ---: | ---: | ---: |
| x | 231,370 | 231,540 | 1,837,176 | 880,756 |
| karpathy | 220,236 | 220,418 | 11,065,633 | 4,698,007 |
| Alice_Bob_Key | 224,418 | 224,588 | 13,988,433 | 7,651,321 |
| ABCDEFGHIJKLMNO | 224,454 | 224,660 | 15,124,613 | 9,121,466 |
| 012345678901234 | 226,716 | 226,910 | 20,438,461 | 16,017,224 |

INTJ and INFP use two fresh collections to preserve one-handle uniqueness. The first mint to an empty recipient balance costs more; do not infer that a one-character handle intrinsically costs more. Mint figures are receipts; read figures use `eth_estimateGas` on the read call and include transaction-style overhead, **not an ETH charge for `eth_call`**. Signature bytes/state can slightly change receipts. The sample max is not a universal bound. Mint contract runtime is **15,726 bytes**, deployment **4,009,953 gas**; renderer deployment is separate/shared. These are unactivated experimental contracts with experimental metadata, not a final production fee quote.

The measured calls are below the local 30m test budget. That does not establish compatibility with every public RPC or marketplace. Before public adoption: independent numerical review, broader adversarial/fuzz evidence, deployed-code pinning, public-provider read-limit checks, complete production metadata and input authority, and an explicitly versioned renderer port profile. No rendering is added to mint to work around read limits.

Reproduce (fresh disposable loopback Anvil; no keys/env file, paid calls or public transactions):

```sh
npm run test:contract
npm run generative:rehearsal -- --execute-local-test-transactions
npm run generative:rehearsal -- --execute-local-test-transactions --quick --mint --backend
```

Generated machine-readable reports are `.local/generative-renderer/survey.json` and `quick.json` (ignored). CI runs the focused parity/mint/backend boundary rehearsal; the full survey is a release/fidelity checkpoint. The active app still uses its previous contract and data. The later sections record projection, browser-wallet and isolated-site startup integration. Public activation remains incomplete.

## Durable input authority and chain recovery — September 21

Implemented in `src/openMint/generative{Inputs,Authorization,Reads}.ts`, `persistence/generative{Inputs,Authorizations}.ts` and two **explicit additive**, unactivated SQL migrations. Only an explicitly configured `generative-experimental-v1` deployment on Anvil 31337 can use this path. There is no public HTTP switch and no implicit database migration at startup.

- Input preparation validates the exact native, X-verified accepted assessment. A self-consistent user-edited MBTI/digest is not authority. Verified spelling, MBTI, assessment and renderer identity are frozen in an insert-only, per-deployment record. Existing assessments are not rewritten or relabelled as a new upstream renderer release.
- Issuance requires the current session, origin/CSRF, wallet-proof generation, recipient, explicit consent and fresh chain witness. It reserves immutable typed data before calling the signer. Restart reuses the same signed bytes; expired or uncertain reservations are not silently released. Logout/disable during signing prevents release; timeout/invalid signing results remain fenced with no automatic second dispatch.
- The chain gate checks collection domain/code plus renderer address/runtime/profile/identity at one explicit canonical block through two configured sources. Historical output-URI issuers reject generative witnesses. The old projection decoder refuses the new profile instead of treating an input digest as an old artifact hash.
- The chain-only reader decodes self-contained `tokenURI` metadata and verifies its input/provenance bindings, owner, collection and renderer pins. It uses one 30m-capped metadata render per source, not duplicate SVG rendering. Cancellation, deadlines, bounded decoding, malformed metadata, mismatched sources and reorg checks fail closed. It does **not** claim freshness/finality by itself; the later projection integration supplies that boundary.
- Actual Anvil + PostgreSQL integration: wallet proof → one accepted **mocked** X/Grok result → frozen inputs → one signature → writer restart and exact reuse → successful mint → disposable database removed → exact SVG recovery solely through RPC. The integration sample (`Backend_Test_1 × INTJ`) minted for **225,422 gas**. No real X/Grok calls or public transactions. The two adapters use the same disposable node, so this is not independent-public-provider evidence.
- Source/compiled-source checks now refuse stale renderer and mint bytecode before rehearsal. New tests cover all MBTI input commitments, case/code/deployment binding, output-domain exclusion, invalid authorization fields, tampering and database/signing restart cases. Existing coverage thresholds remain unchanged.

Verification: **4,938 application tests in 162 files**, all passing with real disposable PostgreSQL and loopback HTTP enabled; **131 Solidity tests**, all passing. Full-suite coverage: **96.08% statements, 91.99% branches, 98.44% functions** against unchanged 93/87/97 thresholds. Typecheck, locked-renderer verification and build pass. Reports are local test evidence, not deployed staging validation.

## Projection, admitted runtime and public reads — September 21

The explicit experimental profile now composes:

- `GenerativeSignatureMinted` event decoding, successful receipt/log agreement, canonical block anchors, collection/renderer code pins and finality. Each event is matched against the on-chain inputs and provenance. No saved private assessment or signer database is needed to recover the minted artwork.
- An **explicit**, additive projection v2 → v3 migration, with separate input/renderer commitments rather than counterfeit old artifact/URI hashes. Historical payloads, events, ownership and finality survive unchanged. There is no automatic migration of the active database.
- Restricted runtime grants/audit for input-only preparation and issuance plus projection. The role cannot rewrite accepted inputs, signatures or issuance policies, and has no old artifact publication privileges. Existing session, consent, CSRF, proof generation, eligibility, recovery and ambiguous-signing protections remain in force.
- The durable private HTTP preparation/authorization path skips publication entirely. Its security suite runs against both the existing and generative profiles. An actual isolated Anvil mint consumes the exact HTTP-returned calldata after a writer restart, with one mocked X lookup, one mocked Grok assessment and one signature.
- Read-only detail, SVG/metadata/PNG, status, home and MBTI gallery composition. Detail reveals on verified inclusion with **Confirming**; galleries admit only finalized work. Transfer/ownership, restart withdrawal, orphan rollback, finality violation, corrupted rows and unavailable-chain behavior are tested. Input/renderer/assessment commitments are displayed honestly; a chain digest is not relabelled as proof of a live Grok response.
- Real browser checks against the disposable Anvil-backed pages at 1024×900 (dark Confirming, light Minted and light home) and 390×844 (dark MBTI gallery). All images load, captions preserve case, no horizontal overflow, and decoded SVG ink is present. Screenshot inspection accompanies DOM/network checks. The verifier waits for image decoding and two paint frames; merely checking `img.complete` previously allowed an incomplete screenshot.

Rehearsal finality is explicitly simulated by two test adapters against **one** local Anvil node. It exercises the transition without pretending Anvil's native finalized tag is immediate, or substituting a fixed elapsed-block rule for public finality. It is not Sepolia finality or independent-provider evidence. The disposable database is removed before the final RPC-only SVG recovery check.

Optional browser evidence uses a locally available visual verifier, never a hard-coded workstation path:

```sh
npm run generative:rehearsal -- --execute-local-test-transactions --quick --mint --backend --visual-tool /absolute/path/to/verify-page.mjs
```

Verification at this integration checkpoint: **5,050 passed, 1 skipped, 0 failed in 164 application test files**, with PostgreSQL and loopback HTTP enabled. The skipped case is the legacy publication-role audit in the generative parameterization; the generative role has its own direct catalog audit and denial tests. Coverage is **96.13% statements, 92.10% branches, 98.33% functions**, against unchanged thresholds. **131 Solidity tests**, renderer-lock checks, typecheck and build pass. The fresh 96-case quick renderer survey has 96 exact matches, and all ten direct contract mints plus the backend-driven mint pass. These are local results, not hosted CI or staging evidence.

At that checkpoint, the read-only page adapter did not take over `/mint`, `/me`, previews or wallet endpoints. The later browser bridge below adds `/mint` and its wallet endpoints only when explicitly composed. Neither adapter is registered in the active application; the partial route set is **not a complete alternative website**.

Next integration order (safe local work, not a request for routine approval):

1. Browser transaction bridge: **implemented and locally validated** below. No active-app switch.
2. Isolated website/startup composition: **implemented below**. Explicit operator reconciliation is now implemented in the later recovery section: unknown/reverted/consumed-nonce submissions stay blocked until finalized authorization expiry is proved; no timer resets them. Active-app migration remains separate.
3. Explicitly version the renderer-port release contract: **candidate lock and offline deployment planning implemented in the release section below**. Candidate backend integration, numerical/read-limit review and observed-deployment admission remain. Only after readiness work request separately scoped Sepolia deployment/provisioning approval. The experimental profile remains unable to deploy there.

## Browser wallet bridge and durable submission recovery — September 21

Implemented as a separately selected `GenerativeMintBrowser`, `GenerativeWalletChain`, `PostgresWalletSubmissions`, and explicit `wallet-submission-schema.sql` migration. The default server does not expose these routes. Composition requires the matching local runtime and public read/page adapters; chain 31337 and non-production startup restrictions remain intact.

- Before authorizing a wallet send, two configured read sources must agree on the latest canonical block, genesis/deployment, collection/renderer code, domain, signer and EOA status. Pinned-block, latest and pending wallet nonces must agree. Deadlines/cancellation and final header checks fail closed. The backend never exposes its RPC URL or broadcasts a wallet transaction.
- The exact server-issued calldata, recipient, zero value, chain and wallet nonce become an immutable plan. A nonce cannot be reserved by two requests for the same wallet/deployment. No SVG, PNG or metadata publication is inserted into mint preparation.
- `/api/mints/begin` commits an append-only dispatch **before** the browser invokes `eth_sendTransaction`. Only one tab wins. A lost begin response, wallet timeout, hash-report failure, browser storage loss, reload or writer restart never silently releases the guard or starts a replacement. Submission permits are private random capabilities stored hashed in PostgreSQL; reports require the original session/wallet, origin/CSRF and matching permit.
- An explicit wallet rejection allows up to five explicit attempts using the **same plan and nonce**. Rejection is a browser observation, not proof that no transaction exists. It cannot change the signed MBTI, mint a second token, allocate a fresh nonce, or erase an earlier dispatch. A conflicting/stale permit cannot overwrite another attempt's report.
- A reported hash is not chain authority. Only the verified projection permits Confirming/Minted and redirects private progress to the public signature. With no verified mint and no dispatch, the private status is `unknown`, not fabricated chain absence; fresh authorization preflight owns eligibility. Submitted/uncertain status remains privately readable after request/proof expiry while the original session/wallet remains valid.
- The current shared client opts into the protocol only through `data-durable-wallet-submission`. Existing local/legacy paths are unchanged. Provider pinning, wallet-change checks, exact-transaction simulation and explicit intent are retained. Unknown outcomes display a check-wallet instruction, not a false success or automatic retry. Mobile progress displays the hash once.
- Separate browser-role grants/audit add SELECT/INSERT on the three new immutable tables, not update/delete, policy control, migration ownership or publication grants. SQL migrations are explicit; no existing database was migrated.

Validation: **5,089 application tests passed, six parameterized non-applicable cases skipped across 165 files** with real disposable PostgreSQL/loopback HTTP; coverage **96.17% statements, 91.92% branches, 98.36% functions** against unchanged 93/87/97 thresholds. The first unconstrained-worker run hit one existing CLI test's five-second timeout; the full bounded-worker run passed without changing tests or production deadlines. Build/typecheck/renderer locks and **131 Solidity tests** pass.

The disposable Anvil rehearsal also passes the 96-case exact-renderer survey, ten contract mints and the backend/browser mint. With `--visual-tool`, the real Chromium page sends once through a **simulated EIP-1193 wallet backed by a public test key**, after the real dispatch commit; its permit/hash report is saved once. It is not a Rabby/MetaMask-extension or device-matrix certification. Dark mobile submitted progress, dark desktop Confirming, light desktop Minted/home and dark mobile MBTI gallery were checked with DOM/network assertions and screenshot inspection; no horizontal overflow or failed requests. One offline mock lookup, one offline mock Grok assessment and one backend signature were used. No real provider call, public transaction, active database/chain reset, deployment or public operating approval occurred.

Limitations intentionally preserved: a lost/reverted/consumed-nonce submission needs explicit reconciliation, not automatic resubmission or nonce advancement. There is no generic pending-clear endpoint, wallet impersonation, new funded key, or public startup path. The next section adds isolated scheduling and preview/collection/About routes; sharing/indexing, real extension QA, renderer-port release review and Sepolia deployment remain separate work.

## Isolated website and automatic observation — September 21

`createIsolatedGenerativeSite` composes the existing admitted runtime, wallet bridge, generative reads, public pages and bounded projection poller. It requires an already configured/audited durable runtime and explicitly installed schemas. It does not read environment files, provision a database, create a signer, deploy a contract or migrate the active application. Its listener is restricted to an explicit `http://127.0.0.1:<port>` origin, local-real namespace and experimental Anvil profile; production/public startup remains refused.

- Construction does not listen or poll. Explicit `start()` starts one listener and one bounded, non-overlapping observer. No GET drives synchronization. Unavailable reads back off; safety halt, writer loss or a hung pass do not restart themselves. Until fresh observation exists, chain-dependent pages fail closed rather than displaying an invented empty gallery.
- `close()` withdraws reads and disables new preparation immediately, then drains HTTP, preparation and the in-flight observation under a deadline. External listener closure stops the observer too. Startup/close races, bind failure, repeated close, rejection and non-cooperative drains are tested. A drain timeout reports failure and does not release writer ownership; the caller must resolve it before recovery.
- `/p/<handle>/<MBTI>`, `/p/<handle>/variations` and locked `/preview/...svg` assets preserve preview case, accept only known MBTI/renderer inputs and do not allocate public sessions or call X/Grok/signing. `/s/` compatibility redirects validate their targets. The minted tile uses the verified contract-generated SVG; the other 15 use the locked preview renderer and are explicitly alternatives, not additional tokens. An experimental on-chain renderer is not mislabelled as an earlier renderer or passed to an unsupported off-chain endpoint.
- Missing/unavailable projection evidence remains **unknown**, including for an apparently new handle. Exploration remains available with the existing subdued warning; this does not become a false “unminted” claim or a mint authorization. Eligibility is still checked only by the explicit mint flow.
- `/me` uses the verified session wallet, normalized to the projection's lowercase owner identity. No URL parameter selects the wallet. The current-owner filter and snapshot-bound pagination include finalized work only; session generation, wallet and proof are rechecked after the read. Unknown chain status is not an empty collection. Signed-out or expired-proof visitors get the connect-wallet view, not another wallet's cards.
- Home, MBTI galleries, detail, mint, collection, previews and About share the established navigation/assets/client. The Grok handoff copy control works with the exact isolated origin. About describes compact on-chain inputs and read-generated SVG/metadata for this profile, while the existing app's wording is unchanged. Approved slogan and content-claim decisions are not rewritten.
- All responses retain no-store/noindex, strict CSP, safe URL/body/query validation and redacted errors. No public indexing/social-card activation or live-provider verification is claimed.

The disposable rehearsal now uses this lifecycle before and after writer restart, with **no manual projection sync**. It checks one actual browser send/report, automatic Confirming then finalized promotion, the selected tile plus 15 alternatives, signed-in/out collections, About, old-route redirects and unknown-handle exploration. Browsing leaves lookup/provider/signing/send counts unchanged. Final chain-only SVG recovery still runs after removal of the disposable database. Two adapters still target one Anvil node, and the test finality ceiling is simulated—not independent RPC or Sepolia evidence.

Verification: **5,181 application tests passed, six non-applicable parameterized cases skipped in 167 files**; coverage **96.20% statements, 92.01% branches, 98.31% functions**, with unchanged thresholds. **131 Solidity tests**, typecheck, build and renderer locks pass. The fresh 96-case quick survey is exact. Nine Chromium views pass DOM/image/network/overflow checks, with screenshot inspection: submitted wallet progress; Confirming/Minted detail; home/MBTI gallery; 16 variations; a single alternative; current-owner collection; and About. Mobile dark and desktop light/dark are covered. Browser integration caught and fixed checksummed-wallet normalization at the collection-query boundary. Test-harness corrections also removed a shadowed variable and an incorrect assumption that the test wallet owned only one work; no application assertion or coverage threshold was relaxed.

Exactly one offline mock X lookup, one offline mock Grok request and one backend signature were used in the final rehearsal. The browser sent/reported one Anvil transaction. No live credentials, paid provider call, public transaction/deployment, active-server replacement or existing database/chain mutation occurred. The new composition is not wired into `src/main.ts`; the next task is explicit operator reconciliation, followed by release-profile and staging readiness work.

## Offline operator retirement — September 21

The [operator recovery runbook](generative-operator-recovery.md) describes the new `GenerativeRecoveryChain`, `PostgresGenerativeRecovery`, explicit `generative-recovery-schema.sql` upgrade and dedicated recovery-role grants/audit. The active application is unchanged.

Recovery requires two pinned read sources to agree on finalized and latest canonical state: the old authorization deadline is strictly past on the finalized chain, the handle is still unminted, and the authorization nonce remains unused/unrevoked. Wall-clock expiry, a missing receipt/hash, a wallet rejection, a reverted transaction or a consumed EOA nonce alone cannot release anything. Paused/revoked/mismatched/uncertain state conservatively stays blocked. No alternative early-revocation recovery is claimed.

The site must be stopped/drained, its writer released and issuance disabled. An independently audited non-owner operator login can review a private snapshot and explicitly apply a short-lived, process-local recovery plan. In one fenced transaction it appends immutable evidence, retires the plan's active wallet-nonce lease and removes exactly the old active reservation pointer. All original assessments, inputs, authorization/signature bytes, plans and submission history remain. Late reports, state changes, expiry, wrong pins and policy changes invalidate a plan; injected failure after evidence insertion rolls the entire operation back. Known recovery IDs support restart/lost-commit-response inspection without blind replay. The browser role has no recovery mutation privilege.

Only a new explicit user request can prepare fresh authority afterward, using the same accepted assessment and inputs, current wallet proof and normal chain/nonce checks. Old request codes remain retired. Recovery does not invoke X/Grok, sign, broadcast, cancel/replace transactions, clear wallet history, fill nonce gaps, re-enable issuance, or migrate/reset an active database/chain. This is an offline operator API, not a new website recovery control or a deployed public operations service.

Validation: **5,206 application tests passed, six non-applicable cases skipped in 168 files**, with **96.24% statement, 92.01% branch and 98.35% function coverage** against unchanged thresholds. **133 Solidity tests**, typecheck, build, renderer locks and whitespace checks pass. The final recovery-role tightening (excluding session secrets, provider receipts, budgets and projection reads) was additionally verified by rerunning all six real-PostgreSQL pipeline scenarios, including direct SQL denial assertions. No active database was migrated.

The normal disposable Anvil rehearsal was rerun separately: **96/96 exact renderer comparisons**, ten direct mints and the HTTP/backend mint, restart reuse and exact RPC-only SVG recovery after removing the disposable database. The backend path used one mocked X lookup, one mocked Grok assessment and one backend signature; zero real provider calls or public transactions. This run did **not** invoke the optional browser verifier, so it makes no new browser/extension claim. Recovery finality evidence in the PostgreSQL tests remains scripted; independent public RPC/Sepolia recovery validation is pending.

## Release-candidate identity and offline deployment planning — September 21

The [generative release candidate](generative-release-candidate.md) now has separate frozen renderer/collection/input/domain identities, source/compiler/dependency/bytecode locks and read-only Sepolia planning. It starts paused and is not adopted by the active app or experimental backend. The full finite candidate survey matches **6,080/6,080 SVGs**; ten input-only local mints, chain-only metadata recovery, **170 Solidity tests** and **119 release-tool tests** pass. The unchanged experiment's 96-case/ten-mint regression passes too. No real provider calls, public transactions or active-data changes occurred.

At that checkpoint, candidate backend integration was next. It is completed in the following local increment. A consistent offline deployment plan is not a deployment witness or permission to broadcast. Sepolia provisioning/deployment remains separately gated. Finished-SVG storage/compression remains abandoned.

## Explicit candidate backend integration — September 22

The separately named `generative-v1-rc1` profile now composes durable preparation/signing, read-only chain and wallet checks, projection/storage, the isolated website and offline finalized-expiry recovery. A frozen shared registry binds its input profile, EIP-712 domain, reservation version, EVM renderer version and exact metadata description to the release lock. The configured profile must match saved renderer/deployment pins; neither a GET nor a mint payload selects it.

Historical experimental wire bytes remain the default only where required for compatibility. Saved upstream assessments are not relabelled as EVM-port releases. Unknown or crossed profiles fail closed. The explicit input-profile schema upgrade allows a new RC deployment without modifying old rows; populated experimental assessment/input/authorization/signature preservation and restart reuse are regression-tested. Recovery's separate wallet-schema upgrade and conservative expiry/finality conditions are unchanged.

The RC rehearsal passes 96 exact SVG comparisons, ten direct test mints, one backend mint and RPC-only SVG recovery after deleting its disposable database. Exactly one mock identity lookup, one mock Grok assessment and one backend signature are used. Real Chromium sends/reports once through the simulated public-test-key wallet. Nine screenshot/DOM/network checks cover submitted progress, Confirming/Minted, galleries, variations, preview, collection and About across desktop/mobile and light/dark. All images load and no horizontal overflow is observed. This is not real extension/device QA or independent public-RPC evidence: two adapters still use one Anvil node with scripted finality lag.

Both profiles run the durable PostgreSQL/HTTP, projection and recovery regressions; CI is configured to rehearse both complete local backends. No active app/database/chain, provider credential or deployment was changed; no paid call or public transaction occurred. All public backend startup/signing/recovery gates remain closed.

At this checkpoint, observed-deployment/public-admission verification was next. The initial deployment verifier is implemented below; public admission, independent numerical/security review and public-provider read-limit evidence remain, followed by separately approved provisioning/deployment and activation.

## Read-only deployment observation — September 22

The [candidate deployment verifier](generative-deployment-verification.md) now compares exact deployed code, including all EIP-712/renderer immutables, finalized signed CREATE transactions, initial roles/delay/domain/signer and pristine paused state across two configured read sources. It requires the published Sepolia genesis and canonical pinned reads, with bounded time/bytes/history and freshness. Its opaque observation never grants public startup or activation authority; declared source/custody separation is not proof.

All 83 new tests pass, with 100% line / 97.87% branch / 100% function coverage. A disposable Anvil rehearsal verifies actual deployed immutable bytes and the preserved initial pause, then confirms that chain-ID simulation is rejected as Sepolia. Application regression is 5,329 passed / seven skips across 169 files, with unchanged coverage thresholds; contract/release-lock regressions remain green. No actual public RPC/deployment evidence, active-app change, paid call or public transaction is claimed.

Next: separate public admission/readiness policy, numerical/security and artwork-read-limit evidence, then approved operational setup and deployment. The runbook and [release candidate](generative-release-candidate.md) preserve the exact remaining boundaries.
