import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  SLOGAN_MBTI_HERO_CSS,
  SLOGAN_MBTI_HERO_LAYOUT,
  SLOGAN_MBTI_HERO_MANIFEST,
  SLOGAN_MBTI_HERO_SCRIPT,
  SLOGAN_MBTI_HERO_SCRIPT_URL,
  SLOGAN_MBTI_HERO_SVG,
} from "./sloganMbtiHero.js";
import { INK_HOOK_QUESTION_MARK, OPEN_FLOW_QUESTION_MARK, REBALANCED_INK_HOOK_QUESTION_MARK } from "./sloganQuestionMark.js";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_LAYOUT } from "./sloganMbtiFrames.js";

const TYPES = ["ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP"] as const;

function animationCycle() {
  const css = SLOGAN_MBTI_HERO_CSS;
  const durationMs = Number(css.match(/animation:slogan-mbti-cycle ([\d.]+)s linear infinite/)?.[1]) * 1_000;
  const keyframes = css.match(/@keyframes slogan-mbti-cycle\{([^\n]+)\}/)?.[1] ?? "";
  const stops = [...keyframes.matchAll(/([\d.% ,]+)\{opacity:([\d.]+)\}/g)]
    .flatMap(([, percentages, opacity]) => percentages!.split(",").map(percentage => ({
      timeMs: Number.parseFloat(percentage) / 100 * durationMs,
      opacity: Number(opacity),
    }))).sort((a, b) => a.timeMs - b.timeMs);
  const delays = [...css.matchAll(/\.slogan-mbti-frame-(\d+)\{animation-delay:([\d.-]+)s\}/g)]
    .map(([, frame, seconds]) => ({ frame: Number(frame), delayMs: Number(seconds) * 1_000 }))
    .sort((a, b) => a.frame - b.frame);

  function opacitiesAt(elapsedMs: number) {
    return delays.map(({ delayMs }) => {
      const phaseMs = ((elapsedMs - delayMs) % durationMs + durationMs) % durationMs;
      const endIndex = stops.findIndex(stop => stop.timeMs > phaseMs);
      const start = stops[endIndex - 1]!;
      const end = stops[endIndex]!;
      const progress = (phaseMs - start.timeMs) / (end.timeMs - start.timeMs);
      return start.opacity + (end.opacity - start.opacity) * progress;
    });
  }

  return { durationMs, stops, delays, opacitiesAt };
}

function eventTarget() {
  const handlers = new Map<string, Array<() => void>>();
  return {
    addEventListener: vi.fn((name: string, callback: () => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), callback]);
    }),
    fire(name: string) { for (const handler of handlers.get(name) ?? []) handler(); },
  };
}

function boot({ hidden = false, observer = true } = {}) {
  const loop = { dataset: {} as Record<string, string> };
  const document = {
    ...eventTarget(), hidden,
    querySelector: vi.fn((selector: string) => selector === ".slogan-loop" ? loop : null),
  };
  let intersection: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
  const observe = vi.fn();
  class Observer {
    constructor(callback: typeof intersection) { intersection = callback; }
    observe = observe;
  }
  const context = { document, ...(observer ? { IntersectionObserver: Observer } : {}) };
  runInNewContext(SLOGAN_MBTI_HERO_SCRIPT, context);
  return { loop, document, observe, context,
    intersect(visible: boolean) { intersection?.([{ isIntersecting: visible }]); },
  };
}

