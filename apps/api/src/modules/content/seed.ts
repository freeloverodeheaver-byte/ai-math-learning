import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContentBundleSchema, type Actor } from "@math/contracts";
import { createDb } from "@math/db";
import { ContentRepository } from "./repository.js";
import { ContentService } from "./service.js";

const seedActor: Actor = { userId: "content-seed", roles: ["operator"] };

export function resolveBundlePath(args: readonly string[]): string {
  const bundlePath = args[0] === "--" ? args[1] : args[0];
  if (!bundlePath) throw new Error("A content bundle JSON path is required");
  return bundlePath;
}

export async function runSeed(
  env: NodeJS.ProcessEnv,
  args: readonly string[]
): Promise<void> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to seed content");
  const bundlePath = resolveBundlePath(args);

  const database = createDb(connectionString);
  try {
    const payload: unknown = JSON.parse(await readFile(bundlePath, "utf8"));
    const bundle = ContentBundleSchema.parse(payload);
    const service = new ContentService(database, new ContentRepository());
    const result = await service.importBundle(bundle, seedActor);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.$client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runSeed(process.env, process.argv.slice(2));
}
