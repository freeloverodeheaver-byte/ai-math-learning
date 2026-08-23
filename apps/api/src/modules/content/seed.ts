import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContentBundleSchema, type ContentBundle } from "@math/contracts";
import { createDb } from "@math/db";
import { AuditRepository } from "../audit/repository.js";
import { AuditService } from "../audit/service.js";
import { ContentImportWorkflow } from "./import-workflow.js";
import { ContentRepository } from "./repository.js";
import { ContentService, type ContentTransactionHost, type ImportResult } from "./service.js";

export function resolveBundlePath(args: readonly string[]): string {
  const bundlePath = args[0] === "--" ? args[1] : args[0];
  if (!bundlePath) throw new Error("A content bundle JSON path is required");
  return bundlePath;
}

export async function seedContentBundle(
  database: ContentTransactionHost,
  bundle: ContentBundle,
): Promise<ImportResult> {
  const repository = new ContentRepository();
  const workflow = new ContentImportWorkflow(
    database,
    new ContentService(database, repository),
    repository,
    new AuditService(new AuditRepository()),
  );
  return workflow.execute(bundle, {
    actor: null,
    metadata: { initiator: "system_seed" },
  });
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
    const result = await seedContentBundle(database, bundle);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.$client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runSeed(process.env, process.argv.slice(2));
}
