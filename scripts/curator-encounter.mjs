import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchiveFixture, openCandidateFixture } from "../services/signatures/candidate-fixture-store.mjs";
import { fixtureKey, FIXTURE_BINDING } from "../services/signatures/encounter-fixtures.mjs";
import { curveCandidates } from "../.local/candidate-build/candidates/service.js";
import { syntheticEncounterApp } from "../.local/candidate-build/candidates/encounterApp.js";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--port" || !/^[0-9]{1,5}$/.test(args[1]) || Number(args[1]) > 65535)) {
  throw Error("Usage: node scripts/curator-encounter.mjs [--port PORT]");
}
const directory = await mkdtemp(join(tmpdir(), "sig-curator-encounter-"));
const primary = openCandidateFixture(join(directory, "primary.sqlite"));
const archive = openArchiveFixture(join(directory, "archive.sqlite"));
const service = curveCandidates(primary.binding, { binding: FIXTURE_BINDING, key: await fixtureKey(), archive: archive.archive });
let app;
const server = createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await app(new Request(new URL(req.url, origin), {
      method: req.method, headers: req.headers,
      ...(size ? { body: Buffer.concat(chunks) } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(503); res.end("Synthetic encounter unavailable"); }
});
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(args[1] ?? 39019), "127.0.0.1", resolve); });
} catch (error) {
  primary.close(); archive.close(); await rm(directory, { recursive: true });
  throw error;
}
const origin = `http://127.0.0.1:${server.address().port}`;
app = syntheticEncounterApp(service, origin);
console.log(JSON.stringify({ synthetic: true, origin, storage: "disposable; removed on shutdown" }));
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  if (closing) return; closing = true;
  await new Promise(resolve => server.close(resolve));
  primary.close(); archive.close(); await rm(directory, { recursive: true });
});
