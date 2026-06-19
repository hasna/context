import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { getDataDir, getDatabase, getDbPath, resetDatabase } from "./database.js";

const oldEnv = new Map<string, string | undefined>();
const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "CONTEXT_DB_PATH",
  "HASNA_CONTEXT_DB_PATH",
  "CONTEXT_DATA_DIR",
  "HASNA_CONTEXT_DATA_DIR",
] as const;

let tempRoot: string | null = null;
let oldCwd = process.cwd();

afterEach(() => {
  resetDatabase();
  process.chdir(oldCwd);
  for (const name of ENV_NAMES) {
    if (!oldEnv.has(name)) continue;
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  oldEnv.clear();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe("database path resolution", () => {
  it("resolves the knowledge app data path without creating it until the database opens", () => {
    const root = isolateHome();
    const expected = join(root, "home", ".hasna", "apps", "knowledge", "context.db");

    expect(getDbPath()).toBe(expected);
    expect(existsSync(dirname(expected))).toBe(false);

    const db = getDatabase();
    expect(db).toBeDefined();
    expect(existsSync(dirname(expected))).toBe(true);
  });

  it("copies legacy context data into the knowledge app directory", () => {
    const root = isolateHome();
    const legacyDir = join(root, "home", ".hasna", "context");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "context.db"), "legacy-db");
    writeFileSync(join(legacyDir, "notes.md"), "legacy docs");

    const dataDir = getDataDir();

    expect(dataDir).toBe(join(root, "home", ".hasna", "apps", "knowledge"));
    expect(existsSync(join(dataDir, "context.db"))).toBe(true);
    expect(existsSync(join(dataDir, "notes.md"))).toBe(true);
  });

  it("does not select a repo-local knowledge.db owned by another knowledge schema", () => {
    const root = isolateHome();
    const otherDbDir = join(root, ".hasna", "apps", "knowledge");
    mkdirSync(otherDbDir, { recursive: true });
    writeFileSync(join(otherDbDir, "knowledge.db"), "not an open-context database");

    expect(getDbPath()).toBe(join(root, "home", ".hasna", "apps", "knowledge", "context.db"));
  });
});

function isolateHome(): string {
  oldCwd = process.cwd();
  for (const name of ENV_NAMES) oldEnv.set(name, process.env[name]);
  tempRoot = mkdtempSync(join(tmpdir(), "context-db-path-"));
  const home = join(tempRoot, "home");
  mkdirSync(home, { recursive: true });
  process.chdir(tempRoot);
  process.env["HOME"] = home;
  delete process.env["USERPROFILE"];
  delete process.env["CONTEXT_DB_PATH"];
  delete process.env["HASNA_CONTEXT_DB_PATH"];
  delete process.env["CONTEXT_DATA_DIR"];
  delete process.env["HASNA_CONTEXT_DATA_DIR"];
  resetDatabase();
  return tempRoot;
}
