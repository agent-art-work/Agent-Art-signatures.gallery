import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { canonicalHandle, handleDigest, isMbti, preservedHandle, RENDERER_VERSION } from "./identity.js";
import { generativeCommitment, generativeInputDigest, profileForRenderer } from "./generativeInputs.js";
import type { AssessmentPageModel } from "./pages.js";
import type { createGenerativeArtworkReads } from "./projection/generativeArtwork.js";
import { validateDeployment, type ProjectionDeployment } from "./projection/model.js";
import { PRIVATE_ROBOTS, LOCAL_ROBOTS_TXT } from "./sharing.js";
import { PublicError } from "./security.js";

const ORIGIN = "https://staging.signatures.gallery";
const PRIVATE_HEAD = `<meta name="robots" content="${PRIVATE_ROBOTS}">`;
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const previewRoute = (path: string) => /^\/p\/([A-Za-z0-9_]{1,15})\/([A-Z]{4}|variations)$/.exec(path);
export const SHARING_READ_LIMITS = Object.freeze({ inFlight: 2, timeoutMs: 5000, pngBytes: 2 * 1024 * 1024 });

/** Explicit staging-only composition. No environment auto-detection, public
 * indexing switch, saved-artifact/IPFS fallback, provider or signing port.
 * Models must come from the co-bound verified artwork reader, never requests.
 * Structural checks here cannot manufacture chain observation authority. */
export function createStagingGenerativeSharing(input: { origin: string; deployment: ProjectionDeployment }) {
  const deployment = validateDeployment(input.deployment), pin = deployment.generativeRenderer;
  if (Object.keys(input).sort().join() !== "deployment,origin" || input.origin !== ORIGIN || deployment.chainId !== "11155111"
    || !pin || profileForRenderer(pin).contractProfile !== "generative-v1-rc1") throw Error("Invalid staging sharing binding.");
  const profile = profileForRenderer(pin);
  function card(path: string, title: string, description: string, image?: string) {
    const meta = (name: string, value: string, property = false) => `<meta ${property ? "property" : "name"}="${name}" content="${escape(value)}">`;
    const canonical = ORIGIN + path;
    return [PRIVATE_HEAD, `<link rel="canonical" href="${escape(canonical)}">`, meta("og:type", "website", true),
      meta("og:site_name", "Signatures Gallery — staging", true), meta("og:url", canonical, true), meta("og:title", title, true),
      meta("og:description", description, true), meta("twitter:card", image ? "summary_large_image" : "summary"),
      meta("twitter:title", title), meta("twitter:description", description), ...(image ? [
        meta("og:image", ORIGIN + image, true), meta("og:image:secure_url", ORIGIN + image, true), meta("og:image:type", "image/png", true),
        meta("og:image:alt", title, true), meta("twitter:image", ORIGIN + image), meta("twitter:image:alt", title),
      ] : [])].join("\n");
  }
  function minted(handle: string, m?: AssessmentPageModel): string {
    if (!m || m.handle !== handle || m.status !== "ready" || m.code !== "" || m.canMint || m.galleryFixture
      || m.mint?.state !== "minted" || !m.renderHandle || preservedHandle(m.renderHandle) !== m.renderHandle
      || canonicalHandle(m.renderHandle) !== handle || !isMbti(m.mbti) || m.artifactDigest
      || m.rendererIdentity !== pin!.identity || m.rendererVersion !== profile.rendererVersion
      || m.tokenId !== BigInt(handleDigest(handle)).toString() || m.mint.tokenId !== m.tokenId
      || m.inputDigest !== generativeInputDigest(m.renderHandle, m.mbti, pin!.identity, profile.inputProfile)
      || m.imageUrl !== `/api/signatures/${handle}/artwork/${m.inputDigest}/svg`) return PRIVATE_HEAD;
    generativeCommitment(m.assessmentDigest); generativeCommitment(m.mint.transactionHash);
    return card(`/signatures/${handle}`, `@${m.renderHandle} × ${m.mbti} — minted signature (staging)`,
      "A finalized signature from the pinned on-chain renderer on Ethereum Sepolia. MBTI is an artistic input, not a psychological diagnosis.",
      `/sharing/signatures/${handle}/${m.inputDigest}.png`);
  }
  function head(path: string, model?: AssessmentPageModel): string {
    try {
      // Never normalize or strip query/fragment credentials into a public URL.
      if (typeof path !== "string" || path.includes("?") || path.includes("#")) return PRIVATE_HEAD;
      const work = /^\/signatures\/([a-z0-9_]{1,15})$/.exec(path);
      if (work) return minted(work[1], model);
      const preview = previewRoute(path);
      if (preview) {
        const [, handle, mbti] = preview;
        if (mbti === "variations") return card(path, `@${handle} — 16 signature variations (staging)`, "Explore 16 MBTI artistic interpretations. Preview choices do not determine the minted signature.");
        if (!isMbti(mbti)) return PRIVATE_HEAD;
        // A selected saved tile displays chain artwork, not a free preview.
        // Confirming keeps its on-page reveal but cannot become a social card.
        if (model && ["confirming", "minted"].includes(model.mint?.state ?? "") && model.mbti === mbti) {
          return model.renderHandle === handle ? minted(canonicalHandle(handle), model) : PRIVATE_HEAD;
        }
        return card(path, `@${handle} × ${mbti} — free preview (staging)`,
          "An editable signature preview using a chosen MBTI artistic input. This preview is not a verified Grok assessment or a minted artwork.",
          `/sharing/previews/${handle}/${mbti}/${RENDERER_VERSION}.png`);
      }
      if (path === "/") return card(path, "Signatures Gallery — staging", "Choose any X handle. Grok interprets it. Mint to reveal the signature. Ethereum Sepolia test environment.");
      if (path === "/about") return card(path, "About the work — Signatures Gallery (staging)", "An X handle, an artist-defined system, and Grok’s reading become a signature.");
      const mbti = /^\/([A-Z]{4})\/$/.exec(path)?.[1];
      return isMbti(mbti) ? card(path, `Signatures × ${mbti} — staging`, "Finalized signatures sharing one MBTI artistic input on Ethereum Sepolia.") : PRIVATE_HEAD;
    } catch { return PRIVATE_HEAD; }
  }
  return Object.freeze({
    head,
    decorate(html: string, path: string, model?: AssessmentPageModel) {
      // Only server-generated templates reach this function; no arbitrary head
      // HTML can be supplied via pageOptions or a user-controlled URL.
      return html.replace(/<meta name="robots" content="[^"]*">/g, "").replace("</head>", head(path, model) + "</head>");
    },
  });
}
export type GenerativeSharing = ReturnType<typeof createStagingGenerativeSharing>;

