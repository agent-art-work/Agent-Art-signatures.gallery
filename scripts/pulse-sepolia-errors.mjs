import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { PublicError } from '../src/openMint/security.ts';
import { sharedReadBlock } from './pulse-sepolia.mjs';
import { readSources, withSepoliaReadSource, requireRpcData } from './pulse-sepolia-rpc.mjs';

export function requireForUser(condition, code, message) {
  if (!condition) throw new PublicError(409, code, message);
}

export function requireFreshMintSnapshot(snapshot, refreshError, now = Date.now()) {
  requireForUser(snapshot && !refreshError && now - snapshot.at <= 90000, 'OBSERVATION_UNAVAILABLE',
    'Mint availability cannot be checked right now. Please try again shortly.');
  return snapshot;
}

/** RC1 deliberately excludes ALL code-bearing callers, including delegated
 * EOAs. Do not relax the backend without a separately reviewed contract. */
export function requireSupportedWalletCode(code) {
  assert.match(code, /^0x(?:[a-f0-9]{2})*$/i, 'Malformed wallet code response');
  if (code === '0x') return;
  if (/^0xef0100[a-f0-9]{40}$/i.test(code)) {
    throw new PublicError(409, 'DELEGATED_WALLET_UNSUPPORTED',
      'This wallet has smart-account delegation enabled on Sepolia. This collection does not support delegated wallets. Choose an account without delegation in your wallet, then reconnect.');
  }
  throw new PublicError(409, 'CONTRACT_WALLET_UNSUPPORTED',
    'This collection does not support contract wallets. Choose an account without on-chain code in your wallet, then reconnect.');
}

export async function checkWalletSupport(c, wallet, head) {
  let address;
  try { address = getAddress(wallet); } catch { throw new PublicError(400, 'INVALID_WALLET', 'Enter a valid wallet address.'); }
  requireForUser(!/^0x0{40}$/i.test(address), 'INVALID_WALLET', 'Enter a valid wallet address.');
  return withSepoliaReadSource(c, source => checkWalletSupportAtSource(source, address, head));
}
async function checkWalletSupportAtSource(c, address, head) {
  const anchor = head ?? await sharedReadBlock(c);
  const codes = await Promise.all(readSources(c).map(async rpc => {
    const code = await rpc('eth_getCode', [address, anchor.number]);
    assert.equal(requireRpcData(await rpc('eth_getBlockByNumber', [anchor.number, false])).hash, anchor.hash);
    return code;
  }));
  for (const code of codes) assert.equal(code, codes[0], 'Wallet code observations disagree');
  requireSupportedWalletCode(codes[0]);
  return address;
}

/** AssertionError.message can contain actual/expected values even when a
 * custom message was supplied. Only explicitly public errors cross HTTP. */
export function publicFailure(error) {
  if (error instanceof PublicError) return { status: error.status, code: error.code, error: error.message };
  return { status: 409, code: 'REQUEST_UNAVAILABLE',
    error: 'The request could not be completed. Your saved request is unchanged. Please try again shortly.' };
}
