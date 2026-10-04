import { createHash } from "node:crypto";
import { signatureIcon } from "./signatureIcon.js";

// Capital S has the fuller silhouette at favicon sizes. Lowercase s remains
// available in the comparison page; both use exact algorithm-derived outlines.
const icon = signatureIcon("S");
export const FAVICON_SVG = icon.svg;
export const FAVICON_MANIFEST = icon.manifest;

// Artwork colors remain the same in both themes; no embedded styles are needed.
export const FAVICON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const FAVICON_VERSION = createHash("sha256").update(FAVICON_SVG).update(FAVICON_CSP).digest("hex").slice(0, 16);
export const FAVICON_URL = `/assets/favicon.svg?v=${FAVICON_VERSION}`;
export const FAVICON_LINK = `<link rel="icon" href="${FAVICON_URL}" type="image/svg+xml" sizes="any">`;
