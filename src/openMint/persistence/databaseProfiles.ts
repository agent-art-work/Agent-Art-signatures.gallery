/** Decode the trusted SQL snapshot without ever rounding numeric lexemes.
 * This parser grants no authority; callers still need the live certifier. */
export function parseExactDatabaseProfiles(raw: string): Record<string, Record<string, string | boolean | null>> {
  const deny = () => { throw Error("Database profiles unavailable."); };
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) deny();
  const rows = JSON.parse(raw), result = Object.create(null);
  if (!Array.isArray(rows) || rows.length !== 8) deny();
  for (const row of rows) {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).sort().join() !== "kind,value"
      || typeof row.kind !== "string" || typeof row.value !== "string" || Object.hasOwn(result, row.kind)) deny();
    const value = JSON.parse(row.value.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token: string, number: string | undefined) => number === undefined ? token : JSON.stringify(number)));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.values(value).every(v => v === null || typeof v === "string" || typeof v === "boolean")) deny();
    result[row.kind] = Object.freeze(value);
  }
  if (Object.keys(result).sort().join() !== "budget,input,issuance,namespace,projection,request,schema,session") deny();
  return Object.freeze(result);
}
