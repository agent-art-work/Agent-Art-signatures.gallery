import { renderSignatureSvg } from "../algorithmV2/index.js";
import { FAVICON_CSP, FAVICON_URL } from "../brand/favicon.js";
import { SLOGAN_MBTI_HERO_SCRIPT_URL } from "../brand/sloganMbtiHero.js";
import { SLOGAN_TOOLTIP_SCRIPT_URL } from "../brand/sloganTooltipScript.js";
import { AGENT_DOCUMENT_PATHS, agentDocument } from "../openMint/agentDocuments.js";
import { isMbti, MBTI_TYPES, preservedHandle, RENDERER_VERSION } from "../openMint/identity.js";
import {
  aboutPage, collectionPage, errorPage, explorePage, homePage, mbtiGalleryPage,
  mintPage, previewPage, previewVariationsPage, type OpenMintPageOptions,
} from "../openMint/pages.js";
import { siteSaleStatus } from "../openMint/sitePhase.js";

export const PREVIEW_STYLESHEET_PATH = "/assets/preview.css";
export const PREVIEW_CLIENT_SCRIPT_PATH = "/assets/preview.js";
export const PREVIEW_PUBLIC_ORIGINS = [
  "https://staging.signatures.gallery", "https://signatures.gallery",
] as const;

/** No optional mint mode, provider, database, wallet, key or contract binding. */
export interface PreviewWorkerEnv {
  PUBLIC_ORIGIN: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PREVIEW_READINESS = Object.freeze({
  live: true,
  frontendOnly: true,
  siteLaunchMode: "prelaunch",
  mintingEnabled: false,
  walletConnectionEnabled: false,
  rpcEnabled: false,
});
const staticAssetPaths = new Set([
  PREVIEW_STYLESHEET_PATH, PREVIEW_CLIENT_SCRIPT_PATH,
  new URL(FAVICON_URL, PREVIEW_PUBLIC_ORIGINS[0]).pathname,
  new URL(SLOGAN_MBTI_HERO_SCRIPT_URL, PREVIEW_PUBLIC_ORIGINS[0]).pathname,
  new URL(SLOGAN_TOOLTIP_SCRIPT_URL, PREVIEW_PUBLIC_ORIGINS[0]).pathname,
]);

function previewOptions(origin: string): OpenMintPageOptions {
  return {
    publicOrigin: origin,
    stylesheetUrl: PREVIEW_STYLESHEET_PATH,
    clientScriptUrl: PREVIEW_CLIENT_SCRIPT_PATH,
    generativeArtwork: true,
    pulseMint: true,
    siteLaunchMode: "prelaunch",
    pulseSaleStatus: siteSaleStatus("prelaunch"),
    mintObservationManaged: true,
  };
}

/** Static font files must be from the packaged distributor, not arbitrary paths. */
function fontAssetPath(path: string): boolean {
  return /^\/assets\/fonts\/playpen-sans-\d+\.\d+\.\d+\/(?:playpen-sans-[a-z0-9-]+\.woff2|LICENSE\.txt)$/.test(path);
}

/** URL keys are unique and scoped to the single route that actually uses them. */
function allowedQuery(url: URL, keys: readonly string[]): boolean {
  return [...url.searchParams.keys()].every(key => keys.includes(key) && url.searchParams.getAll(key).length === 1);
}

function assetContentType(path: string, value: string | null): boolean {
  const type = value?.split(";")[0].trim().toLowerCase();
  if (path.endsWith(".woff2")) return type === "font/woff2";
  if (path.endsWith(".css")) return type === "text/css";
  if (path.endsWith(".js")) return type === "text/javascript" || type === "application/javascript";
  if (path.endsWith(".svg")) return type === "image/svg+xml";
  return path.endsWith("/LICENSE.txt") && type === "text/plain";
}

/** Anonymous prelaunch presentation only. No mint/session API can be enabled by configuration. */
export async function handlePreviewRequest(request: Request, env: PreviewWorkerEnv): Promise<Response> {
  const staging = env?.PUBLIC_ORIGIN === PREVIEW_PUBLIC_ORIGINS[0];
  const headers = () => new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Strict-Transport-Security": "max-age=31536000",
    ...(staging ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
  });
  const send = (status: number, body: BodyInit | null, contentType = "text/plain; charset=utf-8", extra?: HeadersInit) => {
    const output = headers();
    output.set("Content-Type", contentType);
    if (status >= 400) output.set("X-Robots-Tag", staging ? "noindex, nofollow" : "noindex");
    if (extra) new Headers(extra).forEach((value, key) => output.set(key, value));
    return new Response(request.method === "HEAD" ? null : body, { status, headers: output });
  };
  const json = (status: number, value: unknown) => send(status, JSON.stringify(value) + "\n", "application/json; charset=utf-8", { "X-Robots-Tag": "noindex" });

