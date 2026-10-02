import assert from 'node:assert/strict';

export const readUnavailable = error => error?.retryableRead === true || error?.code === 'RPC_DATA_UNAVAILABLE'
  || error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.rpcErrorCode === -32601;

export const integrityFailure = error => ['MINT_EVIDENCE_CONFLICT', 'OWNERSHIP_EVIDENCE_CONFLICT'].includes(error?.code);
export function readFailureDiagnostic(error) {
  const kind = integrityFailure(error) ? 'integrity' : readUnavailable(error) ? 'transient' : 'service';
  const codes = ['MINT_EVIDENCE_CONFLICT', 'OWNERSHIP_EVIDENCE_CONFLICT', 'RPC_DATA_UNAVAILABLE', 'ERR_ASSERTION',
    'OBSERVATION_UNAVAILABLE', 'ENOENT', 'EACCES', 'ECONNREFUSED', 'ECONNRESET'];
  const names = ['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError'];
  const methods = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount',
    'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_call', 'eth_estimateGas'];
  const operators = ['strictEqual', 'deepStrictEqual', 'notStrictEqual', 'match', 'ok', '==', '==='];
  const checks = ['NETWORK_CHAIN', 'NETWORK_GENESIS', 'CORE_CODE', 'COLLECTION_CODE', 'RENDERER_CODE', 'AUTHORIZER', 'MINT_INPUT', 'FINALIZED_ANCHOR'];
  return { kind, code: codes.includes(error?.code) ? error.code : kind === 'transient' ? 'RPC_DATA_UNAVAILABLE' : 'READ_SERVICE_BLOCKED',
    name: names.includes(error?.name) ? error.name : 'Error',
    source: ['primary', 'secondary'].includes(error?.readSource) ? error.readSource : undefined,
    method: methods.includes(error?.readMethod) ? error.readMethod : undefined,
    httpStatus: Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : undefined,
    rpcCode: Number.isSafeInteger(error?.rpcErrorCode) ? error.rpcErrorCode : undefined,
    operator: operators.includes(error?.operator) ? error.operator : undefined,
    integrityCheck: checks.includes(error?.integrityCheck) ? error.integrityCheck : undefined };
}

/** Read-only, single-flight recovery. Deadlines cancel reads, not transactions.
 * An uncooperative pass never overlaps its successor; late results cannot commit.
 * Explicit integrity conflicts halt. Unknown/service failures block this lane
 * for operator review, without invalidating unrelated finalized evidence. */
export function createReadRecovery(work, { intervalMs = 15000, maxBackoffMs = 60000, timeoutMs = 120000,
  onError = () => {}, onSuccess = () => {}, once = false, autoSchedule = true } = {}) {
  for (const value of [intervalMs, maxBackoffMs, timeoutMs]) assert.ok(Number.isSafeInteger(value) && value > 0);
  assert.ok(maxBackoffMs >= intervalMs);
  let timer, active, pending, stopped = false, started = false, failures = 0, nextAllowedAt = 0, firstFailedAt;
  let state = { phase: 'idle', failures: 0 };
  function schedule(delay) { if (!stopped && !['safety-halted', 'blocked'].includes(state.phase)) timer = setTimeout(() => void refresh(), delay); }
  async function refresh() {
    if (stopped || state.phase === 'safety-halted') return;
    if (pending) return pending;
    clearTimeout(timer);
    const controller = new AbortController(); active = controller;
    const startedAt = Date.now(); state = { phase: 'checking', failures, startedAt };
    const deadline = setTimeout(() => {
      const error = new DOMException('Read deadline exceeded.', 'TimeoutError');
      firstFailedAt ??= Date.now();
      controller.abort(error); state = { phase: 'unavailable', failures: failures + 1, startedAt };
      onError(error);
    }, timeoutMs);
    pending = Promise.resolve().then(() => work(controller.signal)).then(value => {
      controller.signal.throwIfAborted();
      if (stopped) return;
      onSuccess(value); failures = 0; firstFailedAt = undefined;
      state = { phase: 'ready', failures: 0, checkedAt: Date.now(), elapsedMs: Date.now() - startedAt };
    }).catch(error => {
      if (stopped) return;
      firstFailedAt ??= Date.now();
      failures = Math.min(failures + 1, 10); onError(error);
      state = { phase: integrityFailure(error) ? 'safety-halted' : readUnavailable(error) ? 'unavailable' : 'blocked', failures,
        elapsedMs: Date.now() - startedAt, ...readFailureDiagnostic(error) };
    }).finally(() => {
      clearTimeout(deadline); active = undefined; pending = undefined;
      const delay = Math.min(maxBackoffMs, intervalMs * 2 ** failures);
      nextAllowedAt = Date.now() + delay;
      if (autoSchedule && !(once && state.phase === 'ready')) schedule(delay);
    });
    return pending;
  }
  return Object.freeze({
    snapshot: () => Object.freeze({ ...state, firstFailedAt }), refresh,
    // Visitor demand must respect the same cooldown as scheduled recovery.
    // Explicit operator/test refresh remains available without this gate.
    wake: () => pending ?? (state.phase !== 'blocked' && Date.now() >= nextAllowedAt ? refresh() : undefined),
    start() { assert.equal(started, false); assert.equal(stopped, false); started = true; void refresh(); },
    async close() { stopped = true; clearTimeout(timer); active?.abort(); await pending; state = { phase: 'stopped', failures }; },
  });
}

