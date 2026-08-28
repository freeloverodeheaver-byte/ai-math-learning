interface PostgresErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

function postgresErrorLike(error: unknown): PostgresErrorLike | undefined {
  return typeof error === "object" && error !== null ? error : undefined;
}

export function isExpectedPostgresRejection(
  error: unknown,
  expectedMessage: string,
): boolean {
  return errorChain(error).some(
    (candidate) => candidate.code === "P0001" && candidate.message === expectedMessage,
  );
}

export function describePostgresRejection(error: unknown): string {
  const chain = errorChain(error);
  const candidate = chain.find((entry) => typeof entry.code === "string") ?? chain[0];
  const code = typeof candidate?.code === "string" ? candidate.code : "missing SQLSTATE";
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  return `${code}: ${message}`;
}

function errorChain(error: unknown): PostgresErrorLike[] {
  const chain: PostgresErrorLike[] = [];
  const seen = new Set<object>();
  let current = postgresErrorLike(error);
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = postgresErrorLike(current.cause);
  }
  return chain;
}
