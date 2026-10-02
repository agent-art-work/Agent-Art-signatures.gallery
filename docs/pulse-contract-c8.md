# C8 — final Pulse integration review and product handoff

September 26, 2026. **Complete for local product-development readiness.**
No unresolved blocking finding remains within this checkpoint's local scope.
Review tier: **GPT-6 Astra · XHigh**, the selected manual checkpoint.

Scope: the [C1 contract specification](pulse-contract-spec.md), frozen C5
consumer, C6 adapters and C7 local evidence. This is an internal engineering
review, not an independent audit or authorization to deploy. Historical RC1
and renderer bytes remain unchanged. The active `.local/rehearsal`, backups,
secrets and public networks are outside this checkpoint.

## Findings and fixes

| Finding | Resolution |
| --- | --- |
| Wallet-plan staging compared the signed recipient with a transaction sender derived from that same recipient. That no longer independently checked the authenticated request wallet. | Restored comparison against the session-bound request wallet; also require the pinned authorizer, namespace and deployment. Five tests use genuine signatures and reject crossed records before any plan write. This hardens the staging boundary; it is not evidence that a browser could bypass the issuer or database guards. |
| After wall-clock expiry but before a new chain block, mint options could relabel a free observation's zero-price placeholder as a paid quote. | Return an unavailable response until a fresh block supplies the paid phase and actual quote. The rehearsal checks both the rejection before mining and the correct quote afterward. Signing already refused the crossed phase; this fixes the misleading offer. |
| C7's losing-race handle assertion used plain text hashing instead of the protocol's domain-separated ABI hash. | Use `openMintHandleKey`, assert the winner's handle is minted and the loser's is not, and assert zero logs in the reverted receipt. The nonce check remains. The old assertion alone did not establish handle rollback. |
| C7 exercised inclusion/finality and recovery but lacked a real Pulse-specific reorg through the application projection. | Added free and paid unfinalized-reorg scenarios, including withdrawal of Confirming, gallery exclusion, rollback of chain economics, retained accepted inputs and no repeat dispatch. A free reorg retains the slot reservation and sponsorship ledger even though the chain claim bit rolls back. |

The contract, ABI, schema and frozen economic rules did not change. The two
runtime changes are in `persistence/walletSubmissions.ts` and
`persistence/runtimeService.ts`. The rehearsal remains a disposable local-only
program; its report format is now `sg-pulse-c7-rehearsal-v2`.

## Verification and evidence boundaries

- TypeScript, candidate verifier and both integration inventory/runtime tests pass.
- **496 focused application tests pass:** the C6 wire/browser/page/event set
  (406), saved wallet-plan bindings (5), site pages (66), and profile boundaries (19).
- **120 database/HTTP/projection tests pass**, with 7 existing profile-specific
  skips: Pulse pipeline (6), historical generative pipeline (12), historical
  HTTP (47 passing), and projection (55). These use disposable PostgreSQL 16.
- Expanded rehearsal: **four browser paths and eight economic/recovery scenarios
  pass**, including free and paid reorgs, corrected same-block handle assertions,
  and stale-block quote refusal across both deadline tests. All four final SVGs
  load, with zero horizontal overflow or HTTP error responses. Desktop-light
  and mobile-dark screenshots were visually inspected using Visual DOM CDP.
- C5/C7's **230 Foundry tests**, **67 released-core EVM vectors**, renderer locks
  and C7's full **5,995-test** application run remain prior evidence, not new
  C8 runs. The fresh candidate verifier confirms the contract/dependency/build
  bytes still match; C8 reruns the affected runtime paths instead of relabelling
  prior results as a new full campaign.

The browser uses an injected test wallet, X/Grok are offline fixtures, the two
read adapters deliberately share one disposable Anvil, and finality is an
explicit test boundary. This proves local behavior, not a successful real Grok
request, installed-extension support, independent RPC availability, Sepolia
consensus or hosted operating readiness. No provider retry allowance is created.

The [retained rehearsal report](validation/pulse-c8-rehearsal-2026-09-26.json)
records receipts, stage/effect counts, source/inventory hashes and successful
cleanup. Original report and four screenshots are at
`/tmp/sg-pulse-c7-evidence-npqBIc/`; temporary screenshots may later be removed by
the OS. Original report raw SHA-256:
`e735f72a337034f058563c3bf903da9670267f04afd09261f43671282b74a3b8`.
The retained JSON has the same data plus a trailing newline. Driver raw hashes:

