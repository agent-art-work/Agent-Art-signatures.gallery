import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { makeReviewPacket } from "../services/signatures/encounter-fixtures.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output")) throw Error("Usage: node scripts/curator-encounter-fixtures.mjs [--output DIRECTORY]");
const destination = resolve(args[1] ?? ".local/curator-encounter-review");
const { current, baselines, packet } = await makeReviewPacket();
await mkdir(destination, { recursive: true });
for (const [name, value] of Object.entries({ "current-v2.json": current, "baselines.json": baselines, "restore-packet.json": packet })) {
  await writeFile(join(destination, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify({ synthetic: true, destination, formats: baselines.map(item => item.format), records: packet.records.length }));
