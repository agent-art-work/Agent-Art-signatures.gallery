import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssessmentProvider } from "../assessment.js";
import { verifyOnchainMintAuthorization as verifyOpenMintAuthorization } from "../onchainAuthorization.js";

import type { XIdentityResolver } from "../xIdentity.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { PostgresOnchainAuthorizationIssuer, type IssuanceIntent, type ReservedAuthorizationSigner } from "./onchainAuthorizations.js";
import { identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { PostgresOnchainArtifactJournal } from "./onchainArtifacts.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";

// Public scalar-1/scalar-2 test accounts; never live custody or a chain write.
const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("durable fully on-chain preparation pipeline composition (offline mocks, actual PostgreSQL and ECDSA)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined;
  const factory = () => new Client(cluster.config);
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "onchain-artifact-schema.sql", "onchain-authorization-schema.sql"]) {
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    }
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });

  it("accepts once, blocks missing frozen bytes, signs once, and reuses exact bytes after writer restart", async () => {
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const };
    const deploymentId = randomUUID(), gate = eligibilityFixture(ns.id, deploymentId);
    const p = { ...gate.profile, authorizer: authorizer.address.toLowerCase() };
    const witness = () => gate.witness("alice", wallet.address, { authorizer: authorizer.address, contractProfile: "onchain-v1" });
    // Only isolated test configuration is seeded. Results, requests, proofs,
    // receipts, frozen SVGs and signatures use the actual APIs.
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-pipeline-test','grok-offline-test',true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deploymentId, p.chain_id, p.contract_address, p.genesis_hash,
      p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.onchain_artifact_profiles VALUES($1,'signatures.gallery/onchain-artifact/v1')", [ns.id]);
    await admin.query("INSERT INTO open_mint.onchain_issuance_profiles VALUES($1,$2,true,600,5000,10000,120000,5000)", [ns.id, deploymentId]);

    writer = await ExclusiveWriter.acquire(factory);
    let repository = await OpenMintRepository.open(writer, ns);
    let requests = await PostgresMintRequests.open(repository, deploymentId);
    const sessionConfig = { namespaceId: ns.id, origin: p.origin, chainId: 31337 };
    let sessions = await PostgresWalletSessions.open({ ...sessionConfig, writer });
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, wallet.address);
    await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const request = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation,
      origin: p.origin, csrf: session.csrf, recipient: wallet.address, handle: "Alice", eligibility: await witness() });
    const intent = async (): Promise<AssessmentWorkerIntent> => ({ code: request.code, sessionToken: session.id,
      sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf, eligibility: await witness() });
    const issuerIntent = async (): Promise<IssuanceIntent> => ({ ...await intent(), consent: true });
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn<XIdentityResolver["resolve"]>(async (handle, execution) => {
      await execution!.recordReceipt(receipt("x-identity", "1"));
      return { ...identity(handle), username: "Alice", provenance: "x-api" };
    }) };
    const provider: AssessmentProvider = { provenance: "grok", model: "grok-offline-test", assess: vi.fn<AssessmentProvider["assess"]>(async (handle, snapshot, execution) => {
      await execution!.recordReceipt(receipt("grok", "1"));
      return { handle, mbti: "INTJ", model: "grok-offline-test", providerResponseId: "offline-pipeline-test",
        sourceUrls: ["https://x.com/Alice"], xUserId: snapshot!.userId };
    }) };
    const worker = new PostgresAssessmentWorker(requests, { timeoutMs: 10000, provider, identityResolver: resolver, refreshEligibility: witness });
    const result = await worker.run(await intent());
    expect(result.kind).toBe("accepted"); if (result.kind !== "accepted") throw new Error("Offline assessment not accepted");
    expect((await requests.get(request.code, session.id)).status).toBe("assessment-accepted");
    const assessmentBytes = (await admin.query<{ payload: Buffer }>("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload;
    expect(JSON.parse(assessmentBytes.toString())).toEqual(result.assessment);
    let journal = await PostgresOnchainArtifactJournal.open(writer, ns.id);
    let issuer = await PostgresOnchainAuthorizationIssuer.open(requests, journal);
    const signer: ReservedAuthorizationSigner = { address: authorizer.address, signTypedData: vi.fn(data => authorizer.signTypedData(data)) };
    await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow("Frozen on-chain");
    expect(signer.signTypedData).not.toHaveBeenCalled();
    const artifact = await journal.stage(result.assessment);
    expect(await journal.stage(result.assessment)).toEqual(artifact);
    const baseIntent = await issuerIntent();
    await expect(issuer.issue({ ...baseIntent, consent: false }, signer)).rejects.toThrow("Explicit mint intent");
    await expect(issuer.issue({ ...baseIntent, eligibility: await gate.witness("alice", wallet.address, { authorizer: authorizer.address }) }, signer)).rejects.toThrow("on-chain deployment");
    await expect(issuer.issue({ ...baseIntent, csrf: "bad" }, signer)).rejects.toThrow("current session");
    const nonce = await issuer.preflightNonce(baseIntent);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const reserved = await issuer.reserve(baseIntent);
    expect(await issuer.preflightNonce(baseIntent)).toBe(reserved.authorization.nonce);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    const issued = await issuer.issue(await issuerIntent(), signer);
    expect(issued.reservation.authorization.assessmentDigest).toBe(result.assessment.digest);
    expect(issued.reservation.authorization.artifactDigest).toBe(artifact.digest);
    expect(issued.reservation.tokenURI).toBe(artifact.tokenURI);
    expect(await verifyOpenMintAuthorization(issued.reservation.domain, issued.reservation.authorization,
      issued.signature, authorizer.address)).toBe(true);

    // Restart just this disposable writer; no active application/pilot is used.
    await writer.close(); writer = await ExclusiveWriter.acquire(factory);
    repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
    sessions = await PostgresWalletSessions.open({ ...sessionConfig, writer });
    expect((await sessions.session(sessions.cookie(session))).session).toEqual(session);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    const reused = await new PostgresAssessmentWorker(requests, { timeoutMs: 10000 }).run(await intent());
    expect(reused).toEqual({ ...result, reused: true });
    journal = await PostgresOnchainArtifactJournal.open(writer, ns.id);
    issuer = await PostgresOnchainAuthorizationIssuer.open(requests, journal);
    expect(await issuer.issue(await issuerIntent(), signer)).toEqual(issued);
    const saved = await journal.load(artifact.assessment.handle);
    expect(saved).toEqual(artifact);
    if (!saved) throw new Error("Frozen on-chain artifact missing");
    expect(saved.assessment).toEqual(result.assessment);
    expect((await admin.query<{ payload: Buffer }>("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload).toEqual(assessmentBytes);
    expect(provider.assess).toHaveBeenCalledOnce(); expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(signer.signTypedData).toHaveBeenCalledOnce();
    for (const table of ["onchain_artifacts", "onchain_authorization_signatures"]) {
      await expect(admin.query(`DELETE FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rejects.toThrow("immutable");
    }
    await expect(admin.query("UPDATE open_mint.onchain_authorizations SET payload=convert_to('{}','UTF8') WHERE namespace_id=$1", [ns.id])).rejects.toThrow("immutable");
    await sessions.logout(session.id);
    await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow();
    expect(signer.signTypedData).toHaveBeenCalledOnce();
    for (const table of ["assessment_attempts", "budget_reservations", "assessments", "onchain_authorization_signatures"]) {
      expect((await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rows[0].n).toBe(1);
    }
  }, 30000);
});
