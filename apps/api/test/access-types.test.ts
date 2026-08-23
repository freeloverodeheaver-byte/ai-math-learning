import type { Database } from "@math/db";
import { expectTypeOf, it } from "vitest";
import type { AccessTransaction } from "../src/modules/access/repository.js";
import type { AccessTransactionHost } from "../src/modules/access/service.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;

it("keeps access database boundaries structural and compatible with the Node driver", () => {
  expectTypeOf<IsAny<AccessTransaction["select"]>>().toEqualTypeOf<false>();
  expectTypeOf<IsAny<Parameters<AccessTransaction["insert"]>[0]>>().toEqualTypeOf<false>();
  expectTypeOf<IsAny<Parameters<AccessTransaction["update"]>[0]>>().toEqualTypeOf<false>();
  expectTypeOf<Database>().toMatchTypeOf<AccessTransaction>();
  expectTypeOf<Database>().toMatchTypeOf<AccessTransactionHost>();
});
