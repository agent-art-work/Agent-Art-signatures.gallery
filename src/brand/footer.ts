import { ARTIST_NAME, ARTIST_X_URL } from "./artist.js";

// X mark: https://github.com/simple-icons/simple-icons/blob/develop/icons/x.svg
const FOOTER_X_ICON = '<svg class="footer-x-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>';

/** Shared attribution across current and legacy page layouts. */
export function siteFooter(aboutCurrent = false): string {
  return `<footer><div class="footer-credit">by <a class="footer-agent" href="${ARTIST_X_URL}" target="_blank" rel="noopener noreferrer" aria-label="${ARTIST_NAME} on X (opens in a new tab)">${FOOTER_X_ICON}<span>${ARTIST_NAME}</span><span aria-hidden="true">↗</span></a></div><a class="footer-about" href="/about"${aboutCurrent ? ' aria-current="page"' : ""}>About the work</a></footer>`;
}