- `scripts/pulse-c7-rehearsal.mjs`:
  `ea1ccf21bd6a2845880ff726bea4c62243ee659ee69e593cfeec5df6106f5e46`.
- `scripts/pulse-c7-browser.mjs`:
  `7b037e046b0fdf92caf184b78a5bec01f0358116184a71b19481054564baabc4`.

Development iterations corrected test-only request-ID/canonical-handle/read-model
assumptions and Anvil's restored clock offset after `evm_revert`. The final run
anchors deadline boundary blocks to actual elapsed wall time. Failed exploratory
runs also cleaned up their owned resources; none supplies acceptance evidence.

Reproduce the changed-path tests from the repository root:

```sh
npm run test:pulse:c6
npx vitest run src/openMint/persistence/walletSubmissions.test.ts \
  src/openMint/persistence/generativeSitePages.test.ts \
  src/openMint/generativeProfiles.test.ts --maxWorkers=1 --minWorkers=1
OPEN_MINT_TEST_POSTGRES=1 OPEN_MINT_TEST_HTTP=1 \
OPEN_MINT_TEST_POSTGRES_BIN=/opt/homebrew/opt/postgresql@16/bin \
  npx vitest run src/openMint/persistence/pulsePipeline.postgres.test.ts \
  src/openMint/persistence/generativePipeline.postgres.test.ts \
  src/openMint/persistence/http.postgres.test.ts \
  src/openMint/projection/projection.test.ts --maxWorkers=1 --minWorkers=1
OPEN_MINT_TEST_POSTGRES_BIN=/opt/homebrew/opt/postgresql@16/bin \
  npm run pulse:c7:rehearsal -- \
  --visual-tool /Users/bigu/.codex/skills/visual-dom-cdp/scripts/verify-page.mjs
```

The last two installation-specific paths may be adjusted. The rehearsal accepts
no existing database, RPC or deployment and loads no environment secrets.

## Candidate and artifact identities

These identify the current working-tree candidate, not a new Git release/tag.
Do not alter the historical lock's `reviewed-for-c6-integration` status to imply
public approval. The independent C8 record supplies this later review result.

| Artifact | Identity |
| --- | --- |
| Candidate/profile | `SignaturesPulseMintV1RC1` / `generative-pulse-v1-rc1` |
| Candidate lock, canonical JSON SHA-256 | `029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8` |
| Collection source, raw SHA-256 | `365e52951b24ec9bf257238efc1ca12b4486f45cb8f903dfaa70e4bc4cc3bb28` |
| Complete ABI file, raw SHA-256 | `37ea7fd2fff64f300d5e90bb9ca462c94fabe86613c1abf263017f476703819c` |
| ABI canonical JSON SHA-256 (lock field) | `2f3de90db104d37d87bf7e0912a9fa2807268ec322edfaba32b7fadca54a5678` |
| Runtime template Keccak-256 | `0x72f059a5d2a182d1cac94f55d65d221913cd6d0011d18914036409005611a91a` |
| Runtime size | 23,819 bytes; 757 bytes below EIP-170 |
| Consumer build | solc 0.8.30, optimizer 200, Prague |
| Renderer | unchanged `sg-evm-renderer-1.0.0-rc.1` |
| Pulse release/commit | `pulse-core-v1.0.0` / `a08ec26e396b9d3e20ccebd8871f176368bcd713` |
| Released core runtime Keccak-256 | `0xfb48657163202d3cdb28060f1eb511fd1f5b93a6e0eb8657242b5632e2200a90` |
| Core build | released solc 0.8.24 / Shanghai bytes, not a consumer recompile |
| Local PostgreSQL 16 schema SHA-256 | `e804e32948c2b4cb999d839144e326846bd461094d75229bc192187f5b540a87` |
| 45-file integration inventory digest | `bbc85d5af406fa8e7184e67531a18c4b3161457fe670e685f14d41dabd646f0b` |
| npm lockfile, raw SHA-256 | `7d35a3dcf4be9acf11c14e8a005d0d39b0259eb86c4dba7801e1d8ee161be963` |

The candidate lock verifies source/compiler/dependency closure for the contract;
`expectedPulseRuntime` substitutes every immutable group and compares exact
deployed bytes. The template hash is **not** a deployment's runtime hash.
The 45-file inventory is an integration subset, not a transitive website package
or a backup manifest. Its changed digest reflects the two C8 runtime fixes.
The rehearsal report additionally pins its two driver sources. R5 must still
build and certify a complete revised distribution; old RC1 packages/certificates
do not certify Pulse simply because individual mechanisms are reusable.

