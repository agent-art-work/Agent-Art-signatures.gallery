import { describe, expect, it } from "vitest";
import { aboutPage, OPEN_MINT_CSS, type OpenMintPageOptions } from "./pages.js";
import { handoffPrompt } from "./pages.js";
import { aboutReadingPrompt } from "./aboutReadingPrompt.js";

const article = (options: OpenMintPageOptions = {}) => aboutPage(options).match(/<article class="about-page"[^>]*>([\s\S]*?)<\/article>/)![1]!;
const field = (name: string, options: OpenMintPageOptions = {}) => article(options).match(new RegExp(`<p data-about-${name}>([\\s\\S]*?)<\\/p>`))![1]!;

describe("About the work context and evidence boundaries", () => {
  it("puts an Agent reading invitation immediately after the heading, before the artwork introduction", () => {
    const html = article({ publicOrigin: "http://127.0.0.1:3008" });
    expect(html).toContain('<h1 id="about-heading">About the work</h1><details class="auth-disclosure about-reading" data-about-reading>');
    expect(html.indexOf('data-about-reading')).toBeLessThan(html.indexOf('Signatures Gallery turns an X handle'));
    expect(html).toContain('<summary><span>Ask your Agent about the work</span>');
    expect(html).toContain('class="about-reading-action">Get prompt');
    expect(html).toContain('data-copy-about-reading><span>Copy prompt</span>');
    expect(html).toContain('data-about-reading-feedback role="status" aria-live="polite"');
    expect(html).toContain('readonly rows="10" data-about-reading-prompt aria-label="Prompt to understand About the work"');
    expect(html).not.toContain('View reading prompt');
    expect(html).not.toContain('Copy reading prompt');
    expect(html).toContain('Read http://127.0.0.1:3008/about and http://127.0.0.1:3008/agent-index.json.');
    expect(html).not.toContain('data-connect-wallet');
  });
  it("uses a scoped Pulse-style disclosure with thin rules, a right-side action and visible keyboard focus", () => {
    const html = article();
    expect(html).toContain('class="about-reading-symbol" aria-hidden="true"');
    expect(html).toContain('<div class="about-reading-content">');
    expect(html).toContain('href="/agent-index.json">Document index');
    expect(html).toContain('href="/prompts/about.txt">Open prompt');
    expect(OPEN_MINT_CSS).toContain('.open-mint .about-sheet .about-reading{margin:0 0 2rem;border-block:1px solid var(--line)');
    expect(OPEN_MINT_CSS).toContain('.open-mint .about-reading-action{display:inline-flex');
    expect(OPEN_MINT_CSS).toContain('margin-inline-start:auto;flex:none;white-space:nowrap');
    expect(OPEN_MINT_CSS).toContain('.open-mint .about-reading>summary:focus-visible{outline:2px solid var(--ink)');
    expect(OPEN_MINT_CSS).toContain('.open-mint .about-reading-symbol::before{content:"+"}');
    expect(OPEN_MINT_CSS).toContain('.open-mint .about-reading[open] .about-reading-symbol::before{content:"−"}');
  });
  it("introduces the artistic premise before explaining the participation flow", () => {
    const html = article();
    expect(html).toContain('<h1 id="about-heading">About the work</h1>');
    expect(aboutPage()).toContain('aria-labelledby="about-heading"');
    for (const title of ["Agent Art", "Artist, Agent and minter", "From handle to mark", "Explore", "Mint &amp; reveal", "Identity and ownership", "Artwork and provenance", "Context and further reading"]) {
      expect(html).toContain(`>${title}</h2>`);
    }
    expect(html.indexOf('id="about-agent-art"')).toBeLessThan(html.indexOf('<h2>Explore</h2>'));
    expect(html).toContain("not a reproduction of someone’s handwriting");
    expect(html).toContain("artistic framing, not a technical certificate");
    expect(html).toContain("not a technical certificate or a claim of machine consciousness");
  });

  it("links the supplied references as context without importing another work's claims", () => {
    const html = article();
    for (const href of ["https://inshell.art/docs/agent-art.md", "https://inshell.art/docs/generative-art.md", "https://inshell.art/docs/lineage.md", "https://agentart.work/guidance/"]) {
      expect(html).toContain(`href="${href}" target="_blank" rel="noopener noreferrer"`);
    }
    expect(html).toContain("Its methods are provisional, not a certification of this work.");
    expect(html).toContain("not claims of affiliation or endorsement");
    expect(html).not.toMatch(/world(?:wide|’s|\s+first)|first\s+(?:AI|agent|autonomous)\s+artwork|THOUGHT|Mono 76|\$PATH/i);
    expect(html).toContain('href="https://x.com/AnAgentARTist"');
    expect(html).toContain("Project 01 by");
  });

  it("separates interpretation and deterministic drawing from psychological or visual-uniqueness claims", () => {
    const html = article();
    for (const mapping of ["E/I reverses the light and dark palette", "S/N changes curvature and smoothing", "T/F changes how the filled stroke’s outline is constructed", "J/P changes spacing and vertical variation"]) expect(html).toContain(mapping);
    expect(html).toContain("The same handle and MBTI, interpreted by the same renderer, produce the same image.");
    expect(html).toContain("These are artistic correspondences");
    expect(html).not.toMatch(/every (?:handle|image|signature) is unique|T\/F.*(?:filled versus outline|fill versus stroke)/);
    expect(field("agent-role")).toContain("Grok does not draw its strokes or rewrite the renderer.");
    expect(html).toContain("not a cryptographic signature from Grok");
    expect(html).toContain("not a complete private conversation or proof of the Agent’s inner intention");
  });

  it.each([false, true])("keeps sample attribution honest with generativeArtwork=%s", generativeArtwork => {
    const options = { assessmentSource: "sample" as const, generativeArtwork, pulseMint: true };
    expect(field("agent-role", options)).toContain("The Grok workflow is designed");
    expect(field("agent-role", options)).toContain("its appearance alone does not establish that Grok participated");
    const html = article(options);
    expect(html).toContain("The assessment source is recorded in each work’s provenance.");
    expect(html).not.toContain("asks Grok to research public X posts");
    expect(html).not.toContain("Grok interprets public X communication and chooses");
    expect(html).not.toMatch(/deterministic fixture|Sepolia test|development fixture/);
  });

  it.each([false, true])("keeps generic development fixtures source-neutral with generativeArtwork=%s", generativeArtwork => {
    const options = { development: { fixture: true }, generativeArtwork };
    expect(field("agent-role", options)).toContain("The Grok workflow is designed");
    expect(article(options)).not.toContain("asks Grok to research public X posts");
    expect(article(options)).not.toContain("independently verifies the current X username spelling");
    expect(article(options)).not.toContain("Grok interprets public X communication and chooses");
  });

  it.each([undefined, "grok"] as const)("explains the first accepted assessment rather than claiming a fresh call on every attempt (%s)", assessmentSource => {
    const html = article({ assessmentSource });
    expect(html).toContain("On the first successful preparation");
    expect(html).toContain("independently verifies the current X username spelling");
    expect(html).toContain("Later attempts reuse the accepted record rather than asking for a preferred result.");
    expect(html).toContain("It does not accept the preview’s MBTI.");
    expect(html).toContain("Preview pages do not call our assessment service or authorize a mint.");
  });

  it.each([undefined, "grok", "sample"] as const)("does not conflate generated on-chain art with saved-image preservation (%s)", assessmentSource => {
    const generative = field("construction", { assessmentSource, generativeArtwork: true });
    expect(generative).toContain("immutable inputs");
    expect(generative).toContain("fixed on-chain renderer");
    expect(generative).toContain("metadata with an embedded SVG");
    expect(generative).not.toContain("SVG and its embedded metadata");
    expect(generative).toContain("without an uploaded image or an IPFS file");
    expect(generative).toContain("viewing surfaces, not the source");
    const snapshot = field("construction", { assessmentSource });
    expect(snapshot).toContain("preserves the prepared SVG");
    expect(snapshot).toContain("depends on retaining those files");
    expect(snapshot).not.toContain("fixed on-chain renderer");
    expect(snapshot).not.toContain("without an uploaded image");
  });

  it("scopes handle identity and makes participation distinct from ownership or endorsement", () => {
    const html = article();
    expect(html).toContain("Within this collection, there is one minted token per handle");
    expect(html).toContain("Identity follows the handle, not the X account ID.");
    expect(html).toContain("wallet eligibility, handle availability and the current mint phase still apply");
    expect(html).toContain("does not require control of its X account");
    expect(html).toContain("does not prove ownership or control of the X account");
    expect(html).toContain("imply the account holder’s endorsement");
    expect(html).toContain("The recorded spelling is an artwork input, not a live profile");
  });

  it("keeps the reading and preview prompts separate with read-only discovery", () => {
    const options = { publicOrigin: "http://127.0.0.1:3008", assessmentSource: "sample" as const };
    const html = article(options);
    const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" })[entity]!);
    const prompts = [...html.matchAll(/<textarea\b[^>]*readonly[^>]*>([\s\S]*?)<\/textarea>/g)].map(match => decode(match[1]!));
    expect(prompts).toEqual([aboutReadingPrompt(options.publicOrigin), handoffPrompt(options.publicOrigin)]);
    expect(html.match(/data-copy-about-reading/g)).toHaveLength(1);
    expect(html.match(/data-copy-handoff/g)).toHaveLength(1);
    expect(html.match(/data-handoff-prompt/g)).toHaveLength(1);
    expect(html).toContain('data-copy-feedback role="status" aria-live="polite"');
    expect(html).toContain("Minting uses the backend’s own assessment, not this preview.");
    expect(html).toContain("Do not assess an X account, request an assessment, connect a wallet, sign or mint.");
    for (const path of ["/agent-index.json", "/prompts/about.txt", "/prompts/mint-assessment.txt"]) expect(html).toContain(`href="${path}"`);
    expect(aboutPage(options)).toContain('<link rel="alternate" type="application/json" href="/agent-index.json" title="Agent documentation">');
  });

  it("consolidates Agent resources into the opening disclosure without another section or full assessment field", () => {
    const html = article();
    const reading = html.match(/<details class="auth-disclosure about-reading"[^>]*>([\s\S]*?)<\/details>/)![1]!;
    for (const [path, label] of [["/agent-index.json", "Document index"], ["/prompts/about.txt", "Open prompt"], ["/prompts/mint-assessment.txt", "Mint assessment instructions"]]) {
      expect(reading).toContain(`href="${path}">${label}</a>`);
      expect(html.match(new RegExp(`href="${path}"`, "g"))).toHaveLength(1);
    }
    expect(html).not.toContain("For Agents");
    expect(html).not.toContain("about-agents");
    expect(html).not.toContain('aria-label="Mint assessment instructions"');
    expect(reading).not.toContain("data-handoff-prompt");
    const explore = html.match(/<section><h2>Explore<\/h2>([\s\S]*?)<\/section>/)![1]!;
    expect(explore).toContain("data-handoff-prompt");
    expect(explore).toContain("data-copy-handoff");
  });

  it.each(["prelaunch", "free", "paid", "unknown"] as const)("keeps Pulse and verified reveal boundaries without acquiring a wallet (%s)", phase => {
    const options = { generativeArtwork: true, pulseMint: true, pulseSaleStatus: { phase, paused: false } };
    const html = article(options);
    expect(html).toContain("successful-mint quota is reached or its deadline arrives, whichever comes first");
    expect(html).toContain("explicit spending ceiling; unused payment is refunded");
    expect(html).toContain("You pay network gas in either phase.");
    expect(html).not.toContain("No mint fee.");
    expect(html).toContain("revealed after verified inclusion");
    expect(html).toContain("Confirming label");
    expect(html).toContain("gallery at the same time");
    expect(html).toContain("Minted after the required confirmations are verified");
    expect(html).not.toMatch(/data-connect-wallet|data-assessment-request|data-request-submit|<form|<script/);
  });
});
