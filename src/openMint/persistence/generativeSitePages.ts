import type { IncomingMessage, ServerResponse } from "node:http";
import { renderSignatureSvg } from "../../algorithmV2/index.js";
import { canonicalHandle, isMbti, preservedHandle, RENDERER_VERSION } from "../identity.js";
import { aboutPage, collectionPage, errorPage, previewPage, previewVariationsPage, type OpenMintPageOptions, type AssessmentPageModel } from "../pages.js";
import type { GenerativeSharing } from "../generativeSharing.js";
import { PRIVATE_ROBOTS, LOCAL_ROBOTS_TXT } from "../sharing.js";
import type { PublicPreviewState } from "../previewState.js";
import { createGenerativeGalleryPages, generativeGalleryEntries, galleryPagination } from "../projection/generativePages.js";
import type { createGenerativeArtworkReads } from "../projection/generativeArtwork.js";
import type { ProjectionReads } from "../projection/http.js";
import { ProjectionCursorError } from "../projection/model.js";
import { PublicError } from "../security.js";
import type { DurableMintRuntime } from "./runtimeService.js";

/** Explicit isolated-site pages. Public browsing never allocates a session,
 * calls a provider or requests mint authority. /me alone uses wallet sessions.
 * No URL-supplied owner, MBTI or renderer becomes mint input. */
