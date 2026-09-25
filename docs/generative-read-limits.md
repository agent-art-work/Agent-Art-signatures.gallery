# Generative artwork reads and startup boundaries

September 22, 2026. **Local implementation and finite-sample evidence; public startup is still disabled.** No active application, database, chain, provider account or existing token was changed.

## One application read policy

`src/openMint/generativeReadLimits.ts` owns `sg-generative-read-limits-v1`. Both the actual chain-only artwork reader and the disposable metadata campaign use these frozen limits:

| Operation / decoded payload | Ceiling |
| --- | ---: |
| One `tokenURI` read per source | 30,000,000 gas |
| Each authority/input/owner/domain getter | 2,000,000 gas |
| Artwork ABI return bytes | 65,536 |
| Scalar ABI return bytes | 2,048 |
| Decoded metadata JSON | 30,000 UTF-8 bytes |
| Decoded SVG | 16,384 UTF-8 bytes |

The existing configured whole-observation deadline remains in force (maximum 30 seconds), including both sources and cancellation. The page/media layer has its own outer deadline. The RPC transport must also bound the streaming JSON envelope **before** decoding; a cap on decoded ABI bytes does not replace that protection. These are application ceilings, not claims about a particular provider's supported gas, response-size, latency, concurrency or historical-state limits.

The reader still makes only one expensive `tokenURI` call per source, at a canonical block-hash pin. It does not additionally call `svg()` or generate artwork using the website renderer. Other getters now use the smaller explicit gas allowance; the domain read is no longer left to a provider default. Exact chain/code/domain/input/provenance/metadata checks and two-source agreement remain mandatory.

ABI responses are decoded and re-encoded: noncanonical dynamic offsets, padding or trailing bytes cannot be silently tolerated. Base64 must be canonical, nonempty and valid UTF-8. Limits count bytes rather than JavaScript characters. A UTF-8 BOM is retained for exact comparison instead of silently removed. Oversized, malformed or inconsistent reads produce the existing sanitized unavailable result, never an external-artifact fallback or new assessment/mint.

These read-only helpers are **not imported into mint authorization**. No SVG rendering/hashing/storage, compression or IPFS publication is added to minting. Existing contract source, compiler/release lock and token identity are unchanged.

## Local full-metadata campaign

```sh
npm run test:contract
npm run generative:release:check
npm run generative:read-limits -- --execute-local-test-transactions
```

The explicit command creates its own loopback Anvil using public test keys. It deploys the locked candidate renderer and 16 separate local collections, preserving one-handle uniqueness while testing every MBTI for each of 11 handles. The corpus covers lengths 1–15, normal names, case, all letters, all underscores, digit runs, repeated zeros/nines, alternating letter/digit and underscore/digit sequences. Handles are validated before their collections are deployed. Each candidate starts paused and is explicitly unpaused by its test pauser **only on that disposable chain**.

For each of the **176** local mints, the campaign reads complete `tokenURI` ABI data with an explicit gas limit and inclusion-block hash, applies the shared bounded/canonical decoder, validates nested metadata/SVG, and compares the SVG exactly with the unchanged locked upstream oracle. It measures encoded and decoded sizes and a read-execution gas estimate. Each sample must remain at or below 90% of the 30m allowance; this is a regression threshold, not a universal gas proof. Eleven deliberately under-gassed reads must reject. The separate existing 96-case direct-renderer survey also runs.

Final observed results:

| Measurement | Largest sample / result |
| --- | ---: |
| Complete metadata/SVG matches | 176 / 176 |
| Additional direct-renderer matches | 96 / 96 |
| Read-execution gas estimate | 20,961,821 |
| ABI return bytes | 14,080 |
| Token URI UTF-8 bytes | 13,985 |
| Decoded metadata JSON bytes | 10,467 |
| Decoded SVG bytes | 7,413 |
| Individual local call plus decoding | 41.22 ms |
| Deliberately under-gassed reads rejected | 11 / 11 |
| Input-only mint gas range | 220,118–231,579 |

The highest sampled execution estimate is `a0a0a0a0a0a0a0a × ESTP`, about 69.9% of the configured read ceiling. Different cases can maximize gas and output size. `eth_estimateGas` includes transaction-style execution overhead; it is **not a fee charged for an `eth_call`**, a public-provider performance guarantee, or a price quote. Latency is from this machine's loopback node under this run's load.

