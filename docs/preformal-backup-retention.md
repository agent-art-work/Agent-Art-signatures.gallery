# Pre-formal local rollback: retention and restoration

## October 2, 2026 decision and evidence

Retain the exact rollback point, but not its redundant loose files. The snapshot
contains seven pre-formal claims and their matching local chain/database state.
The formal renderer intentionally cannot reinterpret them. No requirement to
discard that unique history was established, so lossless archival resolves disk
housekeeping without requiring a decision to erase it.

The original directory was
`/Users/bigu/Projects/Agent-Art-signatures.gallery/.local/backups/pre-formal-v1-20260910`.
Its PostgreSQL 16 control data reported **shut down**; no process had files open
there. Git checkpoint `19af1f4` remains an ancestor of the current repository.
The retained logical dump has 291 TOC entries and was made with PostgreSQL 16.15.

| Evidence | Result |
| --- | --- |
| Original content bytes | 6,806,743,614 (about 6.34 GiB) |
| Complete archive bytes | 3,034,953,810 (about 2.83 GiB) |
| Backup content-footprint reduction | 3,771,789,804 (about 3.51 GiB) |
| Verified entries | 1,587 files/directories |
| Archive SHA-256 | `0b7bf744d1c188e5f9b0a6b6bea505018a3fec74e7fc4e919d113cb50c824951` |

Private retained files, ignored by Git and mode 0600:

- `/Users/bigu/Projects/Agent-Art-signatures.gallery/.local/backups/pre-formal-v1-20260910.tar.zst`
- `/Users/bigu/Projects/Agent-Art-signatures.gallery/.local/backups/pre-formal-v1-20260910.manifest.json`

The manifest stores every ordinary file's length, SHA-256 and mode, plus every
directory's mode. The complete archive was extracted into a private temporary
directory; its full tree matched the source. The source was rehashed immediately
before removal. Both retained outputs and the parent directory were synchronized
to disk first. Only the exact redundant loose directory and the temporary
verification extraction were removed. The archive still restores their content.

The active `.local/rehearsal`, current Sepolia state, secrets and environment
files were not moved, edited or started/stopped by archival. Filesystem-wide
free space can vary during parallel tests and other local work; the figures above
measure this backup's actual content footprint, not unrelated APFS allocation.

## Restore offline first

Do not extract over the active rehearsal, restore only the database, pair the
old database with the current Anvil state, or merge the old claims into the
formal database. This is a **local historical rollback**, not a production
backup or permission to start a second writer.

1. Verify the retained archive checksum above, then create a fresh private
   extraction directory. macOS `tar` recognizes the Zstandard archive directly:

   ```sh
   shasum -a 256 /Users/bigu/Projects/Agent-Art-signatures.gallery/.local/backups/pre-formal-v1-20260910.tar.zst
   preformal_restore_dir="$(mktemp -d /private/tmp/preformal-restore.XXXXXX)"
   chmod 700 "$preformal_restore_dir"
   tar -xpf /Users/bigu/Projects/Agent-Art-signatures.gallery/.local/backups/pre-formal-v1-20260910.tar.zst -C "$preformal_restore_dir"
   ```

2. Compare every extracted path, byte hash, length and permission with the private
   manifest, using the current repository's `snapshotTree` helper:

   ```sh
   node --input-type=module -e '
   import assert from "node:assert/strict";
   import { readFile } from "node:fs/promises";
   import { snapshotTree } from "./scripts/archive-preformal-backup.mjs";
   const manifest = JSON.parse(await readFile(".local/backups/pre-formal-v1-20260910.manifest.json", "utf8"));
   assert.deepEqual(await snapshotTree(process.argv[1]), manifest.entries);
   console.log("Exact historical backup verified.");
   ' "$preformal_restore_dir/pre-formal-v1-20260910"
   ```

3. Inspect `README.md`, `rehearsal/runtime.json`, `rehearsal/anvil/state.json`,
   the complete `rehearsal/postgres/data` cluster and `database.dump`. Keep all
   parts together. `pg_restore --list` is a read-only check of the logical dump;
   it does not prove a live database restore. Use PostgreSQL 16 for the physical
   cluster. Do not upload the archive or manifest publicly.

4. To run the old application, use a **separate checkout/isolated host** at exact
   checkpoint `19af1f4`, install that checkpoint's locked dependencies, and place
   a verified copy of the extracted `rehearsal` tree in that checkout's
   `.local/rehearsal`. This does not authorize replacing the active checkout.
   Review its runtime paths, frozen app origin and ports before starting.
   The old CLI derives its data paths from the checkout and defaults to app
   3000, PostgreSQL 55432 and Anvil 18545; those ports must be free on the isolated
   host. Keep stored artwork origins coherent rather than silently rewriting them.

5. After that separate rollback is explicitly intended and isolation is checked,
   follow **the old checkpoint's** `docs/local-rehearsal.md`: `npm run local:up`
   preserves existing state, `npm run local:verify` checks it, and
   `npm run local:serve:emulator` avoids real X calls. Never use `local:reset`
   for restoration. Check old claim/artwork endpoints, chain/deployment identity,
   receipts, holders and PostgreSQL records before accepting the rollback.

No old database or chain was started for the October 2 archive check. Verified
extraction is recorded; an actual historical application rollback remains a
separate intentional operation, not a claimed live restore rehearsal.

## Archival helper

`node scripts/archive-preformal-backup.mjs` is read-only by default. Actual
archival requires `--execute`; removal of the verified loose copy additionally
requires `--retire-uncompressed`. The helper has one fixed historical basename,
rejects symlinks/special files/existing destinations, verifies stopped PostgreSQL
and absence of open handles, and never targets active `.local/rehearsal`.
The original loose directory is now absent, so rerunning archival is not needed.
Its mock tests require neither archive tools nor a real database.
