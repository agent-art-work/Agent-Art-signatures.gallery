import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactHandleLink, handleLink, handleVariationsPath } from "./handleLink.js";

describe("artwork handle navigation policy", () => {
  it.each(["Alice_Bob_Key", "alice_bob_key", "0xCryptoWizzy", "A", "_", "AbCdEfGhIjKlM15"])("keeps %s spelling and uses same-tab variations navigation", handle => {
    expect(handleVariationsPath(handle)).toBe(`/p/${handle}/variations`);
    expect(handleLink(handle)).toBe(`<a class="gallery-handle" href="/p/${handle}/variations">@${handle}</a>`);
    expect(handleLink(`@${handle}`)).toBe(handleLink(handle));
    expect(handleVariationsPath(`@${handle}`)).toBe(handleVariationsPath(handle));
  });

  it.each(["", "@@alice", " alice", "alice ", "a/b", "a%2Fb", "alice?mbti=INTJ", "alice#mint", "<script>", 'a"onclick="x', "a\\b", "a\u0000b", "a".repeat(16), "Älice"])("rejects malformed navigation input %j", handle => {
    expect(() => handleVariationsPath(handle)).toThrow();
    expect(() => handleLink(handle)).toThrow();
    expect(() => compactHandleLink(handle)).toThrow();
  });

  it.each([
    ["A", "@A", ""],
    ["_", "@_", ""],
    ["AbCd", "@AbCd", ""],
    ["AbCdE", "@AbC", "dE"],
    ["TruthGundlach", "@TruthGundla", "ch"],
    ["Alice_Bob_Key", "@Alice_Bob_K", "ey"],
    ["AbCdEfGhIjKlM15", "@AbCdEfGhIjKlM", "15"],
  ])("keeps the exact %s identity accessible while allowing a compact visual middle", (handle, start, end) => {
    const link = compactHandleLink(handle!);
    expect(link).toBe(`<a class="gallery-handle gallery-handle-compact" href="/p/${handle}/variations" aria-label="@${handle}" title="@${handle}"><span class="gallery-handle-start">${start}</span><span class="gallery-handle-end">${end}</span></a>`);
    expect(link.replace(/<[^>]*>/g, "")).toBe(`@${handle}`);
    expect(link).not.toMatch(/\btarget=|aria-hidden=|\.\.\.|…/);
    expect(compactHandleLink(`@${handle}`)).toBe(link);
  });

  it("does not reintroduce the legacy X-profile UI helper into the active app", () => {
    const root = new URL("./", import.meta.url);
    const files = readdirSync(root, { recursive: true }).map(String)
      .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    for (const file of files) {
      const source = readFileSync(new URL(file, root), "utf8");
      expect(source, `${file}: artwork handles must use handleLink, not the legacy X profile UI`).not.toMatch(/\b(?:xProfileLink|xProfileUrl)\b|(?:from|import\s*\()[^\n]*\/xProfile(?:\.js)?["']/);
    }
  });
});
