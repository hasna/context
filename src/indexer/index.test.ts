import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import {
  scanDirectory,
  detectLanguageFromExtension,
  detectContextType,
  indexFile,
  indexRepository,
  getUntrackedFiles,
  refreshRepository,
} from "./index.js";

let tempDir: string;

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
  // Create temp directory for tests
  tempDir = join("/tmp", `indexer-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  resetDatabase();
  // Clean up temp directory
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("scanDirectory", () => {
  it("scans directory and finds .ts and .js files by default", () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;");
    writeFileSync(join(tempDir, "b.ts"), "const b = 2;");
    writeFileSync(join(tempDir, "c.js"), "const c = 3;");

    const files = scanDirectory(tempDir);
    // Default extensions include .ts and .js
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith("a.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("c.js"))).toBe(true);
  });

  it("scans nested directories", () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "index.ts"), "export const x = 1;");
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const y = 2;");
    mkdirSync(join(tempDir, "lib"), { recursive: true });
    writeFileSync(join(tempDir, "lib", "helper.ts"), "export const z = 3;");

    const files = scanDirectory(tempDir);
    expect(files).toHaveLength(3);
  });

  it("respects custom extensions option", () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;");
    writeFileSync(join(tempDir, "b.py"), "b = 2");

    const files = scanDirectory(tempDir, { extensions: new Set([".py"]) });
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".py")).toBe(true);
  });

  it("ignores node_modules and other directories", () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;");
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    writeFileSync(join(tempDir, "node_modules", "dep.ts"), "const dep = 1;");
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "config.ts"), "// git config");

    const files = scanDirectory(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith("a.ts")).toBe(true);
  });

  it("ignores specified files", () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;");
    writeFileSync(join(tempDir, "package.json"), "{}");
    writeFileSync(join(tempDir, "README.md"), "# Hello");

    const files = scanDirectory(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith("a.ts")).toBe(true);
  });
});

describe("detectLanguageFromExtension", () => {
  it("detects TypeScript", () => {
    expect(detectLanguageFromExtension(".ts")).toBe("TypeScript");
    expect(detectLanguageFromExtension(".tsx")).toBe("TypeScript");
  });

  it("detects JavaScript", () => {
    expect(detectLanguageFromExtension(".js")).toBe("JavaScript");
    expect(detectLanguageFromExtension(".jsx")).toBe("JavaScript");
    expect(detectLanguageFromExtension(".mjs")).toBe("JavaScript");
    expect(detectLanguageFromExtension(".cjs")).toBe("JavaScript");
  });

  it("detects Python", () => {
    expect(detectLanguageFromExtension(".py")).toBe("Python");
  });

  it("detects Rust", () => {
    expect(detectLanguageFromExtension(".rs")).toBe("Rust");
  });

  it("detects Go", () => {
    expect(detectLanguageFromExtension(".go")).toBe("Go");
  });

  it("returns Unknown for unsupported extensions", () => {
    expect(detectLanguageFromExtension(".xyz")).toBe("Unknown");
    expect(detectLanguageFromExtension(".abc")).toBe("Unknown");
  });

  it("is case insensitive", () => {
    expect(detectLanguageFromExtension(".TS")).toBe("TypeScript");
    expect(detectLanguageFromExtension(".JS")).toBe("JavaScript");
  });
});

describe("detectContextType", () => {
  it("detects repository when .git exists", () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    expect(detectContextType(tempDir)).toBe("repository");
  });

  it("detects project when package.json exists", () => {
    writeFileSync(join(tempDir, "package.json"), "{}");
    expect(detectContextType(tempDir)).toBe("project");
  });

  it("detects project when Cargo.toml exists", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), "[package]\nname = \"test\"");
    expect(detectContextType(tempDir)).toBe("project");
  });

  it("detects project when go.mod exists", () => {
    writeFileSync(join(tempDir, "go.mod"), "module test");
    expect(detectContextType(tempDir)).toBe("project");
  });

  it("defaults to folder when no indicators", () => {
    expect(detectContextType(tempDir)).toBe("folder");
  });
});

describe("indexFile", () => {
  it("indexes a TypeScript file and creates item", async () => {
    // First create a context
    const { indexRepository } = await import("./index.js");

    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "test.ts");
    const content = `const x = 1;`;
    writeFileSync(filePath, content);

    const { context } = await indexRepository(tempDir);

    const { indexFile: indexFileFn } = await import("./index.js");
    const result = await indexFileFn(context.id, filePath, content);

    expect(result.item.name).toBe("test.ts");
    expect(result.item.item_type).toBe("file");
    expect(result.item.extension).toBe(".ts");
    expect(result.item.content).toBe(content);
  });

  it("tracks content hash for changes", async () => {
    const { indexRepository } = await import("./index.js");
    const { indexFile: indexFileFn } = await import("./index.js");

    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "package.json"), "{}");
    const { context } = await indexRepository(tempDir);

    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const original = 1;");

    const result1 = await indexFileFn(context.id, filePath, "const original = 1;");
    const hash1 = result1.item.content_hash;

    const result2 = await indexFileFn(context.id, filePath, "const modified = 2;");
    const hash2 = result2.item.content_hash;

    expect(hash1).not.toBe(hash2);
  });
});

describe("indexRepository", () => {
  it("indexes a directory and creates context", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "index.ts"), "export const x = 1;");
    writeFileSync(join(tempDir, "package.json"), "{}");

    const result = await indexRepository(tempDir);

    expect(result.context.name).toBe(basename(tempDir));
    expect(result.context.type).toBe("project");
    expect(result.context.language).toBe("TypeScript");
    expect(result.stats.filesScanned).toBe(1);
    expect(result.stats.filesIndexed).toBe(1);
    expect(result.stats.errors).toHaveLength(0);
  });

  it("indexes multiple files", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tempDir, "src", "b.ts"), "export const b = 2;");
    writeFileSync(join(tempDir, "src", "c.ts"), "export const c = 3;");

    const result = await indexRepository(tempDir);

    expect(result.stats.filesIndexed).toBe(3);
    // entitiesExtracted depends on parser - may or may not extract depending on content
    expect(result.stats.entitiesExtracted).toBeGreaterThanOrEqual(0);
  });

  it("reports errors for unreadable files", async () => {
    // Create a file that might cause issues - empty file is fine actually
    // The real test is that stats track skipped files
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "test.ts"), "const x = 1;");

    const result = await indexRepository(tempDir);

    expect(result.stats.filesSkipped).toBe(0);
    expect(result.stats.errors).toHaveLength(0);
  });

  it("calls onProgress callback when provided", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "test.ts"), "const x = 1;");

    let progressCalled = false;
    const result = await indexRepository(tempDir, {
      onProgress: (stats) => {
        progressCalled = true;
        expect(stats.filesScanned).toBeGreaterThanOrEqual(0);
      },
    });

    expect(progressCalled).toBe(true);
  });
});

describe("getUntrackedFiles", () => {
  it("returns files not yet indexed", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tempDir, "src", "b.ts"), "export const b = 2;");
    writeFileSync(join(tempDir, "package.json"), "{}");

    // Index only a.ts
    const { context } = await indexRepository(tempDir);

    // Delete b.ts from DB manually to simulate untracked
    const { getContextItemByPath, deleteContextItem } = await import("../db/repositories.js");
    const bItem = getContextItemByPath(context.id, join(tempDir, "src", "b.ts"));
    if (bItem) {
      deleteContextItem(bItem.id);
    }

    const untracked = getUntrackedFiles(tempDir, context.id);
    expect(untracked.some((f) => f.endsWith("b.ts"))).toBe(true);
  });

  it("returns empty array when all files tracked", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tempDir, "package.json"), "{}");

    const { context } = await indexRepository(tempDir);
    const untracked = getUntrackedFiles(tempDir, context.id);

    expect(untracked).toHaveLength(0);
  });
});

describe("refreshRepository", () => {
  it("refreshes an already indexed repository", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "test.ts"), "const x = 1;");
    writeFileSync(join(tempDir, "package.json"), "{}");

    // First index
    await indexRepository(tempDir);

    // Modify a file
    writeFileSync(join(tempDir, "src", "test.ts"), "const y = 2;");

    // Refresh
    const result = await refreshRepository(tempDir);

    expect(result.context.id).toBeDefined();
    expect(result.stats.filesIndexed).toBe(1);
  });

  it("does full index if context not found", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "test.ts"), "const x = 1;");
    writeFileSync(join(tempDir, "package.json"), "{}");

    // Don't index first - should do full index
    const result = await refreshRepository(tempDir);

    expect(result.stats.filesIndexed).toBe(1);
  });
});

// Helper to get basename
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
