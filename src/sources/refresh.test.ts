import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import { createLibrary, getLibraryById } from "../db/libraries.js";
import { listDocuments } from "../db/documents.js";
import { upsertDocument } from "../db/documents.js";
import { insertChunk, searchChunks } from "../db/chunks.js";
import { embeddingCoverage } from "../db/embeddings.js";
import { listDocumentArtifacts, resolveDocumentArtifactPath } from "../docs/artifacts.js";
import { getDefaultExternalRetriever, refreshDocumentationSource, resolveExternalRetriever } from "./refresh.js";

let server: Server | null = null;
let oldHome: string | undefined;
let oldRetriever: string | undefined;
let oldCrawler: string | undefined;
let oldEmbeddingProvider: string | undefined;
let oldOpenAiKey: string | undefined;
let oldFetch: typeof globalThis.fetch;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env["HOME"];
  oldRetriever = process.env["CONTEXT_RETRIEVER"];
  oldCrawler = process.env["CONTEXT_CRAWLER"];
  oldEmbeddingProvider = process.env["CONTEXT_EMBEDDING_PROVIDER"];
  oldOpenAiKey = process.env["OPENAI_API_KEY"];
  oldFetch = globalThis.fetch;
  tempHome = mkdtempSync(join(tmpdir(), "context-source-refresh-"));
  process.env["HOME"] = tempHome;
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  delete process.env["CONTEXT_RETRIEVER"];
  delete process.env["CONTEXT_CRAWLER"];
  delete process.env["EXA_API_KEY"];
  delete process.env["FIRECRAWL_API_KEY"];
  delete process.env["CONTEXT_EMBEDDING_PROVIDER"];
  delete process.env["OPENAI_API_KEY"];
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  resetDatabase();
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  if (oldRetriever === undefined) delete process.env["CONTEXT_RETRIEVER"];
  else process.env["CONTEXT_RETRIEVER"] = oldRetriever;
  if (oldCrawler === undefined) delete process.env["CONTEXT_CRAWLER"];
  else process.env["CONTEXT_CRAWLER"] = oldCrawler;
  if (oldEmbeddingProvider === undefined) delete process.env["CONTEXT_EMBEDDING_PROVIDER"];
  else process.env["CONTEXT_EMBEDDING_PROVIDER"] = oldEmbeddingProvider;
  if (oldOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = oldOpenAiKey;
  globalThis.fetch = oldFetch;
  delete process.env["CONTEXT_DB_PATH"];
  rmSync(tempHome, { recursive: true, force: true });
});

