import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SLOGAN_WORDING_PATH, SLOGAN_WORDING_CSS_PATH, SLOGAN_WORDING_CSS, sloganWordingStudyPage } from "../brand/sloganWordingStudy.js";
import { SITE_CSS } from "../v1/siteCss.js";
import { SITE_FONT_CSS, siteFontAsset } from "../v1/fonts.js";
import { FAVICON_SVG, FAVICON_URL } from "../brand/favicon.js";
import { SLOGAN_TOOLTIP_SCRIPT, SLOGAN_TOOLTIP_SCRIPT_URL } from "../brand/sloganTooltipScript.js";
import { SLOGAN_MBTI_HERO_SCRIPT, SLOGAN_MBTI_HERO_SCRIPT_URL } from "../brand/sloganMbtiHero.js";
import { QUESTION_MARK_STUDY_PATH, QUESTION_MARK_STUDY_CSS_PATH, QUESTION_MARK_STUDY_CSS, questionMarkStudyPage } from "../brand/sloganQuestionMarkStudy.js";
import { QUESTION_MARK_REVEAL_PATH, QUESTION_MARK_REVEAL_CSS_PATH, QUESTION_MARK_REVEAL_CSS, questionMarkRevealStudyPage } from "../brand/sloganQuestionMarkRevealStudy.js";
import { MINT_CONTROL_STUDY_PATH, MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_CSS, MINT_CONTROL_STUDY_SCRIPT_PATH, MINT_CONTROL_STUDY_SCRIPT, mintControlStudyPage } from "../brand/mintControlStudy.js";
import { formalSignatureRenderer, sha256Hex } from "../v1/renderer.js";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { canonicalHandle, handleDigest, isMbti, LEGACY_RENDERER_VERSION, preservedHandle, RENDERER_VERSION, seedForMbti } from "./identity.js";
import { OPEN_MINT_CLIENT_SCRIPT } from "./clientScript.js";
import { OPEN_MINT_CSS, aboutPage, assessmentPage, collectionPage, errorPage, homePage, mbtiGalleryPage, mintPage, previewPage, previewVariationsPage, type AssessmentPageModel, type GalleryEntry, type OpenMintPageOptions } from "./pages.js";
import { fields, PublicError, publicErrorDetails, WalletSessions, type SiteSession } from "./security.js";
import { OpenMintService, type SignatureArtifact, type SignatureRequest } from "./service.js";
import { OPEN_MINT_GALLERY_FIXTURES, galleryFixtureModel } from "./galleryFixtures.js";
import { publicPreviewState } from "./previewState.js";
import { openMintSupportUrl } from "./supportUrl.js";
import { LOCAL_ROBOTS_TXT, PRIVATE_ROBOTS } from "./sharing.js";
import { canRevealMint } from "./revealPolicy.js";
import { agentDocument, AGENT_DOCUMENT_PATHS } from "./agentDocuments.js";

export interface OpenMintServerOptions {
  origin: string; fixture: boolean; service: OpenMintService; sessions: WalletSessions;
  rpcUrl?: string;
  supportUrl?: string;
  devWallet?: (session: SiteSession, code?: string) => Promise<string>;
  devMint?: (session: SiteSession, code: string, consent: unknown) => Promise<unknown>;
}
const css = `${SITE_FONT_CSS}\n${SITE_CSS}\n${OPEN_MINT_CSS}`;
const cssUrl = `/assets/open-mint-${sha256Hex(Buffer.from(css)).slice(0, 16)}.css`;
const scriptUrl = `/assets/open-mint-${sha256Hex(Buffer.from(OPEN_MINT_CLIENT_SCRIPT)).slice(0, 16)}.js`;
const faviconPath = new URL(FAVICON_URL, "http://127.0.0.1").pathname;

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new PublicError(415, "JSON_REQUIRED", "Use a JSON request.");
  let size = 0; const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > 8192) throw new PublicError(413, "REQUEST_TOO_LARGE", "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PublicError(400, "INVALID_JSON", "Invalid JSON request."); }
}
function send(res: ServerResponse, status: number, content: string | Uint8Array, type = "text/html; charset=utf-8"): void {
  res.statusCode = status; res.setHeader("Content-Type", type); res.end(content);
}
function json(res: ServerResponse, content: unknown, status = 200): void { send(res, status, JSON.stringify(content), "application/json; charset=utf-8"); }

