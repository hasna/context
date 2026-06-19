#!/usr/bin/env node
import { createRequire } from "module";
import { getDatabase, getDbPath } from "../db/database.js";
import {
  createLibrary,
  listLibraries,
  searchLibraries,
  getLibraryBySlug,
  deleteLibrary,
} from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { handleMcpRequest, healthPayload } from "../mcp/http.js";
import { buildServer } from "../mcp/index.js";
import { listApiEndpoints } from "../db/api-endpoints.js";
import {
  embedText,
  embeddingCoverage,
  getEmbeddingConfig,
  semanticSearch,
} from "../db/embeddings.js";
import { listDocuments } from "../db/documents.js";
import { getRefreshPlan } from "../db/update-tasks.js";
import { parseExternalRetriever, type ExternalRetrieverType } from "../sources/refresh.js";
import { getLibraryDocsManifestArtifact, listDocumentArtifacts } from "../docs/artifacts.js";
import { generateWithAiSdk, getAiProviderStatuses } from "../ai/providers.js";
import type { AiProviderId } from "../ai/providers.js";
import { askDocs, buildDocsContext } from "../ai/docs-context.js";
import { listDocumentationSources } from "../sources/index.js";
import { getSourceReadinessReport } from "../sources/readiness.js";
import { refreshDocumentationSource } from "../sources/refresh.js";
import { getPublishReadinessReport } from "../publish/readiness.js";
import { runVerification } from "../verify/index.js";
import type { SeedSmokeGroup, VerificationOptions } from "../verify/index.js";
import { bootstrapSeedSources } from "../seeds/bootstrap.js";
import { selectSeedLibraries } from "../seeds/libraries.js";
import { embedLibraryChunks } from "../semantic/index.js";
import { runLiveUpdateCycle } from "../live/index.js";
import {
  addWebhookEndpoint,
  emitWebhookEvent,
  listWebhookDeliveries,
  listWebhookEndpoints,
  removeWebhookEndpoint,
} from "../db/webhooks.js";

const DEFAULT_PORT = 19431;
const DEFAULT_HOST = "127.0.0.1";
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

function printHelp(): void {
  console.log(`Usage: context-serve [options]

Start the open-context HTTP API server.

Options:
  -V, --version  output the version number
  -h, --help     display help for command

Environment:
  CONTEXT_PORT   Port to bind the HTTP server (default: ${DEFAULT_PORT})
  PORT           Fallback port variable
  CONTEXT_HOST   Host to bind (default: ${DEFAULT_HOST})
  CONTEXT_HTTP_TOKEN  Optional bearer token required for API routes except health
  CONTEXT_REQUIRE_HTTP_AUTH=true  Require auth even without a token configured
`);
}

function handleMetaArgs(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("-V") || args.includes("--version")) {
    console.log(pkg.version);
    return true;
  }

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return true;
  }

  return false;
}

function getPort(): number {
  const env = process.env["CONTEXT_PORT"] ?? process.env["PORT"];
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n)) return n;
  }
  return DEFAULT_PORT;
}

function getHost(): string {
  return process.env["CONTEXT_HOST"] ?? process.env["HOST"] ?? DEFAULT_HOST;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": getCorsOrigin(),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Context-Token",
  };
}

function getCorsOrigin(): string {
  return process.env["CONTEXT_CORS_ORIGIN"] ?? process.env["HASNA_CONTEXT_CORS_ORIGIN"] ?? `http://localhost:${getPort()}`;
}

function getHttpToken(): string | null {
  const token = process.env["CONTEXT_HTTP_TOKEN"] ?? process.env["HASNA_CONTEXT_HTTP_TOKEN"];
  return token?.trim() ? token.trim() : null;
}

function isHttpAuthRequired(): boolean {
  return getHttpToken() !== null || boolEnv("CONTEXT_REQUIRE_HTTP_AUTH") || boolEnv("HASNA_CONTEXT_REQUIRE_HTTP_AUTH");
}

