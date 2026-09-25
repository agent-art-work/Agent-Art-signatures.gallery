import { expect, it } from "vitest";
import { parseExactDatabaseProfiles } from "./databaseProfiles.js";
const rows = () => ["namespace", "budget", "session", "request", "input", "issuance", "schema", "projection"].map(kind => ({ kind,
  value: '{"big":9007199254740993,"escaped":"\\\"12","decimal":1.2345e+22,"bool":false,"nil":null}' }));
it("preserves exact numeric lexemes, escapes and flat scalar values", () => {
  const result = parseExactDatabaseProfiles(JSON.stringify(rows()));
  expect(result.budget).toEqual({ big: "9007199254740993", escaped: '"12', decimal: "1.2345e+22", bool: false, nil: null });
  expect(Object.isFrozen(result.budget)).toBe(true); expect(Object.isFrozen(result)).toBe(true);
});
it.each(["invalid", "{}", "null", "[]", " ".repeat(65537), null])("rejects malformed/large document (%#)", value => {
  expect(() => parseExactDatabaseProfiles(value as string)).toThrow();
});
it.each([null, { kind: "extra", value: "{}" }, { kind: "namespace", value: "{}" }, { kind: 1, value: "{}" },
  { kind: "budget", value: 5 }, { kind: "budget", value: "[]" }, { kind: "budget", value: "null" },
  { kind: "budget", value: '{"nested":{}}' }, { kind: "budget", value: '{"nested":[]}' }, { kind: "budget", value: "{}", approved: true }])("rejects bad rows (%#)", row => {
  const value: unknown[] = rows(); value[1] = row; expect(() => parseExactDatabaseProfiles(JSON.stringify(value))).toThrow();
});
