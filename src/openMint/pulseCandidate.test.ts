import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { GENERATIVE_PROFILES } from './generativeProfiles.js';
import { PULSE_MINT_CANDIDATE } from './pulseCandidate.js';

describe('Pulse candidate identity', () => {
  it('is distinct from historical RC1 and enters only its own explicit profile', () => {
    expect(PULSE_MINT_CANDIDATE.contractProfile).not.toBe(GENERATIVE_PROFILES['generative-v1-rc1'].contractProfile);
    expect(PULSE_MINT_CANDIDATE.inputProfile).not.toBe(GENERATIVE_PROFILES['generative-v1-rc1'].inputProfile);
    expect(PULSE_MINT_CANDIDATE.domainName).not.toBe(GENERATIVE_PROFILES['generative-v1-rc1'].domainName);
    expect(GENERATIVE_PROFILES['generative-pulse-v1-rc1'].inputProfile).toBe(PULSE_MINT_CANDIDATE.inputProfile);
  });

  it('locks the exact C1 authorization type hash', () => {
    expect(keccak256(toBytes(PULSE_MINT_CANDIDATE.authorizationType))).toBe(PULSE_MINT_CANDIDATE.authorizationTypeHash);
    expect(PULSE_MINT_CANDIDATE.authorizationTypeHash).toBe('0x65be64491ba939c2eb80eaa1c34208acaa5fc27c5d6b40889da86cce405f7150');
  });
});
