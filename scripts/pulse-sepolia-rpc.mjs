import assert from 'node:assert/strict';
import { SEPOLIA_READ_BUDGETS } from './pulse-sepolia-read-budgets.mjs';

export const SEPOLIA_READ_POLICY = 'validated-primary-fallback/v1';
const safeReads = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_call', 'eth_estimateGas']);
const controllers = new WeakMap();

/** Missing data is not contradictory evidence. Only read operations can retry
 * against the other configured endpoint; signatures/broadcasts never enter here. */
export function unavailableRpcData() {
  return Object.assign(new Error('Sepolia read data unavailable.'), { code: 'RPC_DATA_UNAVAILABLE', retryableRead: true });
}
export function requireRpcData(value) {
  if (value === null || value === undefined) throw unavailableRpcData();
  return value;
}
export function requireSepoliaIntegrity(condition, check) {
  if (!condition) throw Object.assign(new Error('Verified Sepolia integrity gate failed.'),
    { code: 'MINT_EVIDENCE_CONFLICT', integrityCheck: check });
}
export const readSources = c => c.second ? [c.rpc, c.second] : [c.rpc];
function readOptions(source, { signal, readPriority = source.readPriority ?? 'action' } = {}) {
  assert.ok(readPriority === 'action' || readPriority === 'background', 'Invalid read priority');
  signal?.throwIfAborted();
  const wrap = request => (method, params = [], options = {}) => request(method, params,
    { ...options, ...(signal ? { signal } : {}), readPriority });
  return Object.freeze({ ...source, readPriority, rpc: wrap(source.rpc), ...(source.second ? { second: wrap(source.second) } : {}) });
}
export const withSepoliaReadSource = (c, operation, options = {}) => controllers.has(c)
  ? controllers.get(c).run(operation, options) : operation(readOptions(c, options));

/** Pin one validated source for an entire semantic read (deployment, observer,
 * receipt, wallet or artwork). If it is unavailable, discard that whole attempt
 * and retry once at the other source. Never stitch partial evidence together.
 * Raw two-source contexts remain available for explicit audit/deployment tools. */
