import { galleryFixtureModel } from "./galleryFixtures.js";
import { canonicalHandle, isMbti } from "./identity.js";
import type { MBTI } from "./identity.js";
import type { OpenMintService } from "./service.js";
import { canRevealMint } from "./revealPolicy.js";

/** Unincluded work stays hidden. Verified inclusion may be shown as confirming. */
export type PublicPreviewState =
  | { state: "unminted" | "pending" | "unavailable" }
  | {
    state: "confirming" | "minted" | "fixture";
    renderHandle: string;
    mbti: MBTI;
    rendererVersion: string;
    /** Generative tokens are read on chain; alternatives remain explicit, locked previews. */
    previewRendererVersion?: string;
    onchain?: boolean;
    imageUrl: string;
    url: string;
  };

/** Read-only: no account lookups, assessment requests, or mint authorizations. */
export async function publicPreviewState(service: OpenMintService, spelling: string, fixture = false): Promise<PublicPreviewState> {
  const handle = canonicalHandle(spelling);
  if (!service.network) {
    // Samples demonstrate the layout only at their exact sample spelling. They do
    // not establish minted identity or override a visitor's preview capitalization.
    const sample = fixture && service.options.fixture ? galleryFixtureModel(handle) : undefined;
    if (sample?.renderHandle === spelling && isMbti(sample.mbti) && sample.imageUrl && sample.rendererVersion) {
      return { state: "fixture", renderHandle: spelling, mbti: sample.mbti, rendererVersion: sample.rendererVersion,
        imageUrl: sample.imageUrl, url: `/signatures/${handle}` };
    }
    return { state: "unavailable" };
  }
  try {
    const mint = await service.state(handle);
    if (mint.state === "unminted" || mint.state === "pending") return { state: mint.state };
    if (!canRevealMint(mint.state)) return { state: "unavailable" };
    // state() verifies the on-chain commitments against the saved artifact. Never
    // publish its chosen type or spelling until inclusion verification succeeds.
    const artifact = await service.artifact(handle);
    if (!artifact) return { state: "unavailable" };
    return { state: mint.state === "minted" ? "minted" : "confirming", renderHandle: artifact.renderHandle ?? artifact.assessment.handle,
      mbti: artifact.assessment.mbti, rendererVersion: artifact.assessment.rendererVersion,
      imageUrl: `/artifacts/${artifact.svgSha256}.svg`, url: `/signatures/${handle}` };
  } catch {
    // Browsing remains possible during RPC/storage outages, but availability is
    // unknown. An outage must not offer another mint or expose a prepared result.
    return { state: "unavailable" };
  }
}
