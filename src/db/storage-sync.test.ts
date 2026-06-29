import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import pg from "pg";
import {
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  resolveTables,
} from "./storage-sync.js";
import { buildPgPoolConfig, isLocalPostgresHost } from "./remote-storage.js";

const ENV_NAMES = [
  ...STORAGE_DATABASE_ENV,
  ...STORAGE_MODE_ENV,
  "PGHOST",
  "PGSSLMODE",
] as const;

const SAVED_ENV = new Map<string, string | undefined>();

function inspectClientParameters(connectionString: string): { host?: string; ssl?: unknown } {
  const client = new pg.Client(buildPgPoolConfig(connectionString));
  const params = (client as unknown as { connectionParameters: { host?: string; ssl?: unknown } }).connectionParameters;
  return {
    host: params.host,
    ssl: params.ssl,
  };
}

beforeEach(() => {
  SAVED_ENV.clear();
  for (const name of ENV_NAMES) {
    SAVED_ENV.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
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

  it("reports storage status for CLI and MCP surfaces", () => {
    process.env["HASNA_CONTEXT_DATABASE_URL"] = "postgres://new.example/context";

    expect(getStorageStatus()).toMatchObject({
      configured: true,
      mode: "remote",
      service: "context",
    });
  });

  it("returns all tables by default and rejects unknown tables", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(() => resolveTables(["libraries", "missing"])).toThrow("Unknown context sync table");
  });

  it("verifies TLS for remote PostgreSQL by default", () => {
    expect(inspectClientParameters("postgres://user:pass@db.example.com/context")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/context")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/context",
      ssl: { rejectUnauthorized: true },
    });
  });

  it("verifies TLS for the exact remote SSL request forms", () => {
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/context?sslmode=require")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/context",
      ssl: { rejectUnauthorized: true },
    });
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/context?ssl=true")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/context",
      ssl: { rejectUnauthorized: true },
    });
    expect(inspectClientParameters("postgres://user:pass@db.example.com/context?sslmode=require")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(inspectClientParameters("postgres://user:pass@db.example.com/context?ssl=true")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
  });

  it("allows local PostgreSQL without TLS", () => {
    expect(isLocalPostgresHost("localhost")).toBe(true);
    expect(isLocalPostgresHost("%2Fvar%2Frun%2Fpostgresql")).toBe(true);
    expect(buildPgPoolConfig("postgres://user:pass@localhost/context")).toMatchObject({
      connectionString: "postgres://user:pass@localhost/context",
      ssl: undefined,
    });
  });

  it("allows local PostgreSQL to request verified TLS", () => {
    expect(inspectClientParameters("postgres://user:pass@localhost/context?sslmode=require")).toMatchObject({
      host: "localhost",
      ssl: { rejectUnauthorized: true },
    });
  });

  it("rejects remote PostgreSQL when TLS is explicitly disabled", () => {
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?ssl=false")).toThrow("TLS disabled");
  });

  it("enforces TLS for remote query host overrides", () => {
    expect(inspectClientParameters("postgres://user:pass@localhost/context?host=db.example.com")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(inspectClientParameters("postgres://user:pass@localhost/context?host=localhost&host=db.example.com")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/context?host=db.example.com&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/context?host=db.example.com&ssl=false")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?host=&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?hostaddr=&ssl=false")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?hostaddr=127.0.0.1&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?hostaddr=127.0.0.1&ssl=false")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?hostaddr=::1&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/context?host=localhost&host=db.example.com&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/context?host=&host=db.example.com&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/context?host=127.0.0.1&host=db.example.com&ssl=false")).toThrow("TLS disabled");
  });

  it("enforces TLS when a hostless PostgreSQL URL inherits remote PGHOST", () => {
    process.env["PGHOST"] = "db.example.com";
    process.env["PGSSLMODE"] = "disable";

    expect(inspectClientParameters("postgres:///context")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(() => buildPgPoolConfig("postgres:///context?sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres:///context?host=&ssl=false")).toThrow("TLS disabled");
  });

  it("allows a hostless PostgreSQL URL to inherit local PGHOST without TLS", () => {
    process.env["PGHOST"] = "/var/run/postgresql";
    process.env["PGSSLMODE"] = "disable";

    expect(inspectClientParameters("postgres:///context")).toMatchObject({
      host: "/var/run/postgresql",
      ssl: false,
    });
    expect(buildPgPoolConfig("postgres:///context?sslmode=disable")).toMatchObject({
      connectionString: "postgres:///context",
      ssl: undefined,
    });
  });

  it("treats remote no-verify mode as verified TLS", () => {
    expect(inspectClientParameters("postgres://user:pass@db.example.com/context?sslmode=no-verify")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
  });

  it("preserves non-mode SSL parameters while enforcing verification", () => {
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/context?sslrootcert=/tmp/ca.pem")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/context?sslrootcert=%2Ftmp%2Fca.pem",
      ssl: { rejectUnauthorized: true },
    });
  });
});
