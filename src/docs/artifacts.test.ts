import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import {
  getLibraryDocsManifestArtifact,
  listDocumentArtifacts,
  readLibraryDocsManifest,
  resolveDocumentArtifactPath,
  writeDocumentArtifact,
  writeLibraryDocsManifest,
} from "./artifacts.js";

let oldHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "context-artifacts-"));
  process.env["HOME"] = tempHome;
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

describe("writeLibraryDocsManifest", () => {
  it("writes a structured JSON manifest for a source library", () => {
    const manifestArtifact = writeLibraryDocsManifest({
      library: {
        id: "lib_1",
        name: "React",
        slug: "react",
        description: null,
        npm_package: "react",
        github_repo: "facebook/react",
        docs_url: "https://react.dev",
        version: null,
        source_type: "docs",
        source_url: "https://react.dev",
        freshness_days: 7,
        priority: 0,
        chunk_count: 1,
        document_count: 1,
        last_crawled_at: null,
        last_checked_at: null,
        next_check_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      documents: [
        {
          id: "doc_1",
          library_id: "lib_1",
          url: "https://react.dev/reference/react/useState",
          title: "useState",
          content: "useState lets you add state.",
          content_hash: "abc123",
          file_path: "docs/react/react-use-state-abc123.md",
          source_type: "docs",
          status: "active",
          metadata: {},
          parsed_at: "2026-01-01T00:00:00.000Z",
          discovered_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      endpoints: [],
      refresh: {
        library_id: "lib_1",
        source_type: "docs",
        ingest_mode: "native",
        retriever: "native:docs",
        retrieved_by: "native:docs",
        crawler: "native:docs",
        external_retriever: null,
        pages_ingested: 1,
        pages_crawled: 1,
        max_pages: 1,
        pages_retrieved: 1,
        page_limit_reached: true,
        full_docs_detected: false,
        chunks_indexed: 1,
        api_endpoints_indexed: 0,
        files_written: 1,
        refreshed_at: "2026-01-01T00:00:00.000Z",
        errors: [],
        embeddings: null,
        source_discovery: null,
      },
    });

    expect(manifestArtifact.relativePath).toBe("docs/react/manifest.json");
    expect(getLibraryDocsManifestArtifact("react")?.relativePath).toBe("docs/react/manifest.json");
    const manifest = readLibraryDocsManifest("react");
    expect(manifest?.schema_version).toBe(1);
    expect(manifest?.library.slug).toBe("react");
    expect(manifest?.counts.documents).toBe(1);
    expect(manifest?.documents[0]?.file_path).toBe("docs/react/react-use-state-abc123.md");
  });
});

afterEach(() => {
  resetDatabase();
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  delete process.env["CONTEXT_DB_PATH"];
  rmSync(tempHome, { recursive: true, force: true });
});

describe("writeDocumentArtifact", () => {
  it("writes structured markdown under the context docs directory", () => {
    const artifact = writeDocumentArtifact({
      librarySlug: "react",
      libraryName: "React",
      url: "https://react.dev/reference/react/useState",
      title: "useState",
      content: "useState lets you add state to a component.",
      contentHash: "abc123",
      retrievedBy: "firecrawl",
    });

    expect(artifact.relativePath).toStartWith("docs/react/");
    expect(resolveDocumentArtifactPath(artifact.relativePath)).toBe(artifact.absolutePath);

    const content = readFileSync(artifact.absolutePath, "utf8");
    expect(content).toContain('library: "React"');
    expect(content).toContain('url: "https://react.dev/reference/react/useState"');
    expect(content).toContain('retrieved_by: "firecrawl"');
    expect(content).toContain("refreshed_at:");
    expect(content).toContain("crawled_at:");
    expect(content).toContain("useState lets you add state");

    const listed = listDocumentArtifacts("react");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.relativePath).toBe(artifact.relativePath);
  });
});
