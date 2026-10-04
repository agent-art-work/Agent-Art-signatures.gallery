import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { homePage, signInRequiredPage } from "../v1/pages.js";
import { renderSignatureSvg, RENDERER_VERSION } from "../algorithmV2/index.js";
import { sloganStudyPage } from "./sloganStudy.js";
import { FAVICON_CSP, FAVICON_LINK, FAVICON_MANIFEST, FAVICON_SVG, FAVICON_URL, FAVICON_VERSION } from "./favicon.js";
import { FAVICON_SHAPE_LOCK, SIGNATURE_ICON_SHAPE_LOCKS } from "./faviconShapeLock.js";
import { signatureIcon, type SignatureIconLetter } from "./signatureIcon.js";
import { pathInkBounds } from "./sloganStudyBounds.js";

const letters = ["S", "s"] as const;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("renderer-derived signature favicon", () => {
  it.each(letters)("locks exact %s from the v2 renderer without case conversion or redrawing", letter => {
    const shape = SIGNATURE_ICON_SHAPE_LOCKS[letter];
    const source = renderSignatureSvg(letter, shape.mbti);
    const paths = source.match(/<path\b[^>]*\/>/g);
    expect(paths).toHaveLength(1);
    expect(shape.rendererInput).toBe(letter);
    expect(shape.mbti).toBe("ENFP");
    expect(shape.rendererVersion).toBe(RENDERER_VERSION);
    expect(shape.sourceSvgSha256).toBe(sha256(source));
    expect(shape.sourcePathElementSha256).toBe(sha256(paths![0]!));
    expect(shape.pathSha256).toBe(sha256(shape.d));
    const icon = signatureIcon(letter);
    expect(icon.svg.match(/<path /g)).toHaveLength(1);
    expect(icon.svg).toContain(paths![0]!);
    expect(icon.manifest).toMatchObject({
      rendererInput: letter, rendererVersion: RENDERER_VERSION, mbti: "ENFP",
      purpose: "branding-only", sourceSvgSha256: shape.sourceSvgSha256,
      sourcePathElementSha256: shape.sourcePathElementSha256, pathSha256: shape.pathSha256,
      canonicalViewBox: [0, 0, 420, 420],
    });
    expect(icon.manifest).not.toHaveProperty("gr0kRaw");
  });

  it("selects capital S, preserving lowercase s as genuinely different algorithm output", () => {
    expect(FAVICON_SHAPE_LOCK).toBe(SIGNATURE_ICON_SHAPE_LOCKS.S);
    expect(FAVICON_SVG).toBe(signatureIcon("S").svg);
    expect(FAVICON_MANIFEST).toEqual(signatureIcon("S").manifest);
    expect(SIGNATURE_ICON_SHAPE_LOCKS.S.d).not.toBe(SIGNATURE_ICON_SHAPE_LOCKS.s.d);
    expect(() => signatureIcon("SS" as SignatureIconLetter)).toThrow(RangeError);
  });

  it.each(letters)("centers %s on an undistorted square with equal paper margins", letter => {
    const { svg, manifest } = signatureIcon(letter);
    const [x, y, width, height] = manifest.viewBox;
    const bounds = pathInkBounds(SIGNATURE_ICON_SHAPE_LOCKS[letter].d);
    expect(width).toBe(height);
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(x + width / 2, 5);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(y + height / 2, 5);
    expect(Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / width).toBeCloseTo(.78, 6);
    expect(svg).toContain(`viewBox="${manifest.viewBox.join(" ")}"`);
    expect(svg).toContain('width="64" height="64"');
    expect(svg).toContain(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f4e7c7"/>`);
    expect(svg).toContain('fill="#000000" stroke="none"');
    expect(manifest.background).toBe("#f4e7c7");
    expect(manifest.ink).toBe("#000000");
    expect(svg).not.toMatch(/transform=|<style|<text|<image|<script|href=|prefers-color-scheme/);
  });

  it("uses a content-versioned URL consistently across product and study pages", () => {
    expect(FAVICON_VERSION).toBe(createHash("sha256").update(FAVICON_SVG).update(FAVICON_CSP).digest("hex").slice(0, 16));
    expect(FAVICON_URL).toBe(`/assets/favicon.svg?v=${FAVICON_VERSION}`);
    for (const html of [homePage(true), signInRequiredPage(true), sloganStudyPage()]) {
      expect(html).toContain(FAVICON_LINK);
      expect(html.match(/rel="icon"/g)).toHaveLength(1);
      expect(html).not.toContain('href="/assets/favicon.svg"');
    }
  });

  it("does not need inline styles or external resources under its strict CSP", () => {
    expect(FAVICON_CSP).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });

  it.each(letters.flatMap(letter => [16, 32, 64].map(size => ({ letter, size }))))("renders $letter with opaque margins without clipping at $size px", async ({ letter, size }) => {
    const { data, info } = await sharp(Buffer.from(signatureIcon(letter).svg)).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let ink = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      expect(data[offset + 3]).toBe(255);
      if (data[offset] < 100) ink++;
      if (x === 0 || x === size - 1 || y === 0 || y === size - 1) expect([...data.subarray(offset, offset + 3)]).toEqual([244, 231, 199]);
    }
    expect(ink).toBeGreaterThan(size * size * .015);
    expect(ink).toBeLessThan(size * size * .45);
  });
});