describe("eight-shape MBTI slogan hero", () => {
  it("declares the exact phrase, v2 source, eight geometric variants, and a 16-second loop", () => {
    expect(SLOGAN_MBTI_HERO_MANIFEST).toMatchObject({
      version: "sg-slogan-mbti-1.3.0",
      sourceRendererVersion: "sg-renderer-2.0.1",
      displayText: "Anyone_Can_Sign_Anyone",
      frameCount: 8,
      durationMs: 16_000,
      transitionMs: 1_000,
      initialOffsetMs: 1_000,
      punctuation: null,
    });
    expect(SLOGAN_MBTI_HERO_MANIFEST).not.toHaveProperty("sourceGr0kRaw");
    expect(SLOGAN_MBTI_HERO_MANIFEST).not.toHaveProperty("sourceGr0kScale");
  });

  it("widens the shared viewport with the upstream canvas while preserving height and aspect ratio", () => {
    const width = SLOGAN_MBTI_LAYOUT.canonical_width - 70;
    expect(SLOGAN_MBTI_HERO_LAYOUT).toEqual({
      viewBox: `35 145 ${width} 150`,
      width: width * 3,
      height: 450,
      punctuationTransform: `translate(${SLOGAN_MBTI_LAYOUT.canonical_width - 39} 195)`,
    });
    expect(width).toBeGreaterThan(380);
    expect(SLOGAN_MBTI_HERO_SVG).toContain(`viewBox="${SLOGAN_MBTI_HERO_LAYOUT.viewBox}"`);
    expect(SLOGAN_MBTI_HERO_SVG).toContain(`width="${SLOGAN_MBTI_HERO_LAYOUT.width}" height="450"`);
    expect(SLOGAN_MBTI_HERO_LAYOUT.width / SLOGAN_MBTI_HERO_LAYOUT.height).toBeCloseTo(width / 150, 12);
    expect(SLOGAN_MBTI_HERO_SVG).not.toMatch(/preserveAspectRatio="none"|\btransform="[^"]*scale\(/);
  });

  it("shares one stable viewport across exactly eight ordered, distinct drawings", () => {
    const svg = SLOGAN_MBTI_HERO_SVG;
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.match(/\bviewBox=/g)).toHaveLength(1);
    expect(svg).toContain('id="slogan-animation"');
    const frames = [...svg.matchAll(/<g\b([^>]*data-slogan-frame="([A-Z]{4})"[^>]*)>([\s\S]*?)<\/g>/g)];
    expect(frames.map(frame => frame[2])).toEqual(TYPES);
    const drawings = frames.map(frame => {
      expect(frame[3]!.match(/<path\b/g)).toHaveLength(1);
      expect(frame[0]).toContain('fill="currentColor"');
      return frame[3]!.match(/\bd="([^"]+)"/)?.[1];
    });
    expect(drawings.every(Boolean)).toBe(true);
    expect(new Set(drawings).size).toBe(8);
    expect(drawings).toEqual(SLOGAN_MBTI_FRAMES.map(frame => frame.d));
    expect(svg).not.toMatch(/data-slogan-frame="E[A-Z]{3}"/);
  });

  it("omits punctuation from the declarative slogan", () => {
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain("data-punctuation-id");
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain(REBALANCED_INK_HOOK_QUESTION_MARK.svgMarkup);
    expect(SLOGAN_MBTI_HERO_SVG.match(/<path\b/g)).toHaveLength(8);
  });

  it("locks the exact approved font-free Rebalanced ink hook independently of renderer geometry", () => {
    expect(Object.isFrozen(REBALANCED_INK_HOOK_QUESTION_MARK)).toBe(true);
    expect(REBALANCED_INK_HOOK_QUESTION_MARK).toMatchObject({ id: "rebalanced-ink-hook", version: "sg-question-mark-rebalanced-ink-hook-1" });
    expect(REBALANCED_INK_HOOK_QUESTION_MARK.svgMarkup.match(/<path\b/g)).toHaveLength(2);
    expect(createHash("sha256").update(REBALANCED_INK_HOOK_QUESTION_MARK.svgMarkup).digest("hex"))
      .toBe("959afaa6d6fe1e919576b1461cd4a01c32e1aa56735f111ce9ffad49b548b69a");
  });

  it("retains the previous font-free Ink hook unchanged for historical comparisons", () => {
    expect(Object.isFrozen(INK_HOOK_QUESTION_MARK)).toBe(true);
    expect(INK_HOOK_QUESTION_MARK).toMatchObject({ id: "ink-hook", version: "sg-question-mark-ink-hook-1" });
    expect(INK_HOOK_QUESTION_MARK.svgMarkup.match(/<path\b/g)).toHaveLength(2);
    expect(createHash("sha256").update(INK_HOOK_QUESTION_MARK.svgMarkup).digest("hex"))
      .toBe("72a357b439f11730fba953e6cccc2a01da6336a316c430b686bd81609eea2808");
  });

  it("is transparent, font-free, theme-aware, and contains no executable or remote content", () => {
    const svg = SLOGAN_MBTI_HERO_SVG;
    expect(svg).not.toMatch(/<rect\b|<text\b|font-family=|<script\b|<foreignObject\b/);
    expect(svg).not.toMatch(/\b(?:href|src)=|url\(|\bon\w+=/);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(svg).not.toMatch(/<animate\b|<animateTransform\b/);
    expect(svg).not.toMatch(/matrix\(|scale\([^)]*[, ]+[^)]*\)/);
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    expect(svg).not.toContain("Anyone_Can_Sign_Anyone");
  });

  it("has a renderer-free runtime boundary rather than generating artwork in the browser", () => {
    const source = readFileSync(new URL("./sloganMbtiHero.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["'][^"']*(?:algorithmV2|\/renderer\.(?:js|ts))/);
    expect(source).not.toMatch(/\b(?:execFile|spawn|renderSignatureSvg|renderSvgForText)\(/);
    expect(SLOGAN_MBTI_HERO_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|eth_sendTransaction/);
  });

  it("preserves hover/focus and visibility pause with a static reduced-motion fallback", () => {
    const css = SLOGAN_MBTI_HERO_CSS;
    expect(css).toContain("prefers-reduced-motion:reduce");
    expect(css).toMatch(/animation\s*:\s*none/);
    expect(css).toContain('data-slogan-suspended="true"');
    expect(css).toMatch(/animation-play-state\s*:\s*paused/);
    expect(css).toMatch(/:hover/);
    expect(css).toMatch(/:focus(?:-within|-visible)?/);
    expect(css).toMatch(/16s/);
    expect(css).toContain("infinite");
  });

  it("uses 1000ms crossfades and 1000ms holds while starting the eight-frame loop at its first fade", () => {
    const { durationMs, stops, delays } = animationCycle();
    expect(durationMs).toBe(SLOGAN_MBTI_HERO_MANIFEST.durationMs);
    expect(durationMs).toBe(16_000);

    expect(stops).toEqual([
      { timeMs: 0, opacity: 1 },
      { timeMs: 1_000, opacity: 1 },
      { timeMs: 2_000, opacity: 0 },
      { timeMs: 15_000, opacity: 0 },
      { timeMs: 16_000, opacity: 1 },
    ]);
    expect(stops[1]!.timeMs - stops[0]!.timeMs).toBe(1_000);
    expect(stops[2]!.timeMs - stops[1]!.timeMs).toBe(SLOGAN_MBTI_HERO_MANIFEST.transitionMs);
    expect(stops[4]!.timeMs - stops[3]!.timeMs).toBe(SLOGAN_MBTI_HERO_MANIFEST.transitionMs);

    expect(delays).toHaveLength(SLOGAN_MBTI_HERO_MANIFEST.frameCount);
    expect(delays.map(({ delayMs }) => delayMs)).toEqual([-1_000, -15_000, -13_000, -11_000, -9_000, -7_000, -5_000, -3_000]);
    const starts = delays.map(({ frame, delayMs }) => ({
      frame,
      timeMs: (delayMs + durationMs) % durationMs,
    }));
    expect(starts).toEqual(TYPES.map((_, frame) => ({
      frame,
      timeMs: (frame * 2_000 - SLOGAN_MBTI_HERO_MANIFEST.initialOffsetMs + durationMs) % durationMs,
    })));
  });

  it.each([
    { elapsedMs: 0, expected: [1, 0, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 100, expected: [0.9, 0.1, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 250, expected: [0.75, 0.25, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 500, expected: [0.5, 0.5, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 1_000, expected: [0, 1, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 2_000, expected: [0, 1, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 2_250, expected: [0, 0.75, 0.25, 0, 0, 0, 0, 0] },
    { elapsedMs: 16_000, expected: [1, 0, 0, 0, 0, 0, 0, 0] },
    { elapsedMs: 16_250, expected: [0.75, 0.25, 0, 0, 0, 0, 0, 0] },
  ])("starts A-to-B immediately and repeats without a startup hold at $elapsedMs ms", ({ elapsedMs, expected }) => {
    const actual = animationCycle().opacitiesAt(elapsedMs);
    expect(actual).toHaveLength(expected.length);
    actual.forEach((opacity, frame) => expect(opacity).toBeCloseTo(expected[frame]!, 10));
  });

  it("keeps exactly two adjacent drawings visible during every fade and never leaves a blank frame across wraparound", () => {
    const { durationMs, opacitiesAt } = animationCycle();
    for (let elapsedMs = 0; elapsedMs <= durationMs * 2; elapsedMs += 50) {
      const opacities = opacitiesAt(elapsedMs);
      const visible = opacities.flatMap((opacity, frame) => opacity > 0 ? [frame] : []);
      const outgoing = Math.floor(elapsedMs / 2_000) % TYPES.length;
      const incoming = (outgoing + 1) % TYPES.length;
      const slotMs = elapsedMs % 2_000;
      const expected = slotMs > 0 && slotMs < 1_000
        ? [outgoing, incoming].sort((a, b) => a - b)
        : [slotMs === 0 ? outgoing : incoming];

      expect(visible, `visible frames at ${elapsedMs}ms`).toEqual(expected);
      expect(opacities.reduce((sum, opacity) => sum + opacity, 0), `total opacity at ${elapsedMs}ms`).toBeCloseTo(1, 10);
      expect(opacities.every(opacity => opacity >= 0 && opacity <= 1)).toBe(true);
    }
  });

  it("content-addresses the CSP-compatible controller script", () => {
    const hash = createHash("sha256").update(SLOGAN_MBTI_HERO_SCRIPT).digest("hex").slice(0, 16);
    expect(SLOGAN_MBTI_HERO_SCRIPT_URL).toMatch(new RegExp(`^/assets/[^/]+-${hash}\\.js$`));
    expect(SLOGAN_MBTI_HERO_SCRIPT).not.toMatch(/\beval\(|new Function\(/);
  });

  it("does not fail or bind visibility events on pages without the hero", () => {
    const document = { querySelector: vi.fn(() => null), getElementById: vi.fn(() => null) };
    expect(() => runInNewContext(SLOGAN_MBTI_HERO_SCRIPT, { document, window: {} })).not.toThrow();
  });

  it("enables animation without a pause control and observes the hero once", () => {
    const { loop, document, observe } = boot();
    expect(loop.dataset).toEqual({ sloganReady: "true", sloganSuspended: "false" });
    expect(document.querySelector.mock.calls).toEqual([[".slogan-loop"]]);
    expect(document.addEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(loop);
  });

  it("has no removed toggle dependency and retains the first-frame no-JavaScript fallback", () => {
    expect(SLOGAN_MBTI_HERO_SCRIPT).not.toMatch(/data-slogan-toggle|sloganPaused|aria-pressed/);
    expect(SLOGAN_MBTI_HERO_CSS).not.toMatch(/slogan-motion-toggle|slogan-motion-pause|slogan-motion-play|data-slogan-paused/);
    expect(SLOGAN_MBTI_HERO_CSS).toContain(".slogan-mbti-frame{opacity:0}");
    expect(SLOGAN_MBTI_HERO_CSS).toContain(".slogan-mbti-frame:first-child{opacity:1}");
    expect(SLOGAN_MBTI_HERO_CSS).toMatch(/\.slogan-loop\[data-slogan-ready="true"\] \.slogan-mbti-frame\{animation:/);
  });

  it("suspends until both the document and the hero are visible", () => {
    const { loop, document, intersect } = boot({ hidden: true });
    expect(loop.dataset.sloganSuspended).toBe("true");
    document.hidden = false; document.fire("visibilitychange");
    expect(loop.dataset.sloganSuspended).toBe("false");
    intersect(false);
    expect(loop.dataset.sloganSuspended).toBe("true");
    document.fire("visibilitychange");
    expect(loop.dataset.sloganSuspended).toBe("true");
    intersect(true);
    expect(loop.dataset.sloganSuspended).toBe("false");
    document.hidden = true; document.fire("visibilitychange");
    expect(loop.dataset.sloganSuspended).toBe("true");
    intersect(true);
    expect(loop.dataset.sloganSuspended).toBe("true");
    document.hidden = false; document.fire("visibilitychange");
    expect(loop.dataset.sloganSuspended).toBe("false");
  });

  it("still suspends hidden documents when IntersectionObserver is unavailable", () => {
    const { loop, document, observe } = boot({ observer: false });
    expect(loop.dataset.sloganReady).toBe("true");
    expect(observe).not.toHaveBeenCalled();
    document.hidden = true; document.fire("visibilitychange");
    expect(loop.dataset.sloganSuspended).toBe("true");
    document.hidden = false; document.fire("visibilitychange");
    expect(loop.dataset.sloganSuspended).toBe("false");
  });

  it("does not register duplicate events or reset offscreen suspension when the asset executes twice", () => {
    const state = boot();
    state.intersect(false);
    runInNewContext(SLOGAN_MBTI_HERO_SCRIPT, state.context);
    expect(state.document.addEventListener).toHaveBeenCalledTimes(1);
    expect(state.observe).toHaveBeenCalledTimes(1);
    expect(state.loop.dataset.sloganSuspended).toBe("true");
    state.document.fire("visibilitychange");
    expect(state.loop.dataset.sloganSuspended).toBe("true");
    state.intersect(true);
    expect(state.loop.dataset.sloganSuspended).toBe("false");
  });
});
