# Finished-SVG storage experiment — superseded

**Not the selected architecture.** The user explicitly rejected storing or compressing finished SVGs. This document records the earlier local experiment only; it is neither a fallback nor a deployment plan. Follow [Generative on-chain artwork](generative-onchain-artwork.md). The raw-SVG contract, journal and rehearsal are unactivated experimental/historical code; do not integrate or deploy them for the new collection. Numbers below measure that abandoned storage design, not generative minting.

Decision: September 21, 2026. The user requires fully on-chain artwork. This supersedes both the proposed IPFS default and the subsequent HTTPS/R2 canonical-artwork proposal. Neither storage account, pinning service, website, database nor our backend may be necessary to recover/display a minted signature.

Ethereum Sepolia and `https://staging.signatures.gallery` remain the staging targets. This decision authorizes local design/refactoring, not paid provisioning, new provider calls, public deployment, funding or mainnet.

## Historical experimental representation (abandoned)

Store the **exact final SVG bytes**, not a renderer version identifier or a hash alone. `OnchainSignatures` stores those bytes in a separate immutable, STOP-prefixed data contract created atomically during mint. `svg(tokenId)` reads them using `EXTCODECOPY`. `tokenURI(tokenId)` builds a self-contained base64 JSON data URI whose `image` is a base64 SVG data URI. Collection metadata is also a fixed data URI. No external canonical URL is present.

The SVG is the canonical artwork; PNG is an optional derived cache. The locked renderer is unchanged: signatures use `sg-renderer-2.0.0`; the slogan-only 2.0.1 patch is not a token renderer upgrade. Existing SVG system-font text retains its existing viewer-dependent font behavior; there is no network-loaded font. Byte identity, not cross-platform font rasterization, is the compatibility promise.

The contract validates the case-preserved handle against the canonical lowercase handle, validates all 16 MBTI spellings, and binds the exact SVG SHA-256, MBTI, renderer/metadata versions, assessment digest and generated tokenURI hash in `signatures.gallery/onchain-artifact/v1`. One handle remains one token per collection, independent of MBTI and wallet. The EIP-712 domain is **`SignaturesOnchainMint` / `1`**, distinct from the historical external-URI `SignaturesOpenMint` contract. An external-URI mint entry point does not exist in the new contract.

The authorizer still attests that the SVG came from the locked renderer and that the assessment was obtained through the controlled backend. Solidity does not execute Grok, independently prove an X research result, or parse arbitrary SVG for remote references. The backend accepts only its durable verified assessment and exact renderer bytes before signing; a low-level encoding helper is not an assessment authority. Fully on-chain **artwork storage and retrieval** does not mean on-chain AI inference. A compromised authorizer remains an assessment/artwork integrity risk and requires the existing pause/key-custody controls.

There is no proxy, artwork updater, renderer replacement, burn, admin mint or fee method. The data contract begins with STOP and exposes no mutable storage or selfdestruct path. Pausing issuance, rotating the authorizer, transferring ownership or losing the application does not change the stored SVG or tokenURI.

## Options evaluated

| Option | Result |
| --- | --- |
| Final SVG in ordinary storage slots | Exact output and simple recovery, but measured raw-storage gas is substantially higher. Comparison harness only, not selected. |
| Final SVG in immutable contract code | Abandoned; retained only as experimental evidence. |
| Compressed SVG plus on-chain decompressor | Abandoned, not a fallback or next optimization. |
| Complete immutable Solidity renderer plus handle/MBTI | **Selected direction.** See the superseding generative architecture for fidelity and feasibility gates. |
| JavaScript/Python source or renderer hash on-chain | Insufficient by itself: `tokenURI()` could not execute it without a complete on-chain execution/rendering implementation. |
| IPFS or HTTPS metadata/image URIs | Does not satisfy the selected requirement; no longer a deployment prerequisite. Optional mirrors only. |

## Measured local evidence

Reproducible command (new disposable Anvil, public test keys, no provider/environment secrets):

```sh
npm run test:contract
npm run onchain:rehearsal -- --execute-local-test-transactions
```

Solc 0.8.30, optimizer 200, Prague EVM. Values below are actual transaction receipt gas, not a dollar quote or a public-network bill. ECDSA/calldata variation can move a few gas units. The storage-only columns exclude mint authorization/metadata/ERC-721 work; compare them to each other, not as total mint estimates.

| Handle / MBTI | SVG bytes | Complete mint gas | Raw code storage gas | Raw slot storage gas |
| --- | ---: | ---: | ---: | ---: |
| `x` / ENFP | 496 | 652,823 | 162,977 | 407,412 |
| `karpathy` / INTJ | 6,242 | ~2,836,700 | 1,410,938 | 4,492,716 |
| `Alice_Bob_Key` / INFP | 1,414 | 1,001,042 | 362,285 | 1,065,517 |
| `ABCDEFGHIJKLMNO` / ENTP | 6,633 | 2,998,126 | 1,495,880 | 4,765,164 |
| `abcdefghijklmno` / ISFJ | 1,589 | 1,085,806 | 400,199 | 1,179,182 |
| `_______________` / ISTJ | 6,638 | 3,000,387 | 1,496,940 | 4,765,224 |

