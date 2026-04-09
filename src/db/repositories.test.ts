import { afterEach, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { registerContextRepositoryTests } from "./repositories-tests/context-suite.js";
import { registerEntityRepositoryTests } from "./repositories-tests/entity-suite.js";
import { registerRepositorySupportTests } from "./repositories-tests/support-suite.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
});

registerContextRepositoryTests();
registerEntityRepositoryTests();
registerRepositorySupportTests();
