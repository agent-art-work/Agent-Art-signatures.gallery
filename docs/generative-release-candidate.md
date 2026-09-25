# Generative release candidate — 1.0.0-rc.1

Prepared September 21, updated September 22, 2026. **Candidate, not approved or publicly deployed.** This checkpoint freezes a separately named EVM port, supplies offline Sepolia deployment planning, integrates an explicit candidate backend profile in disposable local rehearsals and implements a read-only observed-deployment verifier. It does not adopt the port in the active website, migrate active data, enable public startup, provision anything or authorize public transactions.

## Identity and boundaries

| Item | Candidate identity |
| --- | --- |
| Renderer | `SignatureRendererV1RC1` / `sg-evm-renderer-1.0.0-rc.1` |
| Collection | `GenerativeSignaturesV1RC1` / `sg-generative-mint-1.0.0-rc.1` |
| Input profile | `sg-generative-inputs-v1-rc1` |
| EIP-712 name / version | `SignaturesGenerativeMintRC1` / `1` |
| Geometry oracle | Unchanged upstream signature `sg-renderer-2.0.0` |
| Candidate lock | `contracts/releases/generative-v1-rc1.json` |
| Staging target | Ethereum Sepolia, chain 11155111, `https://staging.signatures.gallery` |

Upstream v2.0.1 remains a **slogan-only patch**. The EVM port is neither a new upstream release nor a retroactive relabelling of earlier tokens. Its geometry body is checked against the existing fixed18 experiment, and both are checked against the unchanged locked TypeScript/Python oracle. Experimental contract files and historical backend wire identities remain unchanged; shared backend code now selects the explicit durable deployment profile. The experimental collection still refuses Sepolia.

The new collection permits only Anvil 31337 or Sepolia 11155111 and **starts paused**. It accepts only the exact compiled candidate renderer runtime. No proxy, renderer setter, external geometry service or mutable dependency is added. An old experimental renderer or old EIP-712 domain cannot authorize this release. The renderer address, code hash and input profile bind each input commitment. The collection address and chain bind the authorization domain.

Minting still stores only compact case-preserved handle/MBTI inputs and provenance/replay/ownership state. Rendering, SVG hashes, URI generation, IPFS and finished-SVG storage/compression are not part of authorization or mint. `tokenURI` and `contractURI` are self-contained data URIs. The metadata renderer version comes from the immutable renderer's `VERSION`, not an independent literal. The compiler's existing `bytecodeHash: ipfs` setting only describes its Solidity metadata stamp; the artwork does **not** fetch or require IPFS.

## Read-only lock verification

```sh
npm run test:contract
npm run generative:release:check
npm run test:generative:release
```

Build first: the verifier deliberately refuses missing/stale artifacts. It verifies every transitive compiled source against the actual installed dependency, exact compiler 0.8.30/settings, source hashes, ABI, metadata, creation/runtime code, immutable reference layout, oracle files and Foundry configuration. Runtime is capped at 24,576 bytes; creation/initcode at 49,152. No external library links or renderer immutables are accepted. Incidental AST numbering is excluded from immutable-position identity so unrelated compilation units do not falsely change the lock.

The command is read-only and has no generate/bless/deploy mode. A mismatch requires investigation; do not regenerate the lock merely to make CI green. A deliberate revision needs a new reviewed release identity and evidence. This lock is a reproducibility/review boundary, **not independent security approval or exhaustive numerical proof**.

## Offline Sepolia plan

```sh
npm run generative:release:check -- --plan /absolute/path/to/reviewed-sepolia-config.json
```

Supply exactly these fields. The following is a deliberately **invalid incomplete template**, not a deployable example. No private key, mnemonic, credential or RPC URL belongs in it.

```json
{
  "chainId": 11155111,
  "origin": "https://staging.signatures.gallery",
  "genesisHash": null,
  "adminDelay": "172800",
  "rendererNonce": null,
  "collectionNonce": null,
  "principals": {
    "deployer": { "address": null, "ownerReference": null },
    "delayedAdmin": { "address": null, "ownerReference": null },
    "authorizerManager": { "address": null, "ownerReference": null },
    "pauser": { "address": null, "ownerReference": null },
    "nonceRevoker": { "address": null, "ownerReference": null },
    "authorizer": { "address": null, "ownerReference": null }
  }
}
```

Addresses must be normalized lowercase, nonzero, distinct and not known public test identities or small placeholders. Owner references are distinct lowercase identifiers for reviewed custody records, not secrets or proof of ownership. Nonces are decimal strings, consecutive CREATE nonces from the explicitly supplied deployer. The candidate planning policy requires at least a 48-hour admin delay. No `.env` or wallet is loaded and no defaults infer identities. Contract permissions alone do not prove separate human custody; the offline checks cannot establish that the declared operators actually control their addresses.

The output binds constructor inputs, predicted addresses, exact initcode hashes, expected renderer runtime/identity, collection runtime **template**, domain and lock digest. Its declared genesis must later be independently verified. An EIP-712 collection runtime contains deployment-specific immutables; its template hash is **not** the deployed runtime hash. Changing nonces invalidates predicted addresses and the plan. The output always states:

