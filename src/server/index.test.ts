import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import { handleRequest, startServer } from "./index.js";

let fixtureServer: Server | null = null;
let oldHome: string | undefined;
let oldFetch: typeof globalThis.fetch;
let tempHome: string;
const oldEnv = new Map<string, string | undefined>();

const ISOLATED_ENV_NAMES = [
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "CONTEXT_EMBEDDING_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "GROQ_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "CONTEXT_AI_PROVIDER",
  "CONTEXT_AI_MODEL",
  "CONTEXT_HOST",
  "CONTEXT_CORS_ORIGIN",
  "CONTEXT_HTTP_TOKEN",
  "CONTEXT_REQUIRE_HTTP_AUTH",
  "HASNA_CONTEXT_HTTP_TOKEN",
  "HASNA_CONTEXT_REQUIRE_HTTP_AUTH",
  "HASNA_CONTEXT_CORS_ORIGIN",
] as const;

beforeEach(() => {
  oldHome = process.env["HOME"];
  oldFetch = globalThis.fetch;
  oldEnv.clear();
  for (const name of ISOLATED_ENV_NAMES) {
    oldEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  tempHome = mkdtempSync(join(tmpdir(), "context-server-api-"));
  process.env["HOME"] = tempHome;
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  fixtureServer?.stop(true);
  fixtureServer = null;
  globalThis.fetch = oldFetch;
  resetDatabase();
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  delete process.env["CONTEXT_DB_PATH"];
  for (const name of ISOLATED_ENV_NAMES) {
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe("HTTP source refresh API", () => {
  it("requires a configured token for API routes when HTTP auth is enabled", async () => {
    process.env["CONTEXT_HTTP_TOKEN"] = "test-token";

    const health = await handleRequest(new Request("http://context.test/api/health"));
    expect(health.status).toBe(200);

    const unauthorized = await handleRequest(new Request("http://context.test/api/libraries"));
    expect(unauthorized.status).toBe(401);

    const forbidden = await handleRequest(new Request("http://context.test/api/libraries", {
      headers: { authorization: "Bearer wrong-token" },
    }));
    expect(forbidden.status).toBe(403);

    const authorized = await handleRequest(new Request("http://context.test/api/libraries", {
      headers: { authorization: "Bearer test-token" },
    }));
    expect(authorized.status).toBe(200);
  });

  it("refuses non-local HTTP binds unless a token is configured", () => {
    expect(() => startServer(0, "0.0.0.0")).toThrow("CONTEXT_HTTP_TOKEN");

    process.env["CONTEXT_HTTP_TOKEN"] = "bind-token";
    const server = startServer(0, "0.0.0.0");
    server.stop(true);
  });

  it("refreshes documentation through the preferred /refresh route", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Refresh Route", `${baseUrl}/docs`);

    const response = await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-refresh-route/refresh",
      { max_pages: 2, retriever: "firecrawl" }
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      result: {
        ingest_mode: string;
        retriever: string;
        crawler: string;
        pages_ingested: number;
        pages_crawled: number;
        max_pages: number;
        pages_retrieved: number;
        page_limit_reached: boolean;
        full_docs_detected: boolean;
        refreshed_at: string;
        files_written: number;
      };
    };

    expect(body.result.ingest_mode).toBe("native");
    expect(body.result.retriever).toBe("native:docs");
    expect(body.result.crawler).toBe("native:docs");
    expect(body.result.pages_ingested).toBe(2);
    expect(body.result.pages_crawled).toBe(2);
    expect(body.result.max_pages).toBe(2);
    expect(body.result.pages_retrieved).toBe(2);
    expect(body.result.page_limit_reached).toBe(true);
    expect(body.result.full_docs_detected).toBe(false);
    expect(Date.parse(body.result.refreshed_at)).toBeGreaterThan(0);
    expect(body.result.files_written).toBe(2);

    const docsResponse = await handleRequest(new Request(
      "http://context.test/api/libraries/http-refresh-route/docs"
    ));
    const docsBody = await docsResponse.json() as {
      documents: unknown[];
      artifacts: unknown[];
      manifest: { relativePath: string } | null;
    };
    expect(docsBody.documents).toHaveLength(2);
    expect(docsBody.artifacts).toHaveLength(2);
    expect(docsBody.manifest?.relativePath).toBe("docs/http-refresh-route/manifest.json");
  });

  it("keeps /crawl as a compatibility alias", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Crawl Alias", `${baseUrl}/docs`);

    const response = await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-crawl-alias/crawl",
      { max_pages: 1, crawler: "firecrawl" }
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { pages_ingested: number; pages_crawled: number } };
    expect(body.result.pages_ingested).toBe(1);
    expect(body.result.pages_crawled).toBe(1);
  });

  it("indexes OpenAPI endpoints and exposes them through /api/endpoints", async () => {
    const baseUrl = serveOpenApiYaml();
    const create = await handleRequest(jsonRequest("http://context.test/api/libraries", {
      name: "HTTP Endpoint API",
      docs_url: `${baseUrl}/openapi.yaml`,
      source_type: "openapi",
    }));
    expect(create.status).toBe(201);

    const refresh = await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-endpoint-api/refresh",
      { max_pages: 1, retriever: "firecrawl" }
    ));
    expect(refresh.status).toBe(200);
    const refreshBody = await refresh.json() as { result: { api_endpoints_indexed: number } };
    expect(refreshBody.result.api_endpoints_indexed).toBe(1);

    const endpoints = await handleRequest(new Request(
      "http://context.test/api/endpoints?library=http-endpoint-api&operation_id=createHttpWidget"
    ));
    expect(endpoints.status).toBe(200);
    const body = await endpoints.json() as {
      endpoints: Array<{
        method: string;
        path: string;
        operation_id: string;
        source_format: string;
        responses: Record<string, { schemas?: Record<string, { name?: string }> }>;
      }>;
    };
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0]).toMatchObject({
      method: "POST",
      path: "/widgets",
      operation_id: "createHttpWidget",
      source_format: "yaml",
    });
    expect(body.endpoints[0]?.responses["201"]?.schemas?.["application/json"]?.name).toBe("HttpWidget");
  });

  it("rejects invalid refresh retriever inputs with a bad request", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Invalid Retriever", `${baseUrl}/docs`);

    const response = await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-invalid-retriever/refresh",
      { max_pages: 1, retriever: "bogus" }
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('Invalid retriever "bogus"');
  });
});

