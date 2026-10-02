import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_LAYOUT, SLOGAN_MBTI_SOURCE } from "./sloganMbtiFrames.js";
import { SLOGAN_MBTI_HERO_MANIFEST, SLOGAN_MBTI_HERO_SCRIPT, SLOGAN_MBTI_HERO_SVG } from "./sloganMbtiHero.js";
import { SIGNING_SLOGAN_CANDIDATES } from "./sloganSigningFrames.js";
import {
  SIGNING_SLOGAN_STUDY_CSS,
  SIGNING_SLOGAN_STUDY_CSS_PATH,
  SIGNING_SLOGAN_STUDY_PATH,
  signingSloganStudyPage,
} from "./sloganSigningStudy.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MBTI_ORDER = ["ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP"];
const LITERALS = [
  "Anyone_Can_Sign_Anyone",
  "AnyOneCanSignAnyone",
  "Anyone Can Sign Anyone",
  "Anyone can sign anyone",
] as const;
const PINNED_RENDERER_SHA256 = "bfa7ebdfb6e5ced7ddc0b92c3facb3709863ee6c6d10cf9a2f1596c018ecb896";

// SHA-256 of the eight ordered path hashes, separated by newlines. These
// independent pinned-oracle captures distinguish literal case and spacing.
const PINNED_FRAME_DIGESTS: Readonly<Record<string, string>> = {
  Anyone_Can_Sign_Anyone: "89194b0a854dac7a05a399e5663af85638ba260e14217a1a0e2b36bbb04d6468",
  AnyOneCanSignAnyone: "322d76b6138ce67829dd7f133bd7d6152d0133833c531305044cab770b3f9417",
  "Anyone Can Sign Anyone": "dcbd85e02793cee83ab491b3f6d0ee36b55747ef31198846d9f15b2560d43c30",
  "Anyone can sign anyone": "155c5e13fd069ebb7fe7d58b2bbf55ee1873b2b3760d15faca4b9ae785ac6ea5",
  Anyone: "41cea08e567a5d6edd0d65435bc521f520f28b4b8aa662b5423882c124a885ef",
  Can: "7e0fe7127de4e0b9b3c0b490a429be71423f954cffa44aa6ce78e0d80673b9b1",
  Sign: "51696dc003f18d0046ee4b88fddc70321370f9e8381fdca779cd7863635aed6c",
  can: "f24bea66d7895d56b9fe43f7639aa4467b1528f5c25546990734c1d0b5277fba",
  sign: "300470dfc29e802fe5d3526bd73a4002165a17d23611f654d320c4d16b1d4875",
  anyone: "94c8b89d8b1d363b932f34afac255a4b728c41930665fc0a01dddc94a3224a29",
};

