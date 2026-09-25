import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import canonicalize from "canonicalize";
import type { LocalReviewFileConfig } from "../localReviewFile.js";
import type { localReviewFixture } from "./localReview.js";

/** Tests only: write already-signed ephemeral fixtures to a private temp root.
 * This is not an operator approval tool and is not imported by runtime code. */
export function localReviewFilesFixture(reviews: Record<string, ReturnType<typeof localReviewFixture>>) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sg-review-files-")));
  const configs: Record<string, LocalReviewFileConfig> = {};
  try {
    for (const [name, review] of Object.entries(reviews)) {
      if (!/^[a-z]+$/.test(name)) throw Error("Invalid fixture name.");
      const publicKeyPem = review.config.publicKeyPem;
      configs[name] = { directory, fileName: name + ".json", ownerUid: process.getuid!(), publicKeyPem, scope: review.scope,
        publicKeySpkiSha256: createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex") };
      writeFileSync(join(directory, name + ".json"), canonicalize(review.envelope)! + "\n", { mode: 0o600, flag: "wx" });
    }
    return { directory, configs, remove: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