The corpus digest is `0d8c63347f714cb3dd934c1fac5ef7d8c2eca6e41dfa6983d4c4b1531ba5d1e2`. The ignored report is `.local/generative-renderer/release-read-limits.json`; it includes the release lock identity, actual shared policy, per-mint measurements and explicit `publicProviderCompatibility: false` / `exhaustiveBound: false`. These samples complement, not replace, the earlier 6,080-case geometry survey. No report grants startup or deployment authority.

## Startup ordering fix

Previously the isolated browser bridge checked durable session/deployment versus chain configuration only after the site had opened its projection database. A crossed configuration was rejected before wallet use, but could already have caused projection initialization. The shared `assertIsolatedGenerativeBinding` now runs **before projection writes or listener construction**, and the browser reuses the same check.

It binds contract profile, namespace, chain, session chain and origin, contract address, genesis, runtime code hash, signer and deployment block/hash. It requires local-real/31337; the original listener restriction to explicit `http://127.0.0.1:<port>` remains. The site repeats the binding and production-environment refusal immediately before listening; a configuration change between preparation and start drains instead of opening the listener.

Tests cover both experimental and RC profiles, every crossed binding, production/staging configuration, changed configuration before listening, and forged approved-looking flags/reports. No `NODE_ENV=development`, `ALLOW_PUBLIC_STARTUP`, serialized plan or deployment report bypass exists. The separate read-only [deployment observation](generative-deployment-verification.md) still has no authority to start signing or minting.

## Remaining public-admission sequence

This checkpoint hardens current startup refusal; it does **not** implement an approved Sepolia server. The subsequent [runtime-admission policy](generative-runtime-admission-policy.md) specifies the next implementation stages. The [internal numerical/security worksheet](generative-numerical-security-review.md) adds conditional source-bound size estimates (9,506 SVG / 17,792 ABI bytes), not a universal gas/parity proof or independent review. These stages remain separate:

1. Review the locked numerical port and adversarial bounds; select explicit independent RPC sources and validate actual renderer/metadata reads against their gas, bytes, deadlines and historical-state support. A finite local campaign is necessary evidence, not sufficient acceptance.
2. Bind the reviewed release/deployment plan to chosen operational custody, hosting/database/origin, runtime roles, budgets, secrets, finality/support policy and audited migrations. Never infer these choices from a local test configuration or treat a self-asserted JSON flag as approval.
3. With scoped provisioning/deployment approval, deploy paused and run the real fresh two-source initial-deployment observer. Initialize the separately approved durable deployment without enabling issuance. Do not reuse historical experimental rows under a new deployment identity.
4. Require a separate activation decision and verified activation transaction/state. The current **pristine paused** observer is not an active-state observer and cannot simply be rerun with its pause check disabled.
5. Admit public serving/issuance only through reviewed runtime bindings and ongoing chain/kill-switch/role checks. Unknown or stale evidence must disable mint admission, not request new paid assessments or repair nonces automatically.

Real extension/device QA, external security review, operational ownership and content approvals remain on the execution table. There is no return to finished-SVG storage/compression or remote canonical artwork publication.

## Regression evidence

- **5,395 application tests passed**, seven non-applicable skips across 170 files. Coverage is **96.26% statements, 92.05% branches, 98.35% functions**, above the unchanged 93/87/97 thresholds. The new read-limit decoder and startup-binding helper each have 100% statement/branch/function coverage.
- **142 focused tests** cover bounded/canonical decoding, chain recovery and both profiles' isolated-site lifecycle. Added checks include all crossed deployment fields before projection writes, configuration drift before listening and refusal of forged public-admission flags.
- Both candidate and historical experimental backend rehearsals use disposable PostgreSQL databases and real Anvil mints with mocked X/Grok, followed by restart/reuse, chain-only artwork recovery and automatic inclusion/finality observation. Both pass with the updated reader and startup binding. This is not real provider or wallet-extension evidence.
- Typecheck/build, original renderer/slogan locks, the unchanged RC lock, **170 Solidity tests** and **119 release-tool tests** pass. CI now includes the separate full-metadata campaign; hosted CI has not been observed.

Ignored logs are `.local/generative-renderer/read-limits-{unit,typecheck,build,contract,release,coverage,campaign,backend,experimental}.log`. The local read-limit run uses its own `release-read-limits.json`, separate from the ordinary candidate and historical experimental rehearsal reports. No active data or public-chain state was touched.
