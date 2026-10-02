import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssessmentOperations, type AssessmentAttempt, type AssessmentRecoveryCommand } from "./assessmentOperations.js";
import { GROK_PILOT_PROFILE } from "./providerProfile.js";
import { acquireProcessLock, FileKeyValueStore } from "./storage.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const REVIEW_NOW = NOW + 2000;
const script = fileURLToPath(new URL("../../scripts/open-mint-recovery.mjs", import.meta.url));
const { reviewRecovery } = await import(/* @vite-ignore */ script);
const run = promisify(execFile);
const paths: string[] = [];
const refusal = "Recovery refused: verify arguments, profile, evidence, existing data, and writer lock. No provider request was made.\n";
// Freeze only Date in CLI subprocesses, so the reviewed pricing cutoff remains
// deterministic without importing the application or inheriting billing secrets.
const clockImport = "data:text/javascript," + encodeURIComponent(`const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [${REVIEW_NOW}])); } static now() { return ${REVIEW_NOW}; } }; globalThis.fetch = () => { throw new Error('Offline recovery test forbids network requests.'); };`);
const cli = (args: string[]) => run(process.execPath, ["--import", clockImport, "--import", "tsx", script, ...args], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)), env: {}, timeout: 10_000, maxBuffer: 1024 * 1024,
});

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "sg-recovery-cli-"))); paths.push(parent);
  const dataDirectory = join(parent, "data"), records = join(dataDirectory, "records");
  const store = await FileKeyValueStore.create(records);
  let now = NOW;
  const operations = new AssessmentOperations({ store, now: () => now, generationEnabled: true, allowedHandle: "alice" });
  const source = await operations.admit("alice", GROK_PILOT_PROFILE.id);
  const execution = await operations.execution("alice");
  // Ledger fixtures only: none of these methods invokes a provider.
  await execution.beforeDispatch("x-identity");
  await execution.recordReceipt({ leg: "x-identity", startedAt: NOW, completedAt: NOW + 500, category: "http-error", httpStatus: 402,
    usageStatus: "missing", cost: { status: "unknown", currency: "USD", scale: 10 } });
  now += 1000; await operations.fail("alice", "identity", source.id);
  const command: AssessmentRecoveryCommand = { version: 1, sourceAttemptId: source.id, idempotencyKey: "offline-review-1", operatorReference: "operator-1",
    approvalReference: "approval-1", rejectionEvidenceReference: "x-402-review", billing: { actualCostUsdTicks: "0", evidenceReference: "billing-review-1" },
    profileVersion: GROK_PILOT_PROFILE.id, reservationUsdTicks: "10000000000" };
  const commandPath = join(parent, "command.json"); await writeFile(commandPath, JSON.stringify(command));
  return { parent, dataDirectory, records, store, source, command, commandPath, args: ["--data-dir", dataDirectory, "--command", commandPath] };
}

