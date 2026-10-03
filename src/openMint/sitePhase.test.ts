import { describe, expect, it } from "vitest";
import { parseSiteLaunchMode, sitePhasePresentation, siteSaleStatus, type SiteSaleStatus } from "./sitePhase.js";

describe("website launch and contract sale phases", () => {
  it("keeps the existing open test deployment compatible by default", () => {
    expect(parseSiteLaunchMode()).toBe("open");
    expect(parseSiteLaunchMode("prelaunch")).toBe("prelaunch");
    expect(parseSiteLaunchMode("open")).toBe("open");
  });
  it.each([null, "", "free", "paid", "paused", "OPEN", "pre-launch", true, 0, {}])("rejects invalid launch configuration %j", value => {
    expect(() => parseSiteLaunchMode(value)).toThrow("Invalid website launch mode.");
  });
  it("requires explicit pre-launch, never inferring it from an outage or pause", () => {
    expect(siteSaleStatus("prelaunch")).toEqual({ phase: "prelaunch", paused: false });
    expect(siteSaleStatus("open")).toEqual({ phase: "unknown", paused: false });
    expect(siteSaleStatus("open", { phase: "free", paused: true, freeMinted: 0 })).toEqual({ phase: "free", paused: true, freeMinted: 0 });
    expect(siteSaleStatus("prelaunch", { phase: "paid", paused: true })).toEqual({ phase: "prelaunch", paused: true });
  });
  it("opening preserves actual economics, including paid or unknown, without mutating evidence", () => {
    for (const phase of ["free", "paid", "unknown"] as const) {
      const sale = Object.freeze({ phase, paused: false, freeMinted: 2, freeMintQuota: 2, freeConfigRevision: "3" });
      expect(siteSaleStatus("open", sale)).toBe(sale);
      expect(siteSaleStatus("prelaunch", sale)).toEqual({ phase: "prelaunch", paused: false });
      expect(sale.phase).toBe(phase);
    }
    expect(() => siteSaleStatus("open", { phase: "prelaunch", paused: false })).toThrow("pre-launch contract phase");
    expect(() => siteSaleStatus("free" as never)).toThrow("Invalid website launch mode.");
  });
  it.each([
    ["prelaunch", "Explore previews", "/explore", "Minting coming soon"],
    ["free", "Free Mint", "/mint", "Free Mint"],
    ["paid", "Paid Mint", "/mint", "Mint price"],
    ["unknown", "Mint a signature", "/mint", "Mint availability"],
  ] as const)("presents %s consistently", (phase, ctaLabel, ctaHref, title) => {
    expect(sitePhasePresentation({ phase, paused: false })).toMatchObject({ phase, prelaunch: phase === "prelaunch", ctaLabel, ctaHref, title });
  });
  it("pre-launch is informative and wallet-free even when the underlying contract is paused", () => {
    const state = sitePhasePresentation({ phase: "prelaunch", paused: true });
    expect(state.status).toBe("Minting coming soon.");
    expect(state.walletGuidance).toBe("Explore without a wallet. Minting hasn't opened yet.");
    expect(state.status).not.toMatch(/warning|paused|unavailable/i);
  });
  it.each(["free", "paid", "unknown"] as const)("treats %s maintenance as an overlay, not pre-launch", phase => {
    expect(sitePhasePresentation({ phase, paused: true })).toMatchObject({ phase, prelaunch: false, paused: true, status: "Minting is paused.", walletGuidance: "Minting is paused. You can still explore previews." });
  });
  it("shows free quotas without granting eligibility or a price quote", () => {
    const view = sitePhasePresentation({ phase: "free", paused: false, freeMinted: 1, freeMintQuota: 400 });
    expect(view.status).toBe("Free mint open · 1/400 slots used.");
    expect(view.walletGuidance).toBe("Connect your wallet to check your free mint slot.");
    expect(view).not.toHaveProperty("available");
    expect(view).not.toHaveProperty("priceWei");
    expect(sitePhasePresentation({ phase: "paid", paused: false }).walletGuidance).toBe("Connect your wallet to check the current price.");
  });
  it.each([[undefined, undefined], [-1, 4], [5, 4], [0, Infinity], [NaN, 4], [0, 1.5], [0, Number.MAX_SAFE_INTEGER + 1]])("omits untrustworthy counts %j/%j", (freeMinted, freeMintQuota) => {
    expect(sitePhasePresentation({ phase: "free", paused: false, freeMinted, freeMintQuota }).status).toBe("Free mint open.");
  });
  it("keeps unknown availability and legacy non-Pulse copy distinct", () => {
    expect(sitePhasePresentation().status).toBe("Checking mint availability…");
    expect(sitePhasePresentation(undefined, false).status).toBe("");
    expect(sitePhasePresentation({ phase: "untrusted" as never, paused: false }).phase).toBe("unknown");
  });
  it("uses the same self-contained presentation after browser serialization", () => {
    const browserCopy = Function(`return (${sitePhasePresentation.toString()})`)() as typeof sitePhasePresentation;
    for (const phase of ["prelaunch", "free", "paid", "unknown"] as const) for (const paused of [false, true]) {
      const status: SiteSaleStatus = { phase, paused, freeMinted: 0, freeMintQuota: 4 };
      expect(browserCopy(status)).toEqual(sitePhasePresentation(status));
    }
  });
});
