import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fields, PublicError } from "../security.js";
import { PRIVATE_ROBOTS } from "../sharing.js";
import { IssuanceBlockedError } from "./authorizations.js";
import { IssuanceBlockedError as GenerativeIssuanceBlockedError } from "./generativeAuthorizations.js";
import { AdmissionBlockedError } from "./repository.js";
import { DurableMintRuntime } from "./runtimeService.js";
import { createProjectionReadHandler, type ProjectionReads } from "../projection/http.js";
import type { createVerifiedArtworkReads } from "../projection/artwork.js";
import type { GenerativeMintBrowser } from "./generativeBrowser.js";
import { WalletChainUnavailableError } from "../walletChain.js";

const posts = new Set(["/api/wallet/challenge", "/api/wallet/verify", "/api/session/logout", "/api/assessments", "/api/mints/authorize"]);
const statusPath = /^\/api\/assessments\/([A-Za-z0-9_-]{43})$/;
const loopback = (ip: string | undefined) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value));
}
export async function readPrivateMintBody(req: IncomingMessage, maxBytes = 8192): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8192) throw new Error("Invalid private body limit.");
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new PublicError(415, "JSON_REQUIRED", "Use a JSON request.");
  if (req.headers["content-encoding"] !== undefined) throw new PublicError(415, "ENCODING_UNSUPPORTED", "Compressed requests are not accepted.");
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) throw new PublicError(413, "REQUEST_TOO_LARGE", "Request is too large.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > maxBytes) throw new PublicError(413, "REQUEST_TOO_LARGE", "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new PublicError(400, "INVALID_JSON", "Invalid JSON request."); }
}
export function privateMintFailure(error: unknown): { status: number; code: string; error: string } {
  if (error instanceof PublicError) return { status: error.status, code: error.code, error: error.message };
  if (error instanceof WalletChainUnavailableError) return { status: 503, code: "MINT_NETWORK_UNAVAILABLE", error: error.message };
  if (error instanceof AdmissionBlockedError) return { status: 503, code: "ASSESSMENT_ADMISSION_CLOSED", error: "New assessments are unavailable. Saved work is preserved." };
  if (error instanceof IssuanceBlockedError || error instanceof GenerativeIssuanceBlockedError) {
    const allowed: Record<string, [number, string]> = {
      CONSENT_REQUIRED: [400, "Choose Mint & reveal to continue."], SESSION_REQUIRED: [403, "Refresh this page and reconnect your wallet."],
      NOT_FOUND: [404, "Signature request not found."], REQUEST_EXPIRED: [410, "This request expired. Saved work is preserved."],
      WALLET_CHANGED: [409, "Your wallet changed. Reconnect it before continuing."], WALLET_PROOF_REQUIRED: [403, "Reconnect your wallet before continuing."],
      NOT_READY: [409, "The saved signature is not ready to mint."], MINT_RESERVED: [409, "This handle has a preserved mint reservation. Operator review is required."],
      AUTHORIZATION_EXPIRED: [409, "The mint authorization expired. Its reservation is preserved for review."],
      SIGNING_UNCERTAIN: [409, "The signing result needs operator review. No new signature will be requested automatically."],
      ISSUANCE_DISABLED: [503, "Mint authorization is unavailable. Saved work is preserved."],
      CHAIN_UNAVAILABLE: [503, "Mint eligibility cannot be verified right now."],
    };
    const known = allowed[error.code];
    if (known) return { status: known[0], code: error.code, error: known[1] };
  }
  return { status: 503, code: "SERVICE_UNAVAILABLE", error: "This operation is unavailable. Saved work is preserved; no automatic retry will occur." };
}

/** Loopback-only integration server, not the public/staging entrypoint. It
 * Public pages are an explicit optional read-only composition; no preview/provider
 * APIs, dev controls, private raw artifact reads, broadcaster or user-controlled
 * deployment/MBTI fields are exposed by default.
 */
