import { createStagingTransportServer } from "../../src/openMint/staging/mintTransport.ts";
import { isStagingRuntime } from "./generative-staging-runtime.mjs";
import { readPrivateMintBody, privateMintFailure } from "../../src/openMint/persistence/http.ts";
import { PublicError, fields } from "../../src/openMint/security.ts";
import { checkStagingInstallation } from "./generative-staging-bootstrap.mjs";

const posts = new Set(["/api/wallet/challenge", "/api/wallet/verify", "/api/session/logout", "/api/assessments",
  "/api/mints/authorize", "/api/mints/begin", "/api/mints/report", "/api/mints/reject"]);
const json = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value));
};

/** Private loopback adapter behind one explicitly trusted local TLS proxy.
 * No listener startup, TLS provisioning or header-selected proxy trust. The
 * outer transport is derived from the branded runtime's captured binding. */
function composeStagingRuntimeApiServer(runtime, site, installed) {
  if ((!installed && process.env.NODE_ENV === "production") || !isStagingRuntime(runtime)) throw Error("Private staging HTTP harness required.");
  // Optional server-owned read composition, installed once by staging-site.
  // Never selected by URL, browser JSON, environment flags or wallet reports.
  if (site && (Object.keys(site).sort().join() !== "page,read,status" || Object.values(site).some(v => typeof v !== "function"))) throw Error("Invalid site composition.");
  const view = site && Object.freeze({ ...site });
  const server = createStagingTransportServer(runtime.transport, async (req, res, signal) => {
    const bodyTimer = setTimeout(() => req.destroy(), Math.min(10000, runtime.timeoutMs));
    try {
      if (view) {
        runtime.assertHealthy();
        if (await view.read(req, res) || await view.page(req, res)) { clearTimeout(bodyTimer); return; }
      }
      const path = req.url ?? "/", method = req.method;
      const status = /^\/api\/(?:assessments|mints\/status)\/([A-Za-z0-9_-]{43})$/.exec(path);
      const wallet = path === "/api/wallet/context" || /^\/api\/wallet\/context\?address=0x[0-9a-fA-F]{40}$/.test(path);
      if (!(method === "GET" ? path === "/api/session" || status || wallet : posts.has(path))) throw new PublicError(404, "NOT_FOUND", "Endpoint not found.");
      if (method === "GET") {
        clearTimeout(bodyTimer);
        if (path === "/api/session") {
          const { cookie, ...result } = await runtime.session(req.headers.cookie, signal);
          if (cookie) res.setHeader("Set-Cookie", cookie);
          return json(res, 200, result);
        }
        if (wallet) return json(res, 200, await runtime.walletContext(new URL(path, runtime.origin).searchParams.get("address") ?? undefined, req.headers.cookie, signal));
        const result = await (view ? view.status(status[1], req.headers.cookie, signal) : runtime.status(status[1], req.headers.cookie, signal));
        return json(res, 200, path.startsWith("/api/mints/status/") ? result.mint : result);
      }
      const input = await readPrivateMintBody(req, runtime.transport.maxRequestBytes); clearTimeout(bodyTimer);
      const auth = Object.freeze({ cookie: req.headers.cookie, origin: req.headers.origin, csrf: typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined });
      if (path === "/api/wallet/challenge") { const v = fields(input, ["address"], ["code"]);
        return json(res, 200, await runtime.challenge(v.address, v.code, auth, signal)); }
      if (path === "/api/wallet/verify") { const v = fields(input, ["challengeId", "signature"]);
        return json(res, 200, await runtime.verify(v.challengeId, v.signature, auth, signal)); }
      if (path === "/api/session/logout") {
        fields(input, []); const result = await runtime.logout(auth, signal);
        res.setHeader("Set-Cookie", runtime.expiredSessionCookie); return json(res, 200, result);
      }
      if (path === "/api/assessments") { const v = fields(input, ["handle"]); return json(res, 202, await runtime.create(v.handle, auth, signal)); }
      if (path === "/api/mints/report" || path === "/api/mints/reject") {
        const submitted = path.endsWith("/report"), v = fields(input, submitted ? ["code", "permit", "transactionHash"] : ["code", "permit"]);
        return json(res, 200, await runtime.report(v.code, v.permit, submitted ? "submitted" : "rejected", v.transactionHash, auth, signal));
      }
      const v = fields(input, ["code", "consent"]);
      return json(res, 200, await runtime[path.endsWith("/begin") ? "begin" : "authorize"](v.code, v.consent, auth, signal));
    } catch (error) {
      const f = privateMintFailure(error); json(res, f.status, { code: f.code, error: f.error }); req.resume();
    } finally { clearTimeout(bodyTimer); }
  });
  return server;
}

export function createStagingRuntimeApiServer(runtime, site) {
  return composeStagingRuntimeApiServer(runtime, site, false);
}

/** Production transport is available only through a separately checked
 * installed package/config. It is not a caller-selected boolean or env bypass. */
export function createInstalledStagingRuntimeApiServer(runtime, site, check, root) {
  if (process.env.NODE_ENV !== "production" || !site || !root) throw Error("Installed staging HTTP unavailable.");
  checkStagingInstallation(check, root);
  return composeStagingRuntimeApiServer(runtime, site, true);
}
