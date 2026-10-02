import type { IncomingMessage, ServerResponse } from "node:http";
import { OPEN_MINT_CLIENT_SCRIPT } from "../clientScript.js";
import { assessmentPage, mintPage, type AssessmentPageModel, type OpenMintPageOptions } from "../pages.js";
import type { ProjectionReads } from "../projection/http.js";
import { PublicError } from "../security.js";
import { GenerativeWalletChain } from "../walletChain.js";
import { handleDigest, preservedHandle } from "../identity.js";
import { capabilityHash, type DurableSiteSession } from "./sessions.js";
import { DurableMintRuntime, type RuntimeIntent } from "./runtimeService.js";
import { PostgresWalletSubmissions } from "./walletSubmissions.js";
import { assertIsolatedGenerativeBinding } from "./generativeStartup.js";

/** Opt-in local browser bridge. Does not start synchronization or activate the
 * app, publish an RPC URL, switch environments, sign wallets or broadcast. */
export class GenerativeMintBrowser {
  readonly submissions: PostgresWalletSubmissions;
  readonly #lookup: ProjectionReads["lookup"];
  constructor(readonly runtime: DurableMintRuntime, readonly chain: GenerativeWalletChain, projection: ProjectionReads) {
    if (!(chain instanceof GenerativeWalletChain)) throw new Error("Mismatched isolated browser deployment.");
    assertIsolatedGenerativeBinding(runtime, chain.config);
    this.submissions = new PostgresWalletSubmissions(runtime.requests); this.#lookup = projection.lookup.bind(projection);
  }
  async authorize(code: string, consent: unknown, intent: RuntimeIntent, signal: AbortSignal) {
    if ((await this.submissions.state(code, intent.session.id)).blocked) throw new PublicError(409, "SUBMISSION_UNRESOLVED", "Check the existing wallet submission. No new transaction was prepared.");
    const result = await this.runtime.authorize(code, consent, intent), network = await this.chain.read(intent.session.wallet, signal);
    signal.throwIfAborted();
    const plan = await this.submissions.stage(code, intent, result, network);
    return { ...result, ...plan, network };
  }
  async begin(code: string, consent: unknown, intent: RuntimeIntent, signal: AbortSignal) {
    const authorized = await this.authorize(code, consent, intent, signal);
    signal.throwIfAborted();
    const dispatch = await this.runtime.beginSubmission(this.submissions, code, intent, { ...(authorized.version ? { version: authorized.version } : {}), expiresAt: authorized.expiresAt, transaction: authorized.transaction }, signal);
    return { ...dispatch, transaction: authorized.transaction };
  }
  async mintStatus(code: string, session: DurableSiteSession) {
    const request = await this.runtime.requests.get(code, session.id), saved = await this.submissions.state(code, session.id);
    const result = await this.#lookup(request.handle), item = result.item;
    // Only the projection proves inclusion; a browser report is never reveal authority.
    if ((result.state === "confirmed" || result.state === "confirming") && item && item.handle === request.handle && item.inputDigest
      && item.tokenId === BigInt(handleDigest(request.handle)).toString() && /^0x[0-9a-f]{64}$/.test(item.transactionHash ?? "")
      && item.rendererIdentity === this.chain.config.generativeRenderer!.identity && item.availability !== "quarantined" && !item.artifactDigest) {
      return { state: result.state === "confirmed" ? "minted" as const : "confirming" as const, transactionHash: item.transactionHash, submissionBlocked: true };
    }
    // No dispatch is not proof of chain absence. Fresh authorization preflight
    // owns eligibility; this read never labels an unobserved handle unminted.
    return { state: saved.blocked ? "pending" as const : "unknown" as const, submissionBlocked: saved.blocked,
      ...(saved.transactionHash ? { transactionHash: saved.transactionHash } : {}), submissionUncertain: saved.blocked && !saved.transactionHash };
  }
  async status(code: string, session: DurableSiteSession): Promise<AssessmentPageModel> {
    const s = await this.runtime.status(code, session), mint = await this.mintStatus(code, session);
    const proved = !!session.wallet && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > Date.now()
      && (!session.walletProof.codeHash || session.walletProof.codeHash === capabilityHash(code));
    return { ...s, status: s.status === "preparing" ? "pending" : s.status as "ready" | "failed" | "abstained",
      canMint: s.canMint && !mint.submissionBlocked, walletProvedForCode: proved, walletProofExpiresAt: session.walletProof?.expiresAt, mint };
  }
  /** Read-only page rendering. GET/reload never creates assessment or dispatch. */
  async page(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const raw = req.url ?? "", url = new URL(raw, this.runtime.sessions.origin), match = /^\/mint\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    if (url.pathname !== "/mint" && !match && raw !== "/assets/generative-wallet.js") return false;
    if (req.method !== "GET" || raw.split("?")[0] !== url.pathname || raw.length > 4096 || raw.includes("#") || req.headers["transfer-encoding"]
      || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw new PublicError(400, "INVALID_REQUEST", "Invalid page request.");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (raw === "/assets/generative-wallet.js") { res.setHeader("Content-Type", "text/javascript; charset=utf-8"); res.end(OPEN_MINT_CLIENT_SCRIPT); return true; }
    const options: OpenMintPageOptions = { stylesheetUrl: "/assets/generative-gallery.css", clientScriptUrl: "/assets/generative-wallet.js",
      chainId: "31337", chainName: "Local Anvil", contract: this.runtime.requests.profile.contract_address, durableWalletSubmission: true,
      pulseMint:!!this.runtime.requests.pulse };
    let body: string;
    if (match) {
      if (url.search) throw new PublicError(400, "INVALID_REQUEST", "Mint progress accepts no parameters.");
      const session = await this.runtime.sessions.requireSession(req.headers.cookie), model = await this.status(match[1], session);
      if (model.mint?.state === "minted" || model.mint?.state === "confirming") {
        res.statusCode = 303; res.setHeader("Location", `/signatures/${model.handle}`); res.end(); return true;
      }
      body = assessmentPage(model, { ...options, mintProcess: true, wallet: session.wallet, walletVerified: model.walletProvedForCode });
    } else {
      if ([...url.searchParams.keys()].some(k => k !== "handle") || url.searchParams.getAll("handle").length > 1) throw new PublicError(400, "INVALID_REQUEST", "Choose one handle.");
      const handle = url.searchParams.get("handle") ?? "";
      try { if (handle) preservedHandle(handle); } catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
      const found = await this.runtime.sessions.session(req.headers.cookie);
      if (found.created) res.setHeader("Set-Cookie", this.runtime.sessions.cookie(found.session));
      body = mintPage(handle, { ...options, wallet: found.session.wallet, walletVerified: this.runtime.sessionView(found.session).walletVerified });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(body); return true;
  }
}