describe("HTTP semantic search API", () => {
  it("embeds chunks during refresh when requested", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Refresh Embed Docs", `${baseUrl}/docs`);

    process.env["CONTEXT_EMBEDDING_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test-key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      String(input).includes("openai.com")
        ? fakeEmbeddingFetch()
        : realFetch(input, init);

    const refresh = await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-refresh-embed-docs/refresh",
      { max_pages: 1, retriever: "firecrawl", embed: true }
    ));
    expect(refresh.status).toBe(200);
    const refreshBody = await refresh.json() as {
      result: {
        chunks_indexed: number;
        embeddings: { embedded_count: number; selected_chunks: number; provider: string } | null;
      };
    };
    expect(refreshBody.result.embeddings?.provider).toBe("openai");
    expect(refreshBody.result.embeddings?.embedded_count).toBe(refreshBody.result.chunks_indexed);

    const search = await handleRequest(new Request(
      "http://context.test/api/search?q=refresh%20metadata&library=http-refresh-embed-docs&semantic=true&limit=1"
    ));
    expect(search.status).toBe(200);
    const searchBody = await search.json() as { mode: string; results: unknown[] };
    expect(searchBody.mode).toBe("semantic");
    expect(searchBody.results).toHaveLength(1);
  });

  it("embeds library chunks and serves semantic search results", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Semantic Docs", `${baseUrl}/docs`);
    await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-semantic-docs/refresh",
      { max_pages: 1, retriever: "firecrawl" }
    ));

    process.env["CONTEXT_EMBEDDING_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test-key";
    globalThis.fetch = fakeEmbeddingFetch;

    const embed = await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-semantic-docs/embed",
      { limit: 1 }
    ));
    expect(embed.status).toBe(200);
    const embedBody = await embed.json() as {
      report: { embedded_count: number; failed_count: number; selected_chunks: number };
    };
    expect(embedBody.report.selected_chunks).toBe(1);
    expect(embedBody.report.embedded_count).toBe(1);
    expect(embedBody.report.failed_count).toBe(0);

    const coverage = await handleRequest(new Request(
      "http://context.test/api/libraries/http-semantic-docs/embeddings"
    ));
    const coverageBody = await coverage.json() as { embeddings: { total: number; embedded: number } };
    expect(coverageBody.embeddings.total).toBeGreaterThan(0);
    expect(coverageBody.embeddings.embedded).toBe(1);

    const search = await handleRequest(new Request(
      "http://context.test/api/search?q=refresh%20metadata&library=http-semantic-docs&semantic=true&limit=1"
    ));
    expect(search.status).toBe(200);
    const searchBody = await search.json() as {
      mode: string;
      model: string;
      results: Array<{ content: string; score: number }>;
    };
    expect(searchBody.mode).toBe("semantic");
    expect(searchBody.model).toBe("text-embedding-3-small");
    expect(searchBody.results).toHaveLength(1);
    expect(searchBody.results[0]?.content).toContain("HTTP source refresh documentation");
  });
});

