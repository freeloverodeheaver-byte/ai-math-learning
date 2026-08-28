import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type EmbeddedPostgres from "embedded-postgres";

export interface NativePostgresHandle {
  readonly connectionString: string;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface NativeGateOptions {
  readonly externalUrl?: string;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<void>;
  readonly startEphemeralDatabase?: () => Promise<NativePostgresHandle>;
}

type RunCommand = NonNullable<NativeGateOptions["runCommand"]>;

const cleanupRetryLimit = 5;
const cleanupRetryDelayMs = 50;

function selectedExternalUrl(options: NativeGateOptions): string | undefined {
  return options.externalUrl ?? process.env.TEST_DATABASE_URL;
}

function validateDisposableDatabaseUrl(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL for a disposable _test database");
  }

  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    || url.pathname === ""
    || url.pathname === "/"
    || databaseName === "postgres"
    || !databaseName.endsWith("_test")
  ) {
    throw new Error("Native release gates require a PostgreSQL database whose name ends in _test");
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not reserve a loopback port for native PostgreSQL");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      }));
    }
  }
}

async function startEmbeddedDatabase(): Promise<NativePostgresHandle> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "math-native-postgres-"));
  let postgres: EmbeddedPostgres | undefined;

  try {
    const { default: EmbeddedPostgresRuntime } = await import("embedded-postgres");
    const port = await reserveLoopbackPort();
    const password = randomBytes(24).toString("base64url");
    postgres = new EmbeddedPostgresRuntime({
      databaseDir: join(temporaryDirectory, "data"),
      user: "postgres",
      password,
      port,
      persistent: false,
      postgresFlags: ["-h", "127.0.0.1"],
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("math_learning_test");

    return {
      connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/math_learning_test`,
      stop: () => postgres!.stop(),
      cleanup: () => rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: cleanupRetryLimit,
        retryDelay: cleanupRetryDelayMs,
      }),
    };
  } catch (error) {
    await postgres?.stop().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function runSpawnedCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const pnpmEntrypoint = process.env.npm_execpath;
    const executable = command === "pnpm" && pnpmEntrypoint ? process.execPath : command;
    const commandArgs = command === "pnpm" && pnpmEntrypoint
      ? [pnpmEntrypoint, ...args]
      : args;
    const child = spawn(executable, commandArgs, { env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`Native release command failed with exit code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`));
      }
    });
  });
}

function isTransientWindowsCleanupError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "EBUSY" || (error as { code?: unknown }).code === "EPERM");
}

async function retryOwnedCleanup(cleanup: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt <= cleanupRetryLimit; attempt += 1) {
    try {
      await cleanup();
      return;
    } catch (error) {
      if (!isTransientWindowsCleanupError(error) || attempt === cleanupRetryLimit) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, cleanupRetryDelayMs * (attempt + 1)));
    }
  }
}

async function cleanupOwnedDatabase(handle: NativePostgresHandle): Promise<unknown> {
  let stopError: unknown;
  try {
    await handle.stop();
  } catch (error) {
    stopError = error;
  }
  let cleanupError: unknown;
  try {
    await retryOwnedCleanup(handle.cleanup);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) return stopError ?? cleanupError;
  return isTransientWindowsCleanupError(stopError) ? undefined : stopError;
}

export async function runNativeReleaseGates(options: NativeGateOptions = {}): Promise<void> {
  const externalUrl = selectedExternalUrl(options);
  if (externalUrl !== undefined) validateDisposableDatabaseUrl(externalUrl);

  const handle = externalUrl === undefined
    ? await (options.startEphemeralDatabase ?? startEmbeddedDatabase)()
    : undefined;
  const connectionString = externalUrl ?? handle!.connectionString;
  const childEnvironment: NodeJS.ProcessEnv = { TEST_DATABASE_URL: connectionString };
  const runCommand: RunCommand = options.runCommand ?? runSpawnedCommand;
  let gateFailed = false;

  try {
    await runCommand("pnpm", ["--filter", "@math/db", "build"], childEnvironment);
    await runCommand("pnpm", ["--filter", "@math/api", "build"], childEnvironment);
    await runCommand("pnpm", ["--filter", "@math/db", "test:native-migration"], childEnvironment);
    await runCommand("pnpm", ["--filter", "@math/api", "test:native-access-concurrency:built"], childEnvironment);
  } catch (error) {
    gateFailed = true;
    throw error;
  } finally {
    if (handle) {
      const cleanupError = await cleanupOwnedDatabase(handle);
      if (!gateFailed && cleanupError !== undefined) throw cleanupError;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNativeReleaseGates().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
