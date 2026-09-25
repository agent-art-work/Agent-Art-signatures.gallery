import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type QueryResultRow } from "pg";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admissionDigest, ADMISSION_OPERATIONS, createAdmissionGate, type AdmissionPorts, type AdmissionScope } from "../staging/admission.js";
import { GENERATIVE_MINT_ABI, normalizeGenerativeAuthorization } from "../generativeAuthorization.js";
import { observeLocalMintBinding, prepareLocalMintAdmission, type LocalMintOperation } from "./mintAdmission.js";
import { PostgresGenerativeAuthorizationIssuer, type ReservedAuthorizationSigner } from "./generativeAuthorizations.js";
import { PostgresGenerativeInputJournal } from "./generativeInputs.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { PostgresWalletSubmissions } from "./walletSubmissions.js";
import { eligibilityFixture, fixturePinForProfile } from "./fixtures/eligibility.js";
import { identity, namespace, receipt } from "./fixtures/data.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { generativeBrowserRuntimeGrants } from "./runtimeRole.js";
import { ExclusiveWriter, type OwnershipConnectionFactory } from "./writer.js";

// No network providers, wallet extension, actual transaction or live key.
const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
const role = "sg_browser", model = "grok-offline-test", hash = "a".repeat(64);
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("local RC1 signing and wallet admission (disposable PostgreSQL)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined;
  const runtime = () => new Client({ ...cluster.config, user: role, options: "-c search_path=pg_catalog" });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "generative-input-schema.sql", "generative-release-profile-schema.sql", "generative-authorization-schema.sql", "wallet-submission-schema.sql",
      "../projection/projection-schema.sql", "../projection/projection-v2.sql", "../projection/projection-v3.sql"])
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(generativeBrowserRuntimeGrants(role));
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });
  async function setup(factory: OwnershipConnectionFactory = runtime) {
    await writer?.close(); writer = undefined;
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const }, deployment = randomUUID();
    const chain = eligibilityFixture(ns.id, deployment), p = { ...chain.profile, authorizer: authorizer.address.toLowerCase() }, pin = fixturePinForProfile("generative-v1-rc1");
    const witness = () => chain.witness("alice", wallet.address, { authorizer: authorizer.address, contractProfile: "generative-v1-rc1", generativeRenderer: pin });
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-mint-admission',$2,true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id, model]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deployment, p.chain_id, p.contract_address, p.genesis_hash, p.runtime_code_hash,
      p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-inputs-v1-rc1',$3,$4,$5)", [ns.id, deployment, pin.address, pin.runtimeCodeHash, pin.identity]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,true,600,200,10000,120000,5000)", [ns.id, deployment]);
    writer = await ExclusiveWriter.acquire(factory);
    const repository = await OpenMintRepository.open(writer, ns), requests = await PostgresMintRequests.open(repository, deployment);
    const sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: p.origin, chainId: 31337 });
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, wallet.address);
    await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const request = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf,
      recipient: wallet.address, handle: "Alice", eligibility: await witness() });
    const input = async () => ({ code: request.code, sessionToken: session.id, sessionGeneration: session.generation,
      origin: p.origin, csrf: session.csrf, eligibility: await witness(), consent: true });
    const worker = new PostgresAssessmentWorker(requests, { timeoutMs: 5000, refreshEligibility: witness,
      identityResolver: { provenance: "x-api", resolve: async (handle, execution) => { await execution!.recordReceipt(receipt("x-identity", "1")); return { ...identity(handle), username: "Alice", provenance: "x-api" }; } },
      provider: { provenance: "grok", model, assess: async (handle, snapshot, execution) => { await execution!.recordReceipt(receipt("grok", "1"));
        return { handle, mbti: "INTJ", model, providerResponseId: "offline-mint-admission", sourceUrls: ["https://x.com/Alice"], xUserId: snapshot!.userId }; } },
    });
    const result = await worker.run(await input()); if (result.kind !== "accepted") throw Error("Offline fixture assessment failed");
    const journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deployment); await journal.stage(result.assessment);
    const issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal), reservation = await issuer.reserve(await input());
    const signer = { address: authorizer.address, signTypedData: vi.fn<ReservedAuthorizationSigner["signTypedData"]>(data => authorizer.signTypedData(data)) };
    const submissions = new PostgresWalletSubmissions(requests), browser = { session, origin: p.origin, csrf: session.csrf };
    const scope: AdmissionScope = { operatingPlanSha256: hash, activePolicySha256: hash, reviewRevisionSha256: hash,
      databaseBindingSha256: await observeLocalMintBinding(requests, role), writerEpoch: writer.epoch,
      timeoutMs: 5000, permitTtlMs: 5000, paidValidFrom: Date.now() - 2000, paidValidUntil: Date.now() - 1000 };
    const config = { expectedRole: role, databaseBindingSha256: scope.databaseBindingSha256, scopeSha256: admissionDigest(scope), leaseMs: 5000 };
    const controls = { reviewed: true };
    const gate = <T>(adapter: Awaited<ReturnType<typeof prepareLocalMintAdmission<T>>>) => createAdmissionGate<T>(scope, {
      chain: { observe: async () => ({}), read: (_w, now) => ({ observedAt: now, validUntil: now + 5000 }) },
      requireReview() { if (!controls.reviewed) throw Error("Mock review withdrawn"); }, database: adapter.database,
      effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, op === adapter.intent.operation ? adapter.effect : async () => { throw Error("Unregistered operation"); }])) as AdmissionPorts<T>["effects"],
    });
    const signOperation = () => input().then(v => issuer.prepareSigningAdmission(v, signer));
    const sign = async () => { const a = await prepareLocalMintAdmission(await signOperation(), config), g = gate(a); return g.execute(await g.prepare(a.intent)); };
    const plan = async () => {
      const issued = await issuer.issue(await input(), signer);
      return submissions.stage(request.code, browser, { expiresAt: new Date(Number(issued.reservation.authorization.deadline) * 1000).toISOString(), transaction: {
        from: wallet.address, to: issued.reservation.domain.verifyingContract, chainId: "0x7a69", value: "0x0",
        data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: ["Alice", "INTJ", normalizeGenerativeAuthorization(issued.reservation.authorization), issued.signature] }),
      } }, { chainId: "0x7a69", contract: issued.reservation.domain.verifyingContract, blockNumber: "0xa", blockHash: chain.config.deploymentBlock.hash, nonce: "0x0" });
    };
    const state = async () => (await admin.query("SELECT state FROM open_mint.generative_authorizations WHERE namespace_id=$1", [ns.id])).rows[0].state;
    const dispatches = async () => (await admin.query("SELECT count(*)::int AS n FROM open_mint.wallet_mint_dispatches WHERE namespace_id=$1", [ns.id])).rows[0].n;
    return { ns, deployment, repository, requests, sessions, session, issuer, journal, input, request, signer, submissions, browser, scope, config, controls, gate,
      signOperation, sign, plan, reservation, state, dispatches };
  }

  it("keeps preparation read-only, signs exactly once, and releases the exact saved wallet plan", async () => {
    const h = await setup(), operation = await h.signOperation(), a = await prepareLocalMintAdmission(operation, h.config), g = h.gate(a), token = await g.prepare(a.intent);
    expect(await h.state()).toBe("reserved"); expect(h.signer.signTypedData).not.toHaveBeenCalled();
    await expect(a.effect(a.intent, new AbortController().signal, () => {})).rejects.toThrow();
    const result = await g.execute(token); expect(result.reservation).toEqual(h.reservation); expect(await h.state()).toBe("signed");
    expect(h.signer.signTypedData).toHaveBeenCalledOnce(); await expect(g.execute(token)).rejects.toThrow();
    await expect(h.signOperation()).rejects.toThrow();
    const plan = await h.plan(); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    const op = await h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, plan);
    const wa = await prepareLocalMintAdmission(op, h.config), wg = h.gate(wa), wp = await wg.prepare(wa.intent);
    expect(await h.dispatches()).toBe(0);
    const sent = await wg.execute(wp); expect(sent.permit).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(await h.dispatches()).toBe(1);
    await expect(h.submissions.begin(h.request.code, h.browser, plan)).rejects.toThrow();
    await h.submissions.report(h.request.code, h.browser, sent.permit, "submitted", `0x${"22".repeat(32)}`);
    expect((await h.submissions.state(h.request.code, h.session.id)).blocked).toBe(true);
  });
  it("releases exact saved signatures through a read-only gate without another fence or signer call", async () => {
    const h = await setup(), saved = await h.sign();
    const operation = await h.issuer.prepareIssuanceAdmission(await h.input(), h.signer);
    expect(operation.intent.operation).toBe("reuse");
    const a = await prepareLocalMintAdmission(operation, h.config), g = h.gate(a), s = new AbortController().signal;
    const lease = await a.database.inspect(a.intent, h.config.scopeSha256, s);
    await expect(lease.fence(s)).rejects.toThrow();
    await expect(h.repository.writer.transaction(tx => operation.fence(tx))).rejects.toThrow("read-only");
    expect(await g.execute(await g.prepare(a.intent))).toEqual(saved);
    expect(await h.state()).toBe("signed"); expect(await h.dispatches()).toBe(0); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
  });

  for (const stage of ["sign", "wallet"] as const) {
    it.each(["logout", "proof", "disabled", "review", "halt", "writer", "grants"])(`${stage} rechecks %s after preparation`, async reason => {
      const h = await setup();
      const operation = stage === "sign" ? await h.signOperation() : await h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, await h.plan());
      const a = await prepareLocalMintAdmission(operation as LocalMintOperation<unknown>, h.config), g = h.gate(a), p = await g.prepare(a.intent);
      if (reason === "logout") await h.sessions.logout(h.session.id);
      if (reason === "proof") await h.sessions.challenge(h.session.id, wallet.address);
      if (reason === "disabled") await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [h.ns.id]);
      if (reason === "review") h.controls.reviewed = false;
      if (reason === "halt") a.halt();
      if (reason === "writer") await writer!.close();
      if (reason === "grants") await admin.query(`GRANT UPDATE(enabled) ON open_mint.generative_issuance_profiles TO ${role}`);
      try { await expect(g.execute(p)).rejects.toThrow(); expect(h.signer.signTypedData).toHaveBeenCalledTimes(stage === "sign" ? 0 : 1);
        expect(await h.state()).toBe(stage === "sign" ? "reserved" : "signed"); expect(await h.dispatches()).toBe(0); }
      finally { if (reason === "grants") await admin.query(`REVOKE UPDATE(enabled) ON open_mint.generative_issuance_profiles FROM ${role}`); }
    });

    it.each(["lost-commit", "abort"])(`${stage} preserves a durable fence after %s`, async failure => {
      const faults = { armed: false, fenced: false }, cancel = new AbortController();
      const h = await setup(() => {
        const client = runtime();
        return { connect: () => client.connect(), end: () => client.end(), on: (event, listener) => client.on(event, listener),
          async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
            const result = await client.query<R>(sql, values);
            if (faults.armed && (sql.startsWith("UPDATE open_mint.generative_authorizations SET state='signing'") || sql.startsWith("INSERT INTO open_mint.wallet_mint_dispatches"))) {
              faults.fenced = true; if (failure === "abort") cancel.abort();
            }
            if (faults.armed && faults.fenced && sql === "COMMIT" && failure === "lost-commit") throw Error("Injected lost COMMIT reply");
            return result;
          },
        };
      });
      const plan = stage === "wallet" ? await h.plan() : undefined;
      const op = stage === "sign" ? await h.signOperation() : await h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, plan!);
      const a = await prepareLocalMintAdmission(op as LocalMintOperation<unknown>, h.config), g = h.gate(a), p = await g.prepare(a.intent);
      faults.armed = true;
      await expect(g.execute(p, cancel.signal)).rejects.toMatchObject({ effectMayHaveStarted: false });
      expect(h.signer.signTypedData).toHaveBeenCalledTimes(stage === "sign" ? 0 : 1);
      expect(await h.state()).toBe(stage === "wallet" ? "signed" : failure === "lost-commit" ? "signing" : "reserved");
      expect(await h.dispatches()).toBe(stage === "wallet" && failure === "lost-commit" ? 1 : 0);
      faults.armed = false;
      await writer!.close(); writer = await ExclusiveWriter.acquire(runtime);
      const repository = await OpenMintRepository.open(writer, h.ns), requests = await PostgresMintRequests.open(repository, h.deployment);
      if (failure === "lost-commit") {
        const journal = await PostgresGenerativeInputJournal.open(writer, h.ns.id, h.deployment), issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
        if (stage === "sign") await expect(issuer.issue(await h.input(), h.signer)).rejects.toThrow();
        else await expect(new PostgresWalletSubmissions(requests).begin(h.request.code, h.browser, plan!)).rejects.toThrow();
      }
      expect(h.signer.signTypedData).toHaveBeenCalledTimes(stage === "sign" ? 0 : 1);
    });
  }

  it.each(["invalid", "timeout", "withdrawn-after-await"])("signer %s keeps unknown authority reserved", async failure => {
    const h = await setup();
    h.signer.signTypedData.mockImplementation(async data => {
      if (failure === "invalid") return "0x";
      if (failure === "timeout") return new Promise<string>(() => {});
      await Promise.resolve(); h.controls.reviewed = false; return authorizer.signTypedData(data);
    });
    await expect(h.sign()).rejects.toThrow(); expect(await h.state()).toBe("unknown");
    await expect(h.signOperation()).rejects.toThrow(); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
  });

  it("rechecks review after a handler await, before invoking the signer", async () => {
    const h = await setup(), op = await h.signOperation();
    const wrapped = { ...op, effect: async (signal: AbortSignal, guard: () => void) => {
      await Promise.resolve(); h.controls.reviewed = false; return op.effect(signal, guard);
    } };
    const a = await prepareLocalMintAdmission(wrapped, h.config), g = h.gate(a);
    await expect(g.execute(await g.prepare(a.intent))).rejects.toThrow();
    expect(h.signer.signTypedData).not.toHaveBeenCalled(); expect(await h.state()).toBe("signing");
  });

  it("forwards caller cancellation to the signer and preserves uncertainty", async () => {
    const h = await setup(), stop = new AbortController(); let received: AbortSignal | undefined;
    h.signer.signTypedData.mockImplementation(async (_data, signal) => {
      received = signal; stop.abort(); return new Promise<string>(() => {});
    });
    const a = await prepareLocalMintAdmission(await h.signOperation(), h.config), g = h.gate(a);
    await expect(g.execute(await g.prepare(a.intent), stop.signal)).rejects.toThrow();
    // Gate cancellation may return first; drain bounded signer outcome writes.
    await vi.waitFor(async () => expect(await h.state()).toBe("unknown"));
    expect(received?.aborted).toBe(true); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    await expect(h.signOperation()).rejects.toThrow();
  });

  it("does not couple signing or wallet release to a new paid generation period", async () => {
    const h = await setup();
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    await h.sign(); const plan = await h.plan();
    const op = await h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, plan);
    const a = await prepareLocalMintAdmission(op, h.config), g = h.gate(a); await g.execute(await g.prepare(a.intent));
    expect(h.signer.signTypedData).toHaveBeenCalledOnce(); expect(await h.dispatches()).toBe(1);
  });

  it("rejects corrupted stored signatures before releasing wallet authority", async () => {
    const h = await setup(), plan = await h.plan();
    await admin.query("BEGIN");
    try {
      // Deliberate corruption injection in this disposable test DB only.
      await admin.query("SET LOCAL session_replication_role=replica");
      await admin.query("UPDATE open_mint.generative_authorization_signatures SET signature=$2 WHERE namespace_id=$1", [h.ns.id, `0x${"00".repeat(65)}`]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    await expect(h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, plan)).rejects.toThrow();
    expect(await h.dispatches()).toBe(0); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
  });

  it("only one independently prepared signing operation wins", async () => {
    const h = await setup(), a = await prepareLocalMintAdmission(await h.signOperation(), h.config), b = await prepareLocalMintAdmission(await h.signOperation(), h.config);
    const ga = h.gate(a), gb = h.gate(b), pa = await ga.prepare(a.intent), pb = await gb.prepare(b.intent);
    const results = await Promise.allSettled([ga.execute(pa), gb.execute(pb)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
  });

  it("recovers the exact saved signature when the result COMMIT reply is lost", async () => {
    const fault = { armed: false, signed: false };
    const h = await setup(() => {
      const client = runtime();
      return { connect: () => client.connect(), end: () => client.end(), on: (event, listener) => client.on(event, listener),
        async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
          const result = await client.query<R>(sql, values);
          if (fault.armed && sql.startsWith("UPDATE open_mint.generative_authorizations SET state='signed'")) fault.signed = true;
          if (fault.armed && fault.signed && sql === "COMMIT") throw Error("Injected lost signed-result reply");
          return result;
        },
      };
    });
    fault.armed = true;
    await expect(h.sign()).rejects.toMatchObject({ effectMayHaveStarted: true });
    expect(await h.state()).toBe("signed"); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    const saved = (await admin.query("SELECT signature FROM open_mint.generative_authorization_signatures WHERE namespace_id=$1", [h.ns.id])).rows[0].signature;
    fault.armed = false; await writer!.close(); writer = await ExclusiveWriter.acquire(runtime);
    const repo = await OpenMintRepository.open(writer, h.ns), requests = await PostgresMintRequests.open(repo, h.deployment);
    const journal = await PostgresGenerativeInputJournal.open(writer, h.ns.id, h.deployment), issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
    const recovered = await issuer.issue(await h.input(), h.signer);
    expect(recovered.signature).toBe(saved); expect(recovered.reservation).toEqual(h.reservation);
    expect(h.signer.signTypedData).toHaveBeenCalledOnce();
  });

  it("wallet rejection allows only a bounded explicit resend of identical nonce and calldata", async () => {
    const h = await setup(), plan = await h.plan();
    for (let n = 1; n <= 5; n++) {
      const op = await h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, plan);
      const a = await prepareLocalMintAdmission(op, h.config), g = h.gate(a), result = await g.execute(await g.prepare(a.intent));
      await h.submissions.report(h.request.code, h.browser, result.permit, "rejected");
    }
    expect(await h.dispatches()).toBe(5); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    await expect(h.submissions.prepareSubmissionAdmission(h.issuer, await h.input(), h.browser, plan)).rejects.toThrow();
    await expect(h.submissions.begin(h.request.code, h.browser, { ...plan, transaction: { ...plan.transaction, nonce: "0x1" } })).rejects.toThrow();
  });

  it.each(["scope", "digest", "operation", "expired", "aborted"])("rejects %s leases without signing", async field => {
    const h = await setup(), a = await prepareLocalMintAdmission(await h.signOperation(), h.config), c = new AbortController();
    if (field === "aborted") c.abort();
    const value = { ...a.intent, ...(field === "digest" ? { payloadSha256: "b".repeat(64) } : field === "operation" ? { operation: "wallet-submit" as const } : {}) };
    if (field === "expired") {
      const lease = await a.database.inspect(value, h.config.scopeSha256, c.signal);
      vi.spyOn(Date, "now").mockReturnValue(lease.validUntil);
      try { await expect(lease.fence(c.signal)).rejects.toThrow(); } finally { vi.restoreAllMocks(); }
    } else await expect(a.database.inspect(value, field === "scope" ? "b".repeat(64) : h.config.scopeSha256, c.signal)).rejects.toThrow();
    expect(await h.state()).toBe("reserved"); expect(h.signer.signTypedData).not.toHaveBeenCalled();
  });

  it.each(["csrf", "consent", "chain", "signer", "wallet-plan"])("rejects crossed %s before admission", async field => {
    const h = await setup(), input = await h.input();
    if (field === "csrf") input.csrf = "bad";
    if (field === "consent") input.consent = false;
    if (field === "chain") input.eligibility = {} as typeof input.eligibility;
    if (field === "wallet-plan") {
      const plan = await h.plan(); plan.transaction.nonce = "0x1";
      await expect(h.submissions.prepareSubmissionAdmission(h.issuer, input, h.browser, plan)).rejects.toThrow();
    } else await expect(h.issuer.prepareSigningAdmission(input, field === "signer" ? { ...h.signer, address: wallet.address } : h.signer)).rejects.toThrow();
    expect(h.signer.signTypedData).toHaveBeenCalledTimes(field === "wallet-plan" ? 1 : 0);
  });
});