- `status: plan-only-not-observed`
- `observedDeployment: false`
- `publicBroadcastAllowed: false`
- `runtimeAdmissionAllowed: false`
- `collection.startsPaused: true`

There is no broadcast command here. A consistent plan is not observed chain evidence, a proof of custody, an admission manifest or deployment permission. Do not pass it to the current experimental backend as a deployment witness.

## Local validation

```sh
npm run generative:rehearsal -- --execute-local-test-transactions --release-candidate --quick --mint
# Complete candidate backend, disposable PostgreSQL and loopback website:
npm run generative:rehearsal -- --execute-local-test-transactions --release-candidate --quick --mint --backend
# Full finite parity sample (6,080 cases):
npm run generative:rehearsal -- --execute-local-test-transactions --release-candidate --mint
```

The rehearsal starts and removes its own loopback Anvil node, uses publicly known test keys with separate role accounts, checks the initial pause and explicitly unpauses only the test collections. It tests exact SVG/metadata recovery from chain and input-only mints. No live provider calls, public transactions or existing chain/app/database changes occur. `--release-candidate --backend` now explicitly selects the candidate profile; omitting the release flag retains the historical experiment. CI is configured to run both backend paths plus release checks; the full survey and browser screenshots are separate local evidence, not observed hosted CI.

Observed candidate results:

- **6,080/6,080 exact SVG matches**, zero errors/mismatches, each call capped at 30m gas. All 16 MBTIs, all 63 legal single characters, structured lengths 1–15, existing golden handles and deterministic mixed handles are covered. These are finite samples, not the entire input domain.
- Renderer runtime **14,736 bytes**, deployment **3,238,394 gas**. Collection runtime **16,319 bytes**, deployment **4,096,720 gas**. Both fit the normal limits without disabling code-size enforcement.
- Ten direct mints: **220,203–231,483 gas** in this run. The first mint starts an empty owner balance; signature bytes/storage context affect receipts. This is not an ETH fee quote or a worst-case proof.
- Largest sampled `tokenURI` estimate: **20,447,778 gas-equivalent**, 13,393 UTF-8 URI bytes, for the 15-digit INTJ sample. This is a local read-execution estimate, not an `eth_call` transaction fee or proof of public-provider/marketplace compatibility.
- **170 Solidity tests** pass, including paused startup, explicit activation, Sepolia chain-ID simulation, old-profile rejection, role controls, signer rotation, replay/expiry/uniqueness and a forced-render-failure regression proving mint does not invoke rendering. Chain-ID simulation is not deployment on Sepolia.
- **119 release-tool tests** pass: all compiled dependency hashes, settings/size/lock tampering, immutable positions, strict plan inputs/roles/nonces and readonly CLI. The unchanged experimental path also passes its 96-case/ten-mint regression.
- A forced clean Solidity rebuild passes all 170 tests and reproduces the same release lock without modification.
- Full offline application regression: **5,206 passed, six non-applicable skips across 168 files**, with disposable PostgreSQL/loopback HTTP and mocked providers. Coverage is **96.24% statements, 92.00% branches and 98.35% functions**, above unchanged 93/87/97 thresholds. Typecheck, build, existing renderer/slogan locks and whitespace checks pass.

Machine-readable ignored reports: `.local/generative-renderer/release-survey.json` and, when run, `release-quick.json`. Existing experimental reports use separate names. This checkpoint does not claim real-wallet extension/device certification or hosted CI.

## Explicit backend integration — September 22

The frozen `GENERATIVE_PROFILES` registry binds the contract profile, input profile, renderer version, EIP-712 domain, reservation version and exact metadata description. Candidate values are regression-checked against the release lock. The explicit runtime profile and saved renderer pin must agree; a request/GET cannot select a profile. Unknown profiles fail closed. A missing input-profile field is accepted only as the historical experimental encoding; it never silently upgrades to the candidate.

The journal, durable reserve-before-sign issuer, signature verification/calldata, read-only eligibility and wallet checks, projection decoder/storage, artwork/provenance, isolated site and offline recovery all preserve this binding. Experimental and RC signatures/input digests cannot cross profiles. The accepted upstream assessment stays byte-for-byte unchanged, including its upstream renderer version; the separate EVM version identifies the resulting on-chain implementation. Existing tokens and frozen authorizations are not relabelled.

`generative-release-profile-schema.sql` is an explicit additive upgrade after `generative-input-schema.sql`: it permits a new profile for a separately configured deployment, without updating any row or removing immutability triggers. Tests upgrade a populated experimental deployment and compare its assessments, input/profile rows, authorization reservations and signature bytes before/after, then reuse them after writer restart. This does not import historical rows into a new deployment. The wallet-recovery schema remains a separate explicit upgrade.

Local candidate evidence:

