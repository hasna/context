import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchLibraries,
  getLibraryBySlug,
  resolveLibraryReference,
  listLibraries,
  createLibrary,
} from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { listApiEndpoints } from "../db/api-endpoints.js";
import {
  refreshDocumentationSource,
  getDefaultExternalRetriever,
  type ExternalRetrieverType,
} from "../sources/refresh.js";
import { getLinks } from "../db/links.js";
import { getRelatedNodes } from "../db/kg.js";
import { listDocuments } from "../db/documents.js";
import { getRefreshPlan } from "../db/update-tasks.js";
import { getLibraryDocsManifestArtifact, listDocumentArtifacts } from "../docs/artifacts.js";
import { listDocumentationSources } from "../sources/index.js";
import { getSourceReadinessReport } from "../sources/readiness.js";
import { runVerification } from "../verify/index.js";
import type { SeedSmokeGroup, VerificationOptions } from "../verify/index.js";
import {
  embeddingCoverage,
  getEmbeddingConfig,
  embedText,
  semanticSearch,
} from "../db/embeddings.js";
import { bootstrapSeedSources } from "../seeds/bootstrap.js";
import type { SeedLibraryGroup } from "../seeds/libraries.js";
import { embedLibraryChunks } from "../semantic/index.js";
import { runLiveUpdateCycle } from "../live/index.js";
import { askDocs, buildDocsContext } from "../ai/docs-context.js";
import type { AiProviderId } from "../ai/providers.js";
import {
  addWebhookEndpoint,
  emitWebhookEvent,
  listWebhookDeliveries,
  listWebhookEndpoints,
  removeWebhookEndpoint,
} from "../db/webhooks.js";

