import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../migrations", import.meta.url));
const destination = fileURLToPath(new URL("../dist/migrations", import.meta.url));

await cp(source, destination, { recursive: true, force: true });
