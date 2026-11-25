import type { CommitArchive, SignedRecord } from "./envelope.js";
import type { CandidateDatabase } from "./store.js";

export const ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS curve_commit_archive (
  binding TEXT NOT NULL,
  encounter TEXT NOT NULL,
  body TEXT NOT NULL,
  digest TEXT NOT NULL,
  proof TEXT NOT NULL,
  PRIMARY KEY (binding, encounter)
) STRICT;`;

export function candidateArchive(db: CandidateDatabase): CommitArchive {
  return {
    async putIfAbsent(binding, encounter, record) {
      await db.prepare(`INSERT INTO curve_commit_archive (binding, encounter, body, digest, proof)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (binding, encounter) DO NOTHING RETURNING digest`)
        .bind(binding, encounter, record.body, record.digest, record.proof).first();
    },
    async inventory(binding) {
      return (await db.prepare("SELECT encounter, digest FROM curve_commit_archive WHERE binding = ? ORDER BY encounter")
        .bind(binding).all<{ encounter: string; digest: string }>()).results;
    },
    read(binding, encounter) {
      return db.prepare("SELECT body, digest, proof FROM curve_commit_archive WHERE binding = ? AND encounter = ?")
        .bind(binding, encounter).first<SignedRecord>();
    },
  };
}