export function registerLibraryTools(server: McpServer): void {
  // ─── resolve-library-id ───────────────────────────────────────────────────────

  server.tool(
    "resolve-library-id",
    `Search the local documentation index for a library and return its ID.
Use this before query-docs to get the correct library ID.
Returns matching libraries with IDs, descriptions, and links.`,
    {
      libraryName: z
        .string()
        .describe("Library name to search for (e.g. 'react', 'express', 'numpy')"),
      version: z.string().optional().describe("Optional version to prefer or require (e.g. '18' or '18.2.0')"),
    },
    async ({ libraryName, version }) => {
      try {
        const results = searchLibraries(version ? `${libraryName} ${version}` : libraryName, 5);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No libraries found matching "${libraryName}".\nRun: context add "${libraryName}" to index it, or context seed to populate popular libraries.`,
              },
            ],
          };
        }

        const formatted = results
          .map((lib) => {
            const links = getLinks(lib.id);
            const lines = [
              `- Library ID: /context/${lib.slug}`,
              `  Name: ${lib.name}`,
            ];
            if (lib.description) lines.push(`  Description: ${lib.description}`);
            if (lib.npm_package) lines.push(`  npm: ${lib.npm_package}`);
            if (lib.version) lines.push(`  Version: ${lib.version}`);
            lines.push(`  Source: ${lib.source_type}${lib.source_url ? ` (${lib.source_url})` : ""}`);
            lines.push(`  Freshness: ${lib.freshness_days} days`);

            const docsLink = links.find((l) => l.type === "docs") ?? links.find((l) => l.type === "api");
            if (docsLink) lines.push(`  Docs: ${docsLink.url}`);
            if (lib.github_repo) lines.push(`  GitHub: https://github.com/${lib.github_repo}`);

            lines.push(
              `  Indexed: ${lib.chunk_count > 0 ? `${lib.chunk_count} chunks from ${lib.document_count} pages` : "not yet indexed"}`
            );
            return lines.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} matching librar${results.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── query-docs ───────────────────────────────────────────────────────────────

  server.tool(
    "build-docs-context",
    "Build a read-only documentation context pack for a prompt using indexed docs and API endpoints.",
    {
      prompt: z.string().describe("Question or task to build context for"),
      libraryId: z.string().optional().describe("Optional library slug or /context/<slug> ID"),
      version: z.string().optional().describe("Optional indexed library version to require"),
      limit: z.number().optional().default(5).describe("Maximum documentation chunks"),
      endpoint_limit: z.number().optional().default(5).describe("Maximum API endpoints"),
      tokens: z.number().optional().default(5000).describe("Approximate context token budget"),
      json: z.boolean().optional().default(false).describe("Return raw JSON instead of Markdown text"),
    },
    async ({ prompt, libraryId, version, limit = 5, endpoint_limit = 5, tokens = 5000, json = false }) => {
      try {
        const context = buildDocsContext({
          prompt,
          library: libraryId?.replace(/^\/context\//, "").trim(),
          version,
          limit,
          endpointLimit: endpoint_limit,
          maxTokens: tokens,
        });
        return {
          content: [
            {
              type: "text",
              text: json ? JSON.stringify(context, null, 2) : context.context_text,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "ask-docs",
    "Answer a prompt using indexed documentation context and the configured AI SDK backend.",
    {
      prompt: z.string().describe("Question or task to answer"),
      libraryId: z.string().optional().describe("Optional library slug or /context/<slug> ID"),
      version: z.string().optional().describe("Optional indexed library version to require"),
      limit: z.number().optional().default(5).describe("Maximum documentation chunks"),
      endpoint_limit: z.number().optional().default(5).describe("Maximum API endpoints"),
      tokens: z.number().optional().default(5000).describe("Approximate context token budget"),
      backend: z.string().optional().describe("AI SDK backend id"),
      model: z.string().optional().describe("Model id"),
      system: z.string().optional().describe("System prompt"),
      json: z.boolean().optional().default(false).describe("Return raw JSON instead of answer text"),
    },
    async ({ prompt, libraryId, version, limit = 5, endpoint_limit = 5, tokens = 5000, backend, model, system, json = false }) => {
      try {
        const result = await askDocs({
          prompt,
          library: libraryId?.replace(/^\/context\//, "").trim(),
          version,
          limit,
          endpointLimit: endpoint_limit,
          maxTokens: tokens,
          provider: backend as AiProviderId | undefined,
          model,
          system,
        });
        return {
          content: [
            {
              type: "text",
              text: json ? JSON.stringify(result, null, 2) : result.text,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "query-docs",
    `Fetch relevant documentation chunks for a library.
Uses FTS5 full-text search, with semantic search as fallback when embeddings are available.
Provide a specific topic or query to get the most relevant chunks.`,
    {
      context7CompatibleLibraryID: z
        .string()
        .describe("Library ID from resolve-library-id (e.g. '/context/react' or 'react')"),
      tokens: z
        .number()
        .optional()
        .default(5000)
        .describe("Max tokens to return (default: 5000)"),
      topic: z
        .string()
        .optional()
        .describe("Specific topic or query to search within the library docs"),
      version: z.string().optional().describe("Optional indexed library version to require"),
    },
    async ({ context7CompatibleLibraryID, tokens = 5000, topic, version }) => {
      try {
        const slug = context7CompatibleLibraryID
          .replace(/^\/context\//, "")
          .replace(/^\//, "")
          .trim();

        const library = resolveLibraryReference(slug, { version });

        if (library.chunk_count === 0) {
          const links = getLinks(library.id);
          const docsUrl = links.find((l) => l.type === "docs")?.url ?? library.docs_url;
          return {
            content: [
              {
                type: "text",
                text: `Library "${library.name}" has no indexed documentation yet.\n` +
                  (docsUrl ? `Official docs: ${docsUrl}\n` : "") +
                  `Run: context add ${slug}  (or: context refresh ${slug})`,
              },
            ],
          };
        }

        const query = topic ?? library.name;
        const maxChunks = Math.ceil(tokens / 300);

        // Try semantic search first if available
        const embConfig = getEmbeddingConfig();
        let results;

        if (embConfig) {
          try {
            const queryVec = await embedText(query, embConfig);
            const semantic = semanticSearch(queryVec, library.id, maxChunks);
            // Merge with FTS5 results for hybrid ranking
            const fts = searchChunks(query, library.id, maxChunks);
            const seen = new Set<string>();
            results = [];
            for (const r of [...semantic.slice(0, Math.ceil(maxChunks * 0.6)), ...fts]) {
              if (seen.has(r.chunk_id)) continue;
              seen.add(r.chunk_id);
              results.push(r);
              if (results.length >= maxChunks) break;
            }
          } catch {
            results = searchChunks(query, library.id, maxChunks);
          }
        } else {
          results = searchChunks(query, library.id, maxChunks);
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No documentation found for "${query}" in ${library.name}. The library has ${library.chunk_count} chunks — try a different query.`,
              },
            ],
          };
        }

        const links = getLinks(library.id);
        let output = `# ${library.name} Documentation\n`;
        if (library.version) output += `Version: ${library.version}\n`;
        const docsLink = links.find((l) => l.type === "docs") ?? links.find((l) => l.type === "api");
        if (docsLink) output += `Source: ${docsLink.url}\n`;
        output += "\n";

        let totalTokens = 0;
        for (const result of results) {
          const chunkTokens = Math.ceil(result.content.length / 4);
          if (totalTokens + chunkTokens > tokens) break;

          if (result.title || result.url) {
            output += `---\n`;
            if (result.title) output += `### ${result.title}\n`;
            if (result.url) output += `Source: ${result.url}\n`;
            output += "\n";
          }

          output += result.content + "\n\n";
          totalTokens += chunkTokens;
        }

        return { content: [{ type: "text", text: output.trim() }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "query-api-endpoints",
    "List or search indexed OpenAPI endpoints for a documentation source.",
    {
      libraryId: z.string().describe("Library slug or /context/<slug> ID"),
      query: z.string().optional().describe("Full-text endpoint query"),
      method: z.string().optional().describe("HTTP method filter such as GET or POST"),
      path: z.string().optional().describe("Exact API path filter such as /v1/messages"),
      operation_id: z.string().optional().describe("Exact OpenAPI operationId filter"),
      limit: z.number().optional().default(20).describe("Maximum endpoints to return"),
      json: z.boolean().optional().default(false).describe("Return raw JSON instead of Markdown"),
    },
    async ({ libraryId, query, method, path, operation_id, limit = 20, json = false }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").replace(/^\//, "").trim();
        const library = getLibraryBySlug(slug);
        const endpoints = listApiEndpoints({
          libraryId: library.id,
          query,
          method,
          path,
          operationId: operation_id,
          limit,
        });

        if (json) {
          return {
            content: [{ type: "text", text: JSON.stringify({ library, endpoints }, null, 2) }],
          };
        }

        if (endpoints.length === 0) {
          return {
            content: [{ type: "text", text: `No API endpoints found for ${library.name}.` }],
          };
        }

        let output = `# ${library.name} API Endpoints\n\n`;
        for (const endpoint of endpoints) {
          output += `## ${endpoint.method} ${endpoint.path}\n`;
          if (endpoint.operation_id) output += `Operation ID: ${endpoint.operation_id}\n`;
          if (endpoint.summary) output += `${endpoint.summary}\n`;
          if (endpoint.tags.length) output += `Tags: ${endpoint.tags.join(", ")}\n`;
          output += `Source: ${endpoint.url}\n\n`;
          output += `${endpoint.content}\n\n`;
        }

        return { content: [{ type: "text", text: output.trim() }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "embedding-coverage",
    "Report semantic embedding coverage for a documentation library.",
    {
      libraryId: z.string().describe("Library slug or /context/<slug> ID"),
    },
    async ({ libraryId }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").trim();
        const library = getLibraryBySlug(slug);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                library,
                embeddings: embeddingCoverage(library.id),
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "embed-library",
    "Generate semantic embeddings for a documentation library's chunks.",
    {
      libraryId: z.string().describe("Library slug or /context/<slug> ID"),
      all: z.boolean().optional().default(false).describe("Re-embed already embedded chunks"),
      limit: z.number().optional().describe("Maximum chunks to embed in this run"),
    },
    async ({ libraryId, all = false, limit }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").trim();
        const library = getLibraryBySlug(slug);
        const report = await embedLibraryChunks(library.id, { all, limit });
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          ...(report.failed_count > 0 ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── add-library ──────────────────────────────────────────────────────────────

  server.tool(
    "add-library",
    `Index a new library by refreshing its documentation source. Native source ingestion runs first; Exa or Firecrawl are retriever fallbacks.
After indexing, use resolve-library-id and query-docs to access the docs.`,
    {
      name: z.string().describe("Library name (e.g. 'React', 'Express')"),
      npm_package: z.string().optional().describe("npm package name"),
      docs_url: z.string().optional().describe("Official documentation URL"),
      github_repo: z.string().optional().describe("GitHub repo (e.g. 'facebook/react')"),
      version: z.string().optional().describe("Indexed documentation version"),
      source_type: z
        .string()
        .optional()
        .describe("Source type: docs, website, llms_txt, openapi, github, npm, api, or manual"),
      source_url: z.string().optional().describe("Canonical source URL for refresh planning"),
      freshness_days: z.number().optional().describe("Days before this source is due for refresh"),
      priority: z.number().optional().describe("Refresh priority for update planning"),
      max_pages: z.number().optional().default(20).describe("Max pages to ingest (default: 20)"),
      retriever_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip native source ingestion and use the selected retriever directly"),
      retriever: z
        .enum(["exa", "firecrawl"])
        .optional()
        .describe("Retrieval backend fallback to use: firecrawl (default) or exa"),
      crawler: z
        .enum(["exa", "firecrawl"])
        .optional()
        .describe("Deprecated alias for retriever"),
      embed: z.boolean().optional().default(false).describe("Generate semantic embeddings after refreshing docs"),
      embed_all: z.boolean().optional().default(false).describe("Re-embed existing chunks when embed is true"),
      embed_limit: z.number().optional().describe("Maximum chunks to embed after refresh"),
    },
    async ({
      name,
      npm_package,
      docs_url,
      github_repo,
      version,
      source_type,
      source_url,
      freshness_days,
      priority,
      max_pages = 20,
      retriever_only = false,
      retriever,
      crawler,
      embed = false,
      embed_all = false,
      embed_limit,
    }) => {
      try {
        const existing = searchLibraries(name, 1);
        if (
          existing.length > 0 &&
          existing[0] &&
          existing[0].name.toLowerCase() === name.toLowerCase()
        ) {
          return {
            content: [
              {
                type: "text",
                text: `Library "${name}" is already indexed with ID /context/${existing[0].slug}.`,
              },
            ],
          };
        }

        const library = createLibrary({
          name,
          npm_package,
          docs_url,
          github_repo,
          version,
          source_type,
          source_url,
          freshness_days,
          priority,
        });
        const result = await refreshDocumentationSource(library.id, {
          maxPages: max_pages,
          retriever: selectRetriever(retriever, crawler),
          retrieverOnly: retriever_only,
          embed,
          embedAll: embed_all,
          embedLimit: embed_limit,
        });

        const lines = [
          `Indexed "${name}"`,
          `Library ID: /context/${library.slug}`,
          `Pages ingested: ${result.pages_ingested}`,
          `Chunks indexed: ${result.chunks_indexed}`,
          `API endpoints indexed: ${result.api_endpoints_indexed}`,
          `Files written: ${result.files_written}`,
          `Coverage: ${formatRefreshCoverage(result)}`,
          `Source: ${library.source_type}${library.source_url ? ` (${library.source_url})` : ""}`,
        ];
        if (result.embeddings) {
          lines.push(
            `Embeddings: ${result.embeddings.embedded_count}/${result.embeddings.selected_chunks} chunks via ${result.embeddings.provider}/${result.embeddings.model}`
          );
        }
        if (result.errors.length > 0) {
          lines.push(`Warnings: ${result.errors.slice(0, 2).join("; ")}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── list-sources ────────────────────────────────────────────────────────────

  server.tool(
    "list-sources",
    "List supported documentation source types and their refresh defaults.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(listDocumentationSources(), null, 2),
        },
      ],
    })
  );

  server.tool(
    "source-readiness",
    "Audit indexed libraries for source refresh readiness, native ingest availability, artifacts, and missing retriever keys.",
    {
      libraryId: z.string().optional().describe("Optional library slug or /context/<slug> ID"),
    },
    async ({ libraryId }) => {
      try {
        const slug = libraryId?.replace(/^\/context\//, "").trim();
        const report = getSourceReadinessReport({ slug });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "verify-readiness",
    "Run the shared docs intelligence verifier for agents. Read-only by default; optional smokes use isolated temporary state. Firecrawl is the default seed retriever.",
    {
      publish: z.boolean().optional().default(false).describe("Include package publish readiness checks"),
      registry: z.boolean().optional().default(false).describe("Check npm registry latest version when publish is enabled"),
      source_readiness: z.boolean().optional().default(true).describe("Include indexed source readiness audit"),
      smoke: z.boolean().optional().default(false).describe("Run isolated local source refresh/search smokes"),
      seed_smoke: z.boolean().optional().default(false).describe("Run isolated smoke checks for seeded docs sources"),
      required_smoke: z.boolean().optional().default(false).describe("Run fetch/search smokes for the required LLM/SaaS corpus"),
      required_live_smoke: z.boolean().optional().default(false).describe("Run the live update cycle smoke for the required LLM/SaaS corpus"),
      seed_groups: z
        .array(z.enum(["llm", "saas", "all"]))
        .optional()
        .describe("Seed groups for seed smoke checks"),
      required_groups: z
        .array(z.enum(["llm", "saas", "all"]))
        .optional()
        .describe("Required corpus groups for required smoke checks"),
      required_live_groups: z
        .array(z.enum(["llm", "saas", "all"]))
        .optional()
        .describe("Required corpus groups for live update smoke checks"),
      seed_slugs: z.array(z.string()).optional().describe("Explicit seed slugs to smoke"),
      seed_limit: z.number().optional().default(6).describe("Maximum seeded docs sources to smoke"),
      seed_retriever: z
        .enum(["firecrawl", "exa"])
        .optional()
        .default("firecrawl")
        .describe("Retriever fallback for seeded source smokes"),
      external_smoke: z.boolean().optional().default(false).describe("Run real Firecrawl/Exa retriever smokes when keys exist"),
      retrievers: z
        .array(z.enum(["firecrawl", "exa"]))
        .optional()
        .describe("External retrievers to smoke"),
      pages: z.number().optional().default(2).describe("Max pages per smoke source"),
      concurrency: z.number().optional().default(4).describe("Max concurrent smoke refreshes"),
      case_timeout_ms: z
        .number()
        .optional()
        .default(45_000)
        .describe("Max milliseconds per smoke source; 0 disables"),
      require_full_docs: z
        .boolean()
        .optional()
        .default(false)
        .describe("Fail smoke checks when page limits are reached or llms.txt full docs are missing"),
      ai_smoke: z.string().optional().describe("AI SDK backend id to smoke, or 'default'"),
    },
    async ({
      publish = false,
      registry = false,
      source_readiness = true,
      smoke = false,
      seed_smoke = false,
      required_smoke = false,
      required_live_smoke = false,
      seed_groups,
      required_groups,
      required_live_groups,
      seed_slugs,
      seed_limit = 6,
      seed_retriever = "firecrawl",
      external_smoke = false,
      retrievers,
      pages = 2,
      concurrency = 4,
      case_timeout_ms = 45_000,
      require_full_docs = false,
      ai_smoke,
    }) => {
      try {
        const shouldRunSeedSmoke = seed_smoke || Boolean(seed_groups?.length) || Boolean(seed_slugs?.length);
        const report = await runVerification({
          includePublish: publish,
          includeRegistry: registry,
          includeSourceReadiness: source_readiness,
          includeLocalSmoke: smoke,
          includeSeedSmoke: shouldRunSeedSmoke,
          includeRequiredCorpusSmoke: required_smoke || Boolean(required_groups?.length),
          includeRequiredCorpusLiveUpdateSmoke: required_live_smoke || Boolean(required_live_groups?.length),
          seedGroups: seed_groups as SeedSmokeGroup[] | undefined,
          requiredCorpusGroups: required_groups as SeedSmokeGroup[] | undefined,
          requiredLiveUpdateGroups: required_live_groups as SeedSmokeGroup[] | undefined,
          seedSlugs: seed_slugs,
          seedLimit: seed_limit,
          seedRetriever: seed_retriever,
          includeExternalSmoke: external_smoke,
          retrievers,
          maxPages: pages,
          smokeConcurrency: concurrency,
          smokeCaseTimeoutMs: case_timeout_ms,
          requireFullDocs: require_full_docs,
          aiSmoke: ai_smoke ? (ai_smoke as VerificationOptions["aiSmoke"]) : undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          ...(report.ready ? {} : { isError: true }),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "refresh-source",
    "Refresh an existing library's documentation source. Native source ingestion runs first; Exa or Firecrawl are retriever fallbacks.",
    {
      libraryId: z.string().describe("Library slug or /context/<slug> ID"),
      max_pages: z.number().optional().default(30).describe("Max pages to ingest (default: 30)"),
      retriever_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip native source ingestion and use the selected retriever directly"),
      retriever: z
        .enum(["exa", "firecrawl"])
        .optional()
        .describe("Retrieval backend fallback to use: firecrawl (default) or exa"),
      crawler: z
        .enum(["exa", "firecrawl"])
        .optional()
        .describe("Deprecated alias for retriever"),
      write_files: z.boolean().optional().default(true).describe("Write structured Markdown docs files"),
      embed: z.boolean().optional().default(false).describe("Generate semantic embeddings after refreshing docs"),
      embed_all: z.boolean().optional().default(false).describe("Re-embed existing chunks when embed is true"),
      embed_limit: z.number().optional().describe("Maximum chunks to embed after refresh"),
    },
    async ({ libraryId, max_pages = 30, retriever_only = false, retriever, crawler, write_files = true, embed = false, embed_all = false, embed_limit }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").trim();
        const library = getLibraryBySlug(slug);
        const result = await refreshDocumentationSource(library.id, {
          maxPages: max_pages,
          refresh: true,
          retriever: selectRetriever(retriever, crawler),
          retrieverOnly: retriever_only,
          writeFiles: write_files,
          embed,
          embedAll: embed_all,
          embedLimit: embed_limit,
        });

        const lines = [
          `Refreshed "${library.name}"`,
          `Library ID: /context/${library.slug}`,
          `Source: ${library.source_type}${library.source_url ? ` (${library.source_url})` : ""}`,
          `Ingest: ${result.ingest_mode === "native" ? `native source (${result.source_type})` : `retriever (${result.retriever})`}`,
          `Pages ingested: ${result.pages_ingested}`,
          `Chunks indexed: ${result.chunks_indexed}`,
          `API endpoints indexed: ${result.api_endpoints_indexed}`,
          `Files written: ${result.files_written}`,
          `Coverage: ${formatRefreshCoverage(result)}`,
        ];
        if (result.embeddings) {
          lines.push(
            `Embeddings: ${result.embeddings.embedded_count}/${result.embeddings.selected_chunks} chunks via ${result.embeddings.provider}/${result.embeddings.model}`
          );
        }
        if (result.errors.length > 0) {
          lines.push(`Warnings: ${result.errors.slice(0, 2).join("; ")}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── list-libraries ───────────────────────────────────────────────────────────

  server.tool(
    "list-libraries",
    "List all libraries indexed in the local documentation store.",
    {},
    async () => {
      try {
        const libraries = listLibraries();

        if (libraries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No libraries indexed yet. Use add-library or run: context seed",
              },
            ],
          };
        }

        const formatted = libraries.map((lib) => {
          const status =
            lib.chunk_count > 0
              ? `${lib.chunk_count} chunks, ${lib.document_count} pages`
              : "not indexed";
          return `- /context/${lib.slug} — ${lib.name}${lib.version ? ` v${lib.version}` : ""} (${status}, ${lib.source_type})`;
        }).join("\n");

        return {
          content: [
            {
              type: "text",
              text: `${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} indexed:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── get-library-links ────────────────────────────────────────────────────────

  server.tool(
    "get-library-links",
    "Get all links (docs, npm, github, api, etc.) for a library.",
    {
      libraryId: z
        .string()
        .describe("Library slug or /context/<slug> ID"),
    },
    async ({ libraryId }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").trim();
        const library = getLibraryBySlug(slug);
        const links = getLinks(library.id);

        if (links.length === 0) {
          return {
            content: [{ type: "text", text: `No links registered for ${library.name}.` }],
          };
        }

        const formatted = links
          .map((l) => `- [${l.type}] ${l.label ? `${l.label}: ` : ""}${l.url}`)
          .join("\n");

        return {
          content: [{ type: "text", text: `${library.name} — Links:\n\n${formatted}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── list-doc-files ──────────────────────────────────────────────────────────

  server.tool(
    "list-doc-files",
    "List structured local markdown docs files and SQLite document metadata for a library.",
    {
      libraryId: z.string().describe("Library slug or /context/<slug> ID"),
    },
    async ({ libraryId }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").trim();
        const library = getLibraryBySlug(slug);
        const documents = listDocuments(library.id);
        const artifacts = listDocumentArtifacts(library.slug);
        const manifest = getLibraryDocsManifestArtifact(library.slug);

        if (documents.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No indexed docs for ${library.name}. Run: context refresh ${library.slug}`,
              },
            ],
          };
        }

        const lines = [`${library.name} docs files:`, ""];
        for (const doc of documents) {
          lines.push(`- ${doc.file_path ?? "(missing file)"}`);
          lines.push(`  URL: ${doc.url}`);
          if (doc.title) lines.push(`  Title: ${doc.title}`);
          if (doc.content_hash) lines.push(`  Hash: ${doc.content_hash}`);
        }
        lines.push("");
        lines.push(`Artifacts on disk: ${artifacts.length}`);
        if (manifest) lines.push(`Manifest: ${manifest.relativePath}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── plan-doc-updates ────────────────────────────────────────────────────────

  server.tool(
    "plan-doc-updates",
    "Compute Context7-style docs refresh/update plan and optionally persist pending update tasks.",
    {
      libraryId: z.string().optional().describe("Optional library slug or /context/<slug> ID"),
      createTasks: z.boolean().optional().default(false).describe("Persist pending refresh tasks"),
    },
    async ({ libraryId, createTasks = false }) => {
      try {
        const slug = libraryId?.replace(/^\/context\//, "").trim();
        const plan = getRefreshPlan({ slug, createTasks });
        if (plan.length === 0) {
          return { content: [{ type: "text", text: "No libraries are due for docs refresh." }] };
        }

        const lines = [`Docs refresh plan:`, ""];
        for (const item of plan) {
          lines.push(`- /context/${item.library.slug} ${item.library.name}`);
          lines.push(`  Reason: ${item.reason}`);
          lines.push(`  Due: ${item.due_at}`);
          if (item.task) lines.push(`  Task: ${item.task.id}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "run-live-update-cycle",
    "Run one Context7-style live docs update cycle for due sources. Use plan_only for a read-only preview.",
    {
      max_pages: z.number().optional().default(30).describe("Max pages per source refresh"),
      retriever: z
        .enum(["firecrawl", "exa"])
        .optional()
        .describe("Retrieval backend fallback to use: firecrawl (default) or exa"),
      crawler: z
        .enum(["firecrawl", "exa"])
        .optional()
        .describe("Deprecated alias for retriever"),
      plan_only: z.boolean().optional().default(false).describe("Only return planned actions; do not refresh"),
      native_only: z.boolean().optional().default(false).describe("Only refresh sources that do not need external retrievers"),
      create_tasks: z.boolean().optional().describe("Persist pending refresh tasks before running the cycle"),
      case_timeout_ms: z.number().optional().default(45_000).describe("Max milliseconds per source refresh; 0 disables"),
      embed: z.boolean().optional().default(false).describe("Generate semantic embeddings after each refreshed source"),
      embed_all: z.boolean().optional().default(false).describe("Re-embed existing chunks when embed is true"),
      embed_limit: z.number().optional().describe("Maximum chunks to embed per refreshed source"),
    },
    async ({ max_pages = 30, retriever, crawler, plan_only = false, native_only = false, create_tasks, case_timeout_ms = 45_000, embed = false, embed_all = false, embed_limit }) => {
      try {
        const cycle = await runLiveUpdateCycle({
          maxPages: max_pages,
          retriever: selectRetriever(retriever, crawler),
          planOnly: plan_only,
          nativeOnly: native_only,
          createTasks: create_tasks,
          refreshTimeoutMs: case_timeout_ms,
          embed,
          embedAll: embed_all,
          embedLimit: embed_limit,
        });
        return { content: [{ type: "text", text: JSON.stringify(cycle, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list-webhooks",
    "List configured docs update webhook endpoints.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(listWebhookEndpoints(), null, 2) }],
    })
  );

  server.tool(
    "add-webhook",
    "Add or update a docs update webhook endpoint.",
    {
      url: z.string().describe("Webhook URL"),
      events: z.array(z.string()).optional().describe("Events to deliver; omit for docs.refreshed and docs.refresh_failed"),
      active: z.boolean().optional().default(true).describe("Whether the endpoint is active"),
    },
    async ({ url, events, active = true }) => {
      try {
        const endpoint = addWebhookEndpoint({ url, events, active });
        return { content: [{ type: "text", text: JSON.stringify(endpoint, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "remove-webhook",
    "Remove a docs update webhook endpoint by id.",
    {
      id: z.string().describe("Webhook endpoint id"),
    },
    async ({ id }) => {
      try {
        removeWebhookEndpoint(id);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: true, id }, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list-webhook-deliveries",
    "List recent webhook deliveries.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(listWebhookDeliveries(), null, 2) }],
    })
  );

  server.tool(
    "test-webhook",
    "Send a test webhook event to matching active endpoints.",
    {
      event: z.string().optional().default("docs.refreshed").describe("Event name to emit"),
      payload: z.record(z.unknown()).optional().describe("Additional payload fields"),
    },
    async ({ event = "docs.refreshed", payload }) => {
      try {
        const deliveries = await emitWebhookEvent(event, {
          test: true,
          emitted_by: "context MCP tool",
          ...(payload ?? {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(deliveries, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── get-related-libraries ────────────────────────────────────────────────────

  server.tool(
    "get-related-libraries",
    "Find libraries related to a given library via the knowledge graph (alternatives, dependencies, commonly used together).",
    {
      libraryId: z.string().describe("Library slug or /context/<slug> ID"),
      relation: z
        .enum([
          "depends_on",
          "alternative_to",
          "used_with",
          "wraps",
          "extends",
          "part_of",
          "replaced_by",
        ])
        .optional()
        .describe("Filter by relation type"),
    },
    async ({ libraryId, relation }) => {
      try {
        const slug = libraryId.replace(/^\/context\//, "").trim();
        const library = getLibraryBySlug(slug);

        const { getDatabase } = await import("../db/database.js");
        const db = getDatabase();
        const node = db.get(
          "SELECT id FROM kg_nodes WHERE library_id = ? AND type = 'library' LIMIT 1",
          library.id
        ) as { id: string } | null;

        if (!node) {
          return {
            content: [
              {
                type: "text",
                text: `No knowledge graph node for ${library.name}. Run: context seed`,
              },
            ],
          };
        }

        const withRels = getRelatedNodes(node.id, relation as Parameters<typeof getRelatedNodes>[1]);

        if (withRels.relations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No ${relation ?? ""}relations found for ${library.name} in the knowledge graph.`,
              },
            ],
          };
        }

        const lines = [`${library.name} — Related Libraries:`, ""];
        for (const rel of withRels.relations) {
          const arrow = rel.direction === "outgoing" ? "→" : "←";
          lines.push(`${arrow} [${rel.relation}] ${rel.node.name} (${rel.node.type})`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── seed-libraries ───────────────────────────────────────────────────────────

  server.tool(
    "seed-libraries",
    "Populate or update source metadata for popular tools/services and optionally refresh selected docs sources. Firecrawl is the default external fallback.",
    {
      groups: z
        .array(z.enum(["llm", "saas", "all"]))
        .optional()
        .describe("Seed groups to process. Defaults to all."),
      slugs: z.array(z.string()).optional().describe("Explicit seed slugs to process"),
      limit: z.number().optional().default(0).describe("Maximum selected seeds to process; 0 means no limit"),
      crawl: z.boolean().optional().default(false).describe("Refresh docs for each selected source after seeding"),
      new_only: z.boolean().optional().default(false).describe("When crawl is true, only refresh newly created libraries"),
      max_pages: z.number().optional().default(10).describe("Max pages per source when crawl is true"),
      retriever_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip native source ingestion and use the selected retriever directly"),
      retriever: z
        .enum(["firecrawl", "exa"])
        .optional()
        .describe("Retrieval backend fallback to use: firecrawl (default) or exa"),
      crawler: z
        .enum(["firecrawl", "exa"])
        .optional()
        .describe("Deprecated alias for retriever"),
      write_files: z.boolean().optional().default(true).describe("Write structured Markdown docs files when crawling"),
      embed: z.boolean().optional().default(false).describe("Generate semantic embeddings after refreshing docs"),
      embed_all: z.boolean().optional().default(false).describe("Re-embed existing chunks when embed is true"),
      embed_limit: z.number().optional().describe("Maximum chunks to embed per refreshed source"),
      open_connectors_path: z
        .string()
        .optional()
        .describe("Optional local open-connectors checkout path to import as normal docs sources"),
      open_connectors_enabled_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only import entries enabled in .connectors/manifest.json"),
      open_connectors_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only process imported open-connectors sources"),
    },
    async ({
      groups,
      slugs,
      limit = 0,
      crawl = false,
      new_only = false,
      max_pages = 10,
      retriever_only = false,
      retriever,
      crawler,
      write_files = true,
      embed = false,
      embed_all = false,
      embed_limit,
      open_connectors_path,
      open_connectors_enabled_only = false,
      open_connectors_only = false,
    }) => {
      try {
        const report = await bootstrapSeedSources({
          groups: groups as SeedLibraryGroup[] | undefined,
          slugs,
          limit,
          crawl,
          newOnly: new_only,
          maxPages: max_pages,
          retriever: selectRetriever(retriever, crawler),
          retrieverOnly: retriever_only,
          writeFiles: write_files,
          embed,
          embedAll: embed_all,
          embedLimit: embed_limit,
          openConnectorsPath: open_connectors_path,
          openConnectorsEnabledOnly: open_connectors_enabled_only,
          openConnectorsOnly: open_connectors_only,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
          ...(report.failed_count > 0 ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}

function selectRetriever(
  retriever?: ExternalRetrieverType,
  crawler?: ExternalRetrieverType
): ExternalRetrieverType {
  return retriever ?? crawler ?? getDefaultExternalRetriever();
}

function formatRefreshCoverage(result: {
  max_pages?: number;
  pages_retrieved?: number;
  page_limit_reached?: boolean;
  full_docs_detected?: boolean;
}): string {
  if (result.max_pages === undefined || result.pages_retrieved === undefined) return "unknown";
  const flags = [
    result.page_limit_reached ? "page limit reached" : null,
    result.full_docs_detected ? "llms-full detected" : null,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `retrieved ${result.pages_retrieved}/${result.max_pages} pages${suffix}`;
}
