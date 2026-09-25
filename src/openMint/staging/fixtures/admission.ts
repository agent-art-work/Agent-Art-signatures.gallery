import { ADMISSION_OPERATIONS, admissionDigest, createAdmissionGate, type AdmissionIntent, type AdmissionPorts, type AdmissionScope } from "../admission.js";

/** Simulated trusted adapters only. No real review, DB, wallet, provider or key. */
export function admissionFixture() {
  let time = 1_800_000_000_000;
  const intent: AdmissionIntent = { operation: "sign", requestId: "ba911503-81c4-41c8-8209-e9589b94bdb0", payloadSha256: "a".repeat(64) };
  const scope: AdmissionScope = { operatingPlanSha256: "1".repeat(64), activePolicySha256: "2".repeat(64), databaseBindingSha256: "3".repeat(64),
    reviewRevisionSha256: "4".repeat(64), writerEpoch: "1", timeoutMs: 1000, permitTtlMs: 1000, paidValidFrom: time - 1000, paidValidUntil: time + 10000 };
  const events: string[] = [], signals: AbortSignal[] = [], fences = new Set<string>(), witnesses = new WeakMap<object, { observedAt: number; validUntil: number }>();
  const control = { review: true, healthy: true, generation: true, issuance: true, session: true, budget: true, binding: true, credentials: true };
  const assertCurrent = (operation: string) => {
    for (const k of ["healthy", "binding", ...(operation !== "read" ? ["session"] : []),
      ...(operation.startsWith("assessment-") ? ["generation", "budget", "credentials"] : operation === "sign" ? ["issuance", "credentials"] : [])]) {
      if (!control[k as keyof typeof control]) throw Error("SENSITIVE ADAPTER DIAGNOSTIC");
    }
  };
  const ports: AdmissionPorts<string> = {
    chain: { observe: async signal => { signals.push(signal); events.push("observe"); const w = Object.freeze({}); witnesses.set(w, { observedAt: time, validUntil: time + 1000 }); return w; },
      read(w, now) { const r = witnesses.get(w as object); if (!r || now < r.observedAt || now >= r.validUntil) throw Error("chain unavailable"); return r; } },
    requireReview: (_hash, op) => { events.push("review:" + op); if (!control.review) throw Error("SENSITIVE REVIEW"); },
    database: { inspect: async (i, _scope, signal) => {
      signals.push(signal); events.push("inspect:" + i.operation); assertCurrent(i.operation);
      return { databaseBindingSha256: scope.databaseBindingSha256, intentSha256: admissionDigest(i), writerEpoch: scope.writerEpoch,
        observedAt: time, validUntil: time + 1000, assertCurrent: () => assertCurrent(i.operation),
        fence: async s => { signals.push(s); assertCurrent(i.operation); const id = admissionDigest(i); if (fences.has(id)) throw Error("already fenced");
          fences.add(id); events.push("fence:" + i.operation); } };
    } },
    effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, async (_i: Readonly<AdmissionIntent>, signal: AbortSignal, _guard: () => void) => {
      signals.push(signal); events.push("effect:" + op); return "saved-result:" + op;
    }])) as AdmissionPorts<string>["effects"],
  };
  return { scope, intent, ports, control, events, signals, fences, witnesses, now: () => time, advance: (n: number) => { time += n; },
    create: () => createAdmissionGate(scope, ports, () => time) };
}
