import { afterEach, describe, expect, it } from "bun:test";
import {
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  resolveTables,
} from "./storage-sync.js";

const ENV_NAMES = [
  ...STORAGE_DATABASE_ENV,
  ...STORAGE_MODE_ENV,
] as const;

afterEach(() => {
  for (const name of ENV_NAMES) {
    delete process.env[name];
  }
});

describe("context storage configuration", () => {
  it("prefers canonical storage database envs over fallback envs", () => {
    process.env["HASNA_CONTEXT_DATABASE_URL"] = "postgres://new.example/context";
    process.env["CONTEXT_DATABASE_URL"] = "postgres://fallback.example/context";

    expect(getStorageDatabaseUrl()).toBe("postgres://new.example/context");
    expect(getStorageDatabaseEnvName()).toBe("HASNA_CONTEXT_DATABASE_URL");
  });

  it("uses the service fallback database env", () => {
    process.env["CONTEXT_DATABASE_URL"] = "postgres://fallback.example/context";

    expect(getStorageDatabaseUrl()).toBe("postgres://fallback.example/context");
    expect(getStorageDatabaseEnvName()).toBe("CONTEXT_DATABASE_URL");
  });

  it("reads storage mode envs", () => {
    process.env["HASNA_CONTEXT_STORAGE_MODE"] = "hybrid";

    expect(getStorageMode()).toBe("hybrid");
  });

  it("returns all tables by default and rejects unknown tables", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(STORAGE_TABLES).toContain("api_endpoints");
    expect(resolveTables(["api_endpoints"])).toEqual(["api_endpoints"]);
    expect(() => resolveTables(["libraries", "missing"])).toThrow("Unknown context sync table");
  });
});