/** Captures file content and modification metadata, but never follows links. */
async function snapshot(directory: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path, { bigint: true });
    entries.push(info.isDirectory() ? [name, "directory", await snapshot(path)]
      : info.isSymbolicLink() ? [name, "symlink", info.mtimeNs.toString()]
        : [name, info.mode.toString(), info.mtimeNs.toString(), (await readFile(path)).toString("base64")]);
  }
  return entries;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(REVIEW_NOW);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline recovery test forbids network requests."); }));
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("offline recovery review and staging", () => {
  it("performs a dry run without writes, directories, a writer lock, or dispatch permission", async () => {
    const test = await fixture(), before = await snapshot(test.dataDirectory);
    const report = await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command });
    expect(report).toMatchObject({ sourceAttemptId: test.source.id, handle: "alice", additionalAttempts: 1, totalReservationsAfter: 2,
      exposureAfterUsdTicks: "10000000000", dispatchAllowed: false });
    expect(report.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await snapshot(test.dataDirectory)).toEqual(before);
    expect((await readdir(test.dataDirectory)).sort()).toEqual(["records"]);
  });

  it("allows dry-run inspection while the app holds its lock, but refuses apply without stealing it", async () => {
    const test = await fixture(), unlock = await acquireProcessLock(test.dataDirectory);
    try {
      const before = await snapshot(test.dataDirectory);
      const report = await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command });
      await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command, apply: true, reviewDigest: report.reviewDigest })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await snapshot(test.dataDirectory)).toEqual(before);
      expect(await readFile(join(test.dataDirectory, "writer.lock"), "utf8")).toBe(String(process.pid));
    } finally { await unlock(); }
  });

  it("stages once, releases its exclusive lock, preserves source bytes and is idempotent after restart", async () => {
    const test = await fixture(), sourceBefore = await readFile(test.store.path("attempt:alice"));
    const receiptBefore = await readFile(test.store.path(`receipt:${test.source.id}_x`));
    const preview = await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command });
    const input = { dataDirectory: test.dataDirectory, command: test.command, apply: true, reviewDigest: preview.reviewDigest };
    const result = await reviewRecovery(input);
    expect(result).toMatchObject({ sourceAttemptId: test.source.id, handle: "alice", status: "staged", dispatchAllowed: false });
    expect(result.attemptId).not.toBe(test.source.id);
    expect(await readFile(test.store.path("attempt:alice"))).toEqual(sourceBefore);
    expect(await readFile(test.store.path(`receipt:${test.source.id}_x`))).toEqual(receiptBefore);
    const files = await FileKeyValueStore.create(test.records);
    expect(await files.get(`recoveryattempt:${result.attemptId}`)).toMatchObject({ outcome: "pending", phases: {}, recovery: { sourceAttemptId: test.source.id } });
    expect((await files.get<{ reservations: unknown[] }>("budget:paid_v1"))!.reservations).toHaveLength(2);
    const beforeRepeat = await snapshot(test.dataDirectory);
    expect(await reviewRecovery(input)).toEqual(result);
    expect(await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command })).toEqual(preview);
    expect(await snapshot(test.dataDirectory)).toEqual(beforeRepeat);
    expect(await readdir(test.dataDirectory)).not.toContain("writer.lock");
  });

  it("replays only the exact committed grant after a recovered assessment is saved, without restaging or changing canonical bytes", async () => {
    const test = await fixture(), preview = await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command });
    const input = { dataDirectory: test.dataDirectory, command: test.command, apply: true, reviewDigest: preview.reviewDigest };
    const result = await reviewRecovery(input), key = `recoveryattempt:${result.attemptId}`;
    const staged = await test.store.get<AssessmentAttempt>(key);
    // Model a durably accepted result without running either provider or an app.
    await test.store.put(key, { ...staged, outcome: "accepted", phases: { grokDispatchedAt: REVIEW_NOW, outcomeAt: REVIEW_NOW, assessmentPersistedAt: REVIEW_NOW },
      reconciliation: "operator-review", acceptedAssessment: { id: "recovered-assessment-1", digest: `0x${"a".repeat(64)}` } });
    const assessments = join(test.dataDirectory, "assessments"); await mkdir(assessments);
    await writeFile(join(assessments, "alice.json"), JSON.stringify({ id: "recovered-assessment-1", handle: "alice", immutable: true }));
    const before = await snapshot(test.dataDirectory);
    expect(await reviewRecovery(input)).toEqual(result);
    expect(await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command })).toEqual(preview);
    expect(JSON.parse((await cli([...test.args, "--apply", "--review-digest", preview.reviewDigest])).stdout)).toEqual(result);
    for (const patch of [{ approvalReference: "changed-approval" }, { idempotencyKey: "another-grant" }]) {
      const command = { ...test.command, ...patch };
      await expect(reviewRecovery({ ...input, command })).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_CONFLICT" });
      await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command })).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_CONFLICT" });
    }
    await expect(reviewRecovery({ ...input, reviewDigest: "a".repeat(64) })).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_REVIEW_REQUIRED" });
    expect(await snapshot(test.dataDirectory)).toEqual(before);
    expect(await readdir(test.dataDirectory)).not.toContain("writer.lock");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "not-a-digest", "a".repeat(64)])("rejects an absent, malformed or unreviewed apply digest %# and releases any acquired lock", async reviewDigest => {
    const test = await fixture(), before = await snapshot(test.dataDirectory);
    await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command, apply: true, reviewDigest })).rejects.toThrow();
    expect(await snapshot(test.dataDirectory)).toEqual(before);
    const unlock = await acquireProcessLock(test.dataDirectory); await unlock();
  });

  it.each(["profile", "reservation", "cutoff", "after-cutoff", "invalid-time"])("refuses %s before staging or modifying files", async variant => {
    const test = await fixture(), before = await snapshot(test.dataDirectory);
    const command = { ...test.command, ...(variant === "profile" ? { profileVersion: "unreviewed-profile" } : variant === "reservation" ? { reservationUsdTicks: "1" } : {}) };
    const now = new Date(variant === "cutoff" ? GROK_PILOT_PROFILE.pricingChangesAt : variant === "after-cutoff" ? Date.parse(GROK_PILOT_PROFILE.pricingChangesAt) + 1 : variant === "invalid-time" ? NaN : REVIEW_NOW);
    await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command, now, apply: true, reviewDigest: "a".repeat(64) })).rejects.toThrow("current unexpired pilot profile");
    expect(await snapshot(test.dataDirectory)).toEqual(before);
  });

  it("allows review immediately before the profile cutoff", async () => {
    const test = await fixture();
    expect(await reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command, now: new Date(Date.parse(GROK_PILOT_PROFILE.pricingChangesAt) - 1) })).toMatchObject({ dispatchAllowed: false });
  });

  it.each(["file", "directory", "dangling-symlink"])("refuses an existing canonical assessment path (%s) without opening or rewriting it", async kind => {
    const test = await fixture(), assessments = join(test.dataDirectory, "assessments"), canonical = join(assessments, "alice.json");
    await mkdir(assessments);
    if (kind === "file") await writeFile(canonical, "canonical-content-must-not-be-read-as-a-new-assessment");
    else if (kind === "directory") await mkdir(canonical);
    else await symlink(join(test.parent, "absent-canonical.json"), canonical);
    const before = await snapshot(test.dataDirectory);
    for (const apply of [false, true]) await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command, apply, reviewDigest: "a".repeat(64) })).rejects.toThrow("canonical assessment already exists");
    expect(await snapshot(test.dataDirectory)).toEqual(before);
  });
});

