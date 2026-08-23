import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("repository-root environment loading", () => {
  it("keeps migration, development, start, and seed entry scripts on the native env-file contract", async () => {
    const apiPackage = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const dbPackage = JSON.parse(
      await readFile(new URL("../../../packages/db/package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect({
      migrate: dbPackage.scripts.migrate,
      dev: apiPackage.scripts.dev,
      start: apiPackage.scripts.start,
      seed: apiPackage.scripts.seed,
    }).toEqual({
      migrate: "node --env-file-if-exists=../../.env --import tsx src/migrate.ts",
      dev: "node --env-file-if-exists=../../.env --import tsx --watch src/main.ts",
      start: "node --env-file-if-exists=../../.env --import tsx src/main.ts",
      seed: "pnpm --filter @math/api... build && node --env-file-if-exists=../../.env dist/src/modules/content/seed.js",
    });
  });

  it("loads the file from a package working directory without overriding external variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "math-foundation-env-"));
    const packageDirectory = join(root, "apps", "api");
    try {
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(root, ".env"),
        "DATABASE_URL=from-file\nDEV_IDENTITY_ENABLED=true\n",
        "utf8",
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--env-file-if-exists=../../.env",
          "-e",
          "process.stdout.write(JSON.stringify({ database: process.env.DATABASE_URL, devIdentity: process.env.DEV_IDENTITY_ENABLED }))",
        ],
        {
          cwd: packageDirectory,
          env: { ...process.env, DATABASE_URL: "from-external" },
        },
      );

      expect(JSON.parse(stdout)).toEqual({
        database: "from-external",
        devIdentity: "true",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
