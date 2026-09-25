import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Hex } from "viem";
import { createGenerativeArtworkReader, createStagingGenerativeArtworkReader } from "../generativeReads.js";
import { profileForRenderer } from "../generativeInputs.js";
import { handleDigest } from "../identity.js";
import type { AssessmentPageModel } from "../pages.js";
import type { ProjectionReads } from "./http.js";
import { ArtworkReadUnavailableError, type ArtworkKind } from "./artwork.js";
import { stable } from "./model.js";
import { generativeAssessmentProvenance, type GenerativeProvenanceSource } from "./generativeProvenance.js";

/** No artifact journal or off-chain renderer. SVG/metadata come from the pinned
 * on-chain renderer at the mint's inclusion block. PNG is a read-time convenience
 * only; neither it nor an output hash participates in mint authorization. */
type ArtworkReadsOptions = Parameters<typeof createGenerativeArtworkReader>[0] & {
  projection: Pick<ProjectionReads, "lookup">; timeoutMs: number;
  provenance?: GenerativeProvenanceSource;
};
export function createGenerativeArtworkReads(options: ArtworkReadsOptions) {
  return artworkReads(options, createGenerativeArtworkReader(options));
}
export function createStagingGenerativeArtworkReads(options: ArtworkReadsOptions) {
  return artworkReads(options, createStagingGenerativeArtworkReader(options));
}
function artworkReads(options: ArtworkReadsOptions, chainRead: ReturnType<typeof createGenerativeArtworkReader>) {
  const { timeoutMs } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ArtworkReadUnavailableError();
  const lookup = options.projection.lookup.bind(options.projection);
  const source = options.provenance;
  if (source && (typeof source.loadAccepted !== "function" || !Number.isSafeInteger(source.timeoutMs)
    || source.timeoutMs < 1 || source.timeoutMs > 1000)) throw new ArtworkReadUnavailableError();
  const provenance = source && Object.freeze({ loadAccepted: source.loadAccepted.bind(source), timeoutMs: source.timeoutMs });
  const pin = options.config.generativeRenderer!.identity;
  const pending = new Set<Promise<unknown>>();
  async function read<T>(handle: string, signal: AbortSignal, output: (e: Awaited<ReturnType<typeof chainRead>>, before: Awaited<ReturnType<typeof lookup>>, signal: AbortSignal, remainingMs: number) => Promise<T>, finalizedOnly = false): Promise<T> {
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new ArtworkReadUnavailableError();
    const controller = new AbortController(), end = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= end) throw new ArtworkReadUnavailableError(); };
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new ArtworkReadUnavailableError()); };
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, timeoutMs);
    });
    try {
      const work = async () => {
        check(); const before = await lookup(handle); check(); const mint = before.item;
        if ((finalizedOnly ? before.state !== "confirmed" : !["confirming", "confirmed"].includes(before.state)) || !mint || mint.availability === "quarantined" || mint.handle !== handle
          || mint.tokenId !== BigInt(handleDigest(handle)).toString() || !mint.transactionHash || !mint.inclusion || !mint.inputDigest
          || mint.artifactDigest || mint.tokenURIHash || mint.rendererIdentity !== pin) throw new ArtworkReadUnavailableError();
        const evidence = await chainRead(handle, { number: BigInt(mint.inclusion.number), hash: mint.inclusion.hash as Hex }, controller.signal); check();
        const i = evidence.inputs;
        if (i.digest !== mint.inputDigest || i.rendererIdentity !== pin || i.assessmentDigest !== mint.assessmentDigest
          || i.mbti !== mint.mbti || i.renderHandle !== mint.renderHandle || evidence.recipient !== mint.originalRecipient
          || evidence.authorizationDigest !== mint.authorizationDigest) throw new ArtworkReadUnavailableError();
        const result = await output(evidence, before, controller.signal, end - performance.now()); check();
        if (stable(await lookup(handle)) !== stable(before)) throw new ArtworkReadUnavailableError(); check();
        return result;
      };
      const operation = work(); pending.add(operation);
      operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return await Promise.race([operation, stop]);
    } catch { throw new ArtworkReadUnavailableError(); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  }
  return Object.freeze({
    async drain() {
      // An existing chain read may start optional DB work after drain begins.
      // Drain descendants too, not only the initial snapshot of operations.
      while (pending.size) await Promise.allSettled([...pending]);
    },
    detail(handle: string, signal: AbortSignal): Promise<AssessmentPageModel> {
      return read(handle, signal, async (evidence, before, active, remainingMs) => {
        const i = evidence.inputs, mint = before.item!, base = `/api/signatures/${handle}/artwork/${i.digest}`;
        // Chain commitments do not prove a Grok response. Do not invent model,
        // sources, identity lookup or assessment dates when recovering on chain.
        const assessment = await assessmentDetails(i, active, remainingMs);
        return { handle, renderHandle: i.renderHandle, code: "", status: "ready", canMint: false, mbti: i.mbti,
          tokenId: mint.tokenId, imageUrl: `${base}/svg`, svgUrl: `${base}/svg`, rendererVersion: profileForRenderer(options.config.generativeRenderer!).rendererVersion,
          inputDigest: i.digest, rendererIdentity: i.rendererIdentity, assessmentDigest: i.assessmentDigest,
          svgSha256: createHash("sha256").update(evidence.svg).digest("hex"),
          ...assessment,
          mint: { state: before.state === "confirmed" ? "minted" : "confirming", tokenId: mint.tokenId,
            transactionHash: mint.transactionHash, wallet: mint.originalRecipient } };
      });
    },
    sharingPng(handle: string, digest: string, signal: AbortSignal) { return media(handle, digest, "png", signal, true); },
    media,
  });
  async function assessmentDetails(inputs: Awaited<ReturnType<typeof chainRead>>["inputs"], signal: AbortSignal, remainingMs: number) {
    if (!provenance || signal.aborted) return undefined;
    const controller = new AbortController();
    const budget = Math.min(provenance.timeoutMs, Math.max(1, remainingMs / 2)), deadline = performance.now() + budget;
    const current = () => !controller.signal.aborted && !signal.aborted && performance.now() < deadline;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    // Optional enrichment gets at most half the remaining artwork lifetime,
    // leaving time for the final projection check. Never use a stale fallback.
    const stop = new Promise<undefined>(resolve => {
      abort = () => { controller.abort(); resolve(undefined); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, budget);
    });
    const work = (async () => {
      const value = await provenance.loadAccepted(inputs.canonicalHandle, inputs.assessmentDigest, controller.signal);
      if (!current() || value === undefined) return undefined;
      const details = generativeAssessmentProvenance(value, inputs);
      return current() ? details : undefined;
    })().catch(() => undefined);
    // A public timeout cannot release ownership while a DB operation is still
    // unwinding. The enclosing site's bounded drain retains that responsibility.
    pending.add(work); void work.then(() => pending.delete(work));
    try { return await Promise.race([work, stop]); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  }
  function media(handle: string, digest: string, kind: ArtworkKind, signal: AbortSignal, finalizedOnly = false) {
      if (!/^0x[0-9a-f]{64}$/.test(digest) || !["svg", "png", "metadata"].includes(kind)) return Promise.reject(new ArtworkReadUnavailableError());
      return read(handle, signal, async evidence => {
        if (evidence.inputs.digest !== digest) throw new ArtworkReadUnavailableError();
        if (kind === "metadata") return { mediaType: "application/json" as const, bytes: Uint8Array.from(Buffer.from(evidence.tokenURI.slice("data:application/json;base64,".length), "base64")) };
        const svg = Buffer.from(evidence.svg);
        return { mediaType: kind === "svg" ? "image/svg+xml" as const : "image/png" as const, bytes: Uint8Array.from(kind === "svg" ? svg : await sharp(svg, { limitInputPixels: 1080 * 1080 }).timeout({ seconds: 2 }).png().toBuffer()) };
      }, finalizedOnly);
  }
}