type Capture = {
  source: typeof SLOGAN_MBTI_SOURCE | { displayText: string; rendererVersion: string; upstreamCommit: string; pythonSha256: string; adapter: string };
  layout: { character_count: number; canonical_width: number; canonical_height: number };
  frames: readonly { mbti: string; pairedMbti: string; d: string; sha256: string }[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function frameDigest(capture: Capture): string {
  return sha256(capture.frames.map(frame => frame.sha256).join("\n"));
}

function pythonCapture(literal: string): Capture {
  const args = literal === LITERALS[0]
    ? ["-B", "scripts/capture-slogan-v2.py", "--json"]
    : ["-B", "scripts/capture-signing-slogan-study.py", literal];
  return JSON.parse(execFileSync("python3", args, {
    cwd: ROOT, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
  })) as Capture;
}

function rows(html: string): string[] {
  return html.match(/<figure\b[^>]*data-signing-candidate[^>]*>[\s\S]*?<\/figure>/g) ?? [];
}

describe("signing slogan design study captures", () => {
  it("keeps the exact four approved literals in order, including the deliberate AnyOne capitalization", () => {
    expect(SIGNING_SLOGAN_CANDIDATES.map(candidate => candidate.id)).toEqual([
      "current", "camel", "title-words", "sentence-words",
    ]);
    expect(SIGNING_SLOGAN_CANDIDATES.map(candidate => candidate.literal)).toEqual(LITERALS);
    expect(SIGNING_SLOGAN_CANDIDATES.map(candidate => candidate.source.displayText)).toEqual(LITERALS);
    expect(SIGNING_SLOGAN_CANDIDATES.map(candidate => candidate.mode)).toEqual([
      "phrase", "phrase", "words", "words",
    ]);
    for (const candidate of SIGNING_SLOGAN_CANDIDATES) {
      expect(candidate.literal).not.toMatch(/[?.!]/);
      expect(candidate.layout.character_count).toBe(candidate.literal.length);
    }
  });

  it("pins every candidate to the unmodified v2.0.1 renderer and eight I/E pairs", () => {
    const rendererBytes = readFileSync(new URL("../../reference/algorithm-v2.0.1/signature_renderer_v2.0.1.py", import.meta.url));
    expect(sha256(rendererBytes)).toBe(PINNED_RENDERER_SHA256);
    for (const candidate of SIGNING_SLOGAN_CANDIDATES) {
      expect(candidate.source.rendererVersion).toBe("sg-renderer-2.0.1");
      expect(candidate.source.upstreamCommit).toBe("d00c018d1a740a5807480126d1f1bd0c620fb96d");
      expect(candidate.source.pythonSha256).toBe(PINNED_RENDERER_SHA256);
      expect(candidate.frames.map(frame => frame.mbti)).toEqual(MBTI_ORDER);
      expect(candidate.frames.map(frame => frame.pairedMbti)).toEqual(MBTI_ORDER.map(mbti => `E${mbti.slice(1)}`));
      expect(new Set(candidate.frames.map(frame => frame.sha256)).size).toBe(8);
      expect(frameDigest(candidate)).toBe(PINNED_FRAME_DIGESTS[candidate.literal]);
      for (const frame of candidate.frames) {
        expect(frame.d).toMatch(/^M[-\d., LCM]+Z$/);
        expect(sha256(frame.d)).toBe(frame.sha256);
      }
    }
  });

  it("captures both spaced sentences as four independently rendered, case-exact words", () => {
    expect(SIGNING_SLOGAN_CANDIDATES[0].words).toHaveLength(0);
    expect(SIGNING_SLOGAN_CANDIDATES[1].words).toHaveLength(0);
    expect(SIGNING_SLOGAN_CANDIDATES[2].words.map(word => word.source.displayText)).toEqual(["Anyone", "Can", "Sign", "Anyone"]);
    expect(SIGNING_SLOGAN_CANDIDATES[3].words.map(word => word.source.displayText)).toEqual(["Anyone", "can", "sign", "anyone"]);
    for (const candidate of SIGNING_SLOGAN_CANDIDATES.slice(2)) {
      expect(candidate.words).toHaveLength(4);
      for (const word of candidate.words) {
        expect(word.frames.map(frame => frame.mbti)).toEqual(MBTI_ORDER);
        expect(word.layout.character_count).toBe(word.source.displayText.length);
        expect(word.source.pythonSha256).toBe(PINNED_RENDERER_SHA256);
        expect(frameDigest(word)).toBe(PINNED_FRAME_DIGESTS[word.source.displayText]);
        for (const frame of word.frames) expect(sha256(frame.d)).toBe(frame.sha256);
      }
    }
    const title = SIGNING_SLOGAN_CANDIDATES[2].words;
    const sentence = SIGNING_SLOGAN_CANDIDATES[3].words;
    expect(title[0].frames).toEqual(sentence[0].frames);
    expect(title[0].frames).toEqual(title[3].frames);
    for (const index of [1, 2, 3]) {
      expect(frameDigest(title[index])).not.toBe(frameDigest(sentence[index]));
    }
  });

  it("matches exact offline Python captures for all phrase and word paths", () => {
    const oracle = new Map<string, Capture>();
    for (const candidate of SIGNING_SLOGAN_CANDIDATES) {
      for (const capture of [candidate, ...candidate.words]) {
        const literal = capture.source.displayText;
        if (!oracle.has(literal)) oracle.set(literal, pythonCapture(literal));
        const expected = oracle.get(literal)!;
        expect(capture.source).toEqual(expected.source);
        expect(capture.layout).toEqual(expected.layout);
        expect(capture.frames).toEqual(expected.frames);
      }
    }
    expect(oracle.size).toBe(10);
  });

  it("preserves the production slogan's exact immutable baseline and punctuation-free hero", () => {
    const current = SIGNING_SLOGAN_CANDIDATES[0];
    expect(current.source).toEqual(SLOGAN_MBTI_SOURCE);
    expect(current.layout).toEqual(SLOGAN_MBTI_LAYOUT);
    expect(current.frames).toEqual(SLOGAN_MBTI_FRAMES);
    expect(SLOGAN_MBTI_SOURCE.displayText).toBe("Anyone_Can_Sign_Anyone");
    expect(Object.isFrozen(SLOGAN_MBTI_SOURCE)).toBe(true);
    expect(Object.isFrozen(SLOGAN_MBTI_LAYOUT)).toBe(true);
    expect(Object.isFrozen(SLOGAN_MBTI_FRAMES)).toBe(true);
    expect(SLOGAN_MBTI_FRAMES.every(Object.isFrozen)).toBe(true);
    expect(SLOGAN_MBTI_HERO_MANIFEST.displayText).toBe(LITERALS[0]);
    expect(SLOGAN_MBTI_HERO_MANIFEST.punctuation).toBeNull();
    expect(SLOGAN_MBTI_HERO_SVG).not.toContain("data-punctuation");
    expect(execFileSync("python3", ["-B", "scripts/capture-slogan-v2.py", "--check"], {
      cwd: ROOT, encoding: "utf8", timeout: 20_000,
    })).toBe("Verified 8 pinned v2 slogan shapes and all I/E geometry pairs.\n");
  });

  it("does not relax real X-handle validation to accommodate study-only text", () => {
    for (const literal of LITERALS) {
      expect(() => renderSignatureSvg(literal, "ISTJ")).toThrow(/handle must match/);
    }
    expect(() => renderSignatureSvg("AnAgentArtist", "ISTJ")).not.toThrow();
  });
});

describe("signing slogan design study page", () => {
  it("lives on a separate noindex, read-only design route", () => {
    expect(SIGNING_SLOGAN_STUDY_PATH).toBe("/design/slogan-wording");
    expect(SIGNING_SLOGAN_STUDY_CSS_PATH).toBe("/assets/signing-slogan-study.css");
    const html = signingSloganStudyPage("/site.css");
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain('href="/site.css"');
    expect(html).toContain(`href="${SIGNING_SLOGAN_STUDY_CSS_PATH}"`);
    expect(html).not.toMatch(/<(?:form|input|button|select)\b|data-mint-|data-wallet-|\/api\//);
    expect(html).not.toContain("data-punctuation");
    expect(html).not.toContain("slogan-question-mark");
    expect(SLOGAN_MBTI_HERO_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|ethereum|eth_requestAccounts|wallet_|\/api\//);
  });

  it("renders four artworks, eight frames per row and four literal words only in spaced rows", () => {
    const html = signingSloganStudyPage("/site.css");
    const figures = rows(html);
    expect(figures).toHaveLength(4);
    expect(html.match(/<svg\b[^>]*data-signing-art/g)).toHaveLength(4);
    expect(html.match(/<g\b[^>]*data-slogan-frame=/g)).toHaveLength(32);
    expect(html.match(/<g\b[^>]*data-signing-word=/g)).toHaveLength(64);
    expect(html.match(/<path\b/g)).toHaveLength(80);
    for (const [index, figure] of figures.entries()) {
      const candidate = SIGNING_SLOGAN_CANDIDATES[index];
      expect(figure).toContain(`data-signing-candidate="${candidate.id}"`);
      expect(figure).toContain(candidate.literal);
      expect(figure.match(/data-slogan-frame=/g)).toHaveLength(8);
      expect(figure.match(/data-signing-word=/g) ?? []).toHaveLength(index < 2 ? 0 : 32);
      for (const frame of candidate.frames) expect(figure).toContain(`data-slogan-frame="${frame.mbti}"`);
    }
  });

  it("uses the literal word captures, not spaced-sentence paths or substituted capitalization", () => {
    const figures = rows(signingSloganStudyPage("/site.css"));
    for (const index of [0, 1]) {
      const candidate = SIGNING_SLOGAN_CANDIDATES[index];
      for (const frame of candidate.frames) expect(figures[index]).toContain(`d="${frame.d}"`);
    }
    for (const index of [2, 3]) {
      const candidate = SIGNING_SLOGAN_CANDIDATES[index];
      const words = [...figures[index].matchAll(/data-signing-word="([^"]+)" transform="([^"]+)"><path d="([^"]+)"/g)];
      expect(words).toHaveLength(32);
      for (const [position, match] of words.entries()) {
        const word = candidate.words[position % 4];
        expect(match[1]).toBe(word.source.displayText);
        expect(match[3]).toBe(word.frames[Math.floor(position / 4)].d);
        expect(match[2]).toMatch(/^translate\(-?[\d.]+ 0\)$/);
        expect(match[2]).toBe(words[position % 4][2]);
      }
      for (const frame of candidate.frames) expect(figures[index]).not.toContain(`d="${frame.d}"`);
    }
  });

  it("shares one synchronized 1000ms fade plus 1000ms hold loop with hover, focus and reduced-motion support", () => {
    const html = signingSloganStudyPage("/site.css");
    expect(html.match(/class="slogan-loop"/g)).toHaveLength(1);
    expect(html).toContain('data-animation="on"');
    expect(html).toContain('tabindex="0" aria-label="Four slogan comparisons"');
    expect(html).toContain("1000ms fade + 1000ms hold");
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain("animation:slogan-mbti-cycle 16s linear infinite");
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain("@keyframes slogan-mbti-cycle{0%,6.25%{opacity:1}12.5%,93.75%{opacity:0}100%{opacity:1}}");
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain(".slogan-loop:hover .slogan-mbti-frame");
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain(".slogan-loop:focus-within .slogan-mbti-frame");
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain("animation-play-state:paused");
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain("prefers-reduced-motion:reduce");
    for (const [index, mbti] of MBTI_ORDER.entries()) {
      expect(html.match(new RegExp(`class="slogan-mbti-frame slogan-mbti-frame-${index}" data-slogan-frame="${mbti}"`, "g"))).toHaveLength(4);
    }
  });

  it.each(MBTI_ORDER)("holds %s in all four candidates while keeping the other seven frames hidden", shape => {
    const html = signingSloganStudyPage("/site.css", shape);
    expect(html).toContain('data-animation="off"');
    expect(html).toContain(`Holding ${shape} / E${shape.slice(1)}.`);
    expect(html.match(/data-active="true"/g)).toHaveLength(4);
    expect(html.match(/data-active="false"/g)).toHaveLength(28);
    for (const figure of rows(html)) {
      expect(figure).toContain(`data-slogan-frame="${shape}" data-mbti-pair="${shape}/E${shape.slice(1)}" data-active="true"`);
    }
    expect(html).toContain(`href="${SIGNING_SLOGAN_STUDY_PATH}?shape=${shape}" aria-current="page"`);
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain('.signing-study[data-animation="off"] .slogan-loop .slogan-mbti-frame{animation:none;opacity:0}');
    expect(SIGNING_SLOGAN_STUDY_CSS).toContain('.signing-study[data-animation="off"] .slogan-loop .slogan-mbti-frame[data-active="true"]{opacity:1}');
  });

  it.each(["istj", "ESTJ", "INXX", "", '<script>alert("x")</script>'])("treats invalid shape %j as animated, without echoing it", shape => {
    const html = signingSloganStudyPage("/site.css", shape);
    expect(html).toBe(signingSloganStudyPage("/site.css"));
    expect(html).not.toContain('data-active="true"');
  });

  it("offers fit and native-scale comparisons without stretching any individual word path", () => {
    const fit = signingSloganStudyPage("/site.css", "INTP", "fit");
    const native = signingSloganStudyPage("/site.css", "INTP", "native");
    expect(fit).toContain('data-layout="fit"');
    expect(native).toContain('data-layout="native"');
    const viewBoxes = (html: string) => [...html.matchAll(/data-signing-art="[^"]+" viewBox="([^"]+)"/g)]
      .map(match => match[1].split(" ").map(Number));
    const fitBoxes = viewBoxes(fit);
    const nativeBoxes = viewBoxes(native);
    expect(fitBoxes).toHaveLength(4);
    expect(nativeBoxes).toHaveLength(4);
    expect(new Set(nativeBoxes.map(box => box[2])).size).toBe(1);
    expect(new Set(fitBoxes.map(box => box[2])).size).toBeGreaterThan(1);
    expect(new Set([...fitBoxes, ...nativeBoxes].map(box => `${box[1]} ${box[3]}`)).size).toBe(1);
    expect(native).not.toMatch(/transform="[^"]*(?:scale|matrix)\(/);
    expect(fit).not.toMatch(/transform="[^"]*(?:scale|matrix)\(/);
    expect(native).toContain("Same stroke scale");
    expect(fit).toContain("Fit to equal width");
    expect(native).toContain('href="/design/slogan-wording?shape=INTP&amp;layout=native" aria-current="page"');
    expect(rows(native).map(figure => [...figure.matchAll(/<path d="([^"]+)"/g)].map(match => match[1])))
      .toEqual(rows(fit).map(figure => [...figure.matchAll(/<path d="([^"]+)"/g)].map(match => match[1])));
  });

  it("escapes stylesheet URLs without introducing active markup", () => {
    const html = signingSloganStudyPage('/site.css"><script>bad()</script>');
    expect(html).toContain('href="/site.css&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;"');
    expect(html).not.toContain("<script>bad()");
  });
});
