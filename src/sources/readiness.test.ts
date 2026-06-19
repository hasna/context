import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { insertChunk } from "../db/chunks.js";
import { upsertDocument } from "../db/documents.js";
import { createLibrary, updateLibraryCounts } from "../db/libraries.js";
import { getSourceReadinessReport } from "./readiness.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  delete process.env["EXA_API_KEY"];
  delete process.env["FIRECRAWL_API_KEY"];
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
});

describe("getSourceReadinessReport", () => {
  it("reports native refresh readiness and due status", () => {
    const library = createLibrary({
      name: "Ready Docs",
      docs_url: "https://example.com/docs",
    });
    const doc = upsertDocument({
      library_id: library.id,
      url: "https://example.com/docs",
      content: "Ready documentation content for source readiness.",
    });
    insertChunk({
      library_id: library.id,
      document_id: doc.id,
      content: "Ready documentation content for source readiness.",
      position: 0,
    });
    updateLibraryCounts(library.id);

    const report = getSourceReadinessReport({ slug: library.slug });

    expect(report.totals.libraries).toBe(1);
    expect(report.totals.ready_for_native_refresh).toBe(1);
    expect(report.totals.indexed).toBe(1);
    expect(report.libraries[0]?.can_refresh_natively).toBe(true);
    expect(report.libraries[0]?.issues.map((issue) => issue.code)).toContain("missing_artifacts");
  });

  it("reports missing sources as errors", () => {
    const library = createLibrary({
      name: "Manual Note",
      source_type: "manual",
    });

    const report = getSourceReadinessReport({ slug: library.slug });

    expect(report.totals.with_errors).toBe(1);
    expect(report.libraries[0]?.can_refresh_natively).toBe(false);
    expect(report.libraries[0]?.issues.map((issue) => issue.code)).toContain("missing_source");
    expect(report.libraries[0]?.issues.map((issue) => issue.code)).toContain("not_indexed");
  });

  it("treats bare docs sources as discoverable when Exa is configured", () => {
    process.env["EXA_API_KEY"] = "test-exa-key";
    const library = createLibrary({
      name: "Discoverable Docs",
      source_type: "docs",
    });

    const report = getSourceReadinessReport({ slug: library.slug });

    expect(report.totals.with_errors).toBe(0);
    expect(report.libraries[0]?.issues.map((issue) => issue.code)).toContain("source_discovery_needed");
    expect(report.libraries[0]?.issues.map((issue) => issue.code)).not.toContain("missing_source");
  });

  it("summarizes mixed source readiness across libraries", () => {
    createLibrary({
      name: "API Docs",
      docs_url: "https://example.com/api",
      source_type: "api",
    });
    createLibrary({
      name: "Package Docs",
      npm_package: "example",
      source_type: "npm",
    });

    const report = getSourceReadinessReport();

    expect(report.totals.libraries).toBe(2);
    expect(report.totals.ready_for_native_refresh).toBe(2);
    expect(report.totals.due).toBe(2);
    expect(report.libraries.every((row) => row.issues.some((issue) => issue.code === "not_indexed"))).toBe(true);
  });
});