describe("refreshDocumentationSource", () => {
  it("defaults external retrieval to Firecrawl unless Exa is explicitly configured", () => {
    expect(getDefaultExternalRetriever()).toBe("firecrawl");

    process.env["CONTEXT_RETRIEVER"] = "exa";
    expect(getDefaultExternalRetriever()).toBe("exa");

    delete process.env["CONTEXT_RETRIEVER"];
    process.env["CONTEXT_CRAWLER"] = "exa";
    expect(getDefaultExternalRetriever()).toBe("exa");
  });

  it("rejects invalid default retriever environment values", () => {
    process.env["CONTEXT_RETRIEVER"] = "bogus";
    expect(() => getDefaultExternalRetriever()).toThrow('Invalid retriever "bogus". Expected firecrawl or exa.');
  });

  it("honors explicit retriever values even when the env default is invalid", () => {
    process.env["CONTEXT_RETRIEVER"] = "bogus";
    expect(resolveExternalRetriever("firecrawl")).toBe("firecrawl");
  });

  it("rejects invalid retriever values instead of routing them to Exa", async () => {
    const library = createLibrary({
      name: "Invalid Retriever Docs",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });
    let firecrawlCalled = false;
    let exaCalled = false;

    await expect(refreshDocumentationSource(library.id, {
      retriever: "bogus" as "firecrawl",
      retrieverOnly: true,
      retrievers: {
        firecrawl: async () => {
          firecrawlCalled = true;
          return [];
        },
        exa: async () => {
          exaCalled = true;
          return [];
        },
      },
    })).rejects.toThrow('Invalid retriever "bogus". Expected firecrawl or exa.');

    expect(firecrawlCalled).toBe(false);
    expect(exaCalled).toBe(false);
  });

  it("can force the external retriever instead of native source ingestion", async () => {
    const baseUrl = serveText({
      "/docs": "# Native Docs\n\nNative documentation content is intentionally available but should not be used when retrieverOnly is enabled for backend validation.",
    });
    const library = createLibrary({
      name: "Retriever Only Docs",
      docs_url: `${baseUrl}/docs`,
      source_type: "docs",
    });
    let nativeCalled = false;
    let firecrawlCalled = false;

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 1,
      retriever: "firecrawl",
      retrieverOnly: true,
      retrievers: {
        native: async () => {
          nativeCalled = true;
          return [
            {
              url: `${baseUrl}/native`,
              title: "Native",
              text: "# Native\n\nNative source ingestion should be skipped when retrieverOnly validates an external retriever backend.",
            },
          ];
        },
        firecrawl: async () => {
          firecrawlCalled = true;
          return [
            {
              url: `${baseUrl}/retriever`,
              title: "Retriever",
              text: "# Retriever\n\nRetriever-only documentation proves Firecrawl or Exa can be selected directly while preserving source refresh metadata, artifacts, SQLite documents, and searchable chunks.",
            },
          ];
        },
      },
    });

    expect(nativeCalled).toBe(false);
    expect(firecrawlCalled).toBe(true);
    expect(result.ingest_mode).toBe("crawler");
    expect(result.retriever).toBe("firecrawl");
    expect(result.pages_ingested).toBe(1);
  });

  it("reports retrieval coverage and llms-full detection", async () => {
    const library = createLibrary({
      name: "Full Docs Coverage",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 2,
      retriever: "firecrawl",
      retrieverOnly: true,
      retrievers: {
        firecrawl: async () => [
          {
            url: "https://example.invalid/docs",
            title: "Coverage Docs",
            text: "# Coverage Docs\n\nCoverage docs explain source refresh accounting, page budget saturation, structured local files, SQLite chunks, and searchable documentation metadata for operators.",
          },
          {
            url: "https://example.invalid/llms-full.txt",
            title: "Full Docs",
            text: "# Full Docs\n\nFull documentation content includes API references, SDK examples, webhook behavior, authentication, pagination, retries, semantic search, and update planning details.",
            metadata: { source_role: "llms_full_txt" },
          },
        ],
      },
    });

    expect(result.max_pages).toBe(2);
    expect(result.pages_retrieved).toBe(2);
    expect(result.page_limit_reached).toBe(false);
    expect(result.full_docs_detected).toBe(true);
    expect(result.pages_ingested).toBe(2);
  });

  it("treats complete llms.txt linked-doc expansion as full docs coverage", async () => {
    const library = createLibrary({
      name: "Manifest Full Docs",
      source_type: "llms_txt",
      source_url: "https://example.invalid/llms.txt",
    });

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 2,
      retrievers: {
        native: async () => [
          {
            url: "https://example.invalid/llms.txt",
            title: "Manifest",
            text: "# Manifest\n\nManifest full docs source lists linked documentation for complete ingestion coverage, source metadata, searchable chunks, structured Markdown artifacts, update planning, and agent context assembly workflows.",
            metadata: {
              source_type: "llms_txt",
              source_role: "manifest",
              full_docs_mode: "llms_manifest_links",
              full_docs_complete: true,
            },
          },
          {
            url: "https://example.invalid/guide.md",
            title: "Guide",
            text: "# Guide\n\nManifest linked guide content is fully ingested and searchable for strict coverage checks, source metadata validation, local SQLite indexing, semantic retrieval, and documentation update loops.",
            metadata: { source_type: "llms_txt", source_role: "linked_doc" },
          },
        ],
      },
    });

    expect(result.pages_retrieved).toBe(2);
    expect(result.page_limit_reached).toBe(false);
    expect(result.full_docs_detected).toBe(true);
    expect(result.pages_ingested).toBe(2);
  });

  it("keeps the existing searchable index when refresh retrieval fails", async () => {
    const library = createLibrary({
      name: "Stable Refresh Docs",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });
    const doc = upsertDocument({
      library_id: library.id,
      url: "https://example.invalid/docs",
      title: "Stable Docs",
      content: "stable-refresh-token existing docs",
    });
    insertChunk({
      library_id: library.id,
      document_id: doc.id,
      content: "stable-refresh-token existing docs stay searchable after failed refresh",
      position: 0,
    });

    await expect(refreshDocumentationSource(library.id, {
      refresh: true,
      retriever: "firecrawl",
      retrievers: {
        native: async () => {
          throw new Error("network unavailable");
        },
      },
    })).rejects.toThrow("network unavailable");

    expect(searchChunks("stable-refresh-token", library.id, 3)).toHaveLength(1);
  });

  it("removes stale document rows and artifacts on successful full refresh", async () => {
    const library = createLibrary({
      name: "Replace Refresh Docs",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });
    let secondRefresh = false;

    await refreshDocumentationSource(library.id, {
      refresh: true,
      retrievers: {
        native: async () => [
          {
            url: "https://example.invalid/a",
            title: "Alpha",
            text: "# Alpha\n\nreplace-refresh-alpha-token documents source refresh replacement, structured artifacts, searchable chunks, and metadata cleanup for the first page.",
          },
          {
            url: "https://example.invalid/b",
            title: "Beta",
            text: "# Beta\n\nreplace-refresh-beta-token documents source refresh replacement, structured artifacts, searchable chunks, and metadata cleanup for the second page.",
          },
        ],
      },
    });

    expect(listDocuments(library.id)).toHaveLength(2);
    expect(listDocumentArtifacts(library.slug)).toHaveLength(2);
    expect(searchChunks("replace-refresh-beta-token", library.id, 3)).toHaveLength(1);

    secondRefresh = true;
    await refreshDocumentationSource(library.id, {
      refresh: true,
      retrievers: {
        native: async () => secondRefresh ? [
          {
            url: "https://example.invalid/a",
            title: "Alpha Updated",
            text: "# Alpha Updated\n\nreplace-refresh-alpha-updated-token documents source refresh replacement, structured artifacts, searchable chunks, and metadata cleanup for the retained page.",
          },
        ] : [],
      },
    });

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.url).toBe("https://example.invalid/a");
    expect(listDocumentArtifacts(library.slug)).toHaveLength(1);
    expect(searchChunks("replace-refresh-beta-token", library.id, 3)).toHaveLength(0);
    expect(searchChunks("replace-refresh-alpha-updated-token", library.id, 3)).toHaveLength(1);
  });

  it("clears stale artifacts during full refresh even when file writing is disabled", async () => {
    const library = createLibrary({
      name: "No Files Refresh Docs",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });

    await refreshDocumentationSource(library.id, {
      refresh: true,
      retrievers: {
        native: async () => [
          {
            url: "https://example.invalid/a",
            title: "Alpha",
            text: "# Alpha\n\nnofiles-refresh-alpha-token initial docs artifact cleanup source refresh replacement and searchable chunks for the retained page.",
          },
          {
            url: "https://example.invalid/b",
            title: "Beta",
            text: "# Beta\n\nnofiles-refresh-beta-token initial docs artifact cleanup source refresh replacement and searchable chunks for the stale page.",
          },
        ],
      },
    });

    expect(listDocumentArtifacts(library.slug)).toHaveLength(2);

    await refreshDocumentationSource(library.id, {
      refresh: true,
      writeFiles: false,
      retrievers: {
        native: async () => [
          {
            url: "https://example.invalid/a",
            title: "Alpha Updated",
            text: "# Alpha Updated\n\nnofiles-refresh-alpha-updated-token full refresh with files disabled still removes stale Markdown artifacts and keeps SQLite search current.",
          },
        ],
      },
    });

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.file_path).toBeNull();
    expect(listDocumentArtifacts(library.slug)).toHaveLength(0);
    expect(searchChunks("nofiles-refresh-beta-token", library.id, 3)).toHaveLength(0);
    expect(searchChunks("nofiles-refresh-alpha-updated-token", library.id, 3)).toHaveLength(1);
  });

  it("aborts during large native page processing", async () => {
    const library = createLibrary({
      name: "Abort Large Refresh",
      docs_url: "https://example.invalid/large",
      source_type: "docs",
    });
    const controller = new AbortController();
    const largeText = [
      "# Large Refresh",
      "",
      ...Array.from(
        { length: 1200 },
        (_, index) => `abort-large-refresh-token section ${index} documents source refresh cancellation, chunk indexing, and SQLite artifact processing.`
      ),
    ].join("\n\n");
    const refresh = refreshDocumentationSource(library.id, {
      retriever: "firecrawl",
      signal: controller.signal,
      retrievers: {
        native: async () => [
          {
            url: "https://example.invalid/large",
            title: "Large Refresh",
            text: largeText,
          },
        ],
      },
    });

    setTimeout(() => controller.abort(), 0);

    await expect(refresh).rejects.toThrow("Source refresh was aborted");
  });

  it("can generate semantic embeddings immediately after refresh", async () => {
    process.env["CONTEXT_EMBEDDING_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test-key";
    globalThis.fetch = fakeEmbeddingFetch;
    const library = createLibrary({
      name: "Embedded Refresh Docs",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 1,
      retriever: "firecrawl",
      embed: true,
      retrievers: {
        native: async () => [
          {
            url: "https://example.invalid/docs",
            title: "Embedded Refresh",
            text: "# Embedded Refresh\n\nEmbedded refresh documentation explains automatic semantic indexing after source refresh, SQLite chunk metadata, and searchable local documentation for agents.",
          },
        ],
      },
    });

    expect(result.embeddings?.provider).toBe("openai");
    expect(result.embeddings?.selected_chunks).toBe(result.chunks_indexed);
    expect(result.embeddings?.embedded_count).toBe(result.chunks_indexed);
    expect(embeddingCoverage(library.id).embedded).toBe(result.chunks_indexed);
  });

  it("uses Firecrawl as the default external fallback when native discovery returns no pages", async () => {
    const library = createLibrary({
      name: "Default Firecrawl Fallback",
      docs_url: "https://example.invalid/docs",
      source_type: "docs",
    });
    let firecrawlCalled = false;
    let exaCalled = false;

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 1,
      retrievers: {
        native: async () => [],
        firecrawl: async () => {
          firecrawlCalled = true;
          return [
            {
              url: "https://example.invalid/firecrawl-default",
              title: "Default Firecrawl",
              text: "# Default Firecrawl\n\nDefault Firecrawl retrieval indexes source docs when native source discovery returns no pages.",
            },
          ];
        },
        exa: async () => {
          exaCalled = true;
          return [];
        },
      },
    });

    expect(firecrawlCalled).toBe(true);
    expect(exaCalled).toBe(false);
    expect(result.retriever).toBe("firecrawl");
    expect(result.external_retriever).toBe("firecrawl");
    expect(result.pages_ingested).toBe(1);
  });

  it("discovers a missing source URL with Exa metadata before crawling it with Firecrawl", async () => {
    const library = createLibrary({ name: "Bare Docs Discovery" });
    let nativeCalled = false;
    let firecrawlDocsUrl: string | null | undefined;

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 1,
      retrievers: {
        discoverUrls: async () => [
          {
            url: "https://docs.example.com/bare",
            title: "Bare Docs",
            score: 12,
            query: "Bare Docs Discovery documentation guide",
            source: "exa",
          },
        ],
        native: async () => {
          nativeCalled = true;
          return [];
        },
        firecrawl: async (options) => {
          firecrawlDocsUrl = options.docs_url;
          return [
            {
              url: `${options.docs_url}/getting-started`,
              title: "Bare Getting Started",
              text: "# Bare Getting Started\n\nBare docs discovery source content is crawled by Firecrawl after Exa resolves the canonical documentation URL for a named source.",
            },
          ];
        },
      },
    });

    const updated = getLibraryById(library.id);
    expect(library.source_type).toBe("docs");
    expect(nativeCalled).toBe(false);
    expect(firecrawlDocsUrl).toBe("https://docs.example.com/bare");
    expect(updated.docs_url).toBe("https://docs.example.com/bare");
    expect(updated.source_url).toBe("https://docs.example.com/bare");
    expect(result.retriever).toBe("firecrawl");
    expect(result.source_discovery?.status).toBe("found");
    expect(result.source_discovery?.url).toBe("https://docs.example.com/bare");
    expect(result.pages_ingested).toBe(1);

    const docs = listDocuments(library.id);
    expect(docs[0]?.metadata["source_discovery"]).toMatchObject({
      status: "found",
      provider: "exa",
      url: "https://docs.example.com/bare",
    });
  });

  it("reports source discovery failure when a bare source has no URL to refresh", async () => {
    const library = createLibrary({ name: "Missing Discovery Docs" });

    await expect(refreshDocumentationSource(library.id, {
      maxPages: 1,
      retrievers: {
        discoverUrls: async () => {
          throw new Error("EXA_API_KEY is not configured");
        },
        firecrawl: async () => [],
      },
    })).rejects.toThrow("Source discovery via Exa failed");
  });

  it("falls back to Firecrawl when native docs discovery returns no pages", async () => {
    const baseUrl = serveText({
      "/docs": ["not found", 404],
    });
    const library = createLibrary({
      name: "Fallback Docs",
      docs_url: `${baseUrl}/docs`,
      source_type: "docs",
    });
    let firecrawlCalled = false;

    const result = await refreshDocumentationSource(library.id, {
      maxPages: 1,
      crawler: "firecrawl",
      retrievers: {
        firecrawl: async () => {
          firecrawlCalled = true;
          return [
            {
              url: `${baseUrl}/firecrawl-doc`,
              title: "Firecrawl Fallback",
              text: "# Firecrawl Fallback\n\nFirecrawl fallback documentation explains external crawler retrieval, source refresh metadata, structured Markdown artifact writing, SQLite document storage, and searchable chunks for agents.",
            },
          ];
        },
      },
    });

    expect(firecrawlCalled).toBe(true);
    expect(result.ingest_mode).toBe("crawler");
    expect(result.retriever).toBe("firecrawl");
    expect(result.crawler).toBe("firecrawl");
    expect(result.retrieved_by).toBe("firecrawl");
    expect(result.external_retriever).toBe("firecrawl");
    expect(result.pages_ingested).toBe(1);
    expect(result.pages_crawled).toBe(1);
    expect(Date.parse(result.refreshed_at)).toBeGreaterThan(0);

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata["retrieved_by"]).toBe("firecrawl");
    expect(docs[0]?.metadata["refreshed_at"]).toBe(result.refreshed_at);

    const artifacts = listDocumentArtifacts(library.slug);
    expect(artifacts).toHaveLength(1);
    const artifactContent = readFileSync(resolveDocumentArtifactPath(artifacts[0]!.relativePath), "utf8");
    expect(artifactContent).toContain(`refreshed_at: "${result.refreshed_at}"`);
    expect(artifactContent).toContain('retrieved_by: "firecrawl"');
  });
});

function serveText(routes: Record<string, string | [string, number]>): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const route = routes[path];
      if (!route) return new Response("not found", { status: 404 });
      if (Array.isArray(route)) return new Response(route[0], { status: route[1] });
      return new Response(route, {
        headers: { "content-type": route.trim().startsWith("<") ? "text/html" : "text/plain" },
      });
    },
  });
  return server.url.origin;
}

async function fakeEmbeddingFetch(): Promise<Response> {
  return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
    headers: { "content-type": "application/json" },
  });
}
