/** Website launch is separate from the contract's Free/Paid economics and
 * maintenance pause. Public presentation never grants wallet mint authority. */
export type SiteLaunchMode = "prelaunch" | "open";
export type SiteSalePhase = "prelaunch" | "free" | "paid" | "unknown";
export interface SiteSaleStatus {
  phase: SiteSalePhase;
  paused: boolean;
  freeMinted?: number;
  freeMintQuota?: number;
  freeConfigRevision?: string;
}

export function parseSiteLaunchMode(value: unknown = "open"): SiteLaunchMode {
  if (value !== "prelaunch" && value !== "open") throw new Error("Invalid website launch mode.");
  return value;
}

/** Unknown chain availability must not manufacture a pre-launch or paid phase.
 * Pre-launch is an explicit operator gate; opening follows actual chain state. */
export function siteSaleStatus(mode: SiteLaunchMode, sale?: SiteSaleStatus): SiteSaleStatus {
  parseSiteLaunchMode(mode);
  if (mode === "prelaunch") return { phase: "prelaunch", paused: sale?.paused === true };
  if (sale?.phase === "prelaunch") throw new Error("An open website cannot use a pre-launch contract phase.");
  return sale ?? { phase: "unknown", paused: false };
}

/** Self-contained so SSR and serialized browser clients use identical copy.
 * This is presentation only: checked wallet eligibility and fresh server-side
 * authorization are still required before any mint. */
export function sitePhasePresentation(sale?: SiteSaleStatus, pulseMint = true) {
  const phase: SiteSalePhase = sale && ["prelaunch", "free", "paid", "unknown"].includes(sale.phase) ? sale.phase : "unknown";
  const prelaunch = phase === "prelaunch";
  const paused = sale?.paused === true;
  const used = sale?.freeMinted, quota = sale?.freeMintQuota;
  const count = Number.isSafeInteger(used) && Number.isSafeInteger(quota) && used! >= 0 && quota! >= used!
    ? ` · ${used}/${quota} slots used.` : ".";
  return {
    phase, prelaunch, paused,
    ctaLabel: prelaunch ? "Explore previews" : phase === "free" ? "Free Mint" : phase === "paid" ? "Paid Mint" : "Mint a signature",
    ctaHref: prelaunch ? "/explore" : "/mint",
    title: prelaunch ? "Minting coming soon" : phase === "free" ? "Free Mint" : phase === "paid" ? "Mint price" : "Mint availability",
    status: prelaunch ? "Minting coming soon." : paused ? "Minting is paused." : phase === "free" ? "Free mint open" + count
      : phase === "paid" ? "Paid mint open · Free mint ended." : pulseMint ? "Checking mint availability…" : "",
    walletGuidance: prelaunch ? "Explore without a wallet. Minting hasn't opened yet." : paused ? "Minting is paused. You can still explore previews."
      : phase === "free" ? "Connect your wallet to check your free mint slot." : phase === "paid" ? "Connect your wallet to check the current price." : "Checking mint availability…",
  };
}
