import { defineConfig } from "vitest/config";

// Operational entrypoints are exercised by the local rehearsal commands
// (`npm run local:up`, `local:test`, `test:postgres:local`), not by vitest.
// Counting them here would report the application as less covered than it is.
const OPERATIONAL_ENTRYPOINTS = [
  "src/main.ts",
  "src/legacyMain.ts",
  "src/openMint/main.ts",
  "src/openMint/localChain.ts",
  "src/local/rehearsalCli.ts",
  "src/local/rehearsalServer.ts",
  "src/local/interactiveRehearsalTest.ts",
  "src/local/postgresMigrationTest.ts",
  "src/local/xAuthCheck.ts",
  "src/brand/inspectSloganShapeCandidate.ts",
];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/fixtures/**",
        "src/v1/collectionStateFixtures.ts",
        "src/v1/fixtures.ts",
        "src/v2/fixtures.ts",
        "src/v2/galleryFixtures.ts",
        // Local-only curator qualification runs under Node and Workerd in the recovery job.
        "src/candidates/**",
        ...OPERATIONAL_ENTRYPOINTS,
      ],
      // A ratchet, not a target: raise these as coverage improves, never lower
      // them to make a change pass.
      thresholds: {
        statements: 93,
        branches: 87,
        functions: 97,
      },
    },
  },
});