export function capabilityHealth({ binding, snapshot, history, sale, saleError, observerError, bootstrapError,
  relayError, galleryFailureSince, conflict, now = Date.now() }) {
  const galleryFailure = !!(observerError || bootstrapError || relayError);
  const saleRetrying = !!saleError && readUnavailable(saleError) && !integrityFailure(saleError);
  // This is advisory page readiness, not permission to submit. A transient
  // background refresh failure does not invalidate a recently verified sale;
  // its original 90-second expiry still applies. Prepare/begin read mutable
  // mint state independently before granting submission authority.
  const saleFresh = !!binding && !!sale && !bootstrapError && (!saleError || saleRetrying)
    && now >= sale.at && now - sale.at <= 90000;
  const mintReady = saleFresh && !sale.sale?.paused && !conflict;
  const observerHealthy = !!snapshot && !galleryFailure && !conflict && now >= snapshot.at && now - snapshot.at <= 90000;
  // A verified empty projection is available too. Age is not an RPC failure,
  // and cached presentation never grants fresh mint admission.
  const galleryAvailable = !!(snapshot?.mints || history?.mints);
  // Gallery failures remain operator diagnostics, not visitor warnings. Relay
  // presentation never grants fresh mint admission, regardless of its age.
  const galleryState = conflict ? 'halted' : galleryFailure ? 'unavailable'
    : observerHealthy ? 'current' : galleryAvailable ? 'cached' : 'checking';
  const mintState = conflict ? 'halted' : saleFresh && sale.sale?.paused ? 'paused'
    : mintReady ? 'ready' : saleError || bootstrapError ? 'unavailable' : 'checking';
  const saleReadState = conflict ? 'halted' : bootstrapError || (saleError && !saleRetrying) ? 'unavailable'
    : saleFresh ? saleRetrying ? 'retrying' : 'current' : saleError ? 'unavailable' : 'checking';
  return { live: true, galleryAvailable, mintReady, observerHealthy, galleryState, mintState,
    galleryFailureSince: galleryFailure ? galleryFailureSince : undefined,
    safetyHalted: !!conflict, lastObservedAt: snapshot?.at ?? history?.at,
    lastSaleCheckedAt: sale?.at, saleReadState };
}

// Retain the viewing-policy boundary for callers using the gallery helper.
// Even a prolonged outage or safety halt is not a passive-viewing banner.
export function galleryAvailabilityNotice(_health) {
  return undefined;
}

export function mintAvailabilityNotice(health) {
  if (health.safetyHalted) return 'Previously verified mints need to be checked before minting can continue.';
  if (health.mintState === 'unavailable') return 'Mint availability cannot be checked right now. Please try again shortly.';
  return undefined;
}