  if (!PREVIEW_PUBLIC_ORIGINS.includes(env?.PUBLIC_ORIGIN as typeof PREVIEW_PUBLIC_ORIGINS[number]) || typeof env?.ASSETS?.fetch !== "function") {
    return send(503, "Preview service configuration is unavailable.");
  }
  let url: URL;
  try { url = new URL(request.url); } catch { return send(400, "Invalid request URL."); }
  const validAuthority = !url.username && !url.password && (!request.headers.has("Host") || request.headers.get("Host") === url.host);
  const sameHostHttp = url.protocol === "http:" && !url.port && url.hostname === new URL(env.PUBLIC_ORIGIN).hostname;
  const readMethod = request.method === "GET" || request.method === "HEAD";
  if (!validAuthority || (url.origin !== env.PUBLIC_ORIGIN && !(sameHostHttp && readMethod))) {
    return send(421, "This host is not configured for the preview service.");
  }
  if (request.url.length > 2048 || /[%\\\u0000-\u0020]/.test(url.pathname) || url.pathname.includes("//")) {
    return send(400, "Invalid request path.");
  }
  // Upgrade only this deployment's exact public host. Never redirect a write,
  // foreign authority, credential-bearing URL or non-default port, and never
  // let forwarding headers choose the redirect destination.
  if (sameHostHttp) return send(308, "", undefined, { Location: env.PUBLIC_ORIGIN + url.pathname + url.search });
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) {
    return json(409, { code: "SITE_NOT_OPEN", error: "Minting has not opened yet. Explore previews for now." });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return send(405, "Method not allowed.", undefined, { Allow: "GET, HEAD" });
  }

  const options = previewOptions(env.PUBLIC_ORIGIN);
  const html = (value: string, status = 200) => {
    // Shared development/mint pages stay noindex; public production documents
    // receive canonical metadata here, without changing those shared defaults.
    const indexable = !staging && status === 200 && !["/mint", "/me"].includes(path) && !url.search;
    if (indexable) {
      value = value.replace('<meta name="robots" content="noindex">', '<meta name="robots" content="index, follow">');
      value = value.replace("</head>", `<link rel="canonical" href="${env.PUBLIC_ORIGIN}${path}"></head>`);
    }
    return send(status, value, "text/html; charset=utf-8", {
      // Cloudflare Web Analytics respects no-transform when deciding whether
      // to inject its beacon. Public HTML must still revalidate on every use.
      ...(status === 200 ? { "Cache-Control": "public, max-age=0, must-revalidate, no-transform" } : {}),
      ...(indexable ? {} : { "X-Robots-Tag": "noindex" }),
    });
  };
  const redirect = (location: string, status = 308) => send(status, "", undefined, { Location: location });

  try {
    if ((AGENT_DOCUMENT_PATHS as readonly string[]).includes(path)) {
      if (url.search) return send(400, "Documentation accepts no query parameters.");
      const document = agentDocument(path, options)!;
      return send(200, document.body, document.contentType);
    }
    const isAsset = staticAssetPaths.has(path) || fontAssetPath(path);
    if (isAsset) {
      const favicon = path === new URL(FAVICON_URL, env.PUBLIC_ORIGIN).pathname;
      if (!allowedQuery(url, favicon ? ["v"] : []) || (favicon && url.search && url.search !== new URL(FAVICON_URL, env.PUBLIC_ORIGIN).search)) {
        return send(400, "Invalid asset parameters.");
      }
      let asset: Response;
      try { asset = await env.ASSETS.fetch(request); } catch { return send(503, "Asset is unavailable."); }
      if (asset.status !== 200) return send(asset.status === 404 ? 404 : 503, "Asset is unavailable.");
      if (!assetContentType(path, asset.headers.get("Content-Type"))) return send(503, "Asset is unavailable.");
      const assetHeaders = headers();
      assetHeaders.set("Content-Type", asset.headers.get("Content-Type") ?? "application/octet-stream");
      assetHeaders.set("Cache-Control", path === PREVIEW_STYLESHEET_PATH || path === PREVIEW_CLIENT_SCRIPT_PATH
        ? "no-cache" : "public, max-age=300");
      if (favicon) assetHeaders.set("Content-Security-Policy", FAVICON_CSP);
      // The binding serves only packaged public files. Never relay cookies,
      // redirects, stale security headers or an upstream HTML fallback.
      return new Response(request.method === "HEAD" ? null : asset.body, { status: 200, headers: assetHeaders });
    }
    if (path === "/explore" || path === "/mint") {
      if (!allowedQuery(url, ["handle"])) return send(400, "This page only accepts one handle.");
      const handle = url.searchParams.get("handle") ?? "";
      if (path === "/explore" && handle) {
        try { return redirect(`/p/${preservedHandle(handle.trim())}/variations`, 302); } catch { /* Keep the escaped draft editable. */ }
      }
      return html(path === "/explore" ? explorePage(handle, options) : mintPage(handle, options));
    }
    const image = /^\/preview\/([A-Za-z0-9_]{1,15})\/([A-Za-z]{4})\.svg$/.exec(path);
    if (image && isMbti(image[2].toUpperCase())) {
      if (!allowedQuery(url, ["renderer"]) || (url.searchParams.has("renderer") && url.searchParams.get("renderer") !== RENDERER_VERSION)) {
        return send(400, "This preview renderer is not available.");
      }
      const mbti = image[2].toUpperCase();
      if (!isMbti(mbti)) return send(404, "Page not found.");
      if (image[2] !== mbti) return redirect(`/preview/${image[1]}/${mbti}.svg${url.search}`);
      // HEAD uses the same validated route and response metadata, but must not
      // spend rendering CPU on artwork whose body will immediately be omitted.
      return send(200, request.method === "HEAD" ? null : renderSignatureSvg(image[1], mbti), "image/svg+xml; charset=utf-8", {
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'",
        "Cache-Control": "public, max-age=300",
        "X-Robots-Tag": "noindex",
      });
    }
    if (url.search) return send(400, "This route accepts no query parameters.");
    if (["/health", "/health/live", "/health/ready"].includes(path)) return json(200, PREVIEW_READINESS);
    if (path === "/robots.txt") return send(200, staging ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mint\nDisallow: /me\nSitemap: ${env.PUBLIC_ORIGIN}/sitemap.xml\n`);
    if (path === "/sitemap.xml") {
      const pages = ["/", "/about", "/explore", ...MBTI_TYPES.map(mbti => `/${mbti}/`)];
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(page => `<url><loc>${env.PUBLIC_ORIGIN}${page}</loc></url>`).join("")}</urlset>`, "application/xml; charset=utf-8");
    }
    if (path === "/") return html(homePage(options));
    if (path === "/about") return html(aboutPage(options));
    if (path === "/me") return html(collectionPage([], options));
    const group = /^\/([A-Za-z]{4})\/?$/.exec(path);
    if (group && isMbti(group[1].toUpperCase())) {
      const mbti = group[1].toUpperCase();
      if (!isMbti(mbti)) return send(404, "Page not found.");
      if (path !== `/${mbti}/`) return redirect(`/${mbti}/`);
      return html(mbtiGalleryPage(mbti, [], options));
    }
    const preview = /^\/(p|s)\/([A-Za-z0-9_]{1,15})(?:\/(variations|[A-Za-z]{4}))?\/?$/.exec(path);
    if (preview) {
      const handle = preservedHandle(preview[2]);
      const suffix = preview[3] ?? "variations";
      const mbti = suffix.toUpperCase();
      if (suffix !== "variations" && !isMbti(mbti)) return html(errorPage("Page not found.", options), 404);
      const canonical = `/p/${handle}/${suffix === "variations" ? suffix : mbti}`;
      if (path !== canonical) return redirect(canonical);
      // There is no mint projection in this service. Do not pretend to check
      // chain status or label the chosen preview as a minted token.
      if (suffix === "variations") return html(previewVariationsPage(handle, options, { state: "unavailable" }));
      if (!isMbti(mbti)) return send(404, "Page not found.");
      return html(previewPage(handle, mbti, options, { state: "unavailable" }));
    }
    return html(errorPage("Page not found.", options), 404);
  } catch {
    return send(500, "The preview could not be rendered. Please try again shortly.");
  }
}

export default { fetch: handlePreviewRequest };