describe("HTTP verifier API", () => {
  it("runs the shared readiness verifier with isolated local source smokes", async () => {
    const response = await handleRequest(new Request(
      "http://context.test/api/verify/readiness?publish=false&smoke=true&pages=2"
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      report: {
        ready: boolean;
        publish: null;
        retrievers: { firecrawl: boolean; exa: boolean };
        smoke: {
          local: Array<{ id: string; status: string; retriever: string }>;
          semantic: { status: string; embedded: number; total_chunks: number };
        };
      };
    };

    expect(body.report.ready).toBe(true);
    expect(body.report.publish).toBeNull();
    expect(body.report.retrievers.firecrawl).toBe(false);
    expect(body.report.retrievers.exa).toBe(false);
    expect(body.report.smoke.local.map((item) => item.id)).toEqual([
      "local-docs",
      "local-llms-txt",
      "local-website",
      "local-openapi",
      "local-github",
      "local-npm",
      "local-api",
      "local-discovered-firecrawl",
    ]);
    expect(body.report.smoke.local.every((item) => item.status === "passed")).toBe(true);
    expect(body.report.smoke.local.some((item) => item.retriever === "firecrawl")).toBe(true);
    expect(body.report.smoke.semantic.status).toBe("passed");
    expect(body.report.smoke.semantic.embedded).toBe(2);
    expect(body.report.smoke.semantic.total_chunks).toBe(2);
  });

  it("supports strict full-doc coverage checks in the readiness verifier", async () => {
    const response = await handleRequest(new Request(
      "http://context.test/api/verify/readiness?publish=false&smoke=true&pages=1&concurrency=3&case_timeout_ms=45000&require_full_docs=true"
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      report: {
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
    };

    expect(body.report.ready).toBe(false);
    expect(body.report.smoke.local.every((item) => item.status === "failed")).toBe(true);
    expect(body.report.smoke.local.every((item) => item.coverage_required)).toBe(true);
    expect(body.report.smoke.local.every((item) => item.coverage_passed === false)).toBe(true);
    expect(body.report.smoke.local[0]?.coverage_issues.join("; ")).toContain("Page budget was saturated");
  });

  it("rejects invalid retriever inputs instead of defaulting silently", async () => {
    const response = await handleRequest(new Request(
      "http://context.test/api/verify/readiness?external_smoke=true&retrievers=bogus"
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('Invalid retriever "bogus"');
  });
});

describe("HTTP AI SDK API", () => {
  it("builds docs context through the HTTP API", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Context Docs", `${baseUrl}/docs`, "2026.06");
    await handleRequest(jsonRequest(
      "http://context.test/api/libraries/http-context-docs/refresh",
      { max_pages: 1, retriever: "firecrawl" }
    ));

    const response = await handleRequest(jsonRequest("http://context.test/api/context/build", {
      prompt: "refresh metadata",
      library: "http-context-docs",
      version: "2026",
      limit: 1,
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      context: { chunks: Array<{ content: string }>; context_text: string };
    };
    expect(body.context.chunks).toHaveLength(1);
    expect(body.context.context_text).toContain("Documentation Context");
    expect(body.context.context_text).toContain("Version: 2026.06");
    expect(body.context.context_text).toContain("HTTP source refresh documentation");
  });

  it("reports AI SDK providers and validates generation setup", async () => {
    const status = await handleRequest(new Request("http://context.test/api/ai/status"));
    expect(status.status).toBe(200);
    const statusBody = await status.json() as {
      backends: Array<{ id: string; configured: boolean; env: string[] }>;
    };
    expect(statusBody.backends.some((provider) => provider.id === "xai")).toBe(true);
    expect(statusBody.backends.every((provider) => provider.configured === false)).toBe(true);

    const generate = await handleRequest(jsonRequest("http://context.test/api/ai/generate", {
      prompt: "Reply with ok",
      provider: "xai",
    }));
    expect(generate.status).toBe(400);
    const generateBody = await generate.json() as { error: string };
    expect(generateBody.error).toContain("xAI requires one of: XAI_API_KEY");
  });

  it("validates docs-grounded ask setup through the HTTP API", async () => {
    const response = await handleRequest(jsonRequest("http://context.test/api/ai/ask", {
      prompt: "What docs are indexed?",
      provider: "xai",
    }));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("xAI requires one of: XAI_API_KEY");
  });
});

describe("HTTP live update API", () => {
  it("previews and runs one live update cycle", async () => {
    const baseUrl = serveDocs();
    await createLibrary("HTTP Live Docs", `${baseUrl}/docs`);

    const preview = await handleRequest(new Request(
      "http://context.test/api/live/cycle?native_only=true&pages=1"
    ));
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as {
      cycle: { planned_count: number; refreshed_count: number; actions: Array<{ status: string }> };
    };
    expect(previewBody.cycle.planned_count).toBe(1);
    expect(previewBody.cycle.refreshed_count).toBe(0);
    expect(previewBody.cycle.actions[0]?.status).toBe("planned");

    const run = await handleRequest(jsonRequest("http://context.test/api/live/cycle", {
      native_only: true,
      max_pages: 1,
    }));
    expect(run.status).toBe(200);
    const runBody = await run.json() as {
      cycle: { refreshed_count: number; actions: Array<{ status: string; result: { pages_ingested: number } }> };
    };
    expect(runBody.cycle.refreshed_count).toBe(1);
    expect(runBody.cycle.actions[0]?.status).toBe("refreshed");
    expect(runBody.cycle.actions[0]?.result.pages_ingested).toBe(1);
  });

  it("rejects invalid live update retriever inputs", async () => {
    const response = await handleRequest(new Request(
      "http://context.test/api/live/cycle?retriever=bogus"
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('Invalid retriever "bogus"');
  });
});

describe("HTTP webhook API", () => {
  it("manages endpoints and emits test deliveries", async () => {
    const received: unknown[] = [];
    const targetUrl = serveWebhookReceiver(received);

    const add = await handleRequest(jsonRequest("http://context.test/api/webhooks", {
      url: targetUrl,
      events: ["docs.refreshed"],
    }));
    expect(add.status).toBe(201);
    const addBody = await add.json() as { endpoint: { id: string; url: string; events: string[] } };
    expect(addBody.endpoint.url).toBe(targetUrl);
    expect(addBody.endpoint.events).toEqual(["docs.refreshed"]);

    const list = await handleRequest(new Request("http://context.test/api/webhooks"));
    const listBody = await list.json() as { endpoints: unknown[] };
    expect(listBody.endpoints).toHaveLength(1);

    const test = await handleRequest(jsonRequest("http://context.test/api/webhooks/test", {
      event: "docs.refreshed",
      payload: { source: "server-test" },
    }));
    expect(test.status).toBe(200);
    const testBody = await test.json() as { deliveries: Array<{ status: string; response_status: number }> };
    expect(testBody.deliveries).toHaveLength(1);
    expect(testBody.deliveries[0]?.status).toBe("delivered");
    expect(testBody.deliveries[0]?.response_status).toBe(200);
    expect(received).toHaveLength(1);

    const deliveries = await handleRequest(new Request("http://context.test/api/webhooks/deliveries"));
    const deliveriesBody = await deliveries.json() as { deliveries: Array<{ event: string; status: string }> };
    expect(deliveriesBody.deliveries[0]?.event).toBe("docs.refreshed");
    expect(deliveriesBody.deliveries[0]?.status).toBe("delivered");

    const remove = await handleRequest(new Request(
      `http://context.test/api/webhooks/${addBody.endpoint.id}`,
      { method: "DELETE" }
    ));
    expect(remove.status).toBe(200);
    const afterRemove = await handleRequest(new Request("http://context.test/api/webhooks"));
    const afterRemoveBody = await afterRemove.json() as { endpoints: unknown[] };
    expect(afterRemoveBody.endpoints).toHaveLength(0);
  });
});

describe("HTTP seed catalog API", () => {
  it("lists and bootstraps selected seed sources idempotently", async () => {
    const listResponse = await handleRequest(new Request(
      "http://context.test/api/seeds?groups=llm&limit=1"
    ));
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as {
      seeds: Array<{ slug: string; source_type?: string; source_url?: string }>;
    };
    expect(listBody.seeds).toHaveLength(1);
    expect(listBody.seeds[0]?.slug).toBe("vercel-ai-sdk");

    const first = await handleRequest(jsonRequest("http://context.test/api/seeds", {
      slugs: ["vercel-ai-sdk"],
      limit: 1,
    }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      report: {
        selected_count: number;
        added_count: number;
        updated_count: number;
        items: Array<{ library_slug: string; source_type: string; source_url: string }>;
      };
    };
    expect(firstBody.report.selected_count).toBe(1);
    expect(firstBody.report.added_count).toBe(1);
    expect(firstBody.report.updated_count).toBe(0);
    expect(firstBody.report.items[0]?.library_slug).toBe("vercel-ai-sdk");
    expect(firstBody.report.items[0]?.source_type).toBe("llms_txt");
    expect(firstBody.report.items[0]?.source_url).toBe("https://ai-sdk.dev/llms.txt");

    const second = await handleRequest(jsonRequest("http://context.test/api/seeds", {
      slugs: ["vercel-ai-sdk"],
      limit: 1,
    }));
    const secondBody = await second.json() as {
      report: { added_count: number; updated_count: number };
    };
    expect(secondBody.report.added_count).toBe(0);
    expect(secondBody.report.updated_count).toBe(1);
  });

  it("rejects invalid seed retriever inputs", async () => {
    const response = await handleRequest(jsonRequest("http://context.test/api/seeds", {
      slugs: ["vercel-ai-sdk"],
      retriever: "bogus",
    }));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('Invalid retriever "bogus"');
  });
});

async function createLibrary(name: string, docsUrl: string, version?: string): Promise<void> {
  const response = await handleRequest(jsonRequest("http://context.test/api/libraries", {
    name,
    docs_url: docsUrl,
    version,
    source_type: "docs",
  }));
  expect(response.status).toBe(201);
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function serveDocs(): string {
  fixtureServer?.stop(true);
  fixtureServer = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/docs") {
        return html(`
          <main>
            <h1>HTTP Source Docs</h1>
            <p>HTTP source refresh documentation explains source metadata, native ingestion, Firecrawl fallback options, structured Markdown files, SQLite chunks, and searchable docs for agents.</p>
            <a href="/docs/auth">Auth</a>
          </main>
        `);
      }
      if (path === "/docs/auth") {
        return html(`
          <main>
            <h1>HTTP Source Auth</h1>
            <p>Authentication docs describe API tokens, webhook signatures, retry handling, local source refresh, and searchable artifact metadata for production integrations.</p>
          </main>
        `);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return fixtureServer.url.origin;
}

function serveOpenApiYaml(): string {
  fixtureServer?.stop(true);
  fixtureServer = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/openapi.yaml") return new Response("not found", { status: 404 });
      return new Response([
        "openapi: 3.1.0",
        "info:",
        "  title: HTTP Endpoint API",
        "  version: 1.0.0",
        "paths:",
        "  /widgets:",
        "    post:",
        "      summary: Create HTTP widget",
        "      operationId: createHttpWidget",
        "      responses:",
        "        '201':",
        "          description: Widget created",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: '#/components/schemas/HttpWidget'",
        "components:",
        "  schemas:",
        "    HttpWidget:",
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
  return fixtureServer.url.origin;
}

function serveWebhookReceiver(received: unknown[]): string {
  fixtureServer?.stop(true);
  fixtureServer = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(await req.json());
      return new Response("ok");
    },
  });
  return fixtureServer.url.origin;
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
