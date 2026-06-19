import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import { createLibrary, getLibraryById } from "../db/libraries.js";
import { listDocuments } from "../db/documents.js";
import { listApiEndpoints } from "../db/api-endpoints.js";
import { getNodeByLibraryId, getRelatedNodes } from "../db/kg.js";
import { listDocumentArtifacts, readLibraryDocsManifest } from "../docs/artifacts.js";
import { crawlLibrary } from "./index.js";

let server: Server | null = null;
let oldHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "context-native-source-"));
  process.env["HOME"] = tempHome;
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  delete process.env["EXA_API_KEY"];
  delete process.env["FIRECRAWL_API_KEY"];
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  resetDatabase();
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  delete process.env["CONTEXT_DB_PATH"];
  rmSync(tempHome, { recursive: true, force: true });
});

describe("crawlLibrary native sources", () => {
  it("indexes website sources without crawler API keys", async () => {
    const baseUrl = serveText({
      "/docs": `
        <html><head><title>Website Docs</title></head>
        <body><main>
          <h1>Website Docs</h1>
          <p>Website source documentation describes installation, authentication, pagination, retries, and deployment workflows for production applications.</p>
          <a href="/docs/auth">Authentication</a>
        </main></body></html>
      `,
      "/docs/auth": `
        <html><body><main>
          <h1>Authentication</h1>
          <p>Authentication documentation explains API tokens, rotating secrets, webhook signatures, and request verification for secure integrations.</p>
        </main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Website Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 2 });

    expect(result.ingest_mode).toBe("native");
    expect(result.source_type).toBe("docs");
    expect(result.pages_ingested).toBe(2);
    expect(result.pages_crawled).toBe(2);
    expect(result.files_written).toBe(2);

    const updated = getLibraryById(library.id);
    expect(updated.document_count).toBe(2);
    expect(updated.chunk_count).toBeGreaterThan(0);
    expect(listDocumentArtifacts(library.slug)).toHaveLength(2);

    const manifest = readLibraryDocsManifest(library.slug);
    expect(manifest?.library.slug).toBe(library.slug);
    expect(manifest?.library.source_type).toBe("docs");
    expect(manifest?.counts.documents).toBe(2);
    expect(manifest?.refresh.retrieved_by).toBe("native:docs");
  });

  it("indexes sitemap-discovered website pages without crawler API keys", async () => {
    const baseUrl = serveText({
      "/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/docs/advanced</loc></url>
        </urlset>`,
      "/docs": `
        <html><head><title>Sitemap Website Docs</title></head>
        <body><main>
          <h1>Sitemap Website Docs</h1>
          <p>Entry docs explain installation, authentication, source readiness, refresh planning, and local artifact writing for native source ingestion.</p>
        </main></body></html>
      `,
      "/docs/advanced": `
        <html><body><main>
          <h1>Advanced Sitemap Docs</h1>
          <p>Advanced sitemap-discovered docs explain scheduled updates, native-only live loops, source metadata, SQLite indexing, chunk search, and webhook delivery.</p>
        </main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Sitemap Website Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 2 });

    expect(result.ingest_mode).toBe("native");
    expect(result.pages_crawled).toBe(2);
    expect(result.files_written).toBe(2);

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(2);
    expect(docs.some((doc) => doc.title === "Advanced Sitemap Docs")).toBe(true);
    expect(listDocumentArtifacts(library.slug)).toHaveLength(2);
  });

  it("indexes robots-declared sitemap pages without crawler API keys", async () => {
    const baseUrl = serveText({
      "/robots.txt": "User-agent: *\nAllow: /\nSitemap: /robots-sitemap.xml\n",
      "/robots-sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/docs/robots-guide</loc></url>
        </urlset>`,
      "/docs": `
        <html><head><title>Robots Sitemap Docs</title></head>
        <body><main>
          <h1>Robots Sitemap Docs</h1>
          <p>Entry docs explain robots sitemap discovery, native source crawling, artifact writing, and local search indexing.</p>
        </main></body></html>
      `,
      "/docs/robots-guide": `
        <html><body><main>
          <h1>Robots Guide</h1>
          <p>Robots-discovered documentation explains sitemap parsing, docs scope filtering, SQLite metadata, chunks, and Markdown artifacts.</p>
        </main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Robots Sitemap Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 2 });

    expect(result.ingest_mode).toBe("native");
    expect(result.pages_crawled).toBe(2);
    expect(result.files_written).toBe(2);

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(2);
    expect(docs.some((doc) => doc.title === "Robots Guide")).toBe(true);
    expect(listDocumentArtifacts(library.slug)).toHaveLength(2);
  });

  it("indexes auto-discovered llms.txt docs without crawler API keys", async () => {
    const baseUrl = serveText({
      "/llms.txt": "# LLM Native Docs\n\nThis AI-readable manifest describes native source discovery, documentation refresh planning, local artifact storage, SQLite metadata indexing, and agent search workflows.\n\n- [Agent Guide](/docs/agent-guide.md)",
      "/docs": `
        <html><head><title>LLM Native Docs</title></head>
        <body><main>
          <h1>LLM Native Docs</h1>
          <p>Entry docs explain native source discovery, AI-readable docs manifests, and structured local indexing.</p>
        </main></body></html>
      `,
      "/docs/agent-guide.md": "# Agent Guide\n\nAgent guide content is discovered from llms.txt and indexed into SQLite chunks plus Markdown artifacts.",
    });
    const library = createLibrary({
      name: "LLM Native Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 3 });

    expect(result.ingest_mode).toBe("native");
    expect(result.pages_crawled).toBe(3);
    expect(result.files_written).toBe(3);

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(3);
    expect(docs.some((doc) => doc.title === "Agent Guide")).toBe(true);
    expect(listDocumentArtifacts(library.slug)).toHaveLength(3);
  });

  it("indexes OpenAPI sources without crawler API keys", async () => {
    const baseUrl = serveText({
      "/openapi.json": JSON.stringify({
        openapi: "3.1.0",
        info: {
          title: "Native Source API",
          version: "1.0.0",
          description: "Native source integration test API documentation.",
        },
        paths: {
          "/messages": {
            post: {
              summary: "Create a message",
              operationId: "createMessage",
              description: "Create a message with a body and recipient.",
              requestBody: { required: true, description: "Message create payload" },
              responses: {
                "201": { description: "Message created" },
                "400": { description: "Invalid message payload" },
              },
            },
          },
        },
      }),
    });
    const library = createLibrary({
      name: "Native Source API",
      docs_url: `${baseUrl}/openapi.json`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 1 });

    expect(result.pages_crawled).toBe(1);
    expect(result.chunks_indexed).toBeGreaterThan(0);
    expect(result.files_written).toBe(1);

    const updated = getLibraryById(library.id);
    expect(updated.document_count).toBe(1);
    expect(updated.chunk_count).toBeGreaterThan(0);
    expect(updated.source_type).toBe("openapi");

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata["source_format"]).toBe("json");

    const artifacts = listDocumentArtifacts(library.slug);
    expect(artifacts).toHaveLength(1);
  });

  it("indexes OpenAPI YAML sources without crawler API keys", async () => {
    const baseUrl = serveText({
      "/openapi.yaml": [
        "openapi: 3.1.0",
        "info:",
        "  title: Native YAML API",
        "  version: 1.0.0",
        "  description: Native YAML source integration test API documentation.",
        "paths:",
        "  /messages:",
        "    post:",
        "      summary: Create a message",
        "      operationId: createYamlMessage",
        "      description: Create a message with a body and recipient.",
        "      requestBody:",
        "        required: true",
        "        description: Message create payload",
        "        content:",
        "          application/json:",
        "            schema:",
        "              $ref: './schemas.yaml#/components/schemas/MessageCreate'",
        "      responses:",
        "        '201':",
        "          description: Message created",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: './schemas.yaml#/components/schemas/Message'",
        "        '400':",
        "          description: Invalid message payload",
      ].join("\n"),
      "/schemas.yaml": [
        "components:",
        "  schemas:",
        "    MessageCreate:",
        "      type: object",
        "      required: [body, recipient]",
        "      properties:",
        "        body:",
        "          type: string",
        "        recipient:",
        "          type: string",
        "    Message:",
        "      type: object",
        "      required: [id]",
        "      properties:",
        "        id:",
        "          type: string",
        "        body:",
        "          type: string",
      ].join("\n"),
    });
    const library = createLibrary({
      name: "Native YAML API",
      docs_url: `${baseUrl}/openapi.yaml`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 1 });

    expect(result.pages_crawled).toBe(1);
    expect(result.chunks_indexed).toBeGreaterThan(0);
    expect(result.files_written).toBe(1);

    const updated = getLibraryById(library.id);
    expect(updated.document_count).toBe(1);
    expect(updated.chunk_count).toBeGreaterThan(0);
    expect(updated.source_type).toBe("openapi");

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata["source_format"]).toBe("yaml");
    expect(docs[0]?.content).toContain("### POST /messages");
    expect(docs[0]?.content).toContain("Operation ID: createYamlMessage");

    const endpoints = listApiEndpoints({ libraryId: library.id, operationId: "createYamlMessage" });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.method).toBe("POST");
    expect(endpoints[0]?.path).toBe("/messages");
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.name).toBe("MessageCreate");
    expect(endpoints[0]?.responses["201"]?.description).toBe("Message created");
    expect(endpoints[0]?.responses["201"]?.schemas?.["application/json"]?.name).toBe("Message");

    const libraryNode = getNodeByLibraryId(library.id);
    expect(libraryNode).not.toBeNull();
    const related = getRelatedNodes(libraryNode!.id, "part_of");
    const endpointRelation = related.relations.find((relation) =>
      relation.node.type === "endpoint" &&
      relation.node.metadata["operation_id"] === "createYamlMessage"
    );
    expect(endpointRelation?.direction).toBe("incoming");
    expect(endpointRelation?.node.metadata["path"]).toBe("/messages");

    const artifacts = listDocumentArtifacts(library.slug);
    expect(artifacts).toHaveLength(1);
  });

  it("indexes npm package sources without crawler API keys", async () => {
    const baseUrl = serveText({
      "/registry/example": JSON.stringify({
        name: "example",
        readme: "# Example Package\n\nExample package documentation explains installation, client creation, authentication, retries, pagination, and production deployment with detailed TypeScript examples.",
        "dist-tags": { latest: "2.0.0" },
        versions: {
          "2.0.0": {
            version: "2.0.0",
            description: "Example package for native npm source ingestion.",
          },
        },
      }),
    });
    const library = createLibrary({
      name: "Example Package",
      npm_package: "example",
      source_type: "npm",
      source_url: `${baseUrl}/registry/example`,
    });

    const result = await crawlLibrary(library.id, { maxPages: 1 });

    expect(result.ingest_mode).toBe("native");
    expect(result.source_type).toBe("npm");
    expect(result.pages_crawled).toBe(1);
    expect(result.files_written).toBe(1);

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata["package_name"]).toBe("example");
    expect(listDocumentArtifacts(library.slug)).toHaveLength(1);
  });
});

function serveText(routes: Record<string, string>): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const body = routes[url.pathname];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    },
  });
  return server.url.origin;
}