## Reuse of R1–R4: what was actually verified

| Prior work | Reused and verified locally | Still required for the revised release |
| --- | --- | --- |
| R1 assessment lifetime | Existing bounded worker, durable provider fences, exposure accounting and first-accepted-result storage; Pulse adds one attempt per free slot and phase checks before each new leg. Deadline-crossing fixtures preserve a returned result and stop a not-yet-dispatched Grok leg. | The exact R1 v2 reviewed-policy/admission composition is **not** ported/certified for Pulse. Older RC1 admission controllers are explicitly rejected. Rebind the independent job/response timing policy and reviewed paid envelope before any real-provider/hosted acceptance. |
| R2 provenance | Exact accepted evidence is joined only after verified canonical inclusion; four browser flows check fixture model/source provenance, renderer art and finalized gallery visibility. Reorgs withdraw unfinalized art. | Real provider evidence and final product presentation still need acceptance. A backend signature is not a signature produced by Grok itself. |
| R3 backup/restore | Durable restart and unknown-send fences are reused; C7/C8 restart the local writer without duplicate effects. Historical restore source is preserved. | No cross-cluster Pulse restore or new hosted backup completeness/custody certification was performed. Extend the package, schema/source pins and actual restore matrix after product changes. A writer restart is not a backup restoration. |
| R4 operator recovery | Local finalized-expiry observation, restricted operator grants, atomic authority retirement/slot release, unchanged accepted inputs/sponsorships and disabled issuance are tested with the new candidate. | The RC1 staging inspection/upgrade/action-review certificate is not a Pulse certificate. Port exact staged roles/schema/review/restore bindings and retest before operating the revised release. |

C1 B03's local timeout/phase behavior is covered; its reference to R1 does not
mean Pulse has passed R1's hosted reviewed-policy path. C1 E02 gains explicit
Pulse reorg coverage in C8. Do not present C1's specification table as an
unqualified public-release acceptance report.

## Economics and allowlist handoff

Keep the [C2 deterministic allowlist tooling](pulse-contract-c2.md): one input
wallet line creates one slot; repeated wallets are intentional; N is the number
of slots. Generate into a new directory, then independently verify all four
artifacts (`manifest.json`, `slots.json`, `tree.json`, `proofs.json`) before
freezing root/count. The Merkle root avoids writing thousands of addresses to
contract storage. The actual ordered list remains an operator/product input.

Use [C5's actual receipt-gas table](pulse-contract-c5.md#actual-transaction-gas),
not C4's execution-only figures: sampled free mints cost 242,710–364,320 gas;
first paid after deadline 333,662; subsequent paid 276,672; collection deployment
5,814,032 for 1,024 slots. The controlled 1→15-character sample adds 11,887 gas.
Proof bytes/depth, bitmap/owner writes and phase transitions also affect gas.
These are specific local samples, not gas limits, current fiat fees or universal
bounds. Paid mint adds the current Pulse ask; free minters still pay network gas.
No SVG storage, compression or IPFS work is introduced.

## Next boundary — product discussion, not activation

With local validation complete, the contract candidate is ready for the planned
website/UI/flow discussion. R5–R10 remain paused until those choices settle.
The minimal free/paid controls used in the rehearsal are not final UI approval.
Preview-link MBTI ingestion remains deferred and is not trusted mint authority.

Before an operational deployment, explicitly supply/review:

1. The ordered slot list/root/N and exclusive free deadline.
2. Pulse parameters and intended pricing behavior; there is no total paid cap.
3. Treasury receiver behavior and separated admin/pauser/manager/revoker/signer
   custody, including supported wallet constraints.
4. Actual chain/core/renderer/collection deployment bindings. Ethereum Sepolia
   and `staging.signatures.gallery` are selected targets, not deployed services;
   the published core address still needs live code verification.
5. Revised R1–R4 operating bindings, R5's unresolved fresh-writer review-pin
   boundary, full distribution/backup acceptance and the remaining R6–R10 gates.
6. An explicitly available real-provider paid envelope, supported-wallet QA,
   hosting/TLS/RPC operation and separately approved deployment/activation.

No change here enables installed `serve`, `migrate-v2` or `recover`, selects
launch economics, spends API credits, sends a public transaction, or modifies
the active runtime. This checkpoint does not include a commit, merge or push.