- The full backend rehearsal uses one mocked X lookup, one mocked Grok assessment and one backend signature. An actual Anvil mint succeeds, restart reuses the saved authority, and exact SVG recovery works after the disposable database is removed.
- Real headless Chromium with a **simulated injected test wallet** performs exactly one begin/send/report. Nine captured states cover submitted mobile progress, Confirming and Minted, home/MBTI galleries, 16 variations, preview, wallet collection and About across light/dark desktop/mobile. DOM, image loading, network and screenshot checks pass without horizontal overflow. This is not a Rabby/MetaMask-extension test.
- Durable HTTP/PostgreSQL and projection scenarios run under **both profiles**: invalid signatures, uncertain signing, wallet changes, disabled issuance, expiry recovery, migration/restart and profile spoofing. Recovery still requires strictly past-deadline finalized/unminted evidence; no automatic nonce repair or retry was added.
- The two read adapters in the browser rehearsal point at **one Anvil node**, with a scripted finality lag. They do not establish independent Sepolia-provider behavior or public finality.

All backend issuance, wallet, recovery and site entrypoints still refuse non-31337/public startup. A Sepolia-capable Solidity constructor or offline plan does not override those gates.

Final integration regression: **5,328 application tests passed, seven non-applicable parameterized skips across 169 files**. Coverage is **96.25% statements, 92.02% branches and 98.35% functions**, with the existing 93/87/97 thresholds unchanged. Both profiles pass all 56 isolated-site lifecycle checks, including profile mismatch rejection before projection writes. Typecheck, build, original renderer/slogan locks, the unchanged RC lock, **170 Solidity tests**, **119 release-tool tests** and whitespace checks pass. Hosted CI has been configured, not observed.

```sh
OPEN_MINT_TEST_HTTP=1 OPEN_MINT_TEST_POSTGRES=1 \
OPEN_MINT_TEST_POSTGRES_BIN=/opt/homebrew/opt/postgresql@16/bin \
npm run test:coverage -- --reporter=dot --maxWorkers=2 --minWorkers=1
```

The PostgreSQL binary path above is this local machine's path; CI uses its explicitly installed Linux path. Disposable loopback/socket permission is required before running these tests. An initial sandbox-denied run left 22 never-attached temporary shared-memory segments and exhausted macOS's 32-segment limit. Only those exact resources, created during that test run and rechecked for owner/creator/time/zero attachments, were removed; older resources, persistent files and active services were untouched. The subsequent complete run passed, including backup/restore. No system limit was changed. Ignored local logs are `.local/generative-renderer/profile-coverage.log`, `profile-contract.log`, `profile-release-tools.log` and `profile-browser.log`.

## Read-only observed-deployment verifier — September 22

The [deployment verification runbook](generative-deployment-verification.md) now describes the implemented two-source, bounded verifier. It checks the published Sepolia genesis, finalized signed CREATE transactions, exact runtime including every immutable, complete pristine constructor history, roles/admin delay/signer/domain and still-paused state at canonical block-hash pins. It rejects stale, changed or conflicting observations. It neither admits a public runtime nor authorizes activation; it is not a custody/independence proof or a general audit of an already running collection.

**83 verifier tests** pass with **100% line, 97.87% branch and 100% function coverage**. Actual EVM deployment-byte verification passes on disposable Anvil using chain ID 11155111; the public observer correctly rejects its non-Sepolia genesis. No actual Sepolia deployment has been observed. Latest full application regression is **5,329 passed, seven skips in 169 files**, with unchanged 96.25/92.02/98.35 coverage. The 170 contract tests, 119 release-tool tests, build/typecheck and locks still pass. CI adds dedicated verifier coverage and this local deployment rehearsal; hosted CI has not been observed.

## Next integration order

September 22 read-budget increment: [shared read ceilings and full-metadata campaign](generative-read-limits.md) pass **176/176** cases across all MBTIs, plus 96 direct-renderer comparisons. Highest sampled read estimate is 20,961,821 gas-equivalent, maximum ABI result 14,080 bytes; eleven under-gassed calls reject. The actual reader now uses canonical bounded ABI/data-URI decoding and explicit smaller scalar-call gas limits. Startup binding checks were moved before projection initialization and repeated before listening. These changes do not enable public startup or constitute exhaustive/public-provider read-limit evidence.

1. The [internal numerical/security worksheet](generative-numerical-security-review.md), [runtime-admission policy](generative-runtime-admission-policy.md), [offline operating-plan validator](generative-operating-plan.md), [separate active-state observer](generative-active-state-verification.md) and [admission composition](generative-admission-composition.md) are available. The complete local RC1 worker/issuer/browser integration passes disposable PostgreSQL/Anvil and nine-view browser verification, using signed fixture reviews and mocked paid HTTP. [Operator-pinned review-file startup/recheck](generative-local-review-startup.md) also passes the actual local mint flow. Next is the public database certification boundary, before a separate resource-limited Sepolia entrypoint. Independent numerical/security review, operational custody/review evidence and actual provider acceptance remain pending. Paused/active observations and validated plans have no startup/signing/unpause authority; no plan or report substitutes for custody, read-limit or security approval.
2. Resolve hosting/database/RPC accounts and budget, secret/key custody and operational owners, support/finality policy, extension/device QA and remaining content decisions. Obtain separately scoped approval for provisioning/funding/Sepolia deployment. Deploy paused; verify observations before a distinct activation decision.

No return to finished-SVG storage/compression or remote canonical artwork publication is planned.
