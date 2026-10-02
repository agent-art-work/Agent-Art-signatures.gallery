import { describe, expect, it } from "vitest";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_SOURCE } from "./sloganMbtiFrames.js";
import { SLOGAN_MBTI_HERO_SVG, SLOGAN_MBTI_HERO_LAYOUT, SLOGAN_MBTI_HERO_MANIFEST } from "./sloganMbtiHero.js";
import { OPEN_FLOW_QUESTION_MARK, REBALANCED_INK_HOOK_QUESTION_MARK } from "./sloganQuestionMark.js";
import { QUESTION_MARK_V2_CANDIDATES } from "./sloganQuestionMarkCandidates.js";
import {
  QUESTION_MARK_STUDY_CSS,
  QUESTION_MARK_STUDY_CSS_PATH,
  QUESTION_MARK_STUDY_PATH,
  questionMarkStudyPage,
} from "./sloganQuestionMarkStudy.js";

const stylesheet = "/assets/test-site.css";
const combinations = QUESTION_MARK_V2_CANDIDATES.flatMap(mark => SLOGAN_MBTI_FRAMES.map(frame => ({ mark, frame })));

describe("read-only v2 question-mark proposal page", () => {
  it("defaults to the earlier Ink hook selection and INFP shape with three selectable proposals", () => {
    const html = questionMarkStudyPage(stylesheet);
    expect(QUESTION_MARK_V2_CANDIDATES.map(mark => mark.id)).toEqual(["ink-hook", "ribbon-fold", "quiet-solid"]);
    expect(html).toContain('data-candidate="ink-hook" aria-current="true"');
    expect(html).toContain('data-context="ink-hook" data-shape="INFP"');
    expect(html.match(/class="qm-option"/g)).toHaveLength(3);
    expect(html.match(/class="qm-glyph-large"/g)).toHaveLength(3);
    expect(html.match(/class="qm-glyph-small"/g)).toHaveLength(3);
    expect(html.match(/data-context="/g)).toHaveLength(2);
    expect(html.match(/<svg\b/g)).toHaveLength(8);
    expect(html).toContain('<link rel="stylesheet" href="/assets/test-site.css">');
    expect(html).toContain(`<link rel="stylesheet" href="${QUESTION_MARK_STUDY_CSS_PATH}">`);
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain("Earlier study");
    expect(html).toContain("Previous selection");
    expect(html).toContain("The homepage title is Anyone_Can_Sign_Anyone, with no punctuation.");
    expect(html).not.toMatch(/now on home|On home|homepage now uses/);
    expect(html).not.toContain("Preview only — nothing has changed on home.");
    expect(html).toContain("authored vector marks, not renderer output");
  });

  it.each(combinations)("compares $mark.id against the previous punctuation for $frame.mbti", ({ mark, frame }) => {
    const html = questionMarkStudyPage(stylesheet, mark.id, frame.mbti);
    const contexts = [...html.matchAll(/<svg data-context="([^"]+)"[^>]*>[\s\S]*?<\/svg>/g)];
    expect(contexts.map(context => context[1])).toEqual(["previous", mark.id]);
    for (const context of contexts) {
      expect(context[0]).toContain(`data-shape="${frame.mbti}"`);
      expect(context[0]).toContain(`viewBox="${SLOGAN_MBTI_HERO_LAYOUT.viewBox}" width="${SLOGAN_MBTI_HERO_LAYOUT.width}" height="${SLOGAN_MBTI_HERO_LAYOUT.height}"`);
      expect(context[0]).toContain(`<path d="${frame.d}" fill="currentColor"/>`);
      expect(context[0]).toContain(`transform="${SLOGAN_MBTI_HERO_LAYOUT.punctuationTransform}"`);
      expect(context[0]).toContain(SLOGAN_MBTI_SOURCE.displayText);
    }
    expect(html.split(`<path d="${frame.d}"`)).toHaveLength(3);
    expect(contexts[0]![0]).toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    expect(contexts[1]![0]).toContain(mark.svgMarkup);
    expect(contexts[1]![0]).not.toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    expect(html).toContain(`data-candidate="${mark.id}" aria-current="true"`);
    expect(html.match(/data-candidate="[^"]+" aria-current="true"/g)).toHaveLength(1);

    const selectors = [...html.matchAll(/<a href="([^"]+)" aria-current="(true|false)" aria-label="Compare ([^"]+)"/g)];
    expect(selectors).toHaveLength(8);
    expect(selectors.filter(link => link[2] === "true")).toHaveLength(1);
    SLOGAN_MBTI_FRAMES.forEach((option, index) => {
      expect(selectors[index]![1]).toBe(`${QUESTION_MARK_STUDY_PATH}?mark=${mark.id}&amp;shape=${option.mbti}#context`);
      expect(selectors[index]![3]).toBe(`${option.mbti} and ${option.pairedMbti} shape`);
      expect(selectors[index]![2]).toBe(String(option.mbti === frame.mbti));
    });
    for (const option of QUESTION_MARK_V2_CANDIDATES) {
      expect(html).toContain(`href="${QUESTION_MARK_STUDY_PATH}?mark=${option.id}&amp;shape=${frame.mbti}#context"`);
    }
    expect(html).not.toMatch(/<script\b|<form\b|\bon[a-z]+=|<animate\b|<foreignObject\b/);
  });

  it.each([
    ["", "INFP"], ["unknown", "INFP"], ["Ink-hook", "INFP"], ["ink-hook", ""],
    ["ink-hook", "ENFP"], ["ink-hook", "infp"], ["ink-hook", "INFP\n"],
    ['\"><script>alert(1)</script>', "INFP"], ["ink-hook", '\"><img src=x onerror=alert(1)>'],
    ["__proto__", "INFP"], ["constructor", "INFP"],
  ])("rejects unlisted or unsafe selections: %s / %s", (mark, shape) => {
    expect(() => questionMarkStudyPage(stylesheet, mark, shape)).toThrow("Unknown question-mark study option.");
  });

  it("escapes stylesheet attribute text and keeps links local and non-mutating", () => {
    const html = questionMarkStudyPage('/assets/test.css?foo=bar&label="<tag>');
    expect(html).toContain('href="/assets/test.css?foo=bar&amp;label=&quot;&lt;tag&gt;"');
    for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      expect(match[1]).toMatch(/^\/(?:$|dev\/question-mark-study\?mark=)/);
    }
    expect(html).not.toMatch(/<script\b|<form\b|<button\b|\bon[a-z]+=/);
  });

  it("leaves the current animated hero untouched by any proposal selection", () => {
    const initialHero = SLOGAN_MBTI_HERO_SVG;
    for (const { mark, frame } of combinations) questionMarkStudyPage(stylesheet, mark.id, frame.mbti);
    expect(SLOGAN_MBTI_HERO_SVG).toBe(initialHero);
    expect(SLOGAN_MBTI_HERO_MANIFEST.punctuation).toBeNull();
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain('data-punctuation-id=');
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain(REBALANCED_INK_HOOK_QUESTION_MARK.svgMarkup);
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    for (const mark of QUESTION_MARK_V2_CANDIDATES) {
      expect(SLOGAN_MBTI_HERO_SVG).not.toContain(mark.svgMarkup);
    }
  });

  it("supports keyboard focus, theme colors, and a stacked small-screen comparison without animation", () => {
    expect(QUESTION_MARK_STUDY_CSS).toContain(":focus-visible");
    expect(QUESTION_MARK_STUDY_CSS).toContain("var(--ink)");
    expect(QUESTION_MARK_STUDY_CSS).toContain("var(--paper)");
    expect(QUESTION_MARK_STUDY_CSS).toContain("@media(max-width:700px)");
    expect(QUESTION_MARK_STUDY_CSS).toContain(".qm-comparison{grid-template-columns:1fr}");
    expect(QUESTION_MARK_STUDY_CSS).not.toMatch(/animation\s*:|@keyframes/);
  });
});