describe("recovery filesystem boundaries", () => {
  it.each(["relative", "root", "missing", "file", "symlink", "parent-symlink"])("refuses a %s data directory without creating records", async kind => {
    const test = await fixture();
    let dataDirectory = kind === "relative" ? "relative-data" : kind === "root" ? "/" : join(test.parent, "unavailable");
    if (kind === "file") await writeFile(dataDirectory, "not a directory");
    if (kind === "symlink") await symlink(test.dataDirectory, dataDirectory);
    if (kind === "parent-symlink") { await symlink(test.parent, join(test.parent, "alias")); dataDirectory = join(test.parent, "alias", "data"); }
    const before = await snapshot(test.parent);
    await expect(reviewRecovery({ dataDirectory, command: test.command })).rejects.toThrow();
    expect(await snapshot(test.parent)).toEqual(before);
  });

  it.each(["missing", "file", "symlink"])("refuses %s records without creating or following them", async kind => {
    const test = await fixture(), other = join(test.parent, "other"); await mkdir(other);
    if (kind === "file") await writeFile(join(other, "records"), "not a directory");
    if (kind === "symlink") await symlink(test.records, join(other, "records"));
    const before = await snapshot(test.parent);
    await expect(reviewRecovery({ dataDirectory: other, command: test.command })).rejects.toThrow();
    expect(await snapshot(test.parent)).toEqual(before);
  });

  it.each(["symlink", "oversized", "malformed"])("rejects a %s operational record without staging", async kind => {
    const test = await fixture(), attempt = test.store.path("attempt:alice");
    if (kind === "symlink") { const target = join(test.parent, "source.json"); await rename(attempt, target); await symlink(target, attempt); }
    else await writeFile(attempt, kind === "oversized" ? Buffer.alloc(8 * 1024 * 1024 + 1, 32) : "private-malformed-record");
    const before = await snapshot(test.dataDirectory);
    await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command, apply: true, reviewDigest: "a".repeat(64) })).rejects.toThrow();
    expect(await snapshot(test.dataDirectory)).toEqual(before);
    expect(await readdir(test.dataDirectory)).not.toContain("writer.lock");
  });

  it("refuses a symlinked canonical assessment directory", async () => {
    const test = await fixture(), target = join(test.parent, "canonical"); await mkdir(target);
    await symlink(target, join(test.dataDirectory, "assessments"));
    const before = await snapshot(test.parent);
    await expect(reviewRecovery({ dataDirectory: test.dataDirectory, command: test.command })).rejects.toThrow("real, existing directory");
    expect(await snapshot(test.parent)).toEqual(before);
  });
});

