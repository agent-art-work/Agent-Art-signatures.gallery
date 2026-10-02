/** Reviewed C5 identity. Live mint-path integration belongs to C6. */
export const PULSE_MINT_CANDIDATE = Object.freeze({
  contractName: 'SignaturesPulseMintV1RC1',
  contractVersion: 'sg-generative-pulse-mint-1.0.0-rc.1',
  contractProfile: 'generative-pulse-v1-rc1',
  inputProfile: 'sg-generative-pulse-inputs-v1-rc1',
  rendererVersion: 'sg-evm-renderer-1.0.0-rc.1',
  domainName: 'SignaturesPulseMintRC1',
  domainVersion: '1',
  reservationVersion: 'sg-generative-pulse-authorization-v1-rc1',
  walletPlanVersion: 'sg-pulse-wallet-plan-v1-rc1',
  allowlistFormat: 'sg-pulse-free-slots-v1',
  pulseReleaseTag: 'pulse-core-v1.0.0',
  pulseRuntimeCodeHash: '0xfb48657163202d3cdb28060f1eb511fd1f5b93a6e0eb8657242b5632e2200a90',
  authorizationType: 'PulseMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 inputDigest,address recipient,bytes32 nonce,uint64 issuedAt,uint64 deadline,uint8 mintMode,uint256 slotId,uint256 maxPrice)',
  authorizationTypeHash: '0x65be64491ba939c2eb80eaa1c34208acaa5fc27c5d6b40889da86cce405f7150',
} as const);

/** Exact EIP-712 member order, shared by signers and offline verification. */
export const PULSE_AUTHORIZATION_TYPES = Object.freeze({
  PulseMintAuthorization: Object.freeze([
    { name: 'handleKey', type: 'bytes32' },
    { name: 'assessmentDigest', type: 'bytes32' },
    { name: 'inputDigest', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
    { name: 'mintMode', type: 'uint8' },
    { name: 'slotId', type: 'uint256' },
    { name: 'maxPrice', type: 'uint256' },
  ].map(field => Object.freeze(field))),
});
