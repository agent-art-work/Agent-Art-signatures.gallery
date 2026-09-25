import { isGenerativeProfile } from "../generativeProfiles.js";
import { once } from "node:events";
import { createProjectionCoordinator } from "../projection/coordinator.js";
import { createProjectionPoller, type ProjectionPollerConfig } from "../projection/poller.js";
import { OpenMintProjection } from "../projection/postgres.js";
import { createGenerativeArtworkReads } from "../projection/generativeArtwork.js";
import { GenerativeWalletChain } from "../walletChain.js";
import { closeHttpServer } from "../shutdown.js";
import { DurableMintRuntime } from "./runtimeService.js";
import { GenerativeMintBrowser } from "./generativeBrowser.js";
import { createGenerativeSitePages } from "./generativeSitePages.js";
import { createDurableMintApiServer } from "./http.js";
import { assertIsolatedGenerativeBinding } from "./generativeStartup.js";

/** Explicit local composition, never an alternate application entrypoint.
 * Caller supplies already-opened, audited/migrated durable resources. No env
 * loading, migration, credentials, chain deployment, signer or provider setup.
 * Owns only the listener and bounded observer; caller retains writer ownership. */
export async function createIsolatedGenerativeSite(input: {
  runtime: DurableMintRuntime;
  observation: Parameters<typeof createProjectionCoordinator>[1];
  polling: ProjectionPollerConfig;
  shutdownTimeoutMs?: number;
}) {
  const { runtime } = input, origin = new URL(runtime.sessions.origin), profile = runtime.requests.profile;
  const timeout = input.shutdownTimeoutMs ?? 30000;
  if (process.env.NODE_ENV === "production" || !isGenerativeProfile(runtime.contractProfile)
    || input.observation.config.contractProfile !== runtime.contractProfile
    || runtime.requests.repository.namespace.profile !== "local-real" || profile.chain_id !== "31337"
    || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || Number(origin.port) < 1 || origin.username || origin.password
    || origin.origin !== runtime.sessions.origin || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000
    || input.observation.config.deploymentId !== profile.deployment_id || input.observation.deployment.id !== profile.deployment_id
    || input.observation.deployment.namespaceId !== runtime.requests.repository.namespace.id) throw new Error("Invalid isolated site configuration.");
  assertIsolatedGenerativeBinding(runtime, input.observation.config);
  const chain = new GenerativeWalletChain(input.observation.config, input.observation.rpcs);
  const projection = await OpenMintProjection.open(runtime.requests.repository.writer, input.observation.deployment);
  const coordinator = createProjectionCoordinator(projection, input.observation);
  const artwork = createGenerativeArtworkReads({ config: chain.config, rpcs: input.observation.rpcs, projection: coordinator, timeoutMs: 10000,
    provenance: { timeoutMs: 1000, loadAccepted: runtime.requests.repository.getAcceptedAssessment.bind(runtime.requests.repository) } });
  const browser = new GenerativeMintBrowser(runtime, chain, coordinator);
  const server = createDurableMintApiServer(runtime, coordinator, artwork, createGenerativeSitePages({ runtime, projection: coordinator, artwork }), browser);
  const poller = createProjectionPoller(coordinator, input.polling), controller = new AbortController();
  let phase: "idle" | "starting" | "running" | "closing" | "closed" | "failed" = "idle";
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    phase = "closing"; controller.abort(); poller.stop();
    // Disable admission before draining existing HTTP requests, not afterwards.
    const work = Promise.all([closeHttpServer(server), runtime.drain(), poller.drain(), artwork.drain()]);
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Isolated site did not drain. Keep writer ownership until operator recovery.")), timeout); })]);
        phase = "closed";
      } catch { phase = "failed"; throw new Error("Isolated site shutdown requires operator review; writer ownership was not released."); }
      finally { clearTimeout(timer); }
    })();
    return closing;
  }
  // A caller closing the listener cannot accidentally leave its observer alive.
  server.once("close", () => { void close().catch(() => undefined); });
  return Object.freeze({
    server, browser, artwork, reads: Object.freeze({ lookup: coordinator.lookup, gallery: coordinator.gallery }),
    snapshot: () => Object.freeze({ phase, observer: poller.snapshot() }),
    async start(): Promise<void> {
      if (phase !== "idle") throw new Error("Isolated site is single-use.");
      phase = "starting";
      try {
        if (process.env.NODE_ENV === "production") throw new Error("Public startup remains disabled.");
        assertIsolatedGenerativeBinding(runtime, chain.config);
        const listening = once(server, "listening"); server.listen(Number(origin.port), "127.0.0.1"); await listening;
        if (phase !== "starting") throw new Error("Startup interrupted.");
        poller.start(controller.signal); phase = "running";
      } catch { await close(); throw new Error("Isolated site could not start."); }
    },
    close,
  });
}
