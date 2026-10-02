import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SITE_CSS } from "../v1/siteCss.js";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_SOURCE } from "./sloganMbtiFrames.js";
import { SLOGAN_MBTI_HERO_LAYOUT, SLOGAN_MBTI_HERO_SVG, SLOGAN_MBTI_HERO_MANIFEST } from "./sloganMbtiHero.js";
import { INK_HOOK_QUESTION_MARK, OPEN_FLOW_QUESTION_MARK, REBALANCED_INK_HOOK_QUESTION_MARK } from "./sloganQuestionMark.js";
import {
  QUESTION_MARK_REVEAL_CSS,
  QUESTION_MARK_REVEAL_CSS_PATH,
  QUESTION_MARK_REVEAL_PATH,
  REVEAL_QUESTION_MARK_OPTIONS,
  questionMarkRevealStudyPage,
} from "./sloganQuestionMarkRevealStudy.js";

const stylesheet = "/assets/test-site.css";
const shapeIds = ["ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP"];
const optionIds = ["ink-hook", "rebalanced-ink-hook", "chisel-hook", "quiet-anchor"];

describe("read-only Reveal question-mark comparison", () => {
  it("retains both historical selections and provides immutable alternatives", () => {
    expect(QUESTION_MARK_REVEAL_PATH).toBe("/dev/question-mark-reveal");
    expect(QUESTION_MARK_REVEAL_CSS_PATH).toBe(`${QUESTION_MARK_REVEAL_PATH}.css`);
    expect(REVEAL_QUESTION_MARK_OPTIONS.map(mark => mark.id)).toEqual(optionIds);
    expect(Object.isFrozen(REVEAL_QUESTION_MARK_OPTIONS)).toBe(true);
    expect(REVEAL_QUESTION_MARK_OPTIONS.every(Object.isFrozen)).toBe(true);
    expect(REVEAL_QUESTION_MARK_OPTIONS[0]).toBe(INK_HOOK_QUESTION_MARK);
    expect(REVEAL_QUESTION_MARK_OPTIONS[1]).toBe(REBALANCED_INK_HOOK_QUESTION_MARK);
    expect(new Set(REVEAL_QUESTION_MARK_OPTIONS.map(mark => mark.svgMarkup)).size).toBe(4);
    expect(REVEAL_QUESTION_MARK_OPTIONS.some(mark => mark.svgMarkup === OPEN_FLOW_QUESTION_MARK.svgMarkup)).toBe(false);
  });

  it.each(REVEAL_QUESTION_MARK_OPTIONS)("keeps $id font-free and two-part with all control points inside 30 × 54", ({ label, rationale, svgMarkup }) => {
    expect(label.trim().length).toBeGreaterThan(0);
    expect(rationale.trim().length).toBeGreaterThan(0);
    expect(svgMarkup).toMatch(/^<g fill="currentColor" aria-hidden="true">.*<\/g>$/);
    expect(svgMarkup).not.toMatch(/<(?:text|script|style|svg|image|use|foreignObject)\b|\b(?:font|href|src|transform)[-\w]*=|url\(/i);
    const parts = [...svgMarkup.matchAll(/<(path|circle)\b[^>]*\/>/g)];
    expect(parts).toHaveLength(2);
    expect(parts.map(part => part[0]).join("")).toBe(svgMarkup.replace(/^<g[^>]*>|<\/g>$/g, ""));
    for (const [, path] of svgMarkup.matchAll(/<path d="([^"]+)"\/>/g)) {
      // These absolute commands keep coordinate pairs unambiguous. A Bézier
      // curve stays inside the convex bounds of its endpoints/control points.
      expect(path).toMatch(/^M[\d.,\sMCQLZ]+Z$/);
      const coordinates = path!.match(/\d+(?:\.\d+)?/g)!.map(Number);
      expect(coordinates.length % 2).toBe(0);
      coordinates.forEach((coordinate, index) => {
        expect(coordinate).toBeGreaterThanOrEqual(0);
        expect(coordinate).toBeLessThanOrEqual(index % 2 === 0 ? 30 : 54);
      });
    }
    for (const part of parts.filter(part => part[1] === "circle")) {
      const circle = /^<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/>$/.exec(part[0]);
      expect(circle).not.toBeNull();
      const [cx, cy, radius] = circle!.slice(1).map(Number) as [number, number, number];
      expect(radius).toBeGreaterThan(0);
      expect(cx - radius).toBeGreaterThanOrEqual(0);
      expect(cx + radius).toBeLessThanOrEqual(30);
      expect(cy - radius).toBeGreaterThanOrEqual(0);
      expect(cy + radius).toBeLessThanOrEqual(54);
    }
  });

  it("defaults to INFP and loads only external stylesheets", () => {
    const html = questionMarkRevealStudyPage(stylesheet);
    expect(html.match(/data-context="[^"]+" data-shape="INFP"/g)).toHaveLength(4);
    expect(html).toContain('<link rel="stylesheet" href="/assets/test-site.css">');
    expect(html).toContain(`<link rel="stylesheet" href="${QUESTION_MARK_REVEAL_CSS_PATH}">`);
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain('id="comparisons"');
    expect(html).not.toMatch(/<style\b|\bstyle=/);
  });

  it("identifies the historical Rebalanced ink hook selection without claiming it is on home", () => {
    const html = questionMarkRevealStudyPage(stylesheet);
    const rows = [...html.matchAll(/<figure class="qm-reveal-option" data-candidate="([^"]+)">([\s\S]*?)<\/figure>/g)];
    expect(rows).toHaveLength(4);
    expect(rows[0]![2]).toContain("Previous ink hook");
    expect(rows[0]![2]).toContain('<span class="qm-reveal-tag">Previous</span>');
    expect(rows[1]![1]).toBe("rebalanced-ink-hook");
    expect(rows[1]![2]).toContain('<span class="qm-reveal-tag">Historical selection</span>');
    expect(html.match(/class="qm-reveal-tag">Historical selection</g)).toHaveLength(1);
    expect(html).toContain("Earlier punctuation study");
    expect(html).toContain("The homepage title is Anyone_Can_Sign_Anyone, with no punctuation.");
    expect(html).not.toMatch(/On home|now on home|Selected: Rebalanced ink hook/);
  });

  it.each(SLOGAN_MBTI_FRAMES)("uses identical checked-in $mbti geometry and placement in all four comparisons", frame => {
    const html = questionMarkRevealStudyPage(stylesheet, frame.mbti);
    const contexts = [...html.matchAll(/<svg\b[^>]*data-context="([^"]+)"[^>]*>[\s\S]*?<\/svg>/g)];
    expect(contexts.map(context => context[1])).toEqual(optionIds);
    expect(SLOGAN_MBTI_SOURCE.displayText).toBe("Anyone_Can_Sign_Anyone");
    for (const [index, context] of contexts.entries()) {
      const mark = REVEAL_QUESTION_MARK_OPTIONS[index]!;
      expect(context[0]).toContain(`data-shape="${frame.mbti}"`);
      expect(context[0]).toContain(`viewBox="${SLOGAN_MBTI_HERO_LAYOUT.viewBox}"`);
      expect(context[0]).toContain(`width="${SLOGAN_MBTI_HERO_LAYOUT.width}"`);
      expect(context[0]).toContain(`height="${SLOGAN_MBTI_HERO_LAYOUT.height}"`);
      expect(context[0]).toContain(`<path d="${frame.d}" fill="currentColor"/>`);
      expect(context[0]).toContain(`<g data-context-mark="${mark.id}" transform="${SLOGAN_MBTI_HERO_LAYOUT.punctuationTransform}">${mark.svgMarkup}</g>`);
      expect(context[0]).toContain(SLOGAN_MBTI_SOURCE.displayText);
      expect(context[0]).not.toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    }
    expect(html.split(`<path d="${frame.d}"`)).toHaveLength(5);
    expect(createHash("sha256").update(frame.d).digest("hex")).toBe(frame.sha256);
    expect(html).not.toMatch(/<script\b|<form\b|<button\b|\bon[a-z]+=|<animate\b|<foreignObject\b/);
  });

  it.each(shapeIds)("offers exactly the eight canonical I-frame selectors with %s selected", shape => {
    const html = questionMarkRevealStudyPage(stylesheet, shape);
    const selector = html.match(/<[^>]*class="qm-reveal-types"[^>]*>([\s\S]*?)<\/(?:nav|div)>/);
    expect(selector).not.toBeNull();
    const links = [...selector![1]!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    expect(links).toHaveLength(8);
    expect(SLOGAN_MBTI_FRAMES.map(frame => frame.mbti)).toEqual(shapeIds);
    for (const [index, link] of links.entries()) {
      const frame = SLOGAN_MBTI_FRAMES[index]!;
      expect(link[1]).toContain(`href="${QUESTION_MARK_REVEAL_PATH}?shape=${frame.mbti}#comparisons"`);
      expect(link[1]).toContain(`aria-current="${frame.mbti === shape}"`);
      expect(link[2]).toContain(frame.mbti);
      expect(link[2]).toContain(frame.pairedMbti);
    }
    expect(links.filter(link => link[1]!.includes('aria-current="true"'))).toHaveLength(1);
  });

  it.each(["", "unknown", "ENFP", "infp", "INFP\n", " INFP", "INFP ", "__proto__", "constructor", '\"><img src=x onerror=alert(1)>'])("rejects an unlisted or unsafe shape: %s", shape => {
    expect(() => questionMarkRevealStudyPage(stylesheet, shape)).toThrow();
  });

  it("escapes the stylesheet attribute and limits navigation to read-only local links", () => {
    const html = questionMarkRevealStudyPage('/assets/test.css?foo=bar&label="<tag>');
    expect(html).toContain('href="/assets/test.css?foo=bar&amp;label=&quot;&lt;tag&gt;"');
    for (const [, href] of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      expect(href).toMatch(/^\/(?:$|dev\/question-mark-reveal\?shape=(?:ISTJ|ISFJ|INFJ|INTJ|ISTP|ISFP|INFP|INTP)#comparisons$)/);
    }
    expect(html).not.toMatch(/<script\b|<form\b|<button\b|\bon[a-z]+=/);
  });

  it("does not mutate current paths, the layout, or the homepage's absence of punctuation", () => {
    const heroBefore = SLOGAN_MBTI_HERO_SVG;
    const geometryBefore = JSON.stringify({ source: SLOGAN_MBTI_SOURCE, frames: SLOGAN_MBTI_FRAMES, layout: SLOGAN_MBTI_HERO_LAYOUT });
    for (const frame of SLOGAN_MBTI_FRAMES) questionMarkRevealStudyPage(stylesheet, frame.mbti);
    expect(JSON.stringify({ source: SLOGAN_MBTI_SOURCE, frames: SLOGAN_MBTI_FRAMES, layout: SLOGAN_MBTI_HERO_LAYOUT })).toBe(geometryBefore);
    expect(SLOGAN_MBTI_HERO_SVG).toBe(heroBefore);
    expect(SLOGAN_MBTI_HERO_MANIFEST.punctuation).toBeNull();
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain('data-punctuation-id=');
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    for (const mark of REVEAL_QUESTION_MARK_OPTIONS) {
      expect(SLOGAN_MBTI_HERO_SVG).not.toContain(mark.svgMarkup);
    }
  });

  it("inherits light/dark colors and provides static, keyboard-accessible mobile comparisons", () => {
    expect(SITE_CSS).toContain("color-scheme:light");
    expect(SITE_CSS).toContain("@media(prefers-color-scheme:dark)");
    expect(QUESTION_MARK_REVEAL_CSS).toContain("var(--ink)");
    expect(QUESTION_MARK_REVEAL_CSS).toContain("var(--paper)");
    expect(QUESTION_MARK_REVEAL_CSS).toContain(":focus-visible");
    expect(QUESTION_MARK_REVEAL_CSS).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
    expect(QUESTION_MARK_REVEAL_CSS).toMatch(/\.qm-reveal-option svg\{[^}]*width:100%;[^}]*height:auto/);
    expect(QUESTION_MARK_REVEAL_CSS).toMatch(/\.qm-reveal-types\{[^}]*flex-wrap:wrap/);
    expect(QUESTION_MARK_REVEAL_CSS).not.toMatch(/animation\s*:|@keyframes/);
  });
});
