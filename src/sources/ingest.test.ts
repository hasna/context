import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { resetDatabase } from "../db/database.js";
import { createLibrary } from "../db/libraries.js";
import { ingestNativeSource } from "./ingest.js";

let server: Server | null = null;
let oldLlmsFullTimeout: string | undefined;

beforeEach(() => {
  oldLlmsFullTimeout = process.env["CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS"];
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
  if (oldLlmsFullTimeout === undefined) delete process.env["CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS"];
  else process.env["CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS"] = oldLlmsFullTimeout;
});

describe("ingestNativeSource", () => {
  it("crawls website sources from same-origin HTML links", async () => {
    const baseUrl = serveText({
      "/docs": `
        <html><head><title>Example Docs</title></head>
        <body>
          <main>
            <h1>Example Docs</h1>
            <p>Example documentation explains installation and authentication workflows.</p>
            <a href="/docs/install">Install</a>
          </main>
        </body></html>
      `,
      "/docs/install": `
        <html><body><main>
          <h1>Install</h1>
          <p>Install the package, configure the token, and run the client.</p>
        </main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Example Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 2 });

    expect(pages).toHaveLength(2);
    expect(pages?.[0]?.title).toBe("Example Docs");
    expect(pages?.[1]?.title).toBe("Install");
    expect(pages?.[1]?.text).toContain("configure the token");
  });

  it("skips optional discovery probes for tiny API smoke budgets", async () => {
    const requested: string[] = [];
    const baseUrl = serveText({
      "/docs": `
        <html><head><title>Fast Docs</title></head>
        <body><main><h1>Fast Docs</h1><p>Fast source smoke fetches the declared docs URL first.</p></main></body></html>
      `,
      "/robots.txt": "Sitemap: /sitemap.xml",
      "/sitemap.xml": "<urlset><url><loc>/docs/extra</loc></url></urlset>",
      "/llms.txt": "# Optional llms\n\nOptional discovery should not run for tiny smoke budgets.",
      "/llms-full.txt": "# Optional full docs\n\nOptional discovery should not run for tiny smoke budgets.",
    }, (path) => requested.push(path));
    const library = createLibrary({
      name: "Fast Docs",
      docs_url: `${baseUrl}/docs`,
      source_type: "api",
    });

    const pages = await ingestNativeSource(library, { maxPages: 2 });

    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.url).toBe(`${baseUrl}/docs`);
    expect(requested).toEqual(["/docs"]);
  });

  it("discovers same-scope pages from sitemap.xml", async () => {
    const baseUrl = serveText({
      "/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/docs/advanced</loc></url>
          <url><loc>/blog/not-docs</loc></url>
        </urlset>`,
      "/docs": `
        <html><head><title>Sitemap Docs</title></head>
        <body><main><h1>Sitemap Docs</h1><p>Entry page without direct links.</p></main></body></html>
      `,
      "/docs/advanced": `
        <html><body><main>
          <h1>Advanced</h1>
          <p>Advanced sitemap-discovered docs cover refresh planning and source indexing.</p>
        </main></body></html>
      `,
      "/blog/not-docs": `
        <html><body><main><h1>Blog</h1><p>This page is outside the docs scope.</p></main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Sitemap Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 3 });

    expect(pages).toHaveLength(2);
    expect(pages?.map((page) => page.title)).toEqual(["Sitemap Docs", "Advanced"]);
    expect(pages?.[1]?.metadata?.["source_role"]).toBe("sitemap_page");
  });

  it("skips low-signal news and blog pages during native docs discovery", async () => {
    const baseUrl = serveText({
      "/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/api/create</loc></url>
          <url><loc>/news/release-notes</loc></url>
          <url><loc>/blog/launch</loc></url>
          <url><loc>/quick_start/agent_integrations/example-agent</loc></url>
          <url><loc>/zh-cn/api/create</loc></url>
        </urlset>`,
      "/": `
        <html><head><title>API Docs</title></head>
        <body><main><h1>API Docs</h1><p>API docs entry page.</p></main></body></html>
      `,
      "/api/create": `
        <html><body><main>
          <h1>Create</h1>
          <p>Create API documentation covers requests, responses, authentication, and source indexing.</p>
        </main></body></html>
      `,
      "/news/release-notes": `
        <html><body><main><h1>News</h1><p>News should not consume docs crawl budget.</p></main></body></html>
      `,
      "/blog/launch": `
        <html><body><main><h1>Blog</h1><p>Blog should not consume docs crawl budget.</p></main></body></html>
      `,
      "/quick_start/agent_integrations/example-agent": `
        <html><body><main><h1>Agent</h1><p>Agent catalog pages should not consume core API docs crawl budget.</p></main></body></html>
      `,
      "/zh-cn/api/create": `
        <html><body><main><h1>Create Chinese</h1><p>Alternate locale pages should not duplicate the English docs crawl.</p></main></body></html>
      `,
    });
    const library = createLibrary({
      name: "API Docs",
      docs_url: `${baseUrl}/`,
      source_type: "api",
    });

    const pages = await ingestNativeSource(library, { maxPages: 4 });

    expect(pages?.map((page) => page.url)).toEqual([
      `${baseUrl}/`,
      `${baseUrl}/api/create`,
    ]);
  });

  it("discovers sitemap URLs declared in robots.txt", async () => {
    const baseUrl = serveText({
      "/robots.txt": "User-agent: *\nAllow: /\nSitemap: /docs-map.xml\n",
      "/docs-map.xml": `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/docs/robots-page</loc></url>
        </urlset>`,
      "/docs": `
        <html><head><title>Robots Docs</title></head>
        <body><main><h1>Robots Docs</h1><p>Entry page without sitemap links.</p></main></body></html>
      `,
      "/docs/robots-page": `
        <html><body><main>
          <h1>Robots Page</h1>
          <p>Robots sitemap discovery found this documentation page.</p>
        </main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Robots Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 3 });

    expect(pages).toHaveLength(2);
    expect(pages?.map((page) => page.title)).toEqual(["Robots Docs", "Robots Page"]);
    expect(pages?.[1]?.metadata?.["source_role"]).toBe("sitemap_page");
  });

  it("auto-discovers llms.txt for website sources", async () => {
    const baseUrl = serveText({
      "/llms.txt": "# AI Docs\n\n- [Guide](/docs/guide.md)",
      "/docs": `
        <html><head><title>AI Docs</title></head>
        <body><main><h1>AI Docs</h1><p>Entry page without markdown links.</p></main></body></html>
      `,
      "/docs/guide.md": "# Guide\n\nGuide content discovered through auto llms.txt discovery.",
    });
    const library = createLibrary({
      name: "AI Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 3 });

    expect(pages).toHaveLength(3);
    expect(pages?.map((page) => page.title)).toEqual(["AI Docs", "AI Docs", "Guide"]);
    expect(pages?.[1]?.metadata?.["source_role"]).toBe("llms_txt");
    expect(pages?.[2]?.text).toContain("auto llms.txt discovery");
  });

  it("ingests llms.txt and linked markdown docs", async () => {
    const baseUrl = serveText({
      "/llms.txt": "# Example Docs\n\n- [Intro](./intro.md)\n- [API](/api.md)",
      "/intro.md": "# Intro\n\nUse the Example SDK to create and update resources.",
      "/api.md": "# API\n\nCall the Example REST API with authenticated requests.",
    });
    const library = createLibrary({
      name: "Example",
      source_type: "llms_txt",
      source_url: `${baseUrl}/llms.txt`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 3 });

    expect(pages).toHaveLength(3);
    expect(pages?.[0]?.url).toBe(`${baseUrl}/llms.txt`);
    expect(pages?.[0]?.metadata?.["llms_links_total"]).toBe(2);
    expect(pages?.[0]?.metadata?.["llms_links_fetched"]).toBe(2);
    expect(pages?.[0]?.metadata?.["llms_links_failed"]).toBe(0);
    expect(pages?.[0]?.metadata?.["full_docs_mode"]).toBe("llms_manifest_links");
    expect(pages?.[0]?.metadata?.["full_docs_complete"]).toBe(true);
    expect(pages?.[1]?.title).toBe("Intro");
    expect(pages?.[2]?.title).toBe("API");
  });

  it("uses sibling llms-full.txt instead of fetching manifest links when available", async () => {
    const requested: string[] = [];
    const baseUrl = serveText({
      "/llms.txt": "# Example Docs\n\n- [Intro](./intro.md)",
      "/llms-full.txt": "# Example Full Docs\n\nFull documentation contains installation, authentication, streaming, tools, agents, and provider integration reference material.",
      "/intro.md": "# Intro\n\nIntro documentation explains quickstart setup.",
    }, (path) => requested.push(path));
    const library = createLibrary({
      name: "Example",
      source_type: "llms_txt",
      source_url: `${baseUrl}/llms.txt`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 3 });

    expect(pages).toHaveLength(2);
    expect(pages?.[0]?.metadata?.["source_role"]).toBe("manifest");
    expect(pages?.[1]?.url).toBe(`${baseUrl}/llms-full.txt`);
    expect(pages?.[1]?.metadata?.["source_role"]).toBe("llms_full_txt");
    expect(requested).not.toContain("/intro.md");
  });

  it("treats large inline llms.txt corpora as full docs", async () => {
    const inlineFull = [
      "===/overview===",
      "# Inline Full Docs",
      "",
      "Inline full documentation explains authentication, chat completions, streaming, models, tool use, structured outputs, and agent workflows.",
      "x".repeat(100_000),
    ].join("\n");
    const baseUrl = serveText({
      "/llms.txt": inlineFull,
    });
    const library = createLibrary({
      name: "Inline Full",
      source_type: "llms_txt",
      source_url: `${baseUrl}/llms.txt`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 2 });

    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.metadata?.["full_docs_mode"]).toBe("llms_txt_inline_full");
    expect(pages?.[0]?.metadata?.["full_docs_complete"]).toBe(true);
  });

  it("discovers scoped llms-full.txt next to scoped llms.txt sources", async () => {
    const baseUrl = serveText({
      "/docs/llms.txt": "# Scoped Docs\n\n- [Guide](./guide.md)",
      "/docs/llms-full.txt": "# Scoped Full Docs\n\nScoped full documentation contains API references, SDK guides, deployment notes, webhook handling, and search examples.",
      "/docs/guide.md": "# Scoped Guide\n\nScoped guide documentation explains source-local links.",
    });
    const library = createLibrary({
      name: "Scoped",
      source_type: "llms_txt",
      source_url: `${baseUrl}/docs/llms.txt`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 2 });

    expect(pages).toHaveLength(2);
    expect(pages?.[0]?.url).toBe(`${baseUrl}/docs/llms.txt`);
    expect(pages?.[1]?.url).toBe(`${baseUrl}/docs/llms-full.txt`);
    expect(pages?.[1]?.metadata?.["source_role"]).toBe("llms_full_txt");
  });

  it("falls back to manifest links when optional llms-full.txt is slow", async () => {
    process.env["CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS"] = "10";
    const requested: string[] = [];
    const baseUrl = serveText({
      "/llms.txt": "# Example Docs\n\n- [Guide](./guide.md)",
      "/llms-full.txt": async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "# Slow Full Docs\n\nSlow optional full docs should not block fallback ingestion.";
      },
      "/guide.md": "# Guide\n\nverify-slow-full-fallback-token documents fallback linked docs ingestion.",
    }, (path) => requested.push(path));
    const library = createLibrary({
      name: "Slow Full",
      source_type: "llms_txt",
      source_url: `${baseUrl}/llms.txt`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 3 });

    expect(pages).toHaveLength(2);
    expect(pages?.[1]?.url).toBe(`${baseUrl}/guide.md`);
    expect(pages?.[1]?.metadata?.["source_role"]).toBe("linked_doc");
    expect(requested).toContain("/llms-full.txt");
    expect(requested).toContain("/guide.md");
  });

  it("aborts native llms.txt fetches when the smoke case is cancelled", async () => {
    const baseUrl = serveText({
      "/llms.txt": async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "# Slow Manifest\n\nSlow docs should be cancelled by the caller.";
      },
    });
    const library = createLibrary({
      name: "Abortable Docs",
      source_type: "llms_txt",
      source_url: `${baseUrl}/llms.txt`,
    });
    const controller = new AbortController();
    const pending = ingestNativeSource(library, { maxPages: 1, signal: controller.signal });

    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toThrow(/Aborted fetching/);
  });

  it("renders OpenAPI JSON specs as searchable markdown", async () => {
    const baseUrl = serveText({
      "/openapi.json": JSON.stringify({
        openapi: "3.1.0",
        info: {
          title: "Example API",
          version: "2026-06-16",
          description: "API for Example resources.",
        },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/users": {
            get: {
              summary: "List users",
              operationId: "listUsers",
              parameters: [
                { name: "limit", in: "query", description: "Maximum users to return" },
              ],
              responses: {
                "200": { description: "Users returned" },
              },
            },
          },
        },
      }),
    });
    const library = createLibrary({
      name: "Example API",
      docs_url: `${baseUrl}/openapi.json`,
    });

    const pages = await ingestNativeSource(library);

    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.title).toBe("Example API");
    expect(pages?.[0]?.metadata?.["full_docs_complete"]).toBe(true);
    expect(pages?.[0]?.metadata?.["full_docs_mode"]).toBe("openapi_spec");
    expect(pages?.[0]?.text).toContain("### GET /users");
    expect(pages?.[0]?.text).toContain("Operation ID: listUsers");
    expect(pages?.[0]?.text).toContain("limit (query)");
    expect(pages?.[0]?.text).toContain("200: Users returned");
  });

  it("renders OpenAPI YAML specs as searchable markdown", async () => {
    const baseUrl = serveText({
      "/openapi.yaml": [
        "openapi: 3.1.0",
        "info:",
        "  title: Example YAML API",
        "  version: 2026-06-16",
        "  description: API for YAML-backed Example resources.",
        "servers:",
        "  - url: https://api.example.com",
        "paths:",
        "  /widgets:",
        "    post:",
        "      summary: Create widget",
        "      operationId: createWidget",
        "      parameters:",
        "        - name: workspace_id",
        "          in: query",
        "          required: true",
        "          description: Workspace identifier",
        "      requestBody:",
        "        required: true",
        "        description: Widget create payload",
        "      responses:",
        "        '201':",
        "          description: Widget created",
      ].join("\n"),
    });
    const library = createLibrary({
      name: "Example YAML API",
      docs_url: `${baseUrl}/openapi.yaml`,
    });

    const pages = await ingestNativeSource(library);

    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.title).toBe("Example YAML API");
    expect(pages?.[0]?.metadata?.["source_format"]).toBe("yaml");
    expect(pages?.[0]?.text).toContain("### POST /widgets");
    expect(pages?.[0]?.text).toContain("Operation ID: createWidget");
    expect(pages?.[0]?.text).toContain("workspace_id (query, required)");
    expect(pages?.[0]?.text).toContain("Request body (required): Widget create payload");
    expect(pages?.[0]?.text).toContain("201: Widget created");
  });

  it("resolves OpenAPI component schemas into endpoint metadata and markdown", async () => {
    const baseUrl = serveText({
      "/openapi.yaml": [
        "openapi: 3.1.0",
        "info:",
        "  title: Schema API",
        "  version: 1.0.0",
        "paths:",
        "  /widgets:",
        "    post:",
        "      summary: Create widget",
        "      operationId: createSchemaWidget",
        "      parameters:",
        "        - name: mode",
        "          in: query",
        "          schema:",
        "            type: string",
        "            enum: [draft, live]",
        "      requestBody:",
        "        required: true",
        "        content:",
        "          application/json:",
        "            schema:",
        "              $ref: '#/components/schemas/WidgetCreate'",
        "      responses:",
        "        '201':",
        "          description: Widget created",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: '#/components/schemas/Widget'",
        "components:",
        "  schemas:",
        "    WidgetCreate:",
        "      type: object",
        "      required: [name]",
        "      properties:",
        "        name:",
        "          type: string",
        "          description: Display name",
        "        metadata:",
        "          type: object",
        "    Widget:",
        "      type: object",
        "      required: [id, name]",
        "      properties:",
        "        id:",
        "          type: string",
        "        name:",
        "          type: string",
      ].join("\n"),
    });
    const library = createLibrary({
      name: "Schema API",
      docs_url: `${baseUrl}/openapi.yaml`,
    });

    const pages = await ingestNativeSource(library);
    const endpoints = pages?.[0]?.metadata?.["openapi_endpoints"] as Array<{
      request_body?: { schemas?: Record<string, { name?: string; required?: string[]; properties?: Array<{ name: string; required: boolean }> }> };
      responses?: Record<string, { schemas?: Record<string, { name?: string; required?: string[] }> }>;
      parameters?: Array<{ name: string; schema?: { type?: string; enum?: string[] } }>;
      content: string;
    }>;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.name).toBe("WidgetCreate");
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.required).toContain("name");
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.properties?.[0]).toMatchObject({
      name: "name",
      required: true,
    });
    expect(endpoints[0]?.responses?.["201"]?.schemas?.["application/json"]?.name).toBe("Widget");
    expect(endpoints[0]?.parameters?.[0]?.schema?.enum).toEqual(["draft", "live"]);
    expect(endpoints[0]?.content).toContain("application/json: WidgetCreate; object; required: name");
    expect(endpoints[0]?.content).toContain("name (required): string - Display name");
    expect(pages?.[0]?.text).toContain("Operation ID: createSchemaWidget");
  });

  it("resolves same-origin external OpenAPI schema refs", async () => {
    const baseUrl = serveText({
      "/openapi.yaml": [
        "openapi: 3.1.0",
        "info:",
        "  title: External Schema API",
        "  version: 1.0.0",
        "paths:",
        "  /widgets:",
        "    post:",
        "      operationId: createExternalWidget",
        "      requestBody:",
        "        required: true",
        "        content:",
        "          application/json:",
        "            schema:",
        "              $ref: './schemas.yaml#/components/schemas/ExternalWidgetCreate'",
        "      responses:",
        "        '201':",
        "          description: Widget created",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: './schemas.yaml#/components/schemas/ExternalWidget'",
      ].join("\n"),
      "/schemas.yaml": [
        "components:",
        "  schemas:",
        "    ExternalWidgetCreate:",
        "      type: object",
        "      required: [name]",
        "      properties:",
        "        name:",
        "          type: string",
        "          description: External display name",
        "    ExternalWidget:",
        "      type: object",
        "      required: [id]",
        "      properties:",
        "        id:",
        "          type: string",
      ].join("\n"),
    });
    const library = createLibrary({
      name: "External Schema API",
      docs_url: `${baseUrl}/openapi.yaml`,
    });

    const pages = await ingestNativeSource(library);
    const endpoints = pages?.[0]?.metadata?.["openapi_endpoints"] as Array<{
      request_body?: { schemas?: Record<string, { name?: string; required?: string[]; properties?: Array<{ name: string; description?: string }> }> };
      responses?: Record<string, { schemas?: Record<string, { name?: string }> }>;
      content: string;
    }>;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.name).toBe("ExternalWidgetCreate");
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.required).toContain("name");
    expect(endpoints[0]?.request_body?.schemas?.["application/json"]?.properties?.[0]).toMatchObject({
      name: "name",
      description: "External display name",
    });
    expect(endpoints[0]?.responses?.["201"]?.schemas?.["application/json"]?.name).toBe("ExternalWidget");
    expect(endpoints[0]?.content).toContain("application/json: ExternalWidgetCreate; object; required: name");
    expect(pages?.[0]?.text).toContain("ExternalWidgetCreate");
  });

  it("renders npm registry package READMEs as source pages", async () => {
    const baseUrl = serveText({
      "/registry/example": JSON.stringify({
        name: "example",
        description: "Example package for docs ingestion.",
        readme: "# Example Package\n\nUse this package to create widgets and automate workflows.",
        "dist-tags": { latest: "1.2.3" },
        versions: {
          "1.2.3": {
            version: "1.2.3",
            description: "Latest example package.",
            homepage: "https://example.com",
            repository: { url: "https://github.com/example/example" },
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

    const pages = await ingestNativeSource(library);

    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.metadata?.["source_type"]).toBe("npm");
    expect(pages?.[0]?.text).toContain("Version: 1.2.3");
    expect(pages?.[0]?.text).toContain("Use this package to create widgets");
  });

  it("uses direct source URLs for GitHub-style documentation sources", async () => {
    const baseUrl = serveText({
      "/README.md": "# Repo Docs\n\nRepository documentation covers setup, build, and release workflows.",
    });
    const library = createLibrary({
      name: "Repo Docs",
      source_type: "github",
      source_url: `${baseUrl}/README.md`,
    });

    const pages = await ingestNativeSource(library, { maxPages: 1 });

    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.title).toBe("Repo Docs");
    expect(pages?.[0]?.text).toContain("release workflows");
  });
});

type TextRoute = string | (() => string | Response | Promise<string | Response>);

function serveText(routes: Record<string, TextRoute>, onRequest?: (path: string) => void): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      onRequest?.(url.pathname);
      const route = routes[url.pathname];
      if (route === undefined) return new Response("not found", { status: 404 });
      const body = typeof route === "function" ? await route() : route;
      if (body instanceof Response) return body;
      return new Response(body, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    },
  });
  return server.url.origin;
}