export function createSepoliaReadFailover(c, validate, options = {}) {
  const { now = Date.now, cooldownMs = 30000, validationTtlMs = 60000,
    attemptTimeoutMs = SEPOLIA_READ_BUDGETS.sourceMs,
    // Existing audit/tests that explicitly override one source budget retain
    // that override for both priorities unless they opt into separate limits.
    backgroundAttemptTimeoutMs = options.attemptTimeoutMs ?? SEPOLIA_READ_BUDGETS.backgroundSourceMs } = options;
  assert.equal(typeof c.rpc, 'function'); assert.equal(typeof c.second, 'function');
  assert.notEqual(c.rpc, c.second); assert.equal(typeof validate, 'function');
  assert.equal(typeof now, 'function');
  assert.ok(Number.isSafeInteger(cooldownMs) && cooldownMs > 0 && cooldownMs <= 60000);
  assert.ok(Number.isSafeInteger(validationTtlMs) && validationTtlMs > 0 && validationTtlMs <= 60000);
  assert.ok(Number.isSafeInteger(attemptTimeoutMs) && attemptTimeoutMs > 0 && attemptTimeoutMs <= 60000);
  assert.ok(Number.isSafeInteger(backgroundAttemptTimeoutMs) && backgroundAttemptTimeoutMs > 0 && backgroundAttemptTimeoutMs <= 60000);
  const states = [c.rpc, c.second].map((request, index) => {
    const label = index === 0 ? 'primary' : 'secondary';
    const source = Object.freeze({ readPolicy: SEPOLIA_READ_POLICY, readSource: label,
      rpc: async (method, params = [], options = {}) => {
        options.signal?.throwIfAborted();
        assert.ok(safeReads.has(method), 'Failover permits read-only RPC methods only');
        try {
          const value = await request(method, params, options);
          options.signal?.throwIfAborted();
          // Only transaction lookup methods have a legitimate nullable result.
          // Their caller decides whether that absence is pending or missing
          // known evidence. Null code/call/log/head data is never a valid read.
          return method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash'
            ? value : requireRpcData(value);
        }
        catch (error) {
          // Diagnostic labels only; never copy URLs, response bodies or secrets.
          if (error && typeof error === 'object') { error.readSource = label; error.readMethod = method; }
          throw error;
        }
      } });
    return { source, label, validatedUntil: 0, unavailableUntil: 0, validating: undefined };
  });
  let activeSource, failovers = 0, validationRevision = 0, conflict;
  async function validated(state, signal, readPriority) {
    while (state.validatedUntil <= now()) {
      signal?.throwIfAborted();
      // A timed-out validation can ignore cancellation and settle much later.
      // It must neither trap future readers behind that abandoned flight nor
      // clear a newer flight's lock when its own finally eventually runs.
      if (state.validating?.signal.aborted) state.validating = undefined;
      if (!state.validating) {
        const revision = validationRevision;
        const flight = { signal };
        const aborted = new Promise((_, reject) => { flight.onAbort = () => reject(signal.reason); });
        signal.addEventListener('abort', flight.onAbort, { once: true });
        const work = Promise.resolve().then(() => validate(readOptions(state.source, { signal, readPriority })))
          .then(() => { signal.throwIfAborted(); if (revision === validationRevision) state.validatedUntil = now() + validationTtlMs; });
        flight.promise = Promise.race([work, aborted]).finally(() => {
          signal.removeEventListener('abort', flight.onAbort);
          if (state.validating === flight) state.validating = undefined;
        });
        state.validating = flight;
      }
      const flight = state.validating;
      try { await flight.promise; }
      catch (error) {
        signal?.throwIfAborted();
        // Cancellation belongs to the flight's owner, not every waiting read.
        // A still-live waiter revalidates with its own remaining source budget.
        if (flight.signal.aborted && error === flight.signal.reason) continue;
        throw error;
      }
    }
  }
  async function run(operation, { signal, sourceTimeoutMs, readPriority = 'action' } = {}) {
    signal?.throwIfAborted();
    if (conflict) throw conflict;
    if (sourceTimeoutMs === undefined) sourceTimeoutMs = readPriority === 'background' ? backgroundAttemptTimeoutMs : attemptTimeoutMs;
    assert.ok(Number.isSafeInteger(sourceTimeoutMs) && sourceTimeoutMs > 0 && sourceTimeoutMs <= 60000);
    assert.ok(readPriority === 'action' || readPriority === 'background', 'Invalid read priority');
    // Prefer the primary again after its cooldown. Healthy fallback reads do
    // not repeatedly hit the same failing endpoint while it is cooling down.
    const ready = states.filter(s => s.unavailableUntil <= now());
    const order = [...ready, ...states.filter(s => !ready.includes(s))];
    let failure;
    for (let index = 0; index < order.length; index++) {
      const state = order[index];
      const attempt = new AbortController();
      const abortFromParent = () => attempt.abort(signal.reason);
      signal?.addEventListener('abort', abortFromParent, { once: true });
      const deadline = setTimeout(() => attempt.abort(unavailableRpcData()), sourceTimeoutMs);
      // An uncooperative read must not consume the entire parent budget. Only
      // read-only operations enter this controller; late results are discarded.
      let rejectAborted;
      const aborted = new Promise((_, reject) => { rejectAborted = () => reject(attempt.signal.reason); });
      attempt.signal.addEventListener('abort', rejectAborted, { once: true });
      try {
        const value = await Promise.race([Promise.resolve().then(async () => {
          await validated(state, attempt.signal, readPriority);
          attempt.signal.throwIfAborted();
          if (conflict) throw conflict;
          return operation(readOptions(state.source, { signal: attempt.signal, readPriority }));
        }), aborted]);
        attempt.signal.throwIfAborted();
        signal?.throwIfAborted();
        if (conflict) throw conflict;
        state.unavailableUntil = 0; activeSource = state.label;
        if (index > 0) failovers++;
        return value;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        // Assertions, incorrect chain/code/authority, finality conflicts and
        // EVM reverts are not an invitation to try a more agreeable endpoint.
        if (error?.code === 'MINT_EVIDENCE_CONFLICT') { conflict = error; throw error; }
        if (error?.code !== 'RPC_DATA_UNAVAILABLE' && error?.retryableRead !== true && error?.rpcErrorCode !== -32601) throw error;
        // A transaction receipt or complete mint log history not indexed yet
        // is semantic absence, not a failed endpoint or changed deployment.
        // Try the secondary without clearing immutable validation or source
        // health on every status/history poll. Contradictions still latch.
        if (error?.code !== 'RPC_DATA_UNAVAILABLE'
          || error.missingMintReceipt !== true && error.incompleteMintHistory !== true) {
          state.validatedUntil = 0; state.unavailableUntil = now() + cooldownMs;
        }
        failure = error;
      } finally {
        clearTimeout(deadline);
        attempt.signal.removeEventListener('abort', rejectAborted);
        signal?.removeEventListener('abort', abortFromParent);
      }
    }
    throw failure;
  }
  const context = Object.freeze({
    rpc: (method, params = [], options = {}) => {
      assert.ok(safeReads.has(method), 'Failover permits read-only RPC methods only');
      return run(async source => {
        const result = await source.rpc(method, params);
        return method === 'eth_getBlockByNumber' ? requireRpcData(result) : result;
      }, options);
    },
    resetValidation() { validationRevision++; for (const state of states) state.validatedUntil = 0; },
    readStatus() { return { policy: SEPOLIA_READ_POLICY, activeSource, failovers, evidenceConflict: !!conflict,
      unavailableSources: states.filter(s => s.unavailableUntil > now()).map(s => s.label) }; },
  });
  controllers.set(context, { run });
  return context;
}