/** Read-only, uncached PNG delivery. The enclosing staging server owns the
 * binding/Host/proxy boundary. Unknown sharing paths never invoke a renderer.
 * A timed-out callback keeps its slot until it actually settles. */
export function createGenerativeSharingHandler(artwork: Pick<ReturnType<typeof createGenerativeArtworkReads>, "sharingPng">) {
  const read = artwork.sharingPng.bind(artwork), pending = new Set<Promise<unknown>>(); let active = 0;
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const raw = req.url ?? "";
    if (!raw.startsWith("/sharing/") && raw.split("?")[0] !== "/sitemap.xml") return false;
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    const controller = new AbortController(), cancel = () => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    res.once("close", cancel);
    try {
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new PublicError(405, "METHOD_NOT_ALLOWED", "Use GET."); }
      if (raw.length > 4096 || raw.includes("?") || raw.includes("#") || req.headers["transfer-encoding"]
        || req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") throw new PublicError(400, "INVALID_REQUEST", "Invalid sharing request.");
      const preview = /^\/sharing\/previews\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})\/([^/]+)\.png$/.exec(raw);
      const mint = /^\/sharing\/signatures\/([a-z0-9_]{1,15})\/(0x[0-9a-f]{64})\.png$/.exec(raw);
      // No staging sitemap enumeration, including an empty-looking public one.
      if (!mint && (!preview || !isMbti(preview[2]) || preview[3] !== RENDERER_VERSION)) throw new PublicError(404, "NOT_FOUND", "Sharing image unavailable.");
      if (active >= SHARING_READ_LIMITS.inFlight) throw new PublicError(503, "BUSY", "Sharing image unavailable.");
      active++; const expires = performance.now() + SHARING_READ_LIMITS.timeoutMs;
      const work = (async () => {
        try {
          controller.signal.throwIfAborted();
          const output = mint ? await read(mint[1], mint[2], controller.signal) : {
            mediaType: "image/png", bytes: await sharp(Buffer.from(renderSignatureSvg(preview![1], preview![2])), { limitInputPixels: 1080 * 1080 }).timeout({ seconds: 2 }).png().toBuffer(),
          };
          controller.signal.throwIfAborted();
          if (performance.now() >= expires || output.mediaType !== "image/png" || !output.bytes.length || output.bytes.length > SHARING_READ_LIMITS.pngBytes
            || !Buffer.from(output.bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error("Unavailable image.");
          return output.bytes;
        } finally { active--; }
      })();
      pending.add(work); work.then(() => pending.delete(work), () => pending.delete(work));
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(Error("Sharing read cancelled.")), { once: true });
        timer = setTimeout(cancel, SHARING_READ_LIMITS.timeoutMs);
      });
      const bytes = await Promise.race([work, stopped]);
      if (!res.destroyed && !res.writableEnded) { res.statusCode = 200; res.setHeader("Content-Type", "image/png"); res.setHeader("Content-Length", bytes.byteLength); res.end(Buffer.from(bytes)); }
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        res.statusCode = error instanceof PublicError ? error.status : 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end("Sharing image unavailable.");
      }
    } finally { clearTimeout(timer); controller.abort(); res.removeListener("close", cancel); }
    return true;
  };
  return Object.assign(handler, { async drain() { await Promise.allSettled([...pending]); } });
}

export { LOCAL_ROBOTS_TXT as STAGING_ROBOTS_TXT };
