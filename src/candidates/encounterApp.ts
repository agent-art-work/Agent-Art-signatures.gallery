import { CandidateError, checkedHandle } from "./curve.js";
import { candidateHttp, escaped, htmlPage } from "./http.js";
import type { CandidateService } from "./service.js";
import type { Actor } from "./store.js";

export const SYNTHETIC_CURATOR: Actor = { role: "curator", curatorId: "synthetic-curator" };
export const SCRIPTED_GROK: Actor = { role: "agent", curatorId: "synthetic-curator", agentId: "scripted-grok" };

// No retrieval, provider or model call. The URLs below are deliberately synthetic
// reports, not evidence that any public post exists or was accessible.
export function scriptedProposal(start: Awaited<ReturnType<CandidateService["start"]>>) {
  const handle = start.handle;
  if (!["northwindow", "paperharbor"].includes(handle.toLowerCase())) return null;
  const variation = Number.parseInt(start.encounter.at(-1)!, 16) % 2;
  return {
    encounter: start.encounter, previousDigest: null,
    edit: { point: 0, part: "outgoing", dx: 0, dy: variation ? -12 : 12 },
    intention: variation ? "I let the first turn fall back, as a pause before returning to the window."
      : "I lift the first turn toward the open window, leaving the rest of the line to continue its own pace.",
    posts: [
      { url: `https://x.com/${handle}/status/1900000000000000001`, author: handle },
      { url: `https://x.com/${handle}/status/1900000000000000002`, author: handle },
    ],
  };
}

// A loopback-only, unauthenticated fixture facade. Never mount this in the app's
// real router: production must supply separately authenticated curator sessions.
export function syntheticEncounterApp(service: CandidateService, origin: string) {
  const http = candidateHttp({ service, origin, publicReads: true, authenticate: async request => {
    if (new URL(request.url).pathname === "/mcp") return request.headers.get("Authorization") === "synthetic-agent" ? SCRIPTED_GROK : null;
    return SYNTHETIC_CURATOR;
  } });
  async function run(handle: string) {
    const start = await service.start(SCRIPTED_GROK, { handle });
    const proposal = scriptedProposal(start);
    if (proposal) await service.propose(SCRIPTED_GROK, proposal);
    return new Response(null, { status: 303, headers: { Location: proposal ? `/candidate-review/${start.encounter}` : `/incomplete/${start.encounter}`, "Cache-Control": "no-store" } });
  }
  return async (request: Request) => {
    const url = new URL(request.url);
    try {
      if (url.origin !== origin) throw new CandidateError("invalid_origin", 403);
      if (request.method === "GET" && url.pathname === "/" && !url.search) {
        return htmlPage("Choose a handle", `<p class="eyebrow">Local synthetic encounter</p><h1>A curve, through another’s eyes.</h1>
          <p>Choose the handle Grok will interpret. You can inspect its fixed proposal and decide whether to submit it.</p>
          <form method="post" action="/encounter-start"><label for="handle">X handle</label><p><input id="handle" name="handle" value="NorthWindow" maxlength="16" required></p><button>Start signature</button></form>
          <p>Scripted examples: @NorthWindow and @PaperHarbor. Any other handle demonstrates an incomplete encounter with no accessible qualifying post.</p>`);
      }
      if (request.method === "GET" && url.pathname === "/gallery" && !url.search) {
        const rows = await service.gallery(null, Number.MAX_SAFE_INTEGER, 24);
        return htmlPage("Local gallery", `<p class="eyebrow">Synthetic submissions only</p><h1>Local gallery</h1>${rows.length ? `<div class="gallery">${rows.map(row => `<article><h2>@${escaped(row.handle)}</h2>
          <img src="/candidate-art/${row.candidate_id}/${row.svg_sha}.svg" width="420" height="420" alt="Submitted signature for @${escaped(row.handle)}">
          <p class="intention">${escaped(row.intention)}</p><p class="digest">${row.svg_sha}</p></article>`).join("")}</div>` : "<p>No submissions yet.</p>"}`);
      }
      const incomplete = /^\/incomplete\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && incomplete && !url.search) {
        const encounter = await service.encounter(SYNTHETIC_CURATOR, incomplete[1]);
        if (encounter.digest) throw new CandidateError("not_found", 404);
        return htmlPage("Encounter incomplete", `<h1>Encounter incomplete</h1><p>No qualifying public post authored by @${escaped(encounter.handle)} is accessible in this scripted return. There is no proposal to submit.</p>
          <form method="post" action="/encounter-again/${encounter.encounter}"><button>Do it again</button></form><p><a href="/">Choose another handle</a></p>`);
      }
      if (request.method === "POST" && (url.pathname === "/encounter-start" || url.pathname.startsWith("/encounter-again/")) && !url.search) {
        if (request.headers.get("Origin") !== origin || request.headers.get("Sec-Fetch-Site") === "cross-site") throw new CandidateError("invalid_origin", 403);
        if (url.pathname === "/encounter-start") {
          if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new CandidateError("unsupported_content_type", 415);
          const text = await request.text();
          if (text.length > 128) throw new CandidateError("request_too_large", 413);
          const input = new URLSearchParams(text);
          if ([...input.keys()].length !== 1 || input.getAll("handle").length !== 1) throw new CandidateError("invalid_start");
          return await run(checkedHandle(input.get("handle")));
        }
        const again = /^\/encounter-again\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (!again) throw new CandidateError("not_found", 404);
        const prior = await service.encounter(SYNTHETIC_CURATOR, again[1]);
        // A completed submission remains immutable. An open local attempt is
        // retired before the new attempt starts; its old page cannot submit.
        if (prior.localState !== "declined") {
          try { await service.leaveLocal(SYNTHETIC_CURATOR, prior.encounter, prior.digest, "declined"); }
          catch (error) {
            if (!(error instanceof CandidateError) || error.code !== "local_decision_unavailable") throw error;
            await service.receipt(SYNTHETIC_CURATOR, prior.encounter);
          }
        }
        return await run(prior.handle);
      }
      return http(request);
    } catch (error) {
      if (error instanceof CandidateError) return Response.json({ error: error.code }, { status: error.status });
      return Response.json({ error: "synthetic_encounter_unavailable" }, { status: 503 });
    }
  };
}
