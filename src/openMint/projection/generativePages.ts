import type { IncomingMessage, ServerResponse } from "node:http";
import { SITE_CSS } from "../../v1/siteCss.js";
import { siteFontAsset } from "../../v1/fonts.js";
import { FAVICON_SVG, FAVICON_URL } from "../../brand/favicon.js";
import { SLOGAN_MBTI_HERO_SCRIPT, SLOGAN_MBTI_HERO_SCRIPT_URL } from "../../brand/sloganMbtiHero.js";
import { SLOGAN_TOOLTIP_SCRIPT, SLOGAN_TOOLTIP_SCRIPT_URL } from "../../brand/sloganTooltipScript.js";
import { assessmentPage, homePage, mbtiGalleryPage, errorPage, OPEN_MINT_CSS, type GalleryEntry, type OpenMintPageOptions } from "../pages.js";
import { isMbti } from "../identity.js";
import { REVEAL_MONITOR_SCRIPT } from "../revealMonitor.js";
import type { ProjectionReads } from "./http.js";
import type { createGenerativeArtworkReads } from "./generativeArtwork.js";
import type { GalleryPage } from "./postgres.js";
import type { GenerativeSharing } from "../generativeSharing.js";
import { PRIVATE_ROBOTS } from "../sharing.js";

/** One verified-inclusion card policy for home, MBTI and wallet collections. */
export function generativeGalleryEntries(result: GalleryPage): GalleryEntry[] {
  if (result.state !== "confirmed") throw new Error("Gallery unavailable.");
  return result.items.map(m => {
    if (m.availability === "quarantined" || !m.handle || !m.renderHandle || !isMbti(m.mbti) || !m.inputDigest || !m.rendererIdentity || m.artifactDigest
      || (m.mintState !== undefined && m.mintState !== "confirming" && m.mintState !== "minted")) throw new Error("Invalid gallery record.");
    return { handle: m.handle, renderHandle: m.renderHandle, code: "", mbti: m.mbti, url: `/signatures/${m.handle}`,
      imageUrl: `/api/signatures/${m.handle}/artwork/${m.inputDigest}/svg`, mint: { state: m.mintState ?? "minted", tokenId: m.tokenId, transactionHash: m.transactionHash } };
  });
}

export function galleryPagination(html: string, path: string, cursor?: string): string {
  if (!cursor) return html;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor) || !/^\/(?:[A-Z]{4}\/|me)?$/.test(path)) throw new Error("Invalid pagination.");
  return html.replace("</main>", `<nav aria-label="Gallery pagination"><a class="auth-action" href="${path}?after=${cursor}"><span>More signatures</span></a></nav></main>`);
}

/** Read-only page composition for the explicit isolated generative profile.
 * No session, provider, signer, synchronization or wallet operation is exposed.
 * The enclosing server retains host/capacity/transport restrictions. */
export function createGenerativeGalleryPages(options: {
  projection: ProjectionReads; artwork: Pick<ReturnType<typeof createGenerativeArtworkReads>, "detail">;
  pageOptions?: OpenMintPageOptions;
  sharing?: GenerativeSharing;
}) {
  const gallery = options.projection.gallery.bind(options.projection), detail = options.artwork.detail.bind(options.artwork);
  const cssPath = "/assets/generative-gallery.css", scriptPath = "/assets/generative-reveal.js";
  const assets = new Map<string, { body: string; type: string }>([
    [cssPath, { body: SITE_CSS + OPEN_MINT_CSS, type: "text/css; charset=utf-8" }],
    [scriptPath, { body: REVEAL_MONITOR_SCRIPT, type: "text/javascript; charset=utf-8" }],
    [SLOGAN_MBTI_HERO_SCRIPT_URL, { body: SLOGAN_MBTI_HERO_SCRIPT, type: "text/javascript; charset=utf-8" }],
    [SLOGAN_TOOLTIP_SCRIPT_URL, { body: SLOGAN_TOOLTIP_SCRIPT, type: "text/javascript; charset=utf-8" }],
    [FAVICON_URL, { body: FAVICON_SVG, type: "image/svg+xml" }],
  ]);
  const pageOptions: OpenMintPageOptions = { stylesheetUrl: cssPath, clientScriptUrl: scriptPath, ...options.pageOptions };
  const send = (res: ServerResponse, status: number, body: string | Uint8Array, type = "text/html; charset=utf-8") => {
    if (res.destroyed || res.writableEnded) return;
    res.statusCode = status; res.setHeader("Content-Type", type); res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.end(typeof body === "string" ? body : Buffer.from(body));
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const raw = req.url ?? "", path = raw.split("?")[0], mint = /^\/signatures\/([a-z0-9_]{1,15})$/.exec(path), type = /^\/([A-Z]{4})\/$/.exec(path)?.[1];
    const asset = assets.get(raw), font = siteFontAsset(path);
    if (!asset && !font && path !== "/" && !mint && !isMbti(type)) return false;
    const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
    try {
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); send(res, 405, "Use GET.", "text/plain"); return true; }
      if (raw.length > 4096 || raw.includes("#") || req.headers["transfer-encoding"] || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw new Error();
      if (asset) { send(res, 200, asset.body, asset.type); return true; }
      if (font) { if (raw.includes("?")) throw new Error(); send(res, 200, font.bytes, font.contentType); return true; }
      const query = new URL(raw, "http://route.invalid").searchParams;
      if (mint) {
        if (raw.includes("?")) throw new Error();
        const model = await detail(mint[1], controller.signal), html = assessmentPage(model, pageOptions);
        send(res, 200, options.sharing ? options.sharing.decorate(html, raw, model) : html); return true;
      }
      if ([...query.keys()].some(k => k !== "after") || query.getAll("after").length > 1) throw new Error();
      const cursor = query.get("after"); if (cursor !== null && (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor))) throw new Error();
      const result = await gallery({ filter: isMbti(type) ? { kind: "mbti", value: type } : { kind: "home" }, limit: 24, includeConfirming: true, ...(cursor ? { cursor } : {}) });
      const entries = generativeGalleryEntries(result);
      const html = isMbti(type) ? mbtiGalleryPage(type, entries, pageOptions) : homePage(pageOptions, entries);
      send(res, 200, galleryPagination(options.sharing ? options.sharing.decorate(html, raw) : html, path, result.nextCursor));
    } catch { send(res, 503, errorPage("This page could not be loaded right now. Please try again shortly.", pageOptions)); }
    finally { controller.abort(); res.removeListener("close", cancel); }
    return true;
  };
}
