import { describe, expect, it } from "vitest";
import { mintHandleDraft } from "./mintHandleDraft.js";

const key = "sg-open:mint-handle-draft:v1";
function store(initial?: string) {
  const values = new Map(initial === undefined ? [] : [[key, initial]]);
  return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
}
const field = (value = "") => ({ value, defaultValue: value });

describe("mint handle draft", () => {
  it("restores exact typing, including capitalization, @ and unfinished input", () => {
    const storage = store(), input = field(), save = mintHandleDraft(input, storage);
    for (const value of ["@Alice_Bob_Key", "@", "Alice_"]) {
      input.value = value; save();
      const refreshed = field(); mintHandleDraft(refreshed, storage);
      expect(refreshed.value).toBe(value);
    }
    expect([...storage.values.keys()]).toEqual([key]);
  });
  it("keeps a cleared field empty after refreshing", () => {
    const storage = store(), input = field("Alice"), save = mintHandleDraft(input, storage);
    input.value = ""; save();
    const refreshed = field("Alice"); mintHandleDraft(refreshed, storage);
    expect(refreshed.value).toBe("");
  });
  it("prioritizes a different URL-prefilled handle but preserves edits on same-URL refresh", () => {
    const storage = store(), input = field("Alice"), save = mintHandleDraft(input, storage);
    input.value = "Bob"; save();
    const sameUrl = field("Alice"); mintHandleDraft(sameUrl, storage);
    expect(sameUrl.value).toBe("Bob");
    const newUrl = field("Carol"); mintHandleDraft(newUrl, storage);
    expect(newUrl.value).toBe("Carol");
    const plainMint = field(); mintHandleDraft(plainMint, storage);
    expect(plainMint.value).toBe("Carol");
  });
  it("ignores malformed, oversized and wrong-version storage", () => {
    for (const raw of ["not json", "null", "0", "x".repeat(300), JSON.stringify({ version: 2, source: "", value: "Wrong" }),
      JSON.stringify({ version: 1, source: "", value: "x".repeat(17) }), JSON.stringify({ version: 1, source: {}, value: "Wrong" })]) {
      const input = field(); mintHandleDraft(input, store(raw)); expect(input.value).toBe("");
    }
  });
  it("never breaks typing when browser storage is blocked or full", () => {
    for (const storage of [
      { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } },
      { getItem() { return null; }, setItem() { throw Error("full"); } },
    ]) {
      const input = field(), save = mintHandleDraft(input, storage);
      input.value = "Alice"; expect(() => save()).not.toThrow(); expect(input.value).toBe("Alice");
    }
  });
  it("does not touch storage on pages without a handle field or save overlong values", () => {
    const storage = store(); mintHandleDraft(null, storage)(); expect(storage.values.size).toBe(0);
    mintHandleDraft(field("x".repeat(17)), storage)(); expect(storage.values.size).toBe(0);
  });
});