export function createGenerativeSitePages(input: {
  runtime: Pick<DurableMintRuntime, "sessions" | "sessionView" | "requests">;
  projection: ProjectionReads; artwork: Pick<ReturnType<typeof createGenerativeArtworkReads>, "detail">;
  pageOptions?: OpenMintPageOptions;
  sharing?: GenerativeSharing;
}) {
  const { runtime } = input, detail = input.artwork.detail.bind(input.artwork), gallery = input.projection.gallery.bind(input.projection);
  const options: OpenMintPageOptions = { stylesheetUrl: "/assets/generative-gallery.css", clientScriptUrl: "/assets/generative-wallet.js",
    publicOrigin: runtime.sessions.origin, chainId: "31337", chainName: "Local Anvil", contract: runtime.requests.profile.contract_address,
    durableWalletSubmission: true, generativeArtwork: true, pulseMint: !!runtime.requests.pulse, ...input.pageOptions };
  const publicPages = createGenerativeGalleryPages({ ...input, pageOptions: options });
  async function previewState(spelling: string, signal: AbortSignal): Promise<{ state: PublicPreviewState; model?: AssessmentPageModel }> {
    try {
      const m = await detail(canonicalHandle(spelling), signal);
      if ((m.mint?.state !== "minted" && m.mint?.state !== "confirming") || !isMbti(m.mbti) || !m.renderHandle || !m.imageUrl || !m.rendererVersion
        || canonicalHandle(m.renderHandle) !== canonicalHandle(spelling)) throw new Error();
      return { model: m, state: { state: m.mint.state, renderHandle: m.renderHandle, mbti: m.mbti, rendererVersion: m.rendererVersion,
        previewRendererVersion: RENDERER_VERSION, onchain: true, imageUrl: m.imageUrl, url: `/signatures/${canonicalHandle(spelling)}` } };
    } catch { return { state: { state: "unavailable" } }; } // Missing observation is never proof of absence.
  }
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const raw = req.url ?? "", path = raw.split("?")[0];
    const preview = /^\/(p|s)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const asset = /^\/preview\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})\.svg$/.exec(path);
    if (!preview && !asset && !["/me", "/about", "/robots.txt"].includes(path)) return publicPages(req, res);
    const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
    const send = (status: number, body: string, type = "text/html; charset=utf-8") => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status; res.setHeader("Content-Type", type); res.end(body);
    };
    const redirect = (location: string, status = 303) => { res.setHeader("Location", location); send(status, ""); };
    try {
      res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS);
      res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new PublicError(405, "METHOD_NOT_ALLOWED", "Use GET."); }
      if (raw.length > 4096 || raw.includes("#") || req.headers["transfer-encoding"] || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw new PublicError(400, "INVALID_REQUEST", "Invalid page request.");
      const query = new URL(raw, runtime.sessions.origin).searchParams;
      if (asset) {
        if (!isMbti(asset[2])) throw new PublicError(404, "NOT_FOUND", "Unknown MBTI type.");
        if ([...query.keys()].some(k => k !== "renderer") || query.getAll("renderer").length > 1) throw new PublicError(400, "INVALID_RENDERER", "Choose one renderer.");
        if (query.has("renderer") && query.get("renderer") !== RENDERER_VERSION) throw new PublicError(404, "UNKNOWN_RENDERER", "This preview renderer is not available.");
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
        send(200, renderSignatureSvg(asset[1], asset[2]), "image/svg+xml"); return true;
      }
      if (path === "/me") {
        if ([...query.keys()].some(k => k !== "after") || query.getAll("after").length > 1) throw new PublicError(400, "INVALID_REQUEST", "Use collection pagination only.");
        const cursor = query.get("after");
        if (cursor !== null && !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new PublicError(400, "INVALID_CURSOR", "Restart collection pagination.");
        const found = await runtime.sessions.session(req.headers.cookie);
        if (found.created) res.setHeader("Set-Cookie", runtime.sessions.cookie(found.session));
        const view = runtime.sessionView(found.session);
        if (!view.walletVerified || !view.wallet) { send(200, collectionPage([], options)); return true; }
        const result = await gallery({ filter: { kind: "owner", value: view.wallet.toLowerCase() }, limit: 24, includeConfirming: true, ...(cursor ? { cursor } : {}) });
        // Recheck after the read: logout, changed wallet, generation or expiry
        // while awaiting the database cannot retain the prior wallet's page.
        const current = await runtime.sessions.requireSession(runtime.sessions.cookie(found.session)), checked = runtime.sessionView(current);
        if (current.generation !== found.session.generation || checked.wallet !== view.wallet || !checked.walletVerified) throw new PublicError(403, "SESSION_CHANGED", "Reconnect your wallet to view its collection.");
        send(200, galleryPagination(collectionPage(generativeGalleryEntries(result), { ...options, wallet: view.wallet, walletVerified: true }), path, result.nextCursor)); return true;
      }
      if (raw.includes("?")) throw new PublicError(400, "INVALID_REQUEST", "This page accepts no parameters.");
      if (path === "/about") { const html = aboutPage(options); send(200, input.sharing ? input.sharing.decorate(html, raw) : html); return true; }
      if (path === "/robots.txt") { send(200, LOCAL_ROBOTS_TXT, "text/plain; charset=utf-8"); return true; }
      let spelling: string;
      try { spelling = preservedHandle(decodeURIComponent(preview![2])); } catch { throw new PublicError(404, "INVALID_HANDLE", "Invalid signature handle."); }
      const suffix = preview![3] === "variations" ? "variations" : preview![3]?.toUpperCase();
      if (suffix && suffix !== "variations" && !isMbti(suffix)) throw new PublicError(404, "INVALID_MBTI", "Choose a four-letter MBTI, such as ENFP.");
      if (preview![1] === "s") { redirect(`/p/${spelling}${suffix ? `/${suffix}` : ""}`, 308); return true; }
      if (!suffix) { redirect(`/p/${spelling}/variations`); return true; }
      const { state, model } = await previewState(spelling, controller.signal);
      if (state.state === "minted" || state.state === "confirming") spelling = state.renderHandle;
      if (spelling !== preview![2] || suffix !== preview![3]) { redirect(`/p/${spelling}/${suffix}`); return true; }
      const html = suffix === "variations" ? previewVariationsPage(spelling, options, state) : previewPage(spelling, suffix as import("../identity.js").MBTI, options, state);
      send(200, input.sharing ? input.sharing.decorate(html, raw, model) : html);
    } catch (error) {
      const status = error instanceof PublicError ? error.status : error instanceof ProjectionCursorError ? 400 : 503;
      const message = error instanceof PublicError ? error.message : error instanceof ProjectionCursorError ? "Restart collection pagination."
        : path === "/me" ? "Your collection could not be loaded right now. Please try again shortly."
        : "This page could not be loaded right now. Please try again shortly.";
      send(status, errorPage(message, options));
    } finally { controller.abort(); res.removeListener("close", cancel); }
    return true;
  };
}
