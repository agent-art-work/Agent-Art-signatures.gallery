import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const SITE_FONT_FAMILY = "Playpen Sans";
export const SITE_FONT_WEIGHT = 300;
export const SITE_FONT_EMPHASIS_WEIGHT = 700;

const packageName = "@fontsource-variable/playpen-sans";
const { version } = JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), "utf8")) as { version: string };
const basePath = `/assets/fonts/playpen-sans-${version}`;
const distributorCss = readFileSync(require.resolve(`${packageName}/wght.css`), "utf8");

// Resolve package assets from either src or compiled dist, independently of cwd.
// Publish only the distributor's exact WOFF2 URLs and license; never resolve a request path.
const assets = new Map<string, { bytes: Buffer; contentType: string }>();
for (const [, filename] of distributorCss.matchAll(/url\(\.\/files\/(playpen-sans-[a-z0-9-]+\.woff2)\)/g)) {
  assets.set(`${basePath}/${filename}`, {
    bytes: readFileSync(require.resolve(`${packageName}/files/${filename}`)),
    contentType: "font/woff2",
  });
}
assets.set(`${basePath}/LICENSE.txt`, {
  bytes: readFileSync(require.resolve(`${packageName}/LICENSE`)),
  contentType: "text/plain; charset=utf-8",
});

export function siteFontAsset(pathname: string) {
  return assets.get(pathname);
}

export const SITE_FONT_PRELOAD = `<link rel="preload" href="${basePath}/playpen-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>`;

// Keep the native 100–800 weight range and all Unicode subsets. This family has
// no native italic; only Latin upright is preloaded and other subsets load on demand.
export const SITE_FONT_CSS = `/* ${SITE_FONT_FAMILY} · SIL OFL 1.1 · ${basePath}/LICENSE.txt */\n` +
  distributorCss.replaceAll("Playpen Sans Variable", SITE_FONT_FAMILY)
    .replaceAll("./files/", `${basePath}/`);
