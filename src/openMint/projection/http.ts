import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDigest } from "../identity.js";
import { PublicError } from "../security.js";
import type { createProjectionCoordinator } from "./coordinator.js";
import { ProjectionCursorError, validateFilter, validateLimit, type GalleryFilter } from "./model.js";
import type { createVerifiedArtworkReads, ArtworkKind } from "./artwork.js";

export type ProjectionReads = Pick<ReturnType<typeof createProjectionCoordinator>, "gallery" | "lookup">;
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value));
}
/** Shared read-only route adapter. The enclosing server owns host, transport,
 * capacity and deadline policy. Deliberately has no sync/session/issuer handle.
 * Data is no-store and noindex even when finalized; public caching is a later
 * explicitly reviewed policy, not inferred from the route name.
 */
export function createProjectionReadHandler(reads: ProjectionReads, artwork?: Pick<ReturnType<typeof createVerifiedArtworkReads>, "media">) {
  const gallery = reads.gallery.bind(reads), lookup = reads.lookup.bind(reads);
  const media = artwork?.media.bind(artwork);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const raw = req.url ?? "", path = raw.split("?")[0], signature = /^\/api\/signatures\/([a-z0-9_]{1,15})\/status$/.exec(path);
    const image = media && /^\/api\/signatures\/([a-z0-9_]{1,15})\/artwork\/(0x[0-9a-f]{64})\/(svg|png|metadata)$/.exec(path);
    if (path !== "/api/gallery" && !signature && !image) return false;
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new PublicError(405, "METHOD_NOT_ALLOWED", "Use GET for public reads."); }
      if (req.headers["transfer-encoding"] || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") || raw.length > 4096 || raw.includes("#")) {
        throw new PublicError(400, "INVALID_REQUEST", "Invalid read request.");
      }
      if (image) {
        if (raw.includes("?")) throw new PublicError(400, "INVALID_REQUEST", "Artwork reads accept no parameters.");
        const controller = new AbortController(), cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          const object = await media!(image[1], image[2], image[3] as ArtworkKind, controller.signal);
          if (!res.destroyed && !res.writableEnded) {
            res.statusCode = 200; res.setHeader("Content-Type", object.mediaType); res.setHeader("Content-Length", object.bytes.byteLength);
            res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'"); res.end(Buffer.from(object.bytes));
          }
        } finally { controller.abort(); res.removeListener("close", cancel); }
        return true;
      }
      if (signature) {
        if (raw.includes("?")) throw new PublicError(400, "INVALID_REQUEST", "This status endpoint accepts no parameters.");
        const handle = signature[1], result = await lookup(handle);
        const reveal = result.state === "confirmed" || result.state === "confirming";
        // A corrupt or unavailable record never becomes an unminted result.
        const item = result.item, usable = reveal && item && item.availability !== "quarantined" && item.handle === handle
          && item.tokenId === BigInt(handleDigest(handle)).toString() && item.transactionHash
          && (item.inputDigest ? item.rendererIdentity && !item.artifactDigest && !item.tokenURIHash : item.artifactDigest && !item.rendererIdentity);
        json(res, usable ? 200 : 503, { handle, tokenId: BigInt(handleDigest(handle)).toString(),
          state: usable ? result.state === "confirmed" ? "minted" : "confirming" : "unknown",
          ...(usable ? { ...(item.inputDigest ? { inputDigest: item.inputDigest, rendererIdentity: item.rendererIdentity }
            : { artifactDigest: item.artifactDigest }), transactionHash: item.transactionHash } : {}) });
        return true;
      }
      const query = new URL(raw, "https://route.invalid").searchParams;
      if ([...query.keys()].some(k => !["mbti", "owner", "limit", "after"].includes(k) || query.getAll(k).length !== 1) || (query.has("mbti") && query.has("owner"))) {
        throw new PublicError(400, "INVALID_REQUEST", "Use one gallery filter and one pagination cursor.");
      }
      const text = query.get("limit") ?? "24", after = query.get("after");
      if (!/^[1-9][0-9]?$/.test(text) || (after !== null && (!after || after.length > 2048))) throw new PublicError(400, "INVALID_REQUEST", "Invalid gallery pagination.");
      const limit = Number(text), filter: GalleryFilter = query.has("mbti") ? { kind: "mbti", value: query.get("mbti")! }
        : query.has("owner") ? { kind: "owner", value: query.get("owner")! } : { kind: "home" };
      try { validateFilter(filter); validateLimit(limit); } catch { throw new PublicError(400, "INVALID_REQUEST", "Invalid gallery filter or limit."); }
      const result = await gallery({ filter, limit, includeConfirming: true, ...(after !== null ? { cursor: after } : {}) });
      // Explicit public projection. Never spread database or private evidence rows.
      const confirmed = result.state === "confirmed";
      json(res, confirmed ? 200 : 503, { state: result.state,
        ...(confirmed && result.snapshot ? { snapshot: { number: result.snapshot.number, hash: result.snapshot.hash } } : {}),
        items: (confirmed ? result.items : []).map(item => ({ tokenId: item.tokenId, availability: item.availability,
          ...(item.availability === "quarantined" ? {} : { handle: item.handle, mbti: item.mbti, mintState: item.mintState ?? "minted",
            originalRecipient: item.originalRecipient, currentOwner: item.currentOwner,
            assessmentDigest: item.assessmentDigest, artifactDigest: item.artifactDigest, tokenURIHash: item.tokenURIHash, transactionHash: item.transactionHash,
            ...(item.inputDigest ? { inputDigest: item.inputDigest, rendererIdentity: item.rendererIdentity, renderHandle: item.renderHandle } : {}) }) })),
        ...(confirmed && result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
    } catch (error) {
      req.resume();
      if (error instanceof PublicError) json(res, error.status, { code: error.code, error: error.message });
      else if (error instanceof ProjectionCursorError) json(res, 400, { code: "INVALID_CURSOR", error: "Restart gallery pagination." });
      else json(res, 503, { code: "CHAIN_UNAVAILABLE", error: "Mint status cannot be verified right now." });
    }
    return true;
  };
}