function boolEnv(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function authenticateRequest(req: Request, path: string): Response | null {
  if (path === "/api/health") return null;
  if (!isHttpAuthRequired()) return null;

  const expected = getHttpToken();
  if (!expected) {
    return json({ error: "HTTP auth is required but CONTEXT_HTTP_TOKEN is not configured" }, 503);
  }

  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerToken = req.headers.get("x-context-token")?.trim();
  if (bearer === expected || headerToken === expected) return null;

  return json({ error: "Unauthorized" }, bearer || headerToken ? 403 : 401);
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const authResponse = authenticateRequest(req, path);
  if (authResponse) return authResponse;

  try {
    if (method === "GET" && path === "/health") {
      return json(healthPayload("context"));
    }
    if (path === "/mcp") {
      return handleMcpRequest(req, buildServer);
    }

    // GET /api/health
    if (method === "GET" && path === "/api/health") {
      return json({ status: "ok", db: getDbPath() });
    }

    // GET /api/libraries
    if (method === "GET" && path === "/api/libraries") {
      const q = url.searchParams.get("q");
      const libraries = q ? searchLibraries(q) : listLibraries();
      return json({ libraries });
    }

    // POST /api/libraries
    if (method === "POST" && path === "/api/libraries") {
      const body = (await req.json()) as {
        name: string;
        npm_package?: string;
        docs_url?: string;
        github_repo?: string;
        description?: string;
        source_type?: string;
        source_url?: string;
        version?: string;
        freshness_days?: number;
        priority?: number;
      };
      const library = createLibrary(body);
      return json({ library }, 201);
    }

    // GET /api/libraries/:slug
    const libSlugMatch = path.match(/^\/api\/libraries\/([^/]+)$/);
    if (method === "GET" && libSlugMatch) {
      const slug = libSlugMatch[1]!;
      const library = getLibraryBySlug(slug);
      return json({ library });
    }

    // DELETE /api/libraries/:slug
    if (method === "DELETE" && libSlugMatch) {
      const slug = libSlugMatch[1]!;
      const library = getLibraryBySlug(slug);
      deleteLibrary(library.id);
      return json({ deleted: true });
    }

    // POST /api/libraries/:slug/refresh
    // POST /api/libraries/:slug/crawl is kept as a compatibility alias.
    const refreshMatch = path.match(/^\/api\/libraries\/([^/]+)\/(refresh|crawl)$/);
    if (method === "POST" && refreshMatch) {
      const slug = refreshMatch[1]!;
      const library = getLibraryBySlug(slug);
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as {
            max_pages?: number;
            refresh?: boolean;
            write_files?: boolean;
            retriever?: string;
            retriever_only?: boolean;
            crawler?: string;
            embed?: boolean;
            embed_all?: boolean;
            embed_limit?: number | string;
          })
        : {};
      const result = await refreshDocumentationSource(library.id, {
        maxPages: body.max_pages ?? 30,
        refresh: body.refresh ?? false,
        writeFiles: body.write_files,
        retriever: parseRetriever(body.retriever ?? body.crawler),
        retrieverOnly: body.retriever_only,
        embed: body.embed,
        embedAll: body.embed_all,
        embedLimit: positiveInt(body.embed_limit, 0),
      });
      return json({ result });
    }

    // GET /api/libraries/:slug/docs
    const docsMatch = path.match(/^\/api\/libraries\/([^/]+)\/docs$/);
    if (method === "GET" && docsMatch) {
      const slug = docsMatch[1]!;
      const library = getLibraryBySlug(slug);
      const documents = listDocuments(library.id);
      const artifacts = listDocumentArtifacts(library.slug);
      const manifest = getLibraryDocsManifestArtifact(library.slug);
      return json({ library, documents, artifacts, manifest });
    }

    // GET /api/libraries/:slug/embeddings
    const embeddingsMatch = path.match(/^\/api\/libraries\/([^/]+)\/embeddings$/);
    if (method === "GET" && embeddingsMatch) {
      const slug = embeddingsMatch[1]!;
      const library = getLibraryBySlug(slug);
      return json({
        library,
        embeddings: embeddingCoverage(library.id),
      });
    }

    // POST /api/libraries/:slug/embed
    const embedMatch = path.match(/^\/api\/libraries\/([^/]+)\/embed$/);
    if (method === "POST" && embedMatch) {
      const slug = embedMatch[1]!;
      const library = getLibraryBySlug(slug);
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as EmbedRequestBody)
        : {};
      return json({
        report: await embedLibraryChunks(library.id, {
          all: body.all ?? false,
          limit: positiveInt(body.limit, 0),
        }),
      });
    }

    // GET /api/updates/plan?library=...
    if (method === "GET" && path === "/api/updates/plan") {
      const slug = url.searchParams.get("library") ?? undefined;
      return json({ plan: getRefreshPlan({ slug }) });
    }

    // POST /api/updates/plan
    if (method === "POST" && path === "/api/updates/plan") {
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as { library?: string; create_tasks?: boolean })
        : {};
      return json({
        plan: getRefreshPlan({
          slug: body.library,
          createTasks: body.create_tasks ?? true,
        }),
      });
    }

    // GET /api/live/cycle?plan_only=true&native_only=true&pages=10
    // GET is read-only and always returns a plan-only cycle.
    if (method === "GET" && path === "/api/live/cycle") {
      return json({
        cycle: await runLiveUpdateCycle({
          maxPages: positiveInt(url.searchParams.get("max_pages") ?? url.searchParams.get("pages"), 30),
          retriever: parseRetriever(url.searchParams.get("retriever") ?? url.searchParams.get("crawler")),
          planOnly: true,
          nativeOnly: boolParam(url.searchParams, "native_only", false),
          embed: boolParam(url.searchParams, "embed", false),
          embedAll: boolParam(url.searchParams, "embed_all", false),
          embedLimit: positiveInt(url.searchParams.get("embed_limit"), 0),
          refreshTimeoutMs: nonNegativeInt(url.searchParams.get("case_timeout_ms"), 45_000),
          createTasks: false,
        }),
      });
    }

    // POST /api/live/cycle
    if (method === "POST" && path === "/api/live/cycle") {
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as LiveCycleRequestBody)
        : {};
      return json({
        cycle: await runLiveUpdateCycle({
          maxPages: positiveInt(body.max_pages ?? body.pages, 30),
          retriever: parseRetriever(body.retriever ?? body.crawler),
          planOnly: body.plan_only ?? false,
          nativeOnly: body.native_only ?? false,
          embed: body.embed,
          embedAll: body.embed_all,
          embedLimit: positiveInt(body.embed_limit, 0),
          refreshTimeoutMs: nonNegativeInt(body.case_timeout_ms, 45_000),
          createTasks: body.create_tasks,
        }),
      });
    }

    // GET /api/endpoints?library=slug&q=...&method=POST&path=/v1/items&operation_id=...
    if (method === "GET" && path === "/api/endpoints") {
      const librarySlug = url.searchParams.get("library");
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      let libraryId: string | undefined;
      if (librarySlug) {
        const lib = getLibraryBySlug(librarySlug);
        libraryId = lib.id;
      }

      const endpoints = listApiEndpoints({
        libraryId,
        query: url.searchParams.get("q") ?? undefined,
        method: url.searchParams.get("method") ?? undefined,
        path: url.searchParams.get("path") ?? undefined,
        operationId: url.searchParams.get("operation_id") ?? url.searchParams.get("operation") ?? undefined,
        limit,
      });

      return json({ endpoints, count: endpoints.length });
    }

    // GET /api/search?q=...&library=...
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const librarySlug = url.searchParams.get("library");
      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
      const semantic = boolParam(url.searchParams, "semantic", false) ||
        url.searchParams.get("mode") === "semantic";

      let libraryId: string | undefined;
      if (librarySlug) {
        const lib = getLibraryBySlug(librarySlug);
        libraryId = lib.id;
      }

      if (semantic) {
        const config = getEmbeddingConfig();
        if (!config) {
          return json({ error: "Set CONTEXT_EMBEDDING_PROVIDER=openai|voyage to enable semantic search" }, 400);
        }
        const queryEmbedding = await embedText(q, config);
        const results = semanticSearch(queryEmbedding, libraryId, limit);
        return json({ results, query: q, mode: "semantic", model: config.model });
      }

      const results = searchChunks(q, libraryId, limit);
      return json({ results, query: q, mode: "fts" });
    }

    // GET /api/stats
    if (method === "GET" && path === "/api/stats") {
      const db = getDatabase();
      const libCount =
        db.get("SELECT COUNT(*) AS count FROM libraries")?.count ?? 0;
      const docCount =
        db.get("SELECT COUNT(*) AS count FROM documents")?.count ?? 0;
      const chunkCount =
        db.get("SELECT COUNT(*) AS count FROM chunks")?.count ?? 0;
      return json({ libraries: libCount, documents: docCount, chunks: chunkCount });
    }

    // GET /api/ai/status
    if (method === "GET" && path === "/api/ai/status") {
      return json({ backends: getAiProviderStatuses() });
    }

    // POST /api/ai/generate
    if (method === "POST" && path === "/api/ai/generate") {
      try {
        const body = (await req.json()) as AiGenerateRequestBody;
        const result = await generateWithAiSdk({
          prompt: body.prompt,
          provider: (body.provider ?? body.backend) as AiProviderId | undefined,
          model: body.model,
          system: body.system,
        });
        return json({ result });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    // POST /api/context/build
    if (method === "POST" && path === "/api/context/build") {
      const body = (await req.json()) as DocsContextRequestBody;
      return json({
        context: buildDocsContext({
          prompt: body.prompt,
          library: body.library,
          version: body.version,
          limit: positiveInt(body.limit, 5),
          endpointLimit: positiveInt(body.endpoint_limit, 5),
          maxTokens: positiveInt(body.tokens, 5000),
        }),
      });
    }

    // POST /api/ai/ask
    if (method === "POST" && path === "/api/ai/ask") {
      try {
        const body = (await req.json()) as DocsAskRequestBody;
        const result = await askDocs({
          prompt: body.prompt,
          library: body.library,
          version: body.version,
          limit: positiveInt(body.limit, 5),
          endpointLimit: positiveInt(body.endpoint_limit, 5),
          maxTokens: positiveInt(body.tokens, 5000),
          provider: (body.provider ?? body.backend) as AiProviderId | undefined,
          model: body.model,
          system: body.system,
        });
        return json({ result });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    // GET /api/publish/readiness?registry=true&latest=...
    if (method === "GET" && path === "/api/publish/readiness") {
      return json({
        report: await getPublishReadinessReport({
          includeRegistry: url.searchParams.get("registry") === "true",
          registryLatestVersion: url.searchParams.get("latest") ?? undefined,
        }),
      });
    }

    // GET|POST /api/verify/readiness
    // Shared CLI/SDK/MCP/HTTP readiness verifier. Read-only by default; optional
    // smoke flags use isolated temporary state and Firecrawl remains the default retriever.
    if ((method === "GET" || method === "POST") && (path === "/api/verify/readiness" || path === "/api/verify")) {
      const options = method === "GET"
        ? verificationOptionsFromSearch(url.searchParams)
        : verificationOptionsFromBody(
            req.headers.get("content-type")?.includes("application/json")
              ? await req.json()
              : {}
          );
      return json({ report: await runVerification(options) });
    }

    // GET /api/sources/readiness?library=...
    if (method === "GET" && path === "/api/sources/readiness") {
      return json({
        report: getSourceReadinessReport({
          slug: url.searchParams.get("library") ?? undefined,
        }),
      });
    }

    // GET /api/sources
    if (method === "GET" && path === "/api/sources") {
      return json({ sources: listDocumentationSources() });
    }

    // GET /api/seeds?groups=llm,saas&slugs=vercel-ai-sdk&limit=10
    if (method === "GET" && path === "/api/seeds") {
      const groups = parseSeedGroups(url.searchParams.get("groups"));
      const slugs = parseStringList(url.searchParams.get("slugs"));
      return json({
        seeds: selectSeedLibraries({
          groups: groups.length > 0 ? groups : undefined,
          slugs: slugs.length > 0 ? slugs : undefined,
          limit: nonNegativeInt(url.searchParams.get("limit"), 0),
        }),
      });
    }

    // POST /api/seeds
    if (method === "POST" && path === "/api/seeds") {
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as SeedBootstrapRequestBody)
        : {};
      const groups = parseSeedGroups(body.groups);
      const slugs = parseStringList(body.slugs);
      return json({
        report: await bootstrapSeedSources({
          groups: groups.length > 0 ? groups : undefined,
          slugs: slugs.length > 0 ? slugs : undefined,
          limit: nonNegativeInt(body.limit, 0),
          crawl: body.crawl ?? false,
          newOnly: body.new_only ?? false,
          maxPages: positiveInt(body.max_pages ?? body.pages, 10),
          retriever: parseRetriever(body.retriever ?? body.crawler),
          retrieverOnly: body.retriever_only,
          writeFiles: body.write_files,
          embed: body.embed,
          embedAll: body.embed_all,
          embedLimit: positiveInt(body.embed_limit, 0),
          openConnectorsPath: body.open_connectors_path,
          openConnectorsEnabledOnly: body.open_connectors_enabled_only,
          openConnectorsOnly: body.open_connectors_only,
        }),
      });
    }

    // GET /api/webhooks
    if (method === "GET" && path === "/api/webhooks") {
      return json({ endpoints: listWebhookEndpoints() });
    }

    // POST /api/webhooks
    if (method === "POST" && path === "/api/webhooks") {
      const body = (await req.json()) as WebhookEndpointRequestBody;
      const events = body.events === undefined ? undefined : parseStringList(body.events);
      return json({
        endpoint: addWebhookEndpoint({
          url: body.url,
          events,
          active: body.active ?? true,
        }),
      }, 201);
    }

    const webhookMatch = path.match(/^\/api\/webhooks\/([^/]+)$/);
    if (method === "DELETE" && webhookMatch) {
      removeWebhookEndpoint(webhookMatch[1]!);
      return json({ deleted: true });
    }

    // GET /api/webhooks/deliveries
    if (method === "GET" && path === "/api/webhooks/deliveries") {
      return json({ deliveries: listWebhookDeliveries() });
    }

    // POST /api/webhooks/test
    if (method === "POST" && path === "/api/webhooks/test") {
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as WebhookTestRequestBody)
        : {};
      return json({
        deliveries: await emitWebhookEvent(body.event ?? "docs.refreshed", {
          test: true,
          emitted_by: "context HTTP API",
          ...(body.payload ?? {}),
        }),
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof BadRequestError ? 400 : message.includes("not found") ? 404 : 500;
    return json({ error: message }, status);
  }
}

class BadRequestError extends Error {}

type VerificationRequestBody = {
  publish?: boolean;
  registry?: boolean;
  source_readiness?: boolean;
  smoke?: boolean;
  local_smoke?: boolean;
  external_smoke?: boolean;
  seed_smoke?: boolean | string | string[];
  required_smoke?: boolean | string | string[];
  required_corpus_smoke?: boolean | string | string[];
  required_live_smoke?: boolean | string | string[];
  required_live_groups?: string | string[];
  required_groups?: string | string[];
  seed_groups?: string | string[];
  seed_slugs?: string | string[];
  seed_limit?: number | string;
  seed_retriever?: string;
  retrievers?: string | string[];
  pages?: number | string;
  concurrency?: number | string;
  case_timeout_ms?: number | string;
  require_full_docs?: boolean;
  ai_smoke?: boolean | string;
};

type SeedBootstrapRequestBody = {
  groups?: string | string[];
  slugs?: string | string[];
  limit?: number | string;
  crawl?: boolean;
  new_only?: boolean;
  pages?: number | string;
  max_pages?: number | string;
  retriever?: string;
  crawler?: string;
  retriever_only?: boolean;
  write_files?: boolean;
  embed?: boolean;
  embed_all?: boolean;
  embed_limit?: number | string;
  open_connectors_path?: string;
  open_connectors_enabled_only?: boolean;
  open_connectors_only?: boolean;
};

type EmbedRequestBody = {
  all?: boolean;
  limit?: number | string;
};

type AiGenerateRequestBody = {
  prompt: string;
  provider?: string;
  backend?: string;
  model?: string;
  system?: string;
};

type DocsContextRequestBody = {
  prompt: string;
  library?: string;
  version?: string;
  limit?: number | string;
  endpoint_limit?: number | string;
  tokens?: number | string;
};

type DocsAskRequestBody = DocsContextRequestBody & {
  provider?: string;
  backend?: string;
  model?: string;
  system?: string;
};

type LiveCycleRequestBody = {
  pages?: number | string;
  max_pages?: number | string;
  retriever?: string;
  crawler?: string;
  plan_only?: boolean;
  native_only?: boolean;
  create_tasks?: boolean;
  case_timeout_ms?: number | string;
  embed?: boolean;
  embed_all?: boolean;
  embed_limit?: number | string;
};

type WebhookEndpointRequestBody = {
  url: string;
  events?: string | string[];
  active?: boolean;
};

type WebhookTestRequestBody = {
  event?: string;
  payload?: Record<string, unknown>;
};

function verificationOptionsFromSearch(params: URLSearchParams): VerificationOptions {
  const seedSmokeValue = params.get("seed_smoke");
  const requiredSmokeValue = params.get("required_smoke") ?? params.get("required_corpus_smoke");
  const requiredLiveSmokeValue = params.get("required_live_smoke");
  const hasRequiredGroups = params.has("required_groups");
  const hasRequiredLiveGroups = params.has("required_live_groups");
  const seedGroups = parseSeedGroups(params.get("seed_groups") ?? nonBooleanValue(seedSmokeValue));
  const requiredGroups = parseRequiredGroups(params.get("required_groups") ?? nonBooleanValue(requiredSmokeValue));
  const requiredLiveGroups = parseRequiredGroups(params.get("required_live_groups") ?? nonBooleanValue(requiredLiveSmokeValue));
  const seedSlugs = parseStringList(params.get("seed_slugs"));
  const retrievers = parseRetrievers(params.get("retrievers"));
  return {
    includePublish: boolParam(params, "publish", false),
    includeRegistry: boolParam(params, "registry", false),
    includeSourceReadiness: boolParam(params, "source_readiness", true),
    includeLocalSmoke: boolParam(params, "smoke", false) || boolParam(params, "local_smoke", false),
    includeSeedSmoke: boolParam(params, "seed_smoke", false) || seedGroups.length > 0 || seedSlugs.length > 0,
    includeRequiredCorpusSmoke: boolParam(params, "required_smoke", false) || boolParam(params, "required_corpus_smoke", false) || hasRequiredGroups,
    includeRequiredCorpusLiveUpdateSmoke: boolParam(params, "required_live_smoke", false) || hasRequiredLiveGroups,
    seedGroups: seedGroups.length > 0 ? seedGroups : undefined,
    requiredCorpusGroups: requiredGroups.length > 0 ? requiredGroups : undefined,
    requiredLiveUpdateGroups: requiredLiveGroups.length > 0 ? requiredLiveGroups : undefined,
    seedSlugs: seedSlugs.length > 0 ? seedSlugs : undefined,
    seedLimit: positiveInt(params.get("seed_limit"), 6),
    seedRetriever: parseRetriever(params.get("seed_retriever")),
    includeExternalSmoke: boolParam(params, "external_smoke", false),
    retrievers: retrievers.length > 0 ? retrievers : undefined,
    maxPages: positiveInt(params.get("pages"), 2),
    smokeConcurrency: positiveInt(params.get("concurrency"), 4),
    smokeCaseTimeoutMs: nonNegativeInt(params.get("case_timeout_ms"), 45_000),
    requireFullDocs: boolParam(params, "require_full_docs", false),
    aiSmoke: parseAiSmoke(params.get("ai_smoke")),
  };
}

function verificationOptionsFromBody(body: unknown): VerificationOptions {
  const input = (body ?? {}) as VerificationRequestBody;
  const seedGroups = parseSeedGroups(input.seed_groups ?? nonBooleanBodyValue(input.seed_smoke));
  const requiredSmokeValue = input.required_smoke ?? input.required_corpus_smoke;
  const requiredLiveSmokeValue = input.required_live_smoke;
  const hasRequiredGroups = input.required_groups !== undefined;
  const hasRequiredLiveGroups = input.required_live_groups !== undefined;
  const requiredGroups = parseRequiredGroups(input.required_groups ?? nonBooleanBodyValue(requiredSmokeValue));
  const requiredLiveGroups = parseRequiredGroups(input.required_live_groups ?? nonBooleanBodyValue(requiredLiveSmokeValue));
  const seedSlugs = parseStringList(input.seed_slugs);
  const retrievers = parseRetrievers(input.retrievers);
  return {
    includePublish: input.publish ?? false,
    includeRegistry: input.registry ?? false,
    includeSourceReadiness: input.source_readiness ?? true,
    includeLocalSmoke: Boolean(input.smoke ?? input.local_smoke),
    includeSeedSmoke: Boolean(input.seed_smoke) || seedGroups.length > 0 || seedSlugs.length > 0,
    includeRequiredCorpusSmoke: Boolean(requiredSmokeValue) || hasRequiredGroups,
    includeRequiredCorpusLiveUpdateSmoke: Boolean(requiredLiveSmokeValue) || hasRequiredLiveGroups,
    seedGroups: seedGroups.length > 0 ? seedGroups : undefined,
    requiredCorpusGroups: requiredGroups.length > 0 ? requiredGroups : undefined,
    requiredLiveUpdateGroups: requiredLiveGroups.length > 0 ? requiredLiveGroups : undefined,
    seedSlugs: seedSlugs.length > 0 ? seedSlugs : undefined,
    seedLimit: positiveInt(input.seed_limit, 6),
    seedRetriever: parseRetriever(input.seed_retriever),
    includeExternalSmoke: Boolean(input.external_smoke),
    retrievers: retrievers.length > 0 ? retrievers : undefined,
    maxPages: positiveInt(input.pages, 2),
    smokeConcurrency: positiveInt(input.concurrency, 4),
    smokeCaseTimeoutMs: nonNegativeInt(input.case_timeout_ms, 45_000),
    requireFullDocs: Boolean(input.require_full_docs),
    aiSmoke: parseAiSmoke(input.ai_smoke),
  };
}

function boolParam(params: URLSearchParams, key: string, defaultValue: boolean): boolean {
  const value = params.get(key);
  if (value === null) return defaultValue;
  return value === "" || ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseStringList(value: string | string[] | null | undefined): string[] {
  const values = Array.isArray(value) ? value : (value ?? "").split(",");
  return values.map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function parseSeedGroups(value: string | string[] | null | undefined): SeedSmokeGroup[] {
  return parseStringList(value).filter((item): item is SeedSmokeGroup =>
    item === "llm" || item === "saas" || item === "all"
  );
}

function parseRequiredGroups(value: string | string[] | null | undefined): SeedSmokeGroup[] {
  const groups = parseSeedGroups(value);
  return groups.length > 0 ? groups : ["all"];
}

function parseRetrievers(value: string | string[] | null | undefined): ExternalRetrieverType[] {
  return parseStringList(value).map((item) => parseRequiredRetriever(item));
}

function parseRetriever(value: string | null | undefined): ExternalRetrieverType | undefined {
  if (!value) return undefined;
  return parseRequiredRetriever(value);
}

function parseRequiredRetriever(value: string): ExternalRetrieverType {
  const retriever = parseExternalRetriever(value);
  if (!retriever) throw new BadRequestError(`Invalid retriever "${value}". Expected firecrawl or exa.`);
  return retriever;
}

function parseAiSmoke(value: boolean | string | null | undefined): AiProviderId | "default" | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === "string" && ["0", "false", "no", "off"].includes(value.toLowerCase())) return undefined;
  if (value === true || value === "" || value === "true" || value === "1") return "default";
  return value as AiProviderId;
}

function positiveInt(value: number | string | null | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: number | string | null | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonBooleanValue(value: string | null): string | undefined {
  if (!value || ["1", "0", "true", "false", "yes", "no", "on", "off"].includes(value.toLowerCase())) {
    return undefined;
  }
  return value;
}

function nonBooleanBodyValue(value: boolean | string | string[] | undefined): string | string[] | undefined {
  return typeof value === "boolean" ? undefined : value;
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function startServer(port = getPort(), hostname = getHost()): ReturnType<typeof Bun.serve> {
  if (!isLocalHost(hostname) && !getHttpToken()) {
    throw new Error("Refusing to bind context-serve to a non-local host without CONTEXT_HTTP_TOKEN.");
  }

  const server = Bun.serve({
    hostname,
    port,
    fetch: handleRequest,
  });

  console.log(`context server running on http://${hostname}:${port}`);
  console.log(`db: ${getDbPath()}`);
  return server;
}

if (import.meta.main) {
  if (handleMetaArgs()) {
    process.exit(0);
  }
  startServer();
}
