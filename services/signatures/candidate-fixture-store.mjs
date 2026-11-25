// SQLite bindings for disposable curve studies. Neither initializer accepts a pilot database.
import { DatabaseSync } from "node:sqlite";
import { ARCHIVE_DDL, candidateArchive } from "../../.local/candidate-build/candidates/archive.js";
import { CANDIDATE_SCHEMA, CANDIDATE_V3_MIGRATION } from "../../.local/candidate-build/candidates/schema.js";

function openFixture(path, fixtureId, schema, version) {
  const sqlite = new DatabaseSync(path);
  try {
    const id = sqlite.prepare("PRAGMA application_id").get().application_id;
    const installed = sqlite.prepare("PRAGMA user_version").get().user_version;
    if (id === 0 && installed === 0 && !sqlite.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
      sqlite.exec(`BEGIN IMMEDIATE; ${schema}
        PRAGMA application_id = ${fixtureId}; PRAGMA user_version = ${version}; COMMIT;`);
    } else if (fixtureId === 0x53474331 && id === fixtureId && installed === 2 && version === 3) {
      sqlite.exec(`BEGIN IMMEDIATE; ${CANDIDATE_V3_MIGRATION} PRAGMA user_version = 3; COMMIT;`);
    } else if (id !== fixtureId || installed !== version) {
      throw new Error("Use a separate curve study database of the current fixture version.");
    }
    sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;");
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const binding = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async all() { return { results: statement.all(...values) }; },
          };
        },
      };
    },
  };
  return { sqlite, binding, close: () => sqlite.close() };
}

export function openCandidateFixture(path) {
  const fixture = openFixture(path, 0x53474331, CANDIDATE_SCHEMA, 3);
  return {
    ...fixture,
    importAtomically(rows, revocations, observedAt) {
      const db = fixture.sqlite;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM curve_attempts LIMIT 1").get()) throw Error("Restore target is not empty.");
        const insert = db.prepare(`INSERT INTO curve_attempts (
          encounter, work_instance, definition, policy, curator, agent, handle, handle_key, original_svg,
          original_sha, original_points, draft_digest, edit_json, intention, final_svg, final_sha,
          approved_digest, approved_at, write_until, recover_until, candidate_format, posts_json, local_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const replay = db.prepare(`UPDATE curve_attempts SET operation_id = ?, receipt_json = ?, accepted_at = ?,
          envelope_json = ?, envelope_sha = ? WHERE encounter = ?`);
        const project = db.prepare("UPDATE curve_outbox SET published_at = ? WHERE candidate_id = ?");
        for (const row of rows) {
          insert.run(row.encounter, row.work_instance, row.definition, row.policy, row.curator, row.agent,
            row.handle, row.handle_key, row.original_svg, row.original_sha, row.original_points, row.draft_digest,
            row.edit_json, row.intention, row.final_svg, row.final_sha, row.approved_digest, row.approved_at,
            row.write_until, row.recover_until, row.candidate_format, row.posts_json, row.local_state);
          replay.run(row.operation_id, row.receipt_json, row.accepted_at, row.envelope_json, row.envelope_sha, row.encounter);
          project.run(observedAt, row.encounter);
        }
        const restrict = db.prepare("INSERT INTO curve_restrictions(encounter, right_name, revoked_at) VALUES (?, ?, ?)");
        for (const revoked of revocations) restrict.run(revoked.encounter, revoked.right, revoked.revokedAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function openArchiveFixture(path) {
  const fixture = openFixture(path, 0x53474131, ARCHIVE_DDL, 1);
  return { ...fixture, archive: candidateArchive(fixture.binding) };
}
