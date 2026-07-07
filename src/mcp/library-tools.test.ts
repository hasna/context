import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import { createLibrary, getLibraryBySlug } from "../db/libraries.js";
import { listDocuments } from "../db/documents.js";
import { listDocumentArtifacts } from "../docs/artifacts.js";
import { registerLibraryTools } from "./library-tools.js";

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let server: Server | null = null;
let oldHome: string | undefined;
let oldFetch: typeof globalThis.fetch;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env["HOME"];
  oldFetch = globalThis.fetch;
  tempHome = mkdtempSync(join(tmpdir(), "context-mcp-library-tools-"));
  process.env["HOME"] = tempHome;
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  delete process.env["EXA_API_KEY"];
  delete process.env["FIRECRAWL_API_KEY"];
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  globalThis.fetch = oldFetch;
  resetDatabase();
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  delete process.env["CONTEXT_DB_PATH"];
  delete process.env["CONTEXT_EMBEDDING_PROVIDER"];
  delete process.env["OPENAI_API_KEY"];
  rmSync(tempHome, { recursive: true, force: true });
});

describe("registerLibraryTools", () => {
  it("registers refresh-source and refreshes an existing documentation source", async () => {
    const tools = registerTools();
    const refreshSource = tools.get("refresh-source");
    expect(refreshSource).toBeDefined();

    const baseUrl = serveDocs();
    const library = createLibrary({
      name: "MCP Refresh Docs",
      docs_url: `${baseUrl}/docs`,
      source_type: "docs",
    });

    const result = await refreshSource!({
      libraryId: `/context/${library.slug}`,
      max_pages: 2,
      retriever: "firecrawl",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Refreshed "MCP Refresh Docs"');
    expect(result.content[0]?.text).toContain("Ingest: native source (docs)");
    expect(result.content[0]?.text).toContain("Pages ingested: 2");
    expect(result.content[0]?.text).toContain("Coverage: retrieved 2/2 pages");

    const docs = listDocuments(library.id);
    expect(docs).toHaveLength(2);
    expect(listDocumentArtifacts(library.slug)).toHaveLength(2);
  });

  it("registers query-api-endpoints for indexed OpenAPI sources", async () => {
    const tools = registerTools();
    const refreshSource = tools.get("refresh-source");
    const queryEndpoints = tools.get("query-api-endpoints");
    expect(refreshSource).toBeDefined();
    expect(queryEndpoints).toBeDefined();

    const baseUrl = serveOpenApiYaml();
    const library = createLibrary({
      name: "MCP Endpoint API",
      docs_url: `${baseUrl}/openapi.yaml`,
      source_type: "openapi",
    });

    const refreshed = await refreshSource!({
      libraryId: `/context/${library.slug}`,
      max_pages: 1,
      retriever: "firecrawl",
    });
    expect(refreshed.isError).toBeUndefined();

    const result = await queryEndpoints!({
      libraryId: `/context/${library.slug}`,
      operation_id: "createMcpWidget",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("## POST /widgets");
    expect(result.content[0]?.text).toContain("Operation ID: createMcpWidget");
    expect(result.content[0]?.text).toContain("Create MCP widget");
    expect(result.content[0]?.text).toContain("Set verbose=true");
    expect(result.content[0]?.text).not.toContain("application/json: McpWidget");

    const verbose = await queryEndpoints!({
      libraryId: `/context/${library.slug}`,
      operation_id: "createMcpWidget",
      verbose: true,
    });
    expect(verbose.isError).toBeUndefined();
    expect(verbose.content[0]?.text).toContain("Widget created");
    expect(verbose.content[0]?.text).toContain("application/json: McpWidget");
  });

  it("registers build-docs-context for indexed docs", async () => {
    const tools = registerTools();
    const buildContext = tools.get("build-docs-context");
    expect(buildContext).toBeDefined();

    const baseUrl = serveDocs();
    const library = createLibrary({
      name: "MCP Context Docs",
      version: "1.0.0",
      docs_url: `${baseUrl}/docs`,
      source_type: "docs",
    });
    const refreshSource = tools.get("refresh-source");
    await refreshSource!({
      libraryId: `/context/${library.slug}`,
      max_pages: 1,
      retriever: "firecrawl",
    });

    const result = await buildContext!({
      prompt: "agent-accessible search workflows",
      libraryId: `/context/${library.slug}`,
      version: "1",
      limit: 1,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Documentation Context");
    expect(result.content[0]?.text).toContain("Version: 1.0.0");
    expect(result.content[0]?.text).toContain("agent-accessible search workflows");
  });

  it("registers verify-readiness and runs shared local source smokes", async () => {
    const tools = registerTools();
    const verifyReadiness = tools.get("verify-readiness");
    expect(verifyReadiness).toBeDefined();

    const result = await verifyReadiness!({
      publish: false,
      smoke: true,
      pages: 2,
      json: true,
    });

    expect(result.isError).toBeUndefined();
    const report = JSON.parse(result.content[0]?.text ?? "{}") as {
      ready: boolean;
      publish: null;
      smoke: {
        local: Array<{ id: string; status: string; retriever: string }>;
        semantic: { status: string; embedded: number; total_chunks: number };
      };
    };
    expect(report.ready).toBe(true);
    expect(report.publish).toBeNull();
    expect(report.smoke.local.map((item) => item.id)).toEqual([
      "local-docs",
      "local-llms-txt",
      "local-website",
      "local-openapi",
      "local-github",
      "local-npm",
      "local-api",
      "local-discovered-firecrawl",
    ]);
    expect(report.smoke.local.every((item) => item.status === "passed")).toBe(true);
    expect(report.smoke.local.some((item) => item.retriever === "firecrawl")).toBe(true);
    expect(report.smoke.semantic.status).toBe("passed");
    expect(report.smoke.semantic.embedded).toBe(2);
    expect(report.smoke.semantic.total_chunks).toBe(2);
  });

  it("lets agents require full-doc coverage in verify-readiness", async () => {
    const tools = registerTools();
    const verifyReadiness = tools.get("verify-readiness");
    expect(verifyReadiness).toBeDefined();

    const result = await verifyReadiness!({
      publish: false,
      smoke: true,
      pages: 1,
      concurrency: 2,
      case_timeout_ms: 45_000,
      require_full_docs: true,
      json: true,
    });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.content[0]?.text ?? "{}") as {
      ready: boolean;
      smoke: {
        local: Array<{
          status: string;
          coverage_required: boolean;
          coverage_passed: boolean;
          coverage_issues: string[];
        }>;
      };
    };
    expect(report.ready).toBe(false);
    expect(report.smoke.local.every((item) => item.status === "failed")).toBe(true);
    expect(report.smoke.local.every((item) => item.coverage_required)).toBe(true);
    expect(report.smoke.local.every((item) => item.coverage_passed === false)).toBe(true);
    expect(report.smoke.local[0]?.coverage_issues.join("; ")).toContain("Page budget was saturated");
  });

  it("returns compact verification text by default", async () => {
    const tools = registerTools();
    const verifyReadiness = tools.get("verify-readiness");
    expect(verifyReadiness).toBeDefined();

    const result = await verifyReadiness!({
      publish: false,
      source_readiness: false,
    });

    expect(result.content[0]?.text).toContain("Context verification:");
    expect(result.content[0]?.text).toContain("Set json=true");
    expect(() => JSON.parse(result.content[0]?.text ?? "{}")).toThrow();
  });

  it("registers embed-library and embedding-coverage tools", async () => {
    const tools = registerTools();
    const refreshSource = tools.get("refresh-source");
    const embedLibrary = tools.get("embed-library");
    const embeddingCoverage = tools.get("embedding-coverage");
    expect(refreshSource).toBeDefined();
    expect(embedLibrary).toBeDefined();
    expect(embeddingCoverage).toBeDefined();

    const baseUrl = serveDocs();
    createLibrary({
      name: "MCP Semantic Docs",
      docs_url: `${baseUrl}/docs`,
      source_type: "docs",
    });
    await refreshSource!({
      libraryId: "/context/mcp-semantic-docs",
      max_pages: 1,
      retriever: "firecrawl",
    });

    process.env["CONTEXT_EMBEDDING_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test-key";
    globalThis.fetch = fakeEmbeddingFetch;

    const embedded = await embedLibrary!({
      libraryId: "/context/mcp-semantic-docs",
      limit: 1,
    });
    expect(embedded.isError).toBeUndefined();
    const report = JSON.parse(embedded.content[0]?.text ?? "{}") as {
      selected_chunks: number;
      embedded_count: number;
      failed_count: number;
    };
    expect(report.selected_chunks).toBe(1);
    expect(report.embedded_count).toBe(1);
    expect(report.failed_count).toBe(0);

    const coverage = await embeddingCoverage!({
      libraryId: "/context/mcp-semantic-docs",
    });
    const coverageReport = JSON.parse(coverage.content[0]?.text ?? "{}") as {
      embeddings: { total: number; embedded: number };
    };
    expect(coverageReport.embeddings.total).toBeGreaterThan(0);
    expect(coverageReport.embeddings.embedded).toBe(1);
  });

  it("registers seed-libraries and uses shared source bootstrap selection", async () => {
    const tools = registerTools();
    const seedLibraries = tools.get("seed-libraries");
    expect(seedLibraries).toBeDefined();

    const first = await seedLibraries!({
      groups: ["llm"],
      limit: 1,
      json: true,
    });
    expect(first.isError).toBeUndefined();
    const firstReport = JSON.parse(first.content[0]?.text ?? "{}") as {
      selected_count: number;
      added_count: number;
      updated_count: number;
      items: Array<{ library_slug: string; source_type: string }>;
    };
    expect(firstReport.selected_count).toBe(1);
    expect(firstReport.added_count).toBe(1);
    expect(firstReport.items[0]?.library_slug).toBe("vercel-ai-sdk");
    expect(firstReport.items[0]?.source_type).toBe("llms_txt");

    const library = getLibraryBySlug("vercel-ai-sdk");
    expect(library.source_url).toBe("https://ai-sdk.dev/llms.txt");

    const second = await seedLibraries!({
      slugs: ["vercel-ai-sdk"],
      limit: 1,
      json: true,
    });
    const secondReport = JSON.parse(second.content[0]?.text ?? "{}") as {
      added_count: number;
      updated_count: number;
    };
    expect(secondReport.added_count).toBe(0);
    expect(secondReport.updated_count).toBe(1);
  });

  it("returns compact seed text by default", async () => {
    const tools = registerTools();
    const seedLibraries = tools.get("seed-libraries");
    expect(seedLibraries).toBeDefined();

    const result = await seedLibraries!({
      groups: ["llm"],
      limit: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Seed libraries: 1 selected");
    expect(result.content[0]?.text).toContain("Set json=true");
    expect(() => JSON.parse(result.content[0]?.text ?? "{}")).toThrow();
  });

  it("registers run-live-update-cycle and previews due docs", async () => {
    const tools = registerTools();
    const runLiveUpdateCycle = tools.get("run-live-update-cycle");
    expect(runLiveUpdateCycle).toBeDefined();

    const baseUrl = serveDocs();
    createLibrary({
      name: "MCP Live Docs",
      docs_url: `${baseUrl}/docs`,
      source_type: "docs",
    });

    const result = await runLiveUpdateCycle!({
      plan_only: true,
      native_only: true,
      max_pages: 1,
      json: true,
    });
    expect(result.isError).toBeUndefined();
    const cycle = JSON.parse(result.content[0]?.text ?? "{}") as {
      planned_count: number;
      refreshed_count: number;
      actions: Array<{ library_slug: string; status: string }>;
    };
    expect(cycle.planned_count).toBe(1);
    expect(cycle.refreshed_count).toBe(0);
    expect(cycle.actions[0]?.library_slug).toBe("mcp-live-docs");
    expect(cycle.actions[0]?.status).toBe("planned");
  });

  it("registers webhook tools and emits test deliveries", async () => {
    const tools = registerTools();
    const addWebhook = tools.get("add-webhook");
    const testWebhook = tools.get("test-webhook");
    const listDeliveries = tools.get("list-webhook-deliveries");
    const removeWebhook = tools.get("remove-webhook");
    expect(addWebhook).toBeDefined();
    expect(testWebhook).toBeDefined();
    expect(listDeliveries).toBeDefined();
    expect(removeWebhook).toBeDefined();

    const received: unknown[] = [];
    const targetUrl = serveWebhookReceiver(received);
    const added = await addWebhook!({
      url: targetUrl,
      events: ["docs.refreshed"],
    });
    expect(added.isError).toBeUndefined();
    const endpoint = JSON.parse(added.content[0]?.text ?? "{}") as { id: string; events: string[] };
    expect(endpoint.events).toEqual(["docs.refreshed"]);

    const emitted = await testWebhook!({
      event: "docs.refreshed",
      payload: { source: "mcp-test" },
      json: true,
    });
    expect(emitted.isError).toBeUndefined();
    const deliveries = JSON.parse(emitted.content[0]?.text ?? "[]") as Array<{ status: string; response_status: number }>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("delivered");
    expect(deliveries[0]?.response_status).toBe(200);
    expect(received).toHaveLength(1);

    const listed = await listDeliveries!({ json: true });
    const listedDeliveries = JSON.parse(listed.content[0]?.text ?? "[]") as Array<{ event: string; status: string }>;
    expect(listedDeliveries[0]?.event).toBe("docs.refreshed");
    expect(listedDeliveries[0]?.status).toBe("delivered");

    const removed = await removeWebhook!({ id: endpoint.id });
    expect(removed.isError).toBeUndefined();
  });
});

function registerTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerLibraryTools(fakeServer);
  return tools;
}

function serveDocs(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/docs") {
        return html(`
          <main>
            <h1>MCP Refresh Docs</h1>
            <p>MCP source refresh documentation explains native source ingestion, Firecrawl fallback options, structured Markdown artifacts, SQLite chunks, and agent-accessible search workflows.</p>
            <a href="/docs/tools">Tools</a>
          </main>
        `);
      }
      if (path === "/docs/tools") {
        return html(`
          <main>
            <h1>MCP Refresh Tools</h1>
            <p>Tool documentation describes refresh-source parameters, source metadata, retriever fallback selection, write files behavior, and local docs indexing.</p>
          </main>
        `);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server.url.origin;
}

function serveOpenApiYaml(): string {
  server?.stop(true);
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/openapi.yaml") return new Response("not found", { status: 404 });
      return new Response([
        "openapi: 3.1.0",
        "info:",
        "  title: MCP Endpoint API",
        "  version: 1.0.0",
        "paths:",
        "  /widgets:",
        "    post:",
        "      summary: Create MCP widget",
        "      operationId: createMcpWidget",
        "      responses:",
        "        '201':",
        "          description: Widget created",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: '#/components/schemas/McpWidget'",
        "components:",
        "  schemas:",
        "    McpWidget:",
        "      type: object",
        "      required: [id]",
        "      properties:",
        "        id:",
        "          type: string",
      ].join("\n"), {
        headers: { "content-type": "application/yaml" },
      });
    },
  });
  return server.url.origin;
}

function serveWebhookReceiver(received: unknown[]): string {
  server?.stop(true);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(await req.json());
      return new Response("ok");
    },
  });
  return server.url.origin;
}

function html(value: string): Response {
  return new Response(`<!doctype html>${value}`, {
    headers: { "content-type": "text/html" },
  });
}

async function fakeEmbeddingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
  const text = Array.isArray(body.input) ? body.input.join(" ") : body.input ?? "";
  const embedding = text.toLowerCase().includes("refresh")
    ? [1, 0, 0]
    : [0.8, 0.1, 0];
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    headers: { "content-type": "application/json" },
  });
}
