import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARTIST_NAME, ARTIST_X_HANDLE, ARTIST_X_URL } from "./artist.js";

describe("publisher identity", () => {
  it("keeps the README attribution aligned with the site's artist identity", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`[${ARTIST_NAME} (@${ARTIST_X_HANDLE})](${ARTIST_X_URL})`);
    expect(readme).not.toMatch(/agentart[_-]?aa/i);
    // Agent Art is the field of practice, not the publisher's X account.
    expect(readme).toContain("[Agent Art](https://inshell.art/docs/agent-art)");
  });
});
