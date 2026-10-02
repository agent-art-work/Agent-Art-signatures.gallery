# Pinned Pulse Core v1.0.0 dependency

The release files, sources and license here are copied verbatim from
[`inshell-art/pulse` tag `pulse-core-v1.0.0`](https://github.com/inshell-art/pulse/releases/tag/pulse-core-v1.0.0),
commit `a08ec26e396b9d3e20ccebd8871f176368bcd713`.
`manifest.json` is the upstream reviewed build manifest. This README and
`consumer-lock.json` are consumer-authored. The manifest's old `provenance` sentence was
written before the tag existed; do not interpret it as the current tag status.

The release bundle includes the interface, ABI, standard compiler input,
creation/runtime bytecode and golden vectors. `src/` contains the exact
source files named by the manifest. `sepolia.json` contains upstream's
published testnet binding; it is not a fresh live-chain verification.
`LICENSE` is the upstream MIT license. No application should import a
floating branch or recompile the core with this consumer's Solidity settings
and call it the released bytecode.

Run `npm run pulse:verify` at repository root to verify release/source SHA-256,
bytecode lengths and Keccak hashes, compiler settings, version, license and
the Sepolia binding. C3 will require a chain/address/runtime-code check at
consumer construction. There is no published mainnet core in this lock.
