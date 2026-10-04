import { describe, expect, it } from "vitest";
import { assessmentPage, aboutPage, type AssessmentPageModel } from "./pages.js";
import { MBTI_TYPES, LEGACY_RENDERER_VERSION } from "./identity.js";

const model: AssessmentPageModel = {
  handle: "alice_bob", renderHandle: "Alice_Bob", code: "private-code", status: "ready", canMint: false,
  mint: { state: "minted", tokenId: "123", transactionHash: "0x" + "f".repeat(64) },
  mbti: "ENFP", assessmentProvenance: "grok", assessmentModel: "grok-saved-model",
  assessedAt: "2026-09-19T00:00:00.000Z", identityVerifiedAt: "2026-09-18T23:59:58.000Z", verifiedXUserId: "123456789",
  assessmentSourceUrls: ["https://x.com/Alice_Bob/status/456", "https://example.org/research?q=one&lang=en"],
  rendererVersion: "sg-renderer-2.0.0", svgSha256: "a".repeat(64), pngSha256: "b".repeat(64), svgUrl: "/saved.svg",
};
const body = (value: AssessmentPageModel): string => assessmentPage(value).match(/<div class="signature-provenance-body">([\s\S]*?)<\/details>/)![1]!;

describe("saved assessment provenance", () => {
  it("uses recorded source and actual model, not runtime configuration, and remains collapsed", () => {
    const html = assessmentPage(model, { development: { fixture: true } });
    expect(html).toContain('<details class="signature-provenance"><summary>Provenance</summary>');
    expect(html).toContain('<dt>Assessor</dt><dd>Grok</dd>');
    expect(html).toContain('<dt>Model</dt><dd>grok-saved-model</dd>');
    expect(html).toContain(`<dt>Assessed</dt><dd>${model.assessedAt}</dd>`);
    expect(html).toContain('not a cryptographic signature from Grok');
    expect(html).toContain('<h2>Assessment</h2>');
    expect(html).toContain('<h2>Artwork</h2>');
    expect(html).toContain('<h2>Mint</h2>');
    expect(html.match(/>Caveat</g)).toHaveLength(1);
    expect(html).not.toContain('private-code');
  });

  it("identifies fixture inputs only inside provenance without inventing a real assessment", () => {
    const html = assessmentPage({ ...model, assessmentProvenance: "development-fixture", assessmentModel: "development-fixture-v1" });
    expect(html).toContain('<dt>Assessor</dt><dd>Sample input</dd>');
    expect(html).toContain('Sample MBTI input; Grok was not called.');
    expect(html).toContain(`<dt>Created</dt><dd>${model.assessedAt}</dd>`);
    expect(html).not.toContain('Spelling verified at preparation');
    expect(html).not.toContain('data-assessment-sources');
    const chrome = html.replace(/<details class="signature-provenance">[\s\S]*?<\/details>/, "");
    expect(chrome).not.toContain('Sample input');
    expect(chrome).not.toContain('Grok was not called');
  });

  it("never infers Grok from a missing source or fabricates legacy identity evidence", () => {
    const unknown = body({ ...model, assessmentProvenance: undefined, assessmentModel: undefined, assessmentSourceUrls: undefined });
    expect(unknown).toContain('<dt>Assessor</dt><dd>Not recorded</dd>');
    expect(unknown).not.toContain('<dt>Model</dt>');
    expect(unknown).not.toContain('Spelling verified');
    expect(unknown).not.toContain('https://x.com/');
    const legacy = body({ ...model, rendererVersion: LEGACY_RENDERER_VERSION, identityVerifiedAt: undefined, verifiedXUserId: undefined });
    expect(legacy).toContain('<dt>Assessor</dt><dd>Grok</dd>');
    expect(legacy).toContain(`<dt>Renderer</dt><dd>${LEGACY_RENDERER_VERSION}</dd>`);
    expect(legacy).not.toContain('Spelling verified');
    expect(legacy).not.toContain('/i/user/');
  });

  const names: Record<string, string> = { E: "Extraversion", I: "Introversion", S: "Sensing", N: "Intuition", T: "Thinking", F: "Feeling", J: "Judging", P: "Perceiving" };
  it.each(MBTI_TYPES)("explains the four letters of %s without personality stereotypes", mbti => {
    const html = body({ ...model, mbti });
    expect(html).toContain(`${mbti}<span class="provenance-mbti-meaning">${[...mbti].map(letter => `<span>${letter} — ${names[letter]}</span>`).join(" · ")}</span>`);
    expect(html).not.toMatch(/confidence|rationale|diagnosed|Architect|Campaigner/);
  });

  it("shows saved citations as safe external links with no embedded remote content", () => {
    const html = body(model);
    expect(html).toContain('<a href="https://x.com/Alice_Bob/status/456" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">https://x.com/Alice_Bob/status/456 ↗</a>');
    expect(html).toContain('https://example.org/research?q=one&amp;lang=en');
    expect(html).toContain('Their contents may change or become unavailable.');
    expect(html).not.toMatch(/<iframe|<img|<script/);
    expect(html).toContain('href="https://x.com/i/user/123456789"');
    expect(html).toContain('href="/p/Alice_Bob/variations">@Alice_Bob</a>');
  });

  it.each([
    'javascript:alert(1)', 'data:text/html,hello', 'http://x.com/Alice_Bob', '//x.com/Alice_Bob',
    'https://user:pass@x.com/Alice_Bob', 'https://x.com:444/Alice_Bob', 'https://x.com/\\evil',
    'https://x.com/\nAlice_Bob', 'https://x.com/' + 'a'.repeat(2048), 'not a URL',
  ])("does not link unsafe source %s", value => {
    const html = body({ ...model, assessmentSourceUrls: [value] });
    expect(html).not.toContain('data-assessment-sources');
    expect(html).toContain('No source links available in this record.');
  });

  it("escapes URL markup, deduplicates links and bounds the list without mutating saved input", () => {
    const input = Object.freeze({ ...model, assessmentSourceUrls: Object.freeze(['https://example.org/"<svg>/', ...Array.from({ length: 150 }, (_, index) => `https://x.com/i/status/${index + 1}`)]) });
    const before = JSON.stringify(input);
    const html = body(input);
    expect(html).not.toContain('<svg>');
    expect(html).toContain('%22%3Csvg%3E');
    expect(html.match(/<li>/g)).toHaveLength(128);
    expect(JSON.stringify(input)).toBe(before);
    expect(body({ ...model, assessmentSourceUrls: [model.assessmentSourceUrls![0]!, model.assessmentSourceUrls![0]!] }).match(/<li>/g)).toHaveLength(1);
  });

  it.each(['0', '1/other', '<script>', '9'.repeat(21)])("does not construct an account link from invalid ID %s", verifiedXUserId => {
    expect(body({ ...model, verifiedXUserId })).not.toContain('/i/user/');
  });

  it.each(["pending", "ready", "failed", "abstained"] as const)("does not disclose evidence in unconfirmed %s pages", status => {
    for (const state of ["pending", "unminted"] as const) {
      const html = assessmentPage({ ...model, status, mint: { state } });
      for (const value of ["signature-provenance", "grok-saved-model", model.assessedAt!, model.identityVerifiedAt!, model.verifiedXUserId!, "ENFP", "https://example.org/research"]) expect(html).not.toContain(value);
    }
  });

  it("preserves the About publisher link separately from artwork-handle navigation", () => {
    const about = aboutPage().match(/<article class="about-page"[^>]*>([\s\S]*?)<\/article>/)![1]!;
    expect(about).toContain('<a href="https://x.com/AnAgentARTist" target="_blank" rel="noopener noreferrer">AnAgentARTist ↗</a>');
    expect(about).not.toContain("AgentArt_AA");
  });
});
