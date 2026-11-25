import { CandidateError, checkedHandle, isShape } from "./curve.js";
import { DIGEST, UUID, type CandidateService } from "./service.js";
import type { Actor } from "./store.js";

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const svgHeaders = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};
const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const pageSize = 24;

function json(value: unknown, status = 200, more: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...baseHeaders, ...more } });
}

async function requestBody(request: Request) {
  const stream = request.body?.getReader();
  if (!stream) throw new CandidateError("body_required");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", size = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > 8192) {
        await stream.cancel();
        throw new CandidateError("request_too_large", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof CandidateError) throw error;
    throw new CandidateError("invalid_body");
  } finally { stream.releaseLock(); }
}

async function requestJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new CandidateError("unsupported_content_type", 415);
  }
  const text = await requestBody(request);
  try { return JSON.parse(text); }
  catch { throw new CandidateError("invalid_json"); }
}

export function escaped(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function reviewPage(draft: Awaited<ReturnType<CandidateService["review"]>>) {
  const art = "/candidate-review/" + draft.encounter + "/art/" + draft.svgSha256 + ".svg";
  const title = "Review @" + draft.handle;
  if (draft.format === 2) {
    const fields = `<input type="hidden" name="digest" value="${draft.digest}"><input type="hidden" name="operation" value="${draft.operation}">`;
    return encounterPage(title, `<p class="eyebrow">One fixed proposal · local synthetic study</p><h1>${title}</h1>
      <div class="curves"><figure><img src="/candidate-review/${draft.encounter}/original/${draft.original.sha256}.svg" width="420" height="420" alt="Original curve"><figcaption>Original</figcaption></figure>
      <figure><img src="${art}" width="420" height="420" alt="Proposed signature"><figcaption>Grok’s proposed edit</figcaption></figure></div>
      <h2>Intention</h2><p class="intention">${escaped(draft.intention)}</p>
      <h2>Posts Grok cited</h2><ol>${draft.posts!.map(post => `<li><a href="${escaped(post.url)}" rel="noreferrer">${escaped(post.url)}</a></li>`).join("")}</ol>
      <p>These links are scripted source reports in this synthetic study.</p>
      <details><summary>Inspect the exact proposal</summary><dl><dt>Proposal digest</dt><dd class="digest">${draft.digest}</dd>
      <dt>SVG SHA-256</dt><dd class="digest">${draft.svgSha256}</dd><dt>Definition and rules</dt><dd><pre>${escaped(JSON.stringify({ definition: draft.definition, editPolicy: draft.editPolicy }, null, 2))}</pre></dd>
      <dt>Edit</dt><dd><pre>${escaped(JSON.stringify(draft.edit, null, 2))}</pre></dd><dt>Original geometry</dt><dd><pre>${escaped(JSON.stringify(draft.originalPoints, null, 2))}</pre></dd>
      <dt>Original SVG</dt><dd><pre>${escaped(draft.original.svg)}</pre></dd><dt>Proposed SVG</dt><dd><pre>${escaped(draft.svg)}</pre></dd></dl></details>
      <p class="state">${draft.approved ? "Submission requested. Recover its original outcome below." : draft.localState === "saved" ? "Saved locally. No gallery entry has been created." : draft.localState === "declined" ? "Declined. No gallery entry has been created." : "The proposal is fixed. Submit this exact proposal to add its handle, SVG and Intention to the local synthetic gallery."}</p>
      ${draft.localState !== "declined" ? `<form method="post">${fields}<div class="actions"><button name="action" value="submit">${draft.approved ? "Recover exact submission" : "Submit this exact proposal"}</button>
      ${!draft.approved ? '<button class="secondary" name="action" value="save">Save locally</button><button class="secondary" name="action" value="decline">Decline</button>' : ""}</div></form>` : ""}
      <form method="post" action="/encounter-again/${draft.encounter}"><button class="secondary">Do it again</button></form>`);
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><main><h1>${title}</h1><img src="${art}" alt="Proposed signature" width="420" height="420"><h2>Intention</h2><pre>${escaped(draft.intention)}</pre><p>Submitting this candidate makes the handle, signature and Intention public when publication is enabled.</p><form method="post"><input type="hidden" name="digest" value="${draft.digest}"><button type="submit">Approve this exact version</button></form></main></html>`;
}

export function encounterPage(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M5 22Q9 2 16 16T27 10' fill='none' stroke='%2331553a' stroke-width='3'/%3E%3C/svg%3E"><title>${escaped(title)} · Signatures</title>
    <style>body{margin:0;background:#f5f2e9;color:#23251f;font:17px/1.6 system-ui,sans-serif}main{max-width:1000px;margin:40px auto;padding:0 24px 60px}nav{display:flex;justify-content:space-between;margin-bottom:48px}a{color:#31553a;overflow-wrap:anywhere}h1{font:normal clamp(32px,5vw,52px)/1.1 Georgia,serif;margin:12px 0 32px}h2{font:normal 26px Georgia,serif;margin-top:32px}.eyebrow,figcaption{font-size:14px;color:#5d6259}.curves{display:grid;grid-template-columns:1fr 1fr;gap:24px}figure{margin:0}img{width:100%;height:auto;display:block}figcaption{margin-top:8px}.intention{font:24px/1.6 Georgia,serif;white-space:pre-wrap}button,input{font:inherit;padding:10px 18px;border:1px solid #31553a;border-radius:4px}button{background:#31553a;color:white;cursor:pointer}.secondary{background:transparent;color:#31553a}form{margin-top:20px}.actions{display:flex;gap:12px;flex-wrap:wrap}pre,.digest{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}details{padding:20px 0;border-block:1px solid #ccc7bb}dd{margin:8px 0 20px}.state{margin-top:28px}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}@media(max-width:620px){main{margin-top:24px;padding-inline:16px}nav{margin-bottom:28px}.curves,.gallery{grid-template-columns:1fr}button{width:100%}.intention{font-size:21px}}</style></head><body><main><nav><a href="/">Signatures</a><a href="/gallery">Local gallery</a></nav>${content}</main></body></html>`;
}

export function htmlPage(title: string, content: string, status = 200) {
  return new Response(encounterPage(title, content), { status, headers: { ...baseHeaders, ...pageHeaders } });
}

const toolSpecs = [
  { name: "start_signature", description: "Open a study for the chosen handle and get the original Bézier curve and edit limits.", inputSchema: {
    type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false,
  } },
  { name: "propose_signature", description: "Propose one bounded edit and an Intention. Read back the exact SVG, then send the curator the review URL.", inputSchema: {
    type: "object", properties: { encounter: { type: "string" }, previousDigest: { type: ["string", "null"] }, intention: { type: "string" },
      edit: { type: "object", properties: { point: { type: "integer" }, part: { enum: ["anchor", "incoming", "outgoing"] },
        dx: { type: "integer" }, dy: { type: "integer" } }, required: ["point", "part", "dx", "dy"], additionalProperties: false } },
    required: ["encounter", "previousDigest", "edit", "intention"], additionalProperties: false,
  } },
  { name: "submit_signature", description: "Submit the approved exact version once. Reuse the operation UUID when recovering a lost response.", inputSchema: {
    type: "object", properties: { encounter: { type: "string" }, digest: { type: "string" }, operation: { type: "string" } },
    required: ["encounter", "digest", "operation"], additionalProperties: false,
  } },
  { name: "signature_receipt", description: "Read the original submission receipt without creating a new candidate.", inputSchema: {
    type: "object", properties: { encounter: { type: "string" } }, required: ["encounter"], additionalProperties: false,
  } },
];

const encounterTools = [toolSpecs[0], {
  ...toolSpecs[1],
  description: "Return one fixed proposal after retrieving public posts authored by the selected handle. Include Posts Grok cited, the permitted edit and stated Intention. No accessible qualifying post means the encounter is incomplete. Do it again starts a fresh encounter from the original curve. Only the separate curator page can submit.",
  inputSchema: { ...toolSpecs[1].inputSchema,
    properties: { ...toolSpecs[1].inputSchema.properties, posts: { type: "array", minItems: 1, maxItems: 8,
      items: { type: "object", properties: { url: { type: "string" }, author: { type: "string" } },
        required: ["url", "author"], additionalProperties: false } } },
    required: ["encounter", "previousDigest", "edit", "intention", "posts"],
  },
}, toolSpecs[3]];

async function mcp(request: Request, svc: CandidateService, actor: Actor, origin: string) {
  const body = await requestJson(request);
  if (!isShape(body, ["jsonrpc", "method"], ["params", "id"]) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  if (body.id === undefined && body.method === "notifications/initialized") return new Response(null, { status: 202, headers: baseHeaders });
  if (typeof body.id !== "string" && !Number.isSafeInteger(body.id)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  const result = (value: unknown) => json({ jsonrpc: "2.0", id: body.id, result: value });
  const supported = ["2025-06-18", "2025-03-26"];
  if (body.method === "initialize") {
    const requested = isShape(body.params, ["protocolVersion"], ["capabilities", "clientInfo", "_meta"]) && body.params.protocolVersion;
    const version = typeof requested === "string" && supported.includes(requested) ? requested : supported[0];
    return result({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "Signatures local study", version: "1.0.0" } });
  }
  if (body.method === "tools/list") return result({ tools: svc.format === 1 ? toolSpecs : encounterTools });
  if (body.method !== "tools/call") return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  try {
    const params = body.params;
    if (!isShape(params, ["name", "arguments"], ["_meta"])) throw new CandidateError("invalid_tool_call");
    const input = params.arguments;
    let output;
    switch (params.name) {
      case "start_signature": output = await svc.start(actor, input); break;
      case "propose_signature": {
        const draft = await svc.propose(actor, input);
        output = { ...draft, reviewUrl: origin + "/candidate-review/" + draft.encounter };
        break;
      }
      case "submit_signature":
        // Keep the known legacy call recoverable without advertising Agent
        // submission for new encounters. The service checks the stored format.
        output = await svc.submit(actor, input); break;
      case "signature_receipt": {
        if (!isShape(input, ["encounter"]) || typeof input.encounter !== "string" || !UUID.test(input.encounter)) {
          throw new CandidateError("invalid_encounter");
        }
        output = await svc.receipt(actor, input.encounter);
        break;
      }
      default: throw new CandidateError("unknown_tool");
    }
    return result({ content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output });
  } catch (error) {
    if (!(error instanceof CandidateError)) throw error;
    return result({ isError: true, content: [{ type: "text", text: error.code }] });
  }
}

export function candidateHttp({ service, origin, authenticate, publicReads = false }: {
  service: CandidateService;
  origin: string;
  authenticate: (request: Request) => Promise<Actor | null>;
  publicReads?: boolean;
}) {
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), pathname = url.pathname;
      if (url.origin !== origin) throw new CandidateError("invalid_origin", 403);
      if (request.method === "GET" && pathname === "/candidate-gallery" && publicReads) {
        const validKeys = [...url.searchParams.keys()].every(key => ["handle", "before"].includes(key) && url.searchParams.getAll(key).length === 1);
        const handle = url.searchParams.get("handle"), before = url.searchParams.get("before");
        if (!validKeys || (before !== null && (!/^[1-9][0-9]{0,15}(?![\s\S])/.test(before) || !Number.isSafeInteger(Number(before))))) {
          throw new CandidateError("invalid_gallery_query");
        }
        const rows = await service.gallery(handle === null ? null : checkedHandle(handle).toLowerCase(),
          before === null ? Number.MAX_SAFE_INTEGER : Number(before), pageSize + 1);
        const candidates = rows.slice(0, pageSize).map(row => ({
          id: row.candidate_id, handle: row.handle, intention: row.intention, acceptedAt: row.accepted_at,
          artwork: "/candidate-art/" + row.candidate_id + "/" + row.svg_sha + ".svg", svgSha256: row.svg_sha,
          mintStatus: row.winner === null ? "unminted" : row.winner === row.candidate_id ? "canonical" : "ineligible",
          ...(row.winner === row.candidate_id ? { tokenId: row.winning_token } : {}),
        }));
        return json({ candidates, nextBefore: rows.length > pageSize ? rows[pageSize - 1].sequence : null }, 200,
          { "Cache-Control": "public, max-age=0, must-revalidate" });
      }
      const art = /^\/candidate-art\/([^/]+)\/([^/]+)\.svg$/.exec(pathname);
      if (request.method === "GET" && publicReads && art && UUID.test(art[1]) && DIGEST.test(art[2]) && !url.search) {
        const row = await service.artwork(art[1], art[2]);
        if (!row) throw new CandidateError("not_found", 404);
        const headers = { ...baseHeaders, ...svgHeaders, "Cache-Control": "public, max-age=0, must-revalidate", ETag: '"' + art[2] + '"' };
        return request.headers.get("If-None-Match") === headers.ETag ? new Response(null, { status: 304, headers })
          : new Response(row.svg, { headers });
      }
      if (pathname === "/mcp" && !url.search) {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
        const source = request.headers.get("Origin");
        if (source !== null && source !== origin) throw new CandidateError("invalid_origin", 403);
        const actor = await authenticate(request);
        if (!actor) throw new CandidateError("authentication_required", 401);
        if (actor.role !== "agent") throw new CandidateError("role_not_permitted", 403);
        return await mcp(request, service, actor, origin);
      }
      const review = /^\/candidate-review\/([^/]+)(?:\/(art|original)\/([^/]+)\.svg)?$/.exec(pathname);
      if (!review || !UUID.test(review[1]) || url.search) throw new CandidateError("not_found", 404);
      const actor = await authenticate(request);
      if (!actor) throw new CandidateError("authentication_required", 401);
      if (actor.role !== "curator") throw new CandidateError("role_not_permitted", 403);
      if (request.method === "GET") {
        const draft = await service.review(actor, review[1]);
        if (review[2] !== undefined) {
          const original = review[2] === "original";
          if (review[3] !== (original ? draft.original.sha256 : draft.svgSha256)) throw new CandidateError("not_found", 404);
          return new Response(original ? draft.original.svg : draft.svg, { headers: { ...baseHeaders, ...svgHeaders } });
        }
        return new Response(reviewPage(draft), { headers: { ...baseHeaders, ...pageHeaders } });
      }
      if (request.method !== "POST" || review[2]) throw new CandidateError("not_found", 404);
      if (request.headers.get("Origin") !== origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        throw new CandidateError("invalid_origin", 403);
      }
      const legacyReview = (await service.review(actor, review[1])).format !== 2;
      let digest: unknown, action: unknown, operation: unknown;
      if (/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
        const params = new URLSearchParams(await requestBody(request));
        if (legacyReview && [...params.keys()].length === 1) digest = params.get("digest");
        if (!legacyReview && [...params.keys()].length === 3 && ["action", "digest", "operation"].every(key => params.getAll(key).length === 1)) {
          digest = params.get("digest"); action = params.get("action"); operation = params.get("operation");
        }
      } else {
        const input = await requestJson(request);
        if (isShape(input, ["digest"])) digest = input.digest;
        if (isShape(input, ["digest", "action", "operation"])) {
          digest = input.digest; action = input.action; operation = input.operation;
        }
      }
      if (typeof digest !== "string") throw new CandidateError("invalid_draft_digest");
      if (!legacyReview) {
        if (action === "save" || action === "decline") {
          await service.leaveLocal(actor, review[1], digest, action === "save" ? "saved" : "declined");
          return new Response(null, { status: 303, headers: { ...baseHeaders, Location: pathname } });
        }
        if (action !== "submit") throw new CandidateError("explicit_submission_required", 409);
        const receipt = await service.submit(actor, { encounter: review[1], digest, operation });
        if (/^application\/json/i.test(request.headers.get("content-type") ?? "")) return json(receipt);
        const pending = "status" in receipt;
        return htmlPage(pending ? "Submission pending" : "Submitted", `<h1>${pending ? "Submission pending" : "Submitted to the local gallery"}</h1><pre>${escaped(JSON.stringify(receipt, null, 2))}</pre>
          <p><a href="/candidate-review/${review[1]}">${pending ? "Retry this exact submission" : "Inspect the submitted proposal"}</a> · <a href="/gallery">Read the local gallery</a></p>`);
      }
      return json(await service.approve(actor, review[1], digest));
    } catch (error) {
      if (error instanceof CandidateError) return json({ error: error.code }, error.status);
      return json({ error: "candidate_service_unavailable" }, 503);
    }
  };
}
