import { createOnchainArtworkReader } from "../onchainReads.js";
import { createProjectionObserver } from "./observer.js";

/** Rebuild mint/ownership projections using only chain data. The legacy
 * completed-publication/assessment database is not a recovery dependency. */
export function createOnchainProjectionObserver(
  options: Omit<Parameters<typeof createProjectionObserver>[0], "resolveMint">,
  now: () => number = Date.now,
) {
  if (options.config.contractProfile !== "onchain-v1") throw new Error("An explicit on-chain deployment profile is required.");
  const read = createOnchainArtworkReader(options);
  return createProjectionObserver({ ...options,
    resolveMint: (event, signal, block) => read(event.handle, block, signal),
  }, now);
}
