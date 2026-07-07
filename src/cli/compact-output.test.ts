import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceDocumentApiEndpoints } from "../db/api-endpoints.js";
import { insertChunk } from "../db/chunks.js";
import { resetDatabase } from "../db/database.js";
import { upsertDocument } from "../db/documents.js";
import { createLibrary } from "../db/libraries.js";

const cwd = join(import.meta.dir, "../..");

afterEach(() => {
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
  delete process.env["HASNA_CONTEXT_DB_PATH"];
});

describe("compact CLI output", () => {
  it("caps library lists and keeps raw JSON available", () => {
    const fixture = createFixture();
    try {
      createLibrary({ name: "Compact Extra One", description: "long detail ".repeat(40) });
      createLibrary({ name: "Compact Extra Two" });
      resetDatabase();

      const compact = runCli(fixture, ["list", "--limit", "2"]);
      expect(compact.exitCode).toBe(0);
      expect(compact.stdout).toContain("Use --verbose for descriptions");
      expect(compact.stdout).toContain("more");
      expect(compact.stdout).not.toContain("long detail long detail long detail");

      const json = runCli(fixture, ["list", "--json"]);
      expect(json.exitCode).toBe(0);
      const rows = JSON.parse(json.stdout) as Array<{ name: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(3);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("keeps search compact by default and discloses full chunks on request", () => {
    const fixture = createFixture();
    try {
      const content = [
        "needlecompact default search preview should be concise for agents.",
        "Reference source chunks should stay cited and discoverable.",
        "extra context ".repeat(30),
        "tail-detail-marker only appears when verbose or json output is requested.",
      ].join(" ");
      insertChunk({
        library_id: fixture.library.id,
        document_id: fixture.document.id,
        content,
        position: 0,
      });
      resetDatabase();

      const compact = runCli(fixture, ["search", "needlecompact", "--library", fixture.library.slug]);
      expect(compact.exitCode).toBe(0);
      expect(compact.stdout).toContain("Use --verbose for full chunk text");
      expect(compact.stdout).not.toContain("tail-detail-marker");

      const verbose = runCli(fixture, ["search", "needlecompact", "--library", fixture.library.slug, "--verbose"]);
      expect(verbose.exitCode).toBe(0);
      expect(verbose.stdout).toContain("tail-detail-marker");

      const json = runCli(fixture, ["search", "needlecompact", "--library", fixture.library.slug, "--json"]);
      expect(json.exitCode).toBe(0);
      const rows = JSON.parse(json.stdout) as Array<{ content: string }>;
      expect(rows[0]?.content).toContain("tail-detail-marker");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("keeps endpoint listings compact and preserves verbose/json detail paths", () => {
    const fixture = createFixture({ sourceType: "openapi" });
    try {
      replaceDocumentApiEndpoints({
        library_id: fixture.library.id,
        document_id: fixture.document.id,
        endpoints: [
          {
            url: "https://api.example.test/openapi.yaml",
            method: "POST",
            path: "/widgets",
            operation_id: "createWidget",
            summary: "Create widget",
            tags: ["widgets"],
            content: [
              "### POST /widgets",
              "Operation ID: createWidget",
              "Create widget",
              "application/json: WidgetCreate",
              "endpoint-detail-marker",
            ].join("\n"),
          },
        ],
      });
      resetDatabase();

      const compact = runCli(fixture, ["endpoints", fixture.library.slug, "--operation", "createWidget"]);
      expect(compact.exitCode).toBe(0);
      expect(compact.stdout).toContain("POST /widgets");
      expect(compact.stdout).toContain("Use --verbose for endpoint details");
      expect(compact.stdout).not.toContain("endpoint-detail-marker");

      const verbose = runCli(fixture, ["endpoints", fixture.library.slug, "--operation", "createWidget", "--verbose"]);
      expect(verbose.exitCode).toBe(0);
      expect(verbose.stdout).toContain("endpoint-detail-marker");

      const json = runCli(fixture, ["endpoints", fixture.library.slug, "--operation", "createWidget", "--json"]);
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout) as { endpoints: Array<{ content: string }> };
      expect(parsed.endpoints[0]?.content).toContain("endpoint-detail-marker");
    } finally {
      cleanupFixture(fixture);
    }
  });
});

function createFixture(options: { sourceType?: "docs" | "openapi" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "context-compact-cli-"));
  const dbPath = join(root, "context.db");
  process.env["CONTEXT_DB_PATH"] = dbPath;
  process.env["HASNA_CONTEXT_DB_PATH"] = dbPath;
  resetDatabase();

  const library = createLibrary({
    name: options.sourceType === "openapi" ? "Compact Endpoint API" : "Compact Search Docs",
    docs_url: "https://docs.example.test",
    source_type: options.sourceType ?? "docs",
  });
  const document = upsertDocument({
    library_id: library.id,
    url: "https://docs.example.test/reference",
    title: "Compact Reference",
    source_type: options.sourceType ?? "docs",
  });

  return { root, dbPath, library, document };
}

function runCli(fixture: ReturnType<typeof createFixture>, args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd,
    env: {
      ...process.env,
      HOME: join(fixture.root, "home"),
      CONTEXT_DB_PATH: fixture.dbPath,
      HASNA_CONTEXT_DB_PATH: fixture.dbPath,
      NO_COLOR: "1",
    },
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function cleanupFixture(fixture: ReturnType<typeof createFixture>): void {
  resetDatabase();
  rmSync(fixture.root, { recursive: true, force: true });
}