export function createDurableMintApiServer(runtime: DurableMintRuntime, publicReads?: ProjectionReads, artwork?: Pick<ReturnType<typeof createVerifiedArtworkReads>, "media">,
  publicPages?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>, browser?: GenerativeMintBrowser) {
  if (browser && (browser.runtime !== runtime || !publicReads || !publicPages)) throw new Error("Browser composition requires matching runtime and public reads/pages.");
  if (process.env.NODE_ENV === "production" || runtime.requests.repository.namespace.profile !== "local-real"
    || runtime.requests.profile.chain_id !== "31337") throw new Error("Public durable HTTP startup remains disabled.");
  const origin = runtime.sessions.origin, host = new URL(origin).host;
  const readProjection = publicReads && createProjectionReadHandler(publicReads, artwork);
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS);
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (active >= 32) { req.resume(); return json(res, 503, { code: "BUSY", error: "Please try again later." }); }
    active++;
    // Bound body streaming too; requestTimeout alone does not protect direct
    // request-listener composition or a peer trickling chunks forever.
    const bodyTimer = setTimeout(() => req.destroy(), 10000);
    const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
    try {
      if (!loopback(req.socket.remoteAddress) || !loopback(req.socket.localAddress)) throw new PublicError(403, "LOCAL_ONLY", "This integration server is local only.");
      if (req.headers.host !== host) throw new PublicError(421, "WRONG_HOST", "Open the configured site address.");
      if (req.headers.forwarded !== undefined || Object.keys(req.headers).some(key => key.startsWith("x-forwarded-"))) throw new PublicError(400, "PROXY_UNSUPPORTED", "Proxy headers are not accepted by this local integration server.");
      if (readProjection && await readProjection(req, res)) return;
      if (browser && await browser.page(req, res)) return;
      if (publicPages && await publicPages(req, res)) return;
      const path = req.url ?? "/";
      const status = statusPath.exec(path), method = req.method;
      const mintStatus = browser && /^\/api\/mints\/status\/([A-Za-z0-9_-]{43})$/.exec(path);
      const pulseOptions=runtime.requests.pulse && /^\/api\/mints\/options\?handle=[A-Za-z0-9_]{1,15}$/.test(path);
      const walletContext = browser && (path === "/api/wallet/context" || /^\/api\/wallet\/context\?address=0x[0-9a-fA-F]{40}$/.test(path));
      const walletPost = browser && ["/api/mints/begin", "/api/mints/report", "/api/mints/reject"].includes(path);
      if (method !== "GET" && method !== "POST") throw new PublicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      if (!(method === "GET" ? path === "/api/session" || !!status || mintStatus || walletContext || pulseOptions : posts.has(path) || walletPost)) throw new PublicError(404, "NOT_FOUND", "Endpoint not found.");
      if (method === "GET" && (req.headers["transfer-encoding"] || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"))) throw new PublicError(400, "INVALID_INPUT", "GET requests must not include a body.");
      if (method === "GET") {
        clearTimeout(bodyTimer);
        if (path === "/api/session") {
          const found = await runtime.sessions.session(req.headers.cookie);
          if (found.created) res.setHeader("Set-Cookie", runtime.sessions.cookie(found.session));
          return json(res, 200, runtime.sessionView(found.session));
        }
        const session = await runtime.sessions.requireSession(req.headers.cookie);
        if(pulseOptions) return json(res,200,await runtime.mintOptions(new URL(path,origin).searchParams.get("handle"),session));
        if (walletContext) return json(res, 200, await browser!.chain.read(new URL(path, origin).searchParams.get("address") ?? undefined, controller.signal));
        if (mintStatus) return json(res, 200, await browser!.mintStatus(mintStatus[1], session));
        return json(res, 200, await (browser ? browser.status(status![1], session) : runtime.status(status![1], session)));
      }
      const input = await readPrivateMintBody(req); clearTimeout(bodyTimer);
      const session = await runtime.sessions.requireSession(req.headers.cookie);
      const csrf = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
      await runtime.sessions.authorizePost(session.id, req.headers.origin, csrf);
      const intent = { session, origin: req.headers.origin, csrf };
      if (path === "/api/wallet/challenge") {
        const payload = fields(input, ["address"], ["code"]);
        if (payload.code !== undefined) {
          if (typeof payload.code !== "string") throw new PublicError(400, "INVALID_INPUT", "Invalid request code.");
          await runtime.requests.get(payload.code, session.id);
        }
        return json(res, 200, await runtime.sessions.challenge(session.id, payload.address, payload.code as string | undefined));
      }
      if (path === "/api/wallet/verify") {
        const payload = fields(input, ["challengeId", "signature"]);
        await runtime.sessions.verify(session.id, payload.challengeId, payload.signature);
        return json(res, 200, runtime.sessionView(await runtime.sessions.requireSession(req.headers.cookie)));
      }
      if (path === "/api/session/logout") {
        fields(input, []); await runtime.sessions.logout(session.id);
        res.setHeader("Set-Cookie", runtime.sessions.clearCookie());
        return json(res, 200, { ok: true });
      }
      if (path === "/api/assessments") { const payload = fields(input, runtime.requests.pulse ? ["handle","mintIntent"] : ["handle"]); return json(res, 202, await runtime.create(payload.handle, intent, payload.mintIntent)); }
      if (walletPost && path !== "/api/mints/begin") {
        const submitted = path === "/api/mints/report", payload = fields(input, submitted ? ["code", "permit", "transactionHash"] : ["code", "permit"]);
        return json(res, 200, await browser!.submissions.report(payload.code as string, intent, payload.permit, submitted ? "submitted" : "rejected", payload.transactionHash));
      }
      const payload = fields(input, ["code", "consent"]);
      return json(res, 200, await (browser ? path === "/api/mints/begin" ? browser.begin(payload.code as string, payload.consent, intent, controller.signal)
        : browser.authorize(payload.code as string, payload.consent, intent, controller.signal) : runtime.authorize(payload.code, payload.consent, intent)));
    } catch (error) {
      // Never serialize a provider, database, signer or RPC error/cause.
      const failure = privateMintFailure(error); json(res, failure.status, { code: failure.code, error: failure.error });
      req.resume();
    } finally { clearTimeout(bodyTimer); controller.abort(); res.removeListener("close", cancel); active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
  return server;
}
