import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DARK_COLOR, LIGHT_COLOR, MBTI_TYPES, RENDERER_VERSION, renderSignatureSvg, type MBTI,
} from "../algorithmV2/index.js";
import { FAVICON_SVG } from "./favicon.js";
import { signatureIcon } from "./signatureIcon.js";
import { SITE_ICON_MBTI_CASES, siteIconMbtiStudyIcon } from "./siteIconMbtiStudy.js";
import { pathInkBounds } from "./sloganStudyBounds.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const pathElement = (svg: string): string => {
  const paths = svg.match(/<path\b[^>]*\/>/g);
  expect(paths).toHaveLength(1);
  return paths![0]!;
};
const pathData = (svg: string): string => {
  const match = pathElement(svg).match(/\bd="([^"]+)"/);
  expect(match).not.toBeNull();
  return match![1]!;
};
const withoutTitle = (svg: string): string => svg.replace(/<title>[^<]*<\/title>/, "");
const rgb = (color: string): number[] => [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));

describe("all 16 renderer-derived capital S site icon studies", () => {
  it("provides all MBTI types in renderer order with immutable artwork and provenance", () => {
    expect(SITE_ICON_MBTI_CASES.map(icon => icon.mbti)).toEqual(MBTI_TYPES);
    expect(SITE_ICON_MBTI_CASES).toHaveLength(16);
    expect(Object.isFrozen(SITE_ICON_MBTI_CASES)).toBe(true);
    expect(new Set(SITE_ICON_MBTI_CASES.map(icon => icon.svg)).size).toBe(16);
    for (const icon of SITE_ICON_MBTI_CASES) {
      expect(icon).toEqual(siteIconMbtiStudyIcon(icon.mbti));
      expect(Object.isFrozen(icon)).toBe(true);
      expect(Object.isFrozen(icon.manifest)).toBe(true);
      expect(Object.isFrozen(icon.manifest.canonicalViewBox)).toBe(true);
      expect(Object.isFrozen(icon.manifest.viewBox)).toBe(true);
    }
  });

  it.each(MBTI_TYPES)("preserves the exact renderer path and hashes for %s", mbti => {
    const source = renderSignatureSvg("S", mbti);
    const sourcePath = pathElement(source);
    const d = pathData(source);
    const icon = siteIconMbtiStudyIcon(mbti);
    expect(Object.isFrozen(icon)).toBe(true);
    expect(icon.mbti).toBe(mbti);
    expect(pathElement(icon.svg)).toBe(sourcePath);
    expect(pathData(icon.svg)).toBe(d);
    expect(icon.manifest).toMatchObject({
      rendererInput: "S", rendererVersion: RENDERER_VERSION, mbti,
      purpose: "branding-only", sourceSvgSha256: sha256(source),
      sourcePathElementSha256: sha256(sourcePath), pathSha256: sha256(d),
      canonicalViewBox: [0, 0, 420, 420],
    });
    expect(icon.manifest).not.toHaveProperty("gr0kRaw");
  });

  it.each(MBTI_TYPES)("centers %s in an undistorted square with its native palette", mbti => {
    const { svg, manifest } = siteIconMbtiStudyIcon(mbti);
    const bounds = pathInkBounds(pathData(renderSignatureSvg("S", mbti)));
    const [x, y, width, height] = manifest.viewBox;
    const background = mbti.startsWith("I") ? DARK_COLOR : LIGHT_COLOR;
    const ink = mbti.startsWith("I") ? LIGHT_COLOR : DARK_COLOR;
    expect(width).toBe(height);
    expect(width).toBeGreaterThan(0);
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(x + width / 2, 5);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(y + height / 2, 5);
    expect(Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / width).toBeCloseTo(.78, 6);
    expect(bounds.minX).toBeGreaterThan(x);
    expect(bounds.minY).toBeGreaterThan(y);
    expect(bounds.maxX).toBeLessThan(x + width);
    expect(bounds.maxY).toBeLessThan(y + height);
    expect(manifest.background).toBe(background);
    expect(manifest.ink).toBe(ink);
    expect(svg).toContain(`viewBox="${manifest.viewBox.join(" ")}"`);
    expect(svg).toContain('width="64" height="64"');
    expect(svg).toContain(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${background}"/>`);
    expect(svg).toContain(`fill="${ink}" stroke="none"`);
    expect(svg.match(/<\/?[A-Za-z][^>]*>/g)?.map(tag => tag.match(/^<\/?([A-Za-z]+)/)![1]))
      .toEqual(["svg", "title", "title", "rect", "path", "svg"]);
    expect(svg).not.toMatch(/transform=|<style|<text|<image|<script|<g\b|href=|\son\w+=|prefers-color-scheme/);
    expect(svg).not.toContain("@S");
  });

  it("retains the renderer's I/E geometry pairs while reversing the native palette", () => {
    for (const mbti of MBTI_TYPES.filter(type => type.startsWith("I"))) {
      const introvert = siteIconMbtiStudyIcon(mbti);
      const extrovert = siteIconMbtiStudyIcon(`E${mbti.slice(1)}` as MBTI);
      expect(pathData(introvert.svg)).toBe(pathData(extrovert.svg));
      expect(introvert.manifest.pathSha256).toBe(extrovert.manifest.pathSha256);
      expect(introvert.manifest.viewBox).toEqual(extrovert.manifest.viewBox);
      expect(introvert.manifest.background).toBe(extrovert.manifest.ink);
      expect(introvert.manifest.ink).toBe(extrovert.manifest.background);
      expect(introvert.svg).not.toBe(extrovert.svg);
    }
  });

  it.each(["", "XXXX", "INFPX", "infp", "Infp", " INFP", "INFP ", "INFP\n", "ENFP\r\n", "ENFP\t"])(
    "rejects invalid MBTI %j at the study helper boundary", invalid => {
      expect(() => siteIconMbtiStudyIcon(invalid as MBTI)).toThrow(RangeError);
    },
  );

  it("preserves the existing ENFP S shape and frame without changing the production favicon", () => {
    const study = siteIconMbtiStudyIcon("ENFP");
    const existing = signatureIcon("S");
    expect(withoutTitle(study.svg)).toBe(withoutTitle(existing.svg));
    expect(study.manifest).toEqual(existing.manifest);
    expect(FAVICON_SVG).toBe(existing.svg);
    expect(sha256(FAVICON_SVG)).toBe("64ea0c8827b1639a7783c79aab174fcdd5b05e3372cfddb42d2a9764b9d9aba6");
  });

  it.each(MBTI_TYPES.flatMap(mbti => [16, 32, 64].map(size => ({ mbti, size }))))(
    "renders $mbti with visible native ink and opaque unclipped margins at $size px", async ({ mbti, size }) => {
      const { svg, manifest } = siteIconMbtiStudyIcon(mbti);
      const { data, info } = await sharp(Buffer.from(svg)).resize(size, size).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      const background = rgb(manifest.background);
      const ink = rgb(manifest.ink);
      expect(info.width).toBe(size);
      expect(info.height).toBe(size);
      expect(info.channels).toBe(4);
      let foregroundPixels = 0;
      let nativeInkPixels = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        const pixel = [...data.subarray(offset, offset + 3)];
        expect(data[offset + 3]).toBe(255);
        const distanceFromBackground = pixel.reduce((distance, channel, index) => distance + Math.abs(channel - background[index]!), 0);
        const distanceFromInk = pixel.reduce((distance, channel, index) => distance + Math.abs(channel - ink[index]!), 0);
        if (distanceFromInk < distanceFromBackground) foregroundPixels++;
        if (distanceFromInk < 30) nativeInkPixels++;
        if (x === 0 || x === size - 1 || y === 0 || y === size - 1) expect(pixel).toEqual(background);
      }
      expect(foregroundPixels).toBeGreaterThan(size * size * .015);
      expect(foregroundPixels).toBeLessThan(size * size * .45);
      expect(nativeInkPixels).toBeGreaterThan(0);
    },
  );
});
