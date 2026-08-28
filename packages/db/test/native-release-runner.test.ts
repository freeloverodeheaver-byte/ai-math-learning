import { describe, expect, it } from "vitest";
import {
  runNativeReleaseGates,
  type NativePostgresHandle,
} from "./run-native-release-gates.js";

const externalUrl = "postgresql://math_app:math_app@127.0.0.1:5432/math_learning_test";

function createHandle(overrides: Partial<NativePostgresHandle> = {}): NativePostgresHandle {
  return {
    connectionString: externalUrl,
    stop: async () => {},
    cleanup: async () => {},
    ...overrides,
  };
}

function busyError(): Error & { code: string } {
  return Object.assign(new Error("directory remains busy while PostgreSQL exits"), { code: "EBUSY" });
}

describe("runNativeReleaseGates", () => {
  // Break caught: a clean checkout reaching the API without a contracts build,
  // rebuilding the API through its standalone gate, changing order, or leaking child environment variables.
  it("runs the native gates in order against an explicitly disposable external database", async () => {
    const commands: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];

    await runNativeReleaseGates({
      externalUrl,
      runCommand: async (command, args, env) => {
        commands.push({ command, args, env });
      },
      startEphemeralDatabase: async () => {
        throw new Error("an external URL must not start an embedded database");
      },
    });

    expect(commands).toEqual([
      { command: "pnpm", args: ["--filter", "@math/contracts", "build"], env: { TEST_DATABASE_URL: externalUrl } },
      { command: "pnpm", args: ["--filter", "@math/db", "build"], env: { TEST_DATABASE_URL: externalUrl } },
      { command: "pnpm", args: ["--filter", "@math/api", "build"], env: { TEST_DATABASE_URL: externalUrl } },
      { command: "pnpm", args: ["--filter", "@math/db", "test:native-migration"], env: { TEST_DATABASE_URL: externalUrl } },
      { command: "pnpm", args: ["--filter", "@math/api", "test:native-access-concurrency:built"], env: { TEST_DATABASE_URL: externalUrl } },
    ]);
  });

  // Break caught: an accidental connection to a default, empty, or non-disposable database.
  it.each([
    "postgresql://math_app:math_app@127.0.0.1:5432/postgres",
    "postgresql://math_app:math_app@127.0.0.1:5432/",
    "postgresql://math_app:math_app@127.0.0.1:5432/math_learning",
  ])("rejects a non-disposable external database before executing gates: %s", async (unsafeUrl) => {
    const runCommand = async () => {
      throw new Error("commands must not run for unsafe databases");
    };

    await expect(runNativeReleaseGates({ externalUrl: unsafeUrl, runCommand }))
      .rejects.toThrow(/_test|database/i);
  });

  // Break caught: an embedded PostgreSQL process or its owned directory surviving a successful gate run.
  it("stops and cleans up an internally started database after a successful gate run", async () => {
    const lifecycle: string[] = [];

    await runNativeReleaseGates({
      runCommand: async () => {},
      startEphemeralDatabase: async () => createHandle({
        stop: async () => { lifecycle.push("stop"); },
        cleanup: async () => { lifecycle.push("cleanup"); },
      }),
    });

    expect(lifecycle).toEqual(["stop", "cleanup"]);
  });

  // Break caught: a failed gate bypassing embedded-process shutdown or owned-directory removal.
  it("stops and cleans up an internally started database after a gate failure", async () => {
    const lifecycle: string[] = [];
    const gateFailure = new Error("native migration failed");

    await expect(runNativeReleaseGates({
      runCommand: async () => { throw gateFailure; },
      startEphemeralDatabase: async () => createHandle({
        stop: async () => { lifecycle.push("stop"); },
        cleanup: async () => { lifecycle.push("cleanup"); },
      }),
    })).rejects.toBe(gateFailure);

    expect(lifecycle).toEqual(["stop", "cleanup"]);
  });

  // Break caught: a Windows PostgreSQL process tree releasing its data directory
  // after the first removal attempt and leaking the runner-owned temporary root.
  it("retries transient Windows cleanup failures until the owned root is removed", async () => {
    let cleanupAttempts = 0;

    await expect(runNativeReleaseGates({
      cleanupPlatform: "win32",
      runCommand: async () => {},
      startEphemeralDatabase: async () => createHandle({
        stop: async () => { throw busyError(); },
        cleanup: async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw busyError();
        },
      }),
    })).resolves.toBeUndefined();

    expect(cleanupAttempts).toBe(2);
  });

  // Break caught: a stopped embedded process never resolving and hanging the release gate forever.
  it("fails when an owned stop operation exceeds its cleanup timeout", async () => {
    await expect(runNativeReleaseGates({
      cleanupTimeoutMs: 1,
      runCommand: async () => {},
      startEphemeralDatabase: async () => createHandle({
        stop: async () => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20)),
      }),
    })).rejects.toThrow(/timed out/i);
  });

  // Break caught: a root cleanup failure hidden behind an earlier stop failure.
  it("reports a root cleanup failure instead of a concurrent stop failure", async () => {
    const stopFailure = new Error("stop failed");
    const cleanupFailure = new Error("owned root removal failed");

    await expect(runNativeReleaseGates({
      runCommand: async () => {},
      startEphemeralDatabase: async () => createHandle({
        stop: async () => { throw stopFailure; },
        cleanup: async () => { throw cleanupFailure; },
      }),
    })).rejects.toBe(cleanupFailure);
  });

  // Break caught: a POSIX stop failure being silently accepted because a later directory removal succeeds.
  it("preserves a transient stop failure outside Windows", async () => {
    const stopFailure = busyError();

    await expect(runNativeReleaseGates({
      cleanupPlatform: "linux",
      runCommand: async () => {},
      startEphemeralDatabase: async () => createHandle({
        stop: async () => { throw stopFailure; },
      }),
    })).rejects.toBe(stopFailure);
  });

  // Break caught: a cleanup failure replacing the gate failure that explains why the release is unsafe.
  it("preserves a gate failure when cleanup also fails", async () => {
    const gateFailure = new Error("native migration failed");
    const cleanupFailure = new Error("temporary directory removal failed");
    let cleanupAttempted = false;

    await expect(runNativeReleaseGates({
      runCommand: async () => { throw gateFailure; },
      startEphemeralDatabase: async () => createHandle({
        cleanup: async () => {
          cleanupAttempted = true;
          throw cleanupFailure;
        },
      }),
    })).rejects.toBe(gateFailure);

    expect(cleanupAttempted).toBe(true);
  });
});