Collection deployment: 4,375,683 gas; runtime: 18,838 bytes. Data per token is capped at 16,384 SVG bytes plus one STOP byte, below [EIP-170's 24,576-byte runtime limit](https://eips.ethereum.org/EIPS/eip-170). [EIP-3860](https://eips.ethereum.org/EIPS/eip-3860) also bounds/meters initialization code; the implementation and local rehearsal stay within these limits. A 1,200-case survey (all MBTIs, lengths 1–15, uppercase/lowercase/mixed/digits/underscores) observed a largest SVG of 7,413 bytes. This is representative coverage, not an exhaustive proof over every handle. Oversized inputs fail closed before authority preparation and on-chain mint.

The local rehearsal decodes `tokenURI`, recovers exact SVG bytes with no website/database, verifies TypeScript/Solidity serializer parity and case-sensitive names, and exercises the independent-read adapter against real Anvil state. Two labelled local adapters share that test node: they do **not** prove real operator independence. No real X/Grok calls or public transactions occur.

## Hosting and RPC redesign

| Component | Responsibility / proposed staging arrangement |
| --- | --- |
| Website + controlled backend | One persistent process on a small VM/container host at the approved staging origin. Preview rendering, wallet sessions, X/Grok admission, durable authorization, gallery pages. No need for Kubernetes or a queue broker. |
| PostgreSQL | Durable private work, budget/dispatch fences, sessions, accepted assessments, frozen pre-mint SVG, signed reservations and operational audit. It is necessary for safe **new issuance**, not for recovering already minted artwork. Keep independent backups and rehearse restoration. |
| Chain observer/indexer | Existing bounded canonical inclusion/finality logic, extended to the new domain and ABI. Confirming after verified inclusion; finalized-only minted galleries. Rebuild public mint/MBTI/ownership projections from events and on-chain artwork without the private assessment/publication database. |
| RPC A + RPC B | Separate operators, pinned chain/genesis/deployment/code/domain, EIP-1898 block-hash reads, agreeing logs/receipts, finalized tag, adequate historical state and `eth_call` return-size/gas limits. A different URL to the same operator is not independence. Providers remain to be selected; no provisioning is implied. |
| Optional thumbnail cache/CDN | Cache derived PNGs and exact SVG responses by deployment/token/artifact digest. Can be deleted and rebuilt from chain. A cache failure must not prevent canonical `tokenURI`/SVG recovery. R2/IPFS are optional here, not mandatory. |
| Signer and administration | Preserve distinct authorized principals, a restricted online assessment signer and separate administrative custody. Never put signing keys in the website bundle or RPC URL. |

Read-only public artwork recovery does not require our provider API keys. An Ethereum node or another usable RPC can call the immutable contract. Independent RPCs improve availability/consistency but are still trusted RPC responses, not an implemented cryptographic light client. Long-term accessibility relies on the chain and ordinary node access, rather than our domain retention.

## Historical integration proposal — cancelled, do not execute

1. **Implemented locally:** new immutable SVG contract/profile, backend preparation and authorization encoding, contract and serializer regressions, isolated Anvil gas/recovery rehearsal, chain-only reader, profile-aware eligibility/observer/decoder, separate local-only deployment script and offline manifest schema/validator. Historical external-URI modules remain for old contracts and evidence, not as the selected public architecture.
2. **Next:** add a fresh durable on-chain artifact/authorization profile. Replace pre-sign upload/retrieval prerequisites with persisted exact SVG/metadata verification and contract simulation. Preserve session/consent, lease/budget fences, first-assessment reuse and unknown-submission recovery. Do not fake “uploaded” publication rows for chain bytes.
3. **Then:** compose that profile into admitted runtime and browser transactions. Use a fresh namespace, deployment and isolated local chain; do not reset the user's current wallet/chain or relabel historical tokens. Gallery canonical SVG reads must use the chain reader; derived PNG/detail provenance caches are optional.
4. **Before staging:** pin a reviewed build/manifest, choose host/RPC/key custody, run restore/reorg/provider-loss/wallet QA, present actual gas and obtain deployment/funding/provisioning approvals. No public startup or broadcast gate is removed by these tests.

Historical deployed immutable contracts and tokens cannot be rewritten. They remain external-URI works under their original addresses. The new on-chain collection gets a new contract address/domain/manifest and separate cache/index namespace. This is a new deployment, not an in-place upgrade or a claim that old tokens became fully on-chain.
