import type { GalleryPage, OpenMintProjection } from "./postgres.js";
import { ProjectionCursorError, ProjectionSafetyHaltError } from "./model.js";
import { WriterUnavailableError } from "../persistence/writer.js";
import { createProjectionObserver, createStagingProjectionObserver, type ProjectionObservation } from "./observer.js";

/** One fenced writer / one coordinator. No public request is allowed to trigger
 * sync: an operator-owned scheduler supplies cancellation and bounded cadence.
 * Reads never fetch RPCs, assess, issue authority, or retry writes. Restart loses
 * freshness intentionally; a persisted 'available' flag alone reveals nothing.
 */
export function createProjectionCoordinator(projection: OpenMintProjection, options: Parameters<typeof createProjectionObserver>[0]) {
  return coordinator(projection, createProjectionObserver(options));
}
export function createStagingProjectionCoordinator(projection: OpenMintProjection, options: Parameters<typeof createProjectionObserver>[0]) {
  return coordinator(projection, createStagingProjectionObserver(options));
}
function coordinator(projection: OpenMintProjection, observe: ReturnType<typeof createProjectionObserver>) {
  let witness: ProjectionObservation | undefined, running = false, generation = 0;
  return Object.freeze({
    /** Immediate read withdrawal on drain/lost ownership, with no DB or RPC I/O.
     * An already-running pass cannot restore this withdrawn generation. */
    withdraw(): void { witness = undefined; generation++; },
    async sync(signal: AbortSignal): Promise<"observed" | "safety-halted" | "unavailable" | "writer-unavailable" | "busy"> {
      if (running) return "busy";
      running = true; witness = undefined; generation++;
      const epoch = generation;
      try {
        const next = await observe(await projection.chainCursor(), signal);
        if (signal.aborted) throw new Error("Cancelled before projection write.");
        const result = await projection.applyObservation(next);
        if (result === "observed") {
          if (signal.aborted || generation !== epoch) return "unavailable";
          witness = next;
        }
        return result;
      } catch (error) {
        if (error instanceof ProjectionSafetyHaltError) return "safety-halted";
        if (error instanceof WriterUnavailableError) return "writer-unavailable";
        await projection.unavailable().catch(() => undefined);
        return "unavailable";
      } finally { running = false; }
    },
    async gallery(input: Parameters<OpenMintProjection["gallery"]>[0]): Promise<GalleryPage> {
      const captured = witness, epoch = generation;
      if (!captured) return { state: "unknown", items: [] };
      try {
        const result = await projection.gallery(input, captured);
        return witness === captured && generation === epoch ? result : { state: "unknown", items: [] };
      } catch (error) {
        if (error instanceof ProjectionCursorError) throw error;
        return { state: "unknown", items: [] };
      }
    },
    async lookup(handle: string): Promise<Awaited<ReturnType<OpenMintProjection["lookup"]>>> {
      const captured = witness, epoch = generation;
      if (!captured) return { state: "unknown" };
      try {
        const result = await projection.lookup(handle, captured);
        return witness === captured && generation === epoch ? result : { state: "unknown" };
      } catch { return { state: "unknown" }; }
    },
  });
}
