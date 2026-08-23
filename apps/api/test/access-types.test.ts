import type { Database } from "@math/db";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { expectTypeOf, it } from "vitest";
import type { AccessTransaction } from "../src/modules/access/repository.js";
import type { AccessTransactionHost } from "../src/modules/access/service.js";

type FullSchema<T> = T extends PgDatabase<infer _Result, infer Schema, infer _Relations>
  ? Schema
  : never;
type IsAny<T> = 0 extends (1 & T) ? true : false;

it("keeps access database boundaries structural and compatible with the Node driver", () => {
  expectTypeOf<IsAny<FullSchema<AccessTransaction>>>().toEqualTypeOf<false>();
  expectTypeOf<Database>().toMatchTypeOf<AccessTransaction>();
  expectTypeOf<Database>().toMatchTypeOf<AccessTransactionHost>();
});
