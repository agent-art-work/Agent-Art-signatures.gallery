import assert from 'node:assert/strict';
import { integrityFailure, readUnavailable, readFailureDiagnostic } from './pulse-sepolia-recovery.mjs';

const same = (a, b) => !!a && !!b && a.number === b.number && a.hash === b.hash;
const validHead = value => value && /^0x[0-9a-f]+$/.test(value.number)
  && /^0x[0-9a-f]{64}$/.test(value.hash);

/** Request-driven, single-flight chain observation. Public requests only wake
 * this scheduler; they never wait for an RPC or supply chain evidence. A recent
 * head/finality check is a lease to skip reads, not mint authority. */
export function createSepoliaRelayScheduler({ probe, synchronize, now = Date.now, leaseMs = 5000,
  maxBackoffMs = 60000, onUnchanged = () => {}, onError = () => {} }) {
  assert.equal(typeof probe, 'function'); assert.equal(typeof synchronize, 'function');
  assert.equal(typeof now, 'function'); assert.equal(typeof onUnchanged, 'function'); assert.equal(typeof onError, 'function');
  assert.ok(Number.isSafeInteger(leaseMs) && leaseMs >= 1 && leaseMs <= 60000);
  assert.ok(Number.isSafeInteger(maxBackoffMs) && maxBackoffMs >= leaseMs && maxBackoffMs <= 300000);
  let observed, checkedAt = 0, nextAllowedAt = 0, pending, failures = 0, stopped = false;
  let phase = 'idle', lastError, failedAt, firstFailedAt, diagnostic;
  function seed(value) {
    assert.ok(validHead(value?.head) && validHead(value?.finalized));
    observed = { head: { number: value.head.number, hash: value.head.hash },
      finalized: { number: value.finalized.number, hash: value.finalized.hash } };
    if (lastError === 'RPC_DATA_UNAVAILABLE' && value.at >= failedAt) {
      lastError = undefined; failedAt = undefined; firstFailedAt = undefined; diagnostic = undefined;
    }
  }
  async function wake({ force = false } = {}) {
    if (stopped) return 'stopped';
    if (phase === 'safety-halted') return 'safety-halted';
    if (phase === 'blocked' && !force) return 'blocked';
    if (pending) return pending;
    const at = now();
    if (!force && at < nextAllowedAt) return failures === 0 && checkedAt > 0 && at - checkedAt < leaseMs ? 'leased' : 'cooldown';
    if (!force && checkedAt > 0 && at - checkedAt < leaseMs) return 'leased';
    phase = 'checking';
    pending = Promise.resolve().then(probe).then(async value => {
      assert.ok(validHead(value?.head) && validHead(value?.finalized));
      if (stopped) return 'stopped';
      checkedAt = now();
      if (same(observed?.head, value.head) && same(observed?.finalized, value.finalized)) {
        await onUnchanged(value);
        failures = 0; phase = 'ready'; lastError = undefined; failedAt = undefined; firstFailedAt = undefined; diagnostic = undefined; nextAllowedAt = now() + leaseMs; return 'unchanged';
      }
      phase = 'synchronizing';
      const result = await synchronize(value);
      if (stopped) return 'stopped';
      // The synchronizer must return its actual verified checkpoint. It may
      // have observed a newer head than the cheap probe did.
      seed(result);
      failures = 0; phase = 'ready'; lastError = undefined; failedAt = undefined; firstFailedAt = undefined; diagnostic = undefined; nextAllowedAt = now() + leaseMs;
      return 'updated';
    }).catch(error => {
      if (stopped) return 'stopped';
      diagnostic = readFailureDiagnostic(error); lastError = diagnostic.code;
      failedAt = now();
      firstFailedAt ??= failedAt;
      onError(error);
      if (integrityFailure(error)) { phase = 'safety-halted'; return 'safety-halted'; }
      if (!readUnavailable(error)) { phase = 'blocked'; return 'blocked'; }
      failures = Math.min(failures + 1, 10);
      nextAllowedAt = now() + Math.min(maxBackoffMs, leaseMs * 2 ** failures);
      phase = 'unavailable'; return 'unavailable';
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return Object.freeze({ seed, wake, stop() { stopped = true; phase = 'stopped'; },
    state: () => Object.freeze({ phase, checkedAt, nextAllowedAt, failures, lastError, failedAt, firstFailedAt, diagnostic,
      head: observed?.head && { ...observed.head }, finalized: observed?.finalized && { ...observed.finalized } }) });
}
