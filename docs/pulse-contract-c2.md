# C2 — pinned Pulse dependency and wallet-slot artifacts

September 25, 2026. This is a development checkpoint, not a contract
implementation, deployment or public allowlist. The current RC1 mint path is
unchanged.

## Dependency lock

[`contracts/vendor/pulse-core-v1.0.0/consumer-lock.json`](../contracts/vendor/pulse-core-v1.0.0/consumer-lock.json)
pins `pulse-core-v1.0.0` to commit
`a08ec26e396b9d3e20ccebd8871f176368bcd713`. The bundled upstream
manifest, Solidity source/interface, ABI, standard compiler input, creation
and runtime bytecode, vectors, Sepolia record and MIT license are checked by
`npm run pulse:verify`. The release uses solc 0.8.24, Shanghai, optimizer 200;
the consumer's local compile uses its separate solc 0.8.30/Prague settings.
The pinned runtime hash is
`0xfb48657163202d3cdb28060f1eb511fd1f5b93a6e0eb8657242b5632e2200a90`.
This check verifies repository files, not live Sepolia code. C3 must enforce
the actual bound chain/address/runtime hash when constructed.

## Candidate identity

`src/openMint/pulseCandidate.ts` declares a distinct identity for the
`SignaturesPulseMintV1RC1` candidate and locks its typed-authorization hash.
It does **not** register the profile in the live `GENERATIVE_PROFILES` map or
switch any mint path. The C1 Solidity interface is materialized at
`contracts/src/release/ISignaturesPulseMintV1RC1.sol`; no implementation is
present yet.

`contracts/fixtures/pulse-local-deployment.example.json` supplies explicit
Anvil-only test values and a root derived from the adjacent example wallet
list. The renderer and core addresses remain `null` until both are deployed
locally, the core from that exact released creation bytecode. The small Pulse numbers are upstream golden
vector values, **not chosen real-sale economics**. Do not use this fixture to
operate a live sale or infer approval of the roles, deadline or treasury.

## Wallet slots

The importer accepts one wallet per line, with optional `wallet` header.
Every line creates a distinct slot in input order; repeated addresses are
preserved. It normalizes to EIP-55 casing, rejects zero/malformed addresses,
and assigns contiguous slot IDs `0..N-1`. It builds an OpenZeppelin Standard
Merkle Tree with `['uint256','address']` double-hashed leaves and sorted-pair
proofs. `@openzeppelin/merkle-tree` is pinned exactly to `1.0.8` in the npm
lockfile. The on-chain collection will store one root, not 1,000+ addresses.
Proof length grows logarithmically with N; duplicate-wallet rights cost
additional leaves but no extra storage slot each at deployment.

From the repository root:

```sh
npm run pulse:allowlist -- build contracts/fixtures/pulse-wallets.example.txt /tmp/sg-pulse-example
npm run pulse:allowlist -- verify /tmp/sg-pulse-example
```

Choose a **new** output directory: the command refuses to overwrite an
existing bundle. The four outputs are `manifest.json`, `slots.json`,
`tree.json` and `proofs.json`. The manifest records N, root, raw input SHA-256
and per-artifact SHA-256. Its content is not self-hashed. Verification
reconstructs the entire tree from numbered slots, checks every proof with the
same sorted-pair hashing used by Solidity, and checks file digests. The
OpenZeppelin Solidity `MerkleProof.verify` test confirms generated example
proofs for all three slots, including two slots belonging to one wallet.

Before any real allowlist is frozen, review the ordered source file and
published slot list together. Duplicate entries are entitlements, not
deduplication mistakes. The source and generated proofs include wallet
addresses and are public artifacts; do not treat them as private data.

## Verification and next checkpoint

`npm run test:pulse:c2` covers the pinned release, 1,025-slot deterministic
generation, malformed/zero addresses, duplicate/out-of-range slot IDs,
tamper detection, CLI overwrite refusal, candidate identity isolation and
Solidity-compatible proofs. `npm run typecheck` and the full Foundry build
also compile this scaffold.

Next is **C3 (GPT-6 Astra · XHigh)**: implement the actual free-slot and
paid Pulse mint contract against this interface and pinned core. C3 does not
authorize mainnet/testnet deployment or selection of real wallet/economic
inputs; those still need explicit later decisions.
