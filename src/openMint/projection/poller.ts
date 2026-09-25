import type { createProjectionCoordinator } from "./coordinator.js";
import { performance } from "node:perf_hooks";

type Coordinator = Pick<ReturnType<typeof createProjectionCoordinator>, "sync" | "withdraw">;
type Outcome = Awaited<ReturnType<Coordinator["sync"]>>;
export interface ProjectionPollerConfig {
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
  readonly passTimeoutMs: number;
  /** Owner already completed startup observation; defer the first scheduled
   * refresh without manufacturing a successful observation in this poller. */
  readonly initialDelayMs?: number;
}
export interface ProjectionPollerState {
  readonly state: "idle" | "running" | "waiting" | "backing-off" | "safety-halted" | "failed" | "stopped";
  readonly failures: number;
  readonly lastOutcome?: Outcome | "deadline" | "error";
  readonly nextDelayMs?: number;
}
/** Explicitly started, single-use, read-only chain scheduler. Never assessments,
 * signing, publication or transactions. One bounded sync per tick; no overlaps
 * or catch-up bursts. Public routes cannot start or accelerate it. A hung pass
 * halts instead of starting another potentially overlapping writer operation.
 */
export function createProjectionPoller(coordinator: Coordinator, input: ProjectionPollerConfig) {
  const { intervalMs, maxBackoffMs, passTimeoutMs, initialDelayMs = 0 } = input;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000
    || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs || maxBackoffMs > 300_000
    || !Number.isSafeInteger(passTimeoutMs) || passTimeoutMs < 1 || passTimeoutMs > 60_000
    || !Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > intervalMs) throw new Error("Invalid projection polling policy.");
  const sync = coordinator.sync.bind(coordinator), withdraw = coordinator.withdraw.bind(coordinator);
  let state: ProjectionPollerState = { state: "idle", failures: 0 }, started = false, ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined, parent: AbortSignal | undefined;
  let pending: Promise<void> = Promise.resolve();
  function finish(next: ProjectionPollerState) {
    if (ended) return;
    ended = true; state = next; clearTimeout(timer); clearTimeout(deadline);
    parent?.removeEventListener("abort", stop); active?.abort(); withdraw();
  }
  function stop() { finish({ state: "stopped", failures: state.failures, ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}) }); }
  function tick() {
    if (ended) return;
    const controller = new AbortController(), expires = performance.now() + passTimeoutMs; active = controller;
    state = { state: "running", failures: state.failures, ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}) };
    deadline = setTimeout(() => finish({ state: "failed", failures: state.failures + 1, lastOutcome: "deadline" }), passTimeoutMs);
    // Attach both continuations even if stop/deadline happens first; a late
    // completion cannot become authority and a late rejection is consumed.
    pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) return "unavailable" as const;
      return sync(controller.signal);
    }).then(outcome => {
      if (ended) return;
      if (performance.now() >= expires) return finish({ state: "failed", failures: state.failures + 1, lastOutcome: "deadline" });
      clearTimeout(deadline); active = undefined;
      if (outcome === "safety-halted") return finish({ state: "safety-halted", failures: state.failures, lastOutcome: outcome });
      if (outcome === "busy" || outcome === "writer-unavailable") return finish({ state: "failed", failures: state.failures + 1, lastOutcome: outcome });
      const failures = outcome === "observed" ? 0 : Math.min(state.failures + 1, 30);
      const delay = Math.min(maxBackoffMs, intervalMs * 2 ** failures);
      state = { state: failures ? "backing-off" : "waiting", failures, lastOutcome: outcome, nextDelayMs: delay };
      timer = setTimeout(tick, delay);
    }, () => { if (!ended) finish({ state: "failed", failures: state.failures + 1, lastOutcome: "error" }); });
  }
  return Object.freeze({
    snapshot: (): ProjectionPollerState => Object.freeze({ ...state }),
    start(signal: AbortSignal): void {
      if (started || ended) throw new Error("Projection poller is single-use.");
      started = true; parent = signal; signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      else if (initialDelayMs) {
        state = { state: "waiting", failures: 0, nextDelayMs: initialDelayMs };
        timer = setTimeout(tick, initialDelayMs);
      } else tick();
    },
    stop,
    /** Stop immediately, then wait for the already-started pass to settle.
     * The enclosing lifecycle must bound this wait; cancellation is not proof
     * that an uncooperative transport/database operation has completed. */
    async drain(): Promise<void> { stop(); await pending; },
  });
}