describe("recovery command-line boundary", () => {
  it("runs real CLI dry-run and apply with no inherited environment secrets or provider calls", async () => {
    const test = await fixture(), before = await snapshot(test.dataDirectory);
    const reviewed = await cli(test.args); expect(reviewed.stderr).toBe("");
    const preview = JSON.parse(reviewed.stdout);
    expect(preview).toMatchObject({ sourceAttemptId: test.source.id, dispatchAllowed: false });
    expect(await snapshot(test.dataDirectory)).toEqual(before);
    const args = [...test.args, "--apply", "--review-digest", preview.reviewDigest];
    const applied = await cli(args), result = JSON.parse(applied.stdout); expect(applied.stderr).toBe("");
    expect(result).toMatchObject({ status: "staged", dispatchAllowed: false });
    const saved = await snapshot(test.dataDirectory);
    expect(JSON.parse((await cli(args)).stdout)).toEqual(result);
    expect(await snapshot(test.dataDirectory)).toEqual(saved);
  }, 30_000);

  it.each(["unknown", "duplicate", "missing-value", "missing-command", "digest-without-apply", "positional"])("rejects %s arguments with sanitized diagnostics", async kind => {
    const test = await fixture(), before = await snapshot(test.dataDirectory);
    const args = kind === "unknown" ? [...test.args, "--private-unrecognized-secret"] : kind === "duplicate" ? [...test.args, "--data-dir", test.dataDirectory]
      : kind === "missing-value" ? [...test.args, "--review-digest", "--apply"] : kind === "missing-command" ? test.args.slice(0, 2)
        : kind === "digest-without-apply" ? [...test.args, "--review-digest", "a".repeat(64)] : [...test.args, "private-positional-secret"];
    await expect(cli(args)).rejects.toMatchObject({ code: 1, stdout: "", stderr: refusal });
    expect(await snapshot(test.dataDirectory)).toEqual(before);
  });

  it.each(["relative", "symlink", "directory", "oversized", "malformed-json", "unknown-field"])("rejects a %s command file without echoing its path or payload", async kind => {
    const test = await fixture(); let commandPath = test.commandPath;
    if (kind === "relative") commandPath = "private-command.json";
    else if (kind === "symlink") { commandPath = join(test.parent, "private-link.json"); await symlink(test.commandPath, commandPath); }
    else if (kind === "directory") commandPath = test.parent;
    else if (kind === "oversized") await writeFile(commandPath, JSON.stringify(test.command).padEnd(16_385, " "));
    else if (kind === "malformed-json") await writeFile(commandPath, '{"private-secret":');
    else await writeFile(commandPath, JSON.stringify({ ...test.command, privateSecret: "must-not-leak" }));
    const before = await snapshot(test.parent);
    const failed = await cli(["--data-dir", test.dataDirectory, "--command", commandPath]).catch(error => error);
    expect(failed).toMatchObject({ code: 1, stdout: "" });
    expect(failed.stderr).toMatch(/^Recovery refused: (?:ASSESSMENT_OPERATIONS_CORRUPT\.|verify arguments, profile, evidence, existing data, and writer lock\. No provider request was made\.)\n$/);
    expect(failed.stderr).not.toMatch(/private|secret|must-not-leak|command\.json/);
    expect(await snapshot(test.parent)).toEqual(before);
  });

  it("accepts a valid command exactly at the 16 KiB size limit", async () => {
    const test = await fixture(); await writeFile(test.commandPath, JSON.stringify(test.command).padEnd(16_384, " "));
    const before = await snapshot(test.parent), result = await cli(test.args);
    expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)).toMatchObject({ dispatchAllowed: false });
    expect(await snapshot(test.parent)).toEqual(before);
  });
});
