import { preservedHandle } from "./identity.js";

/** Product navigation: a displayed artwork handle always opens its 16 variations.
 * Keep the rendering spelling, not the lowercase token identity, in preview URLs.
 */
export function handleVariationsPath(handle: string): string {
  return `/p/${preservedHandle(handle)}/variations`;
}

/** Validation restricts both URL and text to safe ASCII handle characters. */
export function handleLink(handle: string): string {
  const spelling = preservedHandle(handle);
  return `<a class="gallery-handle" href="${handleVariationsPath(spelling)}">@${spelling}</a>`;
}

/** Variation captions may truncate only the visual middle, never the identity. */
export function compactHandleLink(handle: string): string {
  const spelling = preservedHandle(handle);
  const start = spelling.length > 4 ? `@${spelling.slice(0, -2)}` : `@${spelling}`;
  const end = spelling.length > 4 ? spelling.slice(-2) : "";
  return `<a class="gallery-handle gallery-handle-compact" href="${handleVariationsPath(spelling)}" aria-label="@${spelling}" title="@${spelling}"><span class="gallery-handle-start">${start}</span><span class="gallery-handle-end">${end}</span></a>`;
}