export function createOpenMintServer(options: OpenMintServerOptions) {
  const { service, sessions } = options;
  const supportUrl = openMintSupportUrl(options.supportUrl);
  // Read-only gallery samples are isolated from real assessments, wallet collections,
  // durable records, and local-chain projections. Never fill a live gallery with mocks.
  const galleryFixtures = options.fixture && !service.network;
  const origin = new URL(options.origin);
  const rates = new Map<string, { start: number; count: number }>();
  const preparationWalletVerified = (session: SiteSession): boolean => service.walletVerified(session) && session.walletProof?.code === undefined;
  const walletTiming = (session: SiteSession) => ({ serverNow: service.now(), walletProofExpiresAt: session.walletProof?.expiresAt });
  const pageOptions = (session: SiteSession): OpenMintPageOptions => ({
    csrfToken: session.csrf, wallet: session.wallet, walletVerified: preparationWalletVerified(session), chainId: String(service.network?.chainId ?? 31337),
    chainName: "Local Anvil", contract: service.network?.address, rpcUrl: options.rpcUrl,
    publicOrigin: options.origin, stylesheetUrl: cssUrl, clientScriptUrl: scriptUrl, supportUrl,
    development: { fixture: options.fixture, localChain: !!options.devWallet, galleryFixtures,
      notes: ["Open-mint development build. The earlier X-claim application and its data are separate.",
        "Previews and new assessments use the native MBTI v2.0.0 renderer. Existing prepared and minted artwork keeps its original renderer and bytes.",
        ...(!service.options.assessments ? ["Set XAI_API_KEY to enable real assessments, or explicitly use dev:fixture for simulated results."] : []),
        ...(!options.fixture && service.options.assessments?.identityProvenance !== "x-api" ? ["Set OPEN_MINT_X_BEARER_TOKEN for authoritative X username verification before preparing new real artwork. Browsing never calls X or Grok."] : []),
        ...(!service.network ? ["Minting is disabled until the isolated local chain is started."] : ["Artifacts are stored locally, not pinned to a public storage network. These tokens are for local testing only."])],
    },
  });
  const artifactFields = (artifact: SignatureArtifact) => ({ renderHandle: artifact.renderHandle ?? artifact.assessment.handle, mbti: artifact.assessment.mbti,
    imageUrl: `/artifacts/${artifact.pngSha256}.png`, svgUrl: `/artifacts/${artifact.svgSha256}.svg`,
    rendererVersion: artifact.assessment.rendererVersion, svgSha256: artifact.svgSha256, pngSha256: artifact.pngSha256, artifactDigest: artifact.digest,
    assessedAt: artifact.assessment.createdAt, assessmentProvenance: artifact.assessment.provenance,
    assessmentModel: artifact.assessment.model, assessmentSourceUrls: artifact.assessment.sourceUrls,
    ...(artifact.assessment.xIdentity?.provenance === "x-api" ? { verifiedXUserId: artifact.assessment.xIdentity.userId, identityVerifiedAt: artifact.assessment.xIdentity.verifiedAt } : {}) });
  const model = async (request: SignatureRequest, session: SiteSession): Promise<AssessmentPageModel> => {
    const mint = await service.state(request.handle);
    // This is a UI reveal, not cryptographic secrecy: mint calldata already binds the artifact.
    // Only verified canonical inclusion (or stronger) unlocks early reveal.
    const artifact = canRevealMint(mint.state) ? await service.artifact(request.handle) : undefined;
    return { handle: request.handle, renderHandle: request.requestedHandle ?? request.handle, code: request.code, status: request.errorCategory === "assessment-abstained" ? "abstained" : request.status, tokenId: BigInt(handleDigest(request.handle)).toString(), canMint: mint.state === "unminted" && service.canMint(request, session),
      diagnosticReference: request.attemptId, errorCategory: request.errorCategory,
      walletProvedForCode: await service.walletProved(request.code, session), requestExpired: request.expiresAt <= service.now(), requestExpiresAt: request.expiresAt, ...walletTiming(session), error: request.error,
      ...(artifact ? artifactFields(artifact) : {}), mint };
  };
  const entries = async (session?: SiteSession): Promise<GalleryEntry[]> => (await service.gallery(session?.wallet)).map(({ artifact, mint }) => ({
    handle: artifact.assessment.handle, renderHandle: artifact.renderHandle ?? artifact.assessment.handle, code: "", mbti: artifact.assessment.mbti, imageUrl: `/artifacts/${artifact.pngSha256}.png`, url: `/signatures/${artifact.assessment.handle}`, mint,
  }));
  const publicEntries = async (): Promise<GalleryEntry[]> => galleryFixtures ? [...OPEN_MINT_GALLERY_FIXTURES] : entries();

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // This is the local-only runtime, never an indexing activation switch.
    res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'${options.rpcUrl ? ` ${new URL(options.rpcUrl).origin}` : ""}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    let session: SiteSession | undefined;
    try {
      if (req.headers.host !== origin.host) throw new PublicError(421, "WRONG_HOST", "Open the configured site address.");
      const url = new URL(req.url ?? "/", options.origin);
      if (url.origin !== options.origin) throw new PublicError(400, "INVALID_URL", "Invalid request URL.");
      if (!["GET", "POST"].includes(req.method ?? "")) throw new PublicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      const path = url.pathname;
      if (AGENT_DOCUMENT_PATHS.some(documentPath => documentPath === path)) {
        if (req.method !== "GET") return send(res, 405, "Documentation is read-only.", "text/plain; charset=utf-8");
        if (url.search) return send(res, 400, "Documentation accepts no query parameters.", "text/plain; charset=utf-8");
        const document = agentDocument(path, { publicOrigin: options.origin, development: { fixture: options.fixture } })!;
        return send(res, 200, document.body, document.contentType);
      }
      if (req.method === "GET") {
        if (path === "/robots.txt") return send(res, 200, LOCAL_ROBOTS_TXT, "text/plain; charset=utf-8");
        if (options.fixture && path === MINT_CONTROL_STUDY_CSS_PATH) return send(res, 200, MINT_CONTROL_STUDY_CSS, "text/css; charset=utf-8");
        if (options.fixture && path === MINT_CONTROL_STUDY_SCRIPT_PATH) return send(res, 200, MINT_CONTROL_STUDY_SCRIPT, "text/javascript; charset=utf-8");
        if (options.fixture && path === MINT_CONTROL_STUDY_PATH) return send(res, 200, mintControlStudyPage(cssUrl));
        if (options.fixture && path === SLOGAN_WORDING_CSS_PATH) return send(res, 200, SLOGAN_WORDING_CSS, "text/css; charset=utf-8");
        if (options.fixture && path === SLOGAN_WORDING_PATH) return send(res, 200, sloganWordingStudyPage(cssUrl));
        if (options.fixture && path === QUESTION_MARK_REVEAL_CSS_PATH) return send(res, 200, QUESTION_MARK_REVEAL_CSS, "text/css; charset=utf-8");
        if (options.fixture && path === QUESTION_MARK_REVEAL_PATH) {
          let html: string;
          try { html = questionMarkRevealStudyPage(cssUrl, url.searchParams.get("shape") ?? "INFP"); }
          catch { throw new PublicError(400, "INVALID_STUDY_OPTION", "Choose a listed slogan shape."); }
          return send(res, 200, html);
        }
        if (options.fixture && path === QUESTION_MARK_STUDY_CSS_PATH) return send(res, 200, QUESTION_MARK_STUDY_CSS, "text/css; charset=utf-8");
        if (options.fixture && path === QUESTION_MARK_STUDY_PATH) {
          let html: string;
          try { html = questionMarkStudyPage(cssUrl, url.searchParams.get("mark") ?? "ink-hook", url.searchParams.get("shape") ?? "INFP"); }
          catch { throw new PublicError(400, "INVALID_STUDY_OPTION", "Choose a listed question mark and slogan shape."); }
          return send(res, 200, html);
        }
        const previewAsset = /^\/preview\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})\.svg$/.exec(path);
        if (previewAsset) {
          const mbti = previewAsset[2]!;
          if (!isMbti(mbti)) throw new PublicError(404, "NOT_FOUND", "Unknown MBTI type.");
          const versions = url.searchParams.getAll("renderer");
          if (versions.length > 1) throw new PublicError(400, "INVALID_RENDERER", "Choose one renderer version.");
          const version = versions[0] ?? RENDERER_VERSION;
          if (version !== RENDERER_VERSION && version !== LEGACY_RENDERER_VERSION) throw new PublicError(404, "UNKNOWN_RENDERER", "This renderer version is not available.");
          const svg = version === LEGACY_RENDERER_VERSION
            ? formalSignatureRenderer.render({ handle: previewAsset[1]!, gr0kRaw: seedForMbti(mbti), gr0kScale: 1, rendererVersion: LEGACY_RENDERER_VERSION }).svgUtf8
            : renderSignatureSvg(previewAsset[1]!, mbti);
          res.setHeader("Cache-Control", "public, max-age=300");
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
          return send(res, 200, svg, "image/svg+xml");
        }
        const font = siteFontAsset(path);
        if (path === cssUrl || path === scriptUrl || path === faviconPath || path === SLOGAN_TOOLTIP_SCRIPT_URL || path === SLOGAN_MBTI_HERO_SCRIPT_URL || font) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (font) return send(res, 200, font.bytes, font.contentType);
          if (path === SLOGAN_TOOLTIP_SCRIPT_URL) return send(res, 200, SLOGAN_TOOLTIP_SCRIPT, "text/javascript; charset=utf-8");
          if (path === SLOGAN_MBTI_HERO_SCRIPT_URL) return send(res, 200, SLOGAN_MBTI_HERO_SCRIPT, "text/javascript; charset=utf-8");
          if (path === faviconPath) return send(res, 200, FAVICON_SVG, "image/svg+xml");
          return send(res, 200, path === cssUrl ? css : OPEN_MINT_CLIENT_SCRIPT, path === cssUrl ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
        }
        const asset = /^\/artifacts\/([a-f0-9]{64})\.(png|svg|json)$/.exec(path);
        if (asset) {
          const bytes = await service.asset(asset[1]!, asset[2]!);
          if (!bytes) throw new PublicError(404, "NOT_FOUND", "Artwork not found.");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
          return send(res, 200, bytes, asset[2] === "png" ? "image/png" : asset[2] === "svg" ? "image/svg+xml" : "application/json");
        }
      }
      const found = sessions.session(req.headers.cookie); session = found.session;
      if (found.created) res.setHeader("Set-Cookie", sessions.cookie(session));
      if (req.method === "POST") {
        sessions.authorizePost(session, req.headers.origin, typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined);
        const now = Date.now();
        for (const [key, rate] of rates) if (now - rate.start > 60_000) rates.delete(key);
        const ip = req.socket.remoteAddress ?? "unknown";
        const rate = rates.get(ip) ?? { start: now, count: 0 };
        rates.set(ip, rate);
        if (++rate.count > 60) throw new PublicError(429, "RATE_LIMIT", "Too many requests. Please wait a minute.");
        const input = await body(req);
        if (path === "/api/assessments") {
          const payload = fields(input, ["handle"]);
          try {
            const request = await service.request(payload.handle, session);
            return json(res, { url: `/mint/${request.code}`, code: request.code, handle: request.handle, tokenId: BigInt(handleDigest(request.handle)).toString(), status: request.status }, 202);
          } catch (error) {
            if (error instanceof PublicError && error.code === "ALREADY_MINTED") return json(res, { error: error.message, code: error.code, url: `/signatures/${canonicalHandle(payload.handle)}` }, error.status);
            throw error;
          }
        }
        if (path === "/api/wallet/challenge") {
          const payload = fields(input, ["address"], ["code"]);
          if (payload.code !== undefined) await service.ownedRequest(payload.code, session);
          return json(res, sessions.challenge(session, payload.address, payload.code as string | undefined));
        }
        if (path === "/api/wallet/verify") { const payload = fields(input, ["challengeId", "signature"]); return json(res, { wallet: await sessions.verify(session, payload.challengeId, payload.signature), ...walletTiming(session) }); }
        if (path === "/api/mints/authorize") { const payload = fields(input, ["code", "consent"]); return json(res, await service.authorize(payload.code, payload.consent, session)); }
        if (path === "/api/mints/report") { const payload = fields(input, ["code", "transactionHash"]); await service.report(payload.code, payload.transactionHash, session); return json(res, { ok: true }); }
        if (path === "/api/session/logout") { fields(input, []); sessions.logout(session); res.setHeader("Set-Cookie", "sg_open_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return json(res, { ok: true }); }
        if (path === "/api/dev/wallet" && options.devWallet) { const payload = fields(input, [], ["code"]); if (payload.code !== undefined) await service.ownedRequest(payload.code, session); return json(res, { wallet: await options.devWallet(session, payload.code as string | undefined), ...walletTiming(session) }); }
        if (path === "/api/dev/mint" && options.devMint) { const payload = fields(input, ["code", "consent"]); await service.ownedRequest(payload.code, session); return json(res, await options.devMint(session, String(payload.code), payload.consent)); }
        throw new PublicError(404, "NOT_FOUND", "Endpoint not found.");
      }
      if (path === "/api/session") return json(res, { csrfToken: session.csrf, wallet: session.wallet ?? null, walletVerified: preparationWalletVerified(session), chainId: String(service.network?.chainId ?? 31337), chainName: "Local Anvil", rpcUrl: options.rpcUrl, ...walletTiming(session) });
      if (path === "/api/wallet/context") {
        if ([...url.searchParams.keys()].some(key => key !== "address") || url.searchParams.getAll("address").length > 1) throw new PublicError(400, "INVALID_REQUEST", "Only one optional wallet address is accepted.");
        return json(res, await service.walletContext(url.searchParams.has("address") ? url.searchParams.get("address") : undefined));
      }
      const status = /^\/api\/assessments\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (status) return json(res, await model(await service.sessionRequest(status[1], session), session));
      const mintStatus = /^\/api\/mints\/status\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (mintStatus) return json(res, await service.state((await service.sessionRequest(mintStatus[1], session)).handle));
      const revealStatus = /^\/api\/signatures\/([a-z0-9_]{1,15})\/status$/.exec(path);
      if (revealStatus) {
        if (url.search) throw new PublicError(400, "INVALID_REQUEST", "This status endpoint accepts no parameters.");
        const handle = revealStatus[1], mint = await service.state(handle);
        // Public read-only confidence projection, not a request capability or
        // authority endpoint. state() verifies saved commitments before reveal.
        return json(res, { handle, tokenId: BigInt(handleDigest(handle)).toString(), state: mint.state,
          ...(canRevealMint(mint.state) ? { artifactDigest: mint.artifactDigest, transactionHash: mint.transactionHash } : {}) });
      }
      if (path === "/") return send(res, 200, homePage(pageOptions(session), await publicEntries()));
      const mbtiPath = /^\/([A-Za-z]{4})\/?$/.exec(path);
      const mbti = mbtiPath?.[1]?.toUpperCase();
      if (isMbti(mbti)) {
        const canonicalPath = `/${mbti}/`;
        if (path !== canonicalPath) { res.setHeader("Location", canonicalPath); return send(res, 303, ""); }
        return send(res, 200, mbtiGalleryPage(mbti, await publicEntries(), pageOptions(session)));
      }
      const galleryFixture = /^\/dev\/gallery\/([A-Za-z0-9_]{1,15})$/.exec(path);
      if (galleryFixture && galleryFixtures) {
        const sample = galleryFixtureModel(galleryFixture[1]!);
        if (!sample) throw new PublicError(404, "NOT_FOUND", "Signature not found.");
        res.setHeader("Location", `/signatures/${sample.handle}`);
        return send(res, 303, "");
      }
      if (path === "/me") return send(res, 200, collectionPage(session.wallet ? await entries(session) : [], pageOptions(session)));
      if (path === "/about") return send(res, 200, aboutPage(pageOptions(session)));
      if (path === "/mint") {
        let handle = "";
        try { if (url.searchParams.has("handle")) handle = preservedHandle(url.searchParams.get("handle")); }
        catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
        return send(res, 200, mintPage(handle, pageOptions(session)));
      }
      const mintRequest = /^\/mint\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (mintRequest) {
        const request = await service.sessionRequest(mintRequest[1], session);
        const view = await model(request, session);
        if (canRevealMint(view.mint?.state)) { res.setHeader("Location", `/signatures/${request.handle}`); return send(res, 303, ""); }
        return send(res, 200, assessmentPage(view, { ...pageOptions(session), mintProcess: true }));
      }
      const preview = /^\/(?:p|s)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (preview) {
        let spelling: string;
        try { spelling = preservedHandle(decodeURIComponent(preview[1]!)); } catch { throw new PublicError(404, "NOT_FOUND", "Invalid signature handle."); }
        // Compatibility only: old shared preview URLs never render or check chain
        // state here. Validate first, then move to the canonical preview namespace.
        if (path.startsWith("/s/")) {
          const suffix = preview[2] === "variations" ? "variations" : preview[2]?.toUpperCase();
          if (suffix && suffix !== "variations" && !isMbti(suffix)) throw new PublicError(404, "NOT_FOUND", "Use a four-letter MBTI type, such as ENFP.");
          res.setHeader("Location", `/p/${spelling}${suffix ? `/${suffix}` : ""}`);
          return send(res, 308, "");
        }
        if (!preview[2]) { res.setHeader("Location", `/mint?handle=${spelling}`); return send(res, 303, ""); }
        if (preview[2] === "variations") {
          const state = await publicPreviewState(service, spelling, galleryFixtures);
          if (state.state === "minted" || state.state === "confirming") spelling = state.renderHandle;
          if (preview[1] !== spelling) { res.setHeader("Location", `/p/${spelling}/variations`); return send(res, 303, ""); }
          return send(res, 200, previewVariationsPage(spelling, pageOptions(session), state));
        }
        const mbti = preview[2].toUpperCase();
        if (!isMbti(mbti)) throw new PublicError(404, "NOT_FOUND", "Use a four-letter MBTI type, such as ENFP.");
        const state = await publicPreviewState(service, spelling, galleryFixtures);
        if (state.state === "minted" || state.state === "confirming") spelling = state.renderHandle;
        if (preview[2] !== mbti || preview[1] !== spelling) { res.setHeader("Location", `/p/${spelling}/${mbti}`); return send(res, 303, ""); }
        return send(res, 200, previewPage(spelling, mbti, pageOptions(session), state));
      }
      const permalink = /^\/signatures\/([A-Za-z0-9_]{1,15})$/.exec(path);
      if (permalink) {
        // Samples use the same presentation URLs as real works, but only in the
        // explicitly enabled, offline fixture environment. They never fall back
        // into a live gallery or establish a durable/on-chain mint record.
        const sample = galleryFixtures ? galleryFixtureModel(permalink[1]!) : undefined;
        if (sample) {
          const canonicalPath = `/signatures/${sample.handle}`;
          if (path !== canonicalPath) { res.setHeader("Location", canonicalPath); return send(res, 303, ""); }
          return send(res, 200, assessmentPage(sample, pageOptions(session)));
        }
        const artifact = await service.artifact(permalink[1]!);
        if (!artifact) throw new PublicError(404, "NOT_FOUND", "Signature not found.");
        const mint = await service.state(artifact.assessment.handle);
        if (!canRevealMint(mint.state)) throw new PublicError(404, "NOT_FOUND", "This signature has not been included in a verified block yet.");
        return send(res, 200, assessmentPage({ handle: artifact.assessment.handle, code: "", status: "ready", canMint: false, ...artifactFields(artifact), mint }, pageOptions(session)));
      }
      throw new PublicError(404, "NOT_FOUND", "Page not found. Start a new signature request from the gallery.");
    } catch (error) {
      const known = error instanceof PublicError;
      const status = known ? error.status : 503;
      const message = known ? error.message : "This operation is temporarily unavailable. Please try again shortly.";
      if ((req.url ?? "").startsWith("/api/")) json(res, { error: message, code: known ? error.code : "SERVICE_UNAVAILABLE", ...(known ? publicErrorDetails(error.details) : {}) }, status);
      else send(res, status, errorPage(message, session ? pageOptions(session) : { stylesheetUrl: cssUrl, clientScriptUrl: scriptUrl }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
