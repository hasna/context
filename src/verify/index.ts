import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAiProviderStatuses, generateWithAiSdk, type AiProviderId } from "../ai/providers.js";
import { insertChunk } from "../db/chunks.js";
import { searchChunks } from "../db/chunks.js";
import { resetDatabase } from "../db/database.js";
import { upsertDocument } from "../db/documents.js";
import { embeddingCoverage, saveEmbedding, semanticSearch } from "../db/embeddings.js";
import { createLibrary } from "../db/libraries.js";
import { getRefreshPlan, listDocUpdateTasks } from "../db/update-tasks.js";
import { addWebhookEndpoint, listWebhookDeliveries } from "../db/webhooks.js";
import { runLiveUpdateCycle } from "../live/index.js";
import { getPublishReadinessReport, type PublishReadinessReport } from "../publish/readiness.js";
import {
  SEED_LIBRARIES,
  getSeedSourceMetadata,
  selectSeedLibraries,
  type SeedLibrary,
  type SeedLibraryGroup,
} from "../seeds/libraries.js";
import {
  REQUIRED_LLM_SEED_SLUGS,
  REQUIRED_SAAS_SEED_SLUGS,
  getSeedCorpusCoverageReport,
  type SeedCorpusCoverageReport,
} from "../seeds/coverage.js";
import { bootstrapSeedSources } from "../seeds/bootstrap.js";
import { getSourceReadinessReport, type SourceReadinessReport } from "../sources/readiness.js";
import { getDefaultExternalRetriever, refreshDocumentationSource, type ExternalRetrieverType, type SourceRefreshRetrievers } from "../sources/refresh.js";
import type { SourcePage } from "../sources/ingest.js";
import type { LibrarySourceType } from "../types/index.js";
import type { SourceRefreshResult } from "../types/index.js";

export type VerificationSeverity = "info" | "warning" | "error";
export type VerificationSmokeStatus = "passed" | "failed" | "skipped";

const DEFAULT_SMOKE_CONCURRENCY = 4;
const MAX_SMOKE_CONCURRENCY = 12;
const DEFAULT_SMOKE_CASE_TIMEOUT_MS = 45_000;
const MAX_SMOKE_CASE_TIMEOUT_MS = 300_000;

export interface VerificationIssue {
  code: string;
  severity: VerificationSeverity;
  message: string;
}

export interface SourceSmokeCaseResult {
  id: string;
  name: string;
  source_type: LibrarySourceType;
  retriever: ExternalRetrieverType;
  retriever_only: boolean;
  status: VerificationSmokeStatus;
  pages_ingested: number;
  max_pages: number;
  pages_retrieved: number;
  page_limit_reached: boolean;
  full_docs_detected: boolean;
  coverage_required: boolean;
  coverage_passed: boolean;
  coverage_issues: string[];
  chunks_indexed: number;
  files_written: number;
  search_hits: number;
  retrieved_by: string | null;
  source_discovery: SourceRefreshResult["source_discovery"];
  error: string | null;
}

export interface AiSmokeResult {
  status: VerificationSmokeStatus;
  backend: string | null;
  model: string | null;
  text: string | null;
  error: string | null;
}

export interface RefreshLoopSmokeResult {
  status: VerificationSmokeStatus;
  task_created: boolean;
  task_completed: boolean;
  webhook_delivered: boolean;
  pages_ingested: number;
  chunks_indexed: number;
  search_hits: number;
  event_received: string | null;
  error: string | null;
}

export interface SemanticSmokeResult {
  status: VerificationSmokeStatus;
  embedded: number;
  total_chunks: number;
  top_hit: string | null;
  top_score: number | null;
  error: string | null;
}

export interface RequiredCorpusLiveUpdateSmokeResult {
  status: VerificationSmokeStatus;
  groups: SeedSmokeGroup[];
  selected_count: number;
  planned_count: number;
  refreshed_count: number;
  failed_count: number;
  task_created_count: number;
  task_done_count: number;
  docs_ready_count: number;
  search_ready_count: number;
  coverage_required: boolean;
  coverage_ready_count: number;
  total_pages_ingested: number;
  total_chunks_indexed: number;
  total_files_written: number;
  failures: Array<{
    library_slug: string;
    library_name: string;
    error: string;
  }>;
  error: string | null;
}

export interface VerificationReport {
  generated_at: string;
  ready: boolean;
  publish: PublishReadinessReport | null;
  ai: {
    configured_count: number;
    configured: string[];
    smoke: AiSmokeResult | null;
  };
  retrievers: {
    default: ExternalRetrieverType;
    exa: boolean;
    firecrawl: boolean;
  };
  sources: SourceReadinessReport | null;
  corpus: SeedCorpusCoverageReport | null;
  smoke: {
    local: SourceSmokeCaseResult[];
    external: SourceSmokeCaseResult[];
    seed: SourceSmokeCaseResult[];
    required_corpus: SourceSmokeCaseResult[];
    required_live_update: RequiredCorpusLiveUpdateSmokeResult | null;
    refresh_loop: RefreshLoopSmokeResult | null;
    semantic: SemanticSmokeResult | null;
  };
  issues: VerificationIssue[];
}

export interface VerificationOptions {
  includePublish?: boolean;
  includeRegistry?: boolean;
  includeSourceReadiness?: boolean;
  includeCorpusCoverage?: boolean;
  includeLocalSmoke?: boolean;
  includeExternalSmoke?: boolean;
  includeSeedSmoke?: boolean;
  includeRequiredCorpusSmoke?: boolean;
  includeRequiredCorpusLiveUpdateSmoke?: boolean;
  seedGroups?: SeedSmokeGroup[];
  seedSlugs?: string[];
  requiredCorpusGroups?: SeedSmokeGroup[];
  requiredLiveUpdateGroups?: SeedSmokeGroup[];
  seedLimit?: number;
  retrievers?: ExternalRetrieverType[];
  seedRetriever?: ExternalRetrieverType;
  maxPages?: number;
  smokeConcurrency?: number;
  smokeCaseTimeoutMs?: number;
  requireFullDocs?: boolean;
  aiSmoke?: AiProviderId | "default";
  rootDir?: string;
}

export type SeedSmokeGroup = SeedLibraryGroup;

interface SmokeCase {
  id: string;
  name: string;
  source_type: LibrarySourceType;
  source_url?: string;
  docs_url?: string;
  npm_package?: string;
  query: string;
  retriever: ExternalRetrieverType;
  retriever_only: boolean;
  native_pages?: SourcePage[];
  discovered_url?: string;
  retriever_pages?: SourcePage[];
}

export async function runVerification(
  options: VerificationOptions = {}
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  const publish = options.includePublish === false
    ? null
    : await getPublishReadinessReport({
        rootDir: options.rootDir,
        includeRegistry: options.includeRegistry,
      });
  if (publish && !publish.ready) {
    issues.push(error("publish_not_ready", "Publish readiness has blocking errors."));
  }

  const aiStatuses = getAiProviderStatuses();
  const configuredAi = aiStatuses.filter((provider) => provider.configured).map((provider) => provider.id);
  const aiSmoke = options.aiSmoke ? await runAiSmoke(options.aiSmoke) : null;
  if (options.aiSmoke && aiSmoke?.status !== "passed") {
    issues.push(error("ai_smoke_failed", aiSmoke?.error ?? "AI SDK smoke failed."));
  }

  const retrieverKeys = getRetrieverKeyStatus();
  const sources = options.includeSourceReadiness === false
    ? null
    : getSourceReadinessReport();
  if (sources?.totals.with_errors) {
    issues.push(error("source_readiness_errors", `${sources.totals.with_errors} source readiness error(s) found.`));
  }
  const corpus = options.includeCorpusCoverage === false
    ? null
    : getSeedCorpusCoverageReport();
  if (corpus && !corpus.ready) {
    for (const issue of corpus.issues) {
      issues.push({
        code: `corpus_${issue.code}`,
        severity: issue.severity,
        message: issue.message,
      });
    }
  }

  const smoke = {
    local: options.includeLocalSmoke
      ? await runLocalSourceSmoke(options.maxPages ?? 2, {
          requireFullDocs: options.requireFullDocs,
          concurrency: options.smokeConcurrency,
          caseTimeoutMs: options.smokeCaseTimeoutMs,
        })
      : [],
    external: options.includeExternalSmoke
      ? await runExternalRetrieverSmoke(options.retrievers ?? ["firecrawl", "exa"], options.maxPages ?? 1, {
        requireFullDocs: options.requireFullDocs,
        concurrency: options.smokeConcurrency,
        caseTimeoutMs: options.smokeCaseTimeoutMs,
      })
      : [],
    seed: options.includeSeedSmoke
      ? await runSeedSourceSmoke({
          groups: options.seedGroups ?? ["llm"],
          slugs: options.seedSlugs,
          limit: options.seedLimit ?? 6,
          maxPages: options.maxPages ?? 1,
          retriever: options.seedRetriever ?? "firecrawl",
          requireFullDocs: options.requireFullDocs,
          concurrency: options.smokeConcurrency,
          caseTimeoutMs: options.smokeCaseTimeoutMs,
        })
      : [],
    required_corpus: options.includeRequiredCorpusSmoke
      ? await runRequiredCorpusSourceSmoke({
          groups: options.requiredCorpusGroups ?? ["all"],
          maxPages: options.maxPages ?? 1,
          retriever: options.seedRetriever ?? "firecrawl",
          requireFullDocs: options.requireFullDocs,
          concurrency: options.smokeConcurrency,
          caseTimeoutMs: options.smokeCaseTimeoutMs,
        })
      : [],
    required_live_update: options.includeRequiredCorpusLiveUpdateSmoke
      ? await runRequiredCorpusLiveUpdateSmoke({
          groups: options.requiredLiveUpdateGroups ?? ["all"],
          maxPages: options.maxPages ?? 2,
          retriever: options.seedRetriever ?? "firecrawl",
          requireFullDocs: options.requireFullDocs,
          caseTimeoutMs: options.smokeCaseTimeoutMs,
        })
      : null,
    refresh_loop: options.includeLocalSmoke ? await runRefreshLoopSmoke(options.maxPages ?? 2) : null,
    semantic: options.includeLocalSmoke ? await runSemanticSearchSmoke() : null,
  };
  for (const result of [...smoke.local, ...smoke.external, ...smoke.seed, ...smoke.required_corpus]) {
    if (result.status === "failed") {
      issues.push(error("source_smoke_failed", `${result.name} failed: ${result.error ?? "unknown error"}`));
    }
  }
  if (smoke.refresh_loop?.status === "failed") {
    issues.push(error("refresh_loop_smoke_failed", smoke.refresh_loop.error ?? "Refresh loop smoke failed."));
  }
  if (smoke.semantic?.status === "failed") {
    issues.push(error("semantic_smoke_failed", smoke.semantic.error ?? "Semantic search smoke failed."));
  }
  if (smoke.required_live_update?.status === "failed") {
    issues.push(error(
      "required_live_update_smoke_failed",
      smoke.required_live_update.error ?? "Required corpus live update smoke failed."
    ));
  }

  return {
    generated_at: new Date().toISOString(),
    ready: !issues.some((issue) => issue.severity === "error"),
    publish,
    ai: {
      configured_count: configuredAi.length,
      configured: configuredAi,
      smoke: aiSmoke,
    },
    retrievers: {
      default: getDefaultRetrieverFromEnv(),
      ...retrieverKeys,
    },
    sources,
    corpus,
    smoke,
    issues,
  };
}

interface SmokeCoverageOptions {
  requireFullDocs?: boolean;
  concurrency?: number;
  caseTimeoutMs?: number;
}

export async function runLocalSourceSmoke(
  maxPages = 2,
  options: SmokeCoverageOptions = {}
): Promise<SourceSmokeCaseResult[]> {
  return withTemporaryContextState(async () => {
    const cases: SmokeCase[] = [
      {
        id: "local-docs",
        name: "Local Docs Source",
        source_type: "docs",
        source_url: "https://verify.local/docs",
        docs_url: "https://verify.local/docs",
        query: "verify-docs-search-token",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://verify.local/docs",
            title: "Verify Docs",
            text: "# Verify Docs\n\nverify-docs-search-token documents native docs source refresh, retriever fallback metadata, SQLite chunks, and local Markdown artifacts for agents.",
            metadata: { source_role: "entry" },
          },
        ],
      },
      {
        id: "local-llms-txt",
        name: "Local llms.txt Source",
        source_type: "llms_txt",
        source_url: "https://verify.local/llms.txt",
        query: "verify-llms-search-token",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://verify.local/llms.txt",
            title: "Verify LLM Manifest",
            text: "# Verify LLM Manifest\n\nllms.txt manifest points agents at full documentation for source metadata and searchable local context.",
            metadata: { source_role: "manifest" },
          },
          {
            url: "https://verify.local/llms-full.txt",
            title: "Verify LLM Full Docs",
            text: "# Verify LLM Full Docs\n\nverify-llms-search-token documents llms-full ingestion, full documentation coverage, source metadata, and searchable local context.",
            metadata: { source_role: "llms_full_txt" },
          },
        ],
      },
      {
        id: "local-website",
        name: "Local Website Source",
        source_type: "website",
        source_url: "https://verify.local/website",
        docs_url: "https://verify.local/website",
        query: "verify-website-search-token",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://verify.local/website",
            title: "Verify Website",
            text: "# Verify Website\n\nverify-website-search-token documents website-style docs sources, linked pages, structured artifacts, and source metadata.",
            metadata: { source_role: "entry" },
          },
        ],
      },
      {
        id: "local-openapi",
        name: "Local OpenAPI Source",
        source_type: "openapi",
        source_url: "https://verify.local/openapi.json",
        query: "verifyOpenApiOperation",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://verify.local/openapi.json",
            title: "Verify API OpenAPI",
            text: "# Verify API OpenAPI\n\nGET /verify\n\noperationId: verifyOpenApiOperation\n\nOpenAPI smoke documentation for endpoint-aware search and source metadata.",
            metadata: { source_format: "json" },
          },
        ],
      },
      {
        id: "local-github",
        name: "Local GitHub Source",
        source_type: "github",
        source_url: "verify/local-github",
        query: "verify-github-search-token",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://github.com/verify/local-github#readme",
            title: "Verify GitHub README",
            text: "# Verify GitHub README\n\nverify-github-search-token documents GitHub repository docs, README ingestion, examples, and source references.",
            metadata: { source_role: "repository_readme" },
          },
        ],
      },
      {
        id: "local-npm",
        name: "Local npm Source",
        source_type: "npm",
        source_url: "https://verify.local/npm/verify-package",
        npm_package: "verify-package",
        query: "verify-npm-search-token",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://verify.local/npm/verify-package",
            title: "verify-package npm package",
            text: "# Verify Package\n\nverify-npm-search-token documents npm package source ingestion and local searchable artifacts.",
            metadata: { source_role: "package_readme" },
          },
        ],
      },
      {
        id: "local-api",
        name: "Local API Docs Source",
        source_type: "api",
        source_url: "https://verify.local/api",
        docs_url: "https://verify.local/api",
        query: "verify-api-source-token",
        retriever: "firecrawl",
        retriever_only: false,
        native_pages: [
          {
            url: "https://verify.local/api/reference",
            title: "Verify API Docs",
            text: "# Verify API Docs\n\nverify-api-source-token documents SaaS API docs, webhook references, SDK examples, and endpoint search metadata.",
            metadata: { source_role: "api_reference" },
          },
        ],
      },
      {
        id: "local-discovered-firecrawl",
        name: "Local Discovered Firecrawl Source",
        source_type: "docs",
        query: "verify-discovered-firecrawl-token",
        retriever: "firecrawl",
        retriever_only: false,
        discovered_url: "https://verify.local/discovered-docs",
        retriever_pages: [
          {
            url: "https://verify.local/discovered-docs/getting-started",
            title: "Discovered Firecrawl Docs",
            text: "# Discovered Firecrawl Docs\n\nverify-discovered-firecrawl-token proves source URL discovery can resolve a bare named docs source before Firecrawl refreshes structured Markdown artifacts and SQLite chunks.",
            metadata: { source_role: "discovered_firecrawl_page" },
          },
        ],
      },
    ];
    return runSmokeCases(cases, maxPages, options);
  });
}

export async function runExternalRetrieverSmoke(
  retrievers: ExternalRetrieverType[],
  maxPages = 1,
  options: SmokeCoverageOptions = {}
): Promise<SourceSmokeCaseResult[]> {
  const cases: SmokeCase[] = [];
  if (retrievers.includes("firecrawl")) {
    cases.push({
      id: "external-firecrawl",
      name: "Firecrawl Retriever",
      source_type: "docs",
      source_url: "https://docs.firecrawl.dev/introduction",
      docs_url: "https://docs.firecrawl.dev/introduction",
      query: "Firecrawl",
      retriever: "firecrawl",
      retriever_only: true,
    });
  }
  if (retrievers.includes("exa")) {
    cases.push({
      id: "external-exa",
      name: "Exa Retriever",
      source_type: "docs",
      source_url: "https://docs.exa.ai/reference/getting-started",
      docs_url: "https://docs.exa.ai/reference/getting-started",
      query: "Exa",
      retriever: "exa",
      retriever_only: true,
    });
  }
  return withTemporaryContextState(() => runSmokeCases(cases, maxPages, options));
}

export async function runRefreshLoopSmoke(maxPages = 2): Promise<RefreshLoopSmokeResult> {
  return withTemporaryContextState(async () => {
    const received: Array<{ event?: string; payload?: Record<string, unknown> }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/hook") {
          return new Response("not found", { status: 404 });
        }
        try {
          received.push(await req.json() as { event?: string; payload?: Record<string, unknown> });
        } catch {
          received.push({});
        }
        return new Response("ok");
      },
    });

    try {
      addWebhookEndpoint({
        url: `${server.url.origin}/hook`,
        events: ["docs.refreshed"],
      });
      const library = createLibrary({
        name: "Local Refresh Loop Source",
        slug: "local-refresh-loop",
        docs_url: "https://verify.local/refresh-loop",
        source_type: "docs",
        source_url: "https://verify.local/refresh-loop",
        freshness_days: 1,
        priority: 20,
      });

      const plan = getRefreshPlan({ createTasks: true });
      const pendingBefore = listDocUpdateTasks("pending");
      const result = await refreshDocumentationSource(library.id, {
        maxPages,
        retriever: "firecrawl",
        retrievers: {
          native: async () => [
            {
              url: "https://verify.local/refresh-loop",
              title: "Verify Refresh Loop",
              text: "# Verify Refresh Loop\n\nverify-refresh-loop-token proves refresh planning, pending update task completion, webhook delivery, SQLite chunk indexing, and searchable docs artifacts for the Context7-style update loop.",
              metadata: { source_role: "refresh_loop" },
            },
          ],
        },
      });
      const pendingAfter = listDocUpdateTasks("pending");
      const doneAfter = listDocUpdateTasks("done");
      const deliveries = listWebhookDeliveries();
      const hits = searchChunks("verify-refresh-loop-token", library.id, 3);
      const delivered = deliveries.find((item) => item.event === "docs.refreshed" && item.status === "delivered");
      const receivedEvent = received[0]?.event ?? null;
      const taskCreated = plan.some((item) => item.library.id === library.id && item.task);
      const taskCompleted = pendingBefore.some((item) => item.library_id === library.id) &&
        pendingAfter.every((item) => item.library_id !== library.id) &&
        doneAfter.some((item) => item.library_id === library.id);
      const webhookDelivered = Boolean(delivered) && receivedEvent === "docs.refreshed";
      const passed = taskCreated &&
        taskCompleted &&
        webhookDelivered &&
        result.pages_ingested > 0 &&
        result.chunks_indexed > 0 &&
        hits.length > 0;

      return {
        status: passed ? "passed" : "failed",
        task_created: taskCreated,
        task_completed: taskCompleted,
        webhook_delivered: webhookDelivered,
        pages_ingested: result.pages_ingested,
        chunks_indexed: result.chunks_indexed,
        search_hits: hits.length,
        event_received: receivedEvent,
        error: passed ? null : "Refresh loop did not create/complete task, deliver webhook, and index searchable docs.",
      };
    } catch (error_) {
      return {
        status: "failed",
        task_created: false,
        task_completed: false,
        webhook_delivered: false,
        pages_ingested: 0,
        chunks_indexed: 0,
        search_hits: 0,
        event_received: received[0]?.event ?? null,
        error: error_ instanceof Error ? error_.message : String(error_),
      };
    } finally {
      server.stop(true);
    }
  });
}

export async function runSemanticSearchSmoke(): Promise<SemanticSmokeResult> {
  return withTemporaryContextState(async () => {
    try {
      const library = createLibrary({
        name: "Local Semantic Search Source",
        slug: "local-semantic-search",
        docs_url: "https://verify.local/semantic",
        source_type: "docs",
        source_url: "https://verify.local/semantic",
      });
      const doc = upsertDocument({
        library_id: library.id,
        url: "https://verify.local/semantic",
        title: "Semantic Search Smoke",
      });
      const reactChunk = insertChunk({
        library_id: library.id,
        document_id: doc.id,
        content: "semantic-react-hook-token covers React hooks, state updates, and component rendering.",
        position: 0,
      });
      const billingChunk = insertChunk({
        library_id: library.id,
        document_id: doc.id,
        content: "semantic-billing-api-token covers invoices, payments, customers, and subscription webhooks.",
        position: 1,
      });

      saveEmbedding(reactChunk.id, "verify-local", new Float32Array([1, 0, 0]));
      saveEmbedding(billingChunk.id, "verify-local", new Float32Array([0, 1, 0]));

      const coverage = embeddingCoverage(library.id);
      const results = semanticSearch(new Float32Array([0.95, 0.05, 0]), library.id, 2);
      const top = results[0] ?? null;
      const passed = coverage.total === 2 &&
        coverage.embedded === 2 &&
        top?.chunk_id === reactChunk.id &&
        top.score > (results[1]?.score ?? 0);

      return {
        status: passed ? "passed" : "failed",
        embedded: coverage.embedded,
        total_chunks: coverage.total,
        top_hit: top?.content ?? null,
        top_score: top?.score ?? null,
        error: passed ? null : "Semantic search did not return the expected top embedded chunk.",
      };
    } catch (error_) {
      return {
        status: "failed",
        embedded: 0,
        total_chunks: 0,
        top_hit: null,
        top_score: null,
        error: error_ instanceof Error ? error_.message : String(error_),
      };
    }
  });
}

export interface SeedSourceSmokeOptions {
  groups?: SeedSmokeGroup[];
  slugs?: string[];
  limit?: number;
  maxPages?: number;
  retriever?: ExternalRetrieverType;
  requireFullDocs?: boolean;
  concurrency?: number;
  caseTimeoutMs?: number;
}

export async function runSeedSourceSmoke(
  options: SeedSourceSmokeOptions = {}
): Promise<SourceSmokeCaseResult[]> {
  const seeds = selectSeedSmokeSeeds({
    groups: options.groups ?? ["llm"],
    slugs: options.slugs,
    limit: options.limit ?? 6,
  });
  const cases = seeds.map((seed) => seedToSmokeCase(seed, options.retriever ?? "firecrawl"));
  return withTemporaryContextState(() => runSmokeCases(cases, options.maxPages ?? 1, {
    requireFullDocs: options.requireFullDocs,
    concurrency: options.concurrency,
    caseTimeoutMs: options.caseTimeoutMs,
  }));
}

export async function runRequiredCorpusSourceSmoke(
  options: Omit<SeedSourceSmokeOptions, "slugs" | "limit"> = {}
): Promise<SourceSmokeCaseResult[]> {
  const seeds = selectRequiredCorpusSmokeSeeds({
    groups: options.groups ?? ["all"],
  });
  const cases = seeds.map((seed) => seedToSmokeCase(seed, options.retriever ?? "firecrawl"));
  return withTemporaryContextState(() => runSmokeCases(cases, options.maxPages ?? 1, {
    requireFullDocs: options.requireFullDocs,
    concurrency: options.concurrency,
    caseTimeoutMs: options.caseTimeoutMs,
  }));
}

export async function runRequiredCorpusLiveUpdateSmoke(
  options: Omit<SeedSourceSmokeOptions, "slugs" | "limit"> = {}
): Promise<RequiredCorpusLiveUpdateSmokeResult> {
  const groups: SeedSmokeGroup[] = options.groups?.length ? options.groups : ["all"];
  const retriever = options.retriever ?? "firecrawl";
  const maxPages = options.maxPages ?? 2;
  const coverageRequired = Boolean(options.requireFullDocs);
  const caseTimeoutMs = normalizeSmokeCaseTimeoutMs(options.caseTimeoutMs);

  return withTemporaryContextState(async () => {
    try {
      const seeds = selectRequiredCorpusSmokeSeeds({ groups });
      const seedBySlug = new Map(seeds.map((seed) => [seed.slug, seed]));
      const bootstrap = await bootstrapSeedSources({
        slugs: seeds.map((seed) => seed.slug),
        refreshableOnly: true,
        retriever,
      });
      const bootstrapFailures = bootstrap.items
        .filter((item) => item.status === "failed" || !item.library_id || !item.library_slug)
        .map((item) => ({
          library_slug: item.seed_slug,
          library_name: item.library_name,
          error: item.error ?? "Seed registration failed",
        }));

      const plan = getRefreshPlan({ createTasks: true });
      const taskLibraryIds = new Set(plan.map((item) => item.library.id));
      const cycle = await runLiveUpdateCycle(
        {
          maxPages,
          retriever,
          createTasks: true,
          refreshTimeoutMs: caseTimeoutMs,
        }
      );
      const doneTasks = listDocUpdateTasks("done");
      const doneLibraryIds = new Set(doneTasks.map((task) => task.library_id));
      const failures = [...bootstrapFailures];
      let docsReadyCount = 0;
      let searchReadyCount = 0;
      let coverageReadyCount = 0;
      let totalPages = 0;
      let totalChunks = 0;
      let totalFiles = 0;

      for (const item of bootstrap.items) {
        const librarySlug = item.library_slug ?? item.seed_slug;
        const seed = seedBySlug.get(item.seed_slug);
        const action = cycle.actions.find((candidate) => candidate.library_slug === librarySlug);
        const result = action?.result;
        const searchHits = item.library_id && seed ? searchChunks(seedSearchQuery(seed), item.library_id, 3).length : 0;

        if (result) {
          totalPages += result.pages_ingested;
          totalChunks += result.chunks_indexed;
          totalFiles += result.files_written;
        }

        const coverageIssues = result && seed ? coverageFailureReasons(result, seedToSmokeCase(seed, retriever)) : [];
        const coverageReady = !coverageRequired || (Boolean(result) && coverageIssues.length === 0);
        const docsReady = Boolean(result) &&
          smokeFailureReasons(result!, searchHits, seed ? seedSearchQuery(seed) : item.seed_slug).length === 0 &&
          coverageReady;
        if (docsReady) docsReadyCount++;
        if (searchHits > 0) searchReadyCount++;
        if (coverageReady) coverageReadyCount++;

        const libraryTaskCreated = Boolean(item.library_id && taskLibraryIds.has(item.library_id));
        const libraryTaskDone = Boolean(item.library_id && doneLibraryIds.has(item.library_id));
        const failureReasons: string[] = [];
        if (!action) failureReasons.push("No live update action was created");
        else if (action.status !== "refreshed") failureReasons.push(action.error ?? action.skip_reason ?? `Live update status was ${action.status}`);
        if (!libraryTaskCreated) failureReasons.push("No pending update task was created");
        if (!libraryTaskDone) failureReasons.push("Pending update task was not completed");
        if (result) {
          failureReasons.push(...smokeFailureReasons(result, searchHits, seed ? seedSearchQuery(seed) : item.seed_slug));
          if (coverageRequired) failureReasons.push(...coverageIssues);
        }
        else failureReasons.push("No refresh result was produced");

        if (failureReasons.length > 0) {
          failures.push({
            library_slug: librarySlug,
            library_name: item.library_name,
            error: [...new Set(failureReasons)].join("; "),
          });
        }
      }

      const taskCreatedCount = bootstrap.items.filter((item) => item.library_id && taskLibraryIds.has(item.library_id)).length;
      const taskDoneCount = bootstrap.items.filter((item) => item.library_id && doneLibraryIds.has(item.library_id)).length;
      const passed = bootstrap.failed_count === 0 &&
        cycle.failed_count === 0 &&
        cycle.skipped_count === 0 &&
        cycle.refreshed_count === bootstrap.selected_count &&
        taskCreatedCount === bootstrap.selected_count &&
        taskDoneCount === bootstrap.selected_count &&
        docsReadyCount === bootstrap.selected_count &&
        searchReadyCount === bootstrap.selected_count &&
        failures.length === 0;

      return {
        status: passed ? "passed" : "failed",
        groups,
        selected_count: bootstrap.selected_count,
        planned_count: cycle.plan_count,
        refreshed_count: cycle.refreshed_count,
        failed_count: cycle.failed_count,
        task_created_count: taskCreatedCount,
        task_done_count: taskDoneCount,
        docs_ready_count: docsReadyCount,
        search_ready_count: searchReadyCount,
        coverage_required: coverageRequired,
        coverage_ready_count: coverageReadyCount,
        total_pages_ingested: totalPages,
        total_chunks_indexed: totalChunks,
        total_files_written: totalFiles,
        failures,
        error: passed ? null : `${failures.length} required corpus live update item(s) failed.`,
      };
    } catch (error_) {
      return {
        status: "failed",
        groups,
        selected_count: 0,
        planned_count: 0,
        refreshed_count: 0,
        failed_count: 0,
        task_created_count: 0,
        task_done_count: 0,
        docs_ready_count: 0,
        search_ready_count: 0,
        coverage_required: coverageRequired,
        coverage_ready_count: 0,
        total_pages_ingested: 0,
        total_chunks_indexed: 0,
        total_files_written: 0,
        failures: [],
        error: error_ instanceof Error ? error_.message : String(error_),
      };
    }
  });
}

export function selectSeedSmokeSeeds(input: {
  groups?: SeedSmokeGroup[];
  slugs?: string[];
  limit?: number;
} = {}): SeedLibrary[] {
  const groups: SeedSmokeGroup[] = input.groups?.length ? input.groups : ["llm"];
  return selectSeedLibraries({
    groups,
    slugs: input.slugs,
    limit: input.limit ?? 6,
    refreshableOnly: true,
  });
}

export function selectRequiredCorpusSmokeSeeds(input: {
  groups?: SeedSmokeGroup[];
} = {}): SeedLibrary[] {
  const groups: SeedSmokeGroup[] = input.groups?.length ? input.groups : ["all"];
  const slugs = requiredCorpusSmokeSlugs(groups);
  const bySlug = new Map(SEED_LIBRARIES.map((seed) => [seed.slug, seed]));
  return slugs
    .map((slug) => bySlug.get(slug))
    .filter((seed): seed is SeedLibrary => Boolean(seed));
}

export function requiredCorpusSmokeSlugs(groups: SeedSmokeGroup[] = ["all"]): string[] {
  const includeAll = groups.length === 0 || groups.includes("all");
  const slugs: string[] = [];
  if (includeAll || groups.includes("llm")) slugs.push(...REQUIRED_LLM_SEED_SLUGS);
  if (includeAll || groups.includes("saas")) slugs.push(...REQUIRED_SAAS_SEED_SLUGS);
  return [...new Set(slugs)];
}

async function runSmokeCases(
  cases: SmokeCase[],
  maxPages: number,
  options: SmokeCoverageOptions = {}
): Promise<SourceSmokeCaseResult[]> {
  const coverageRequired = Boolean(options.requireFullDocs);
  const concurrency = normalizeSmokeConcurrency(options.concurrency);
  const caseTimeoutMs = normalizeSmokeCaseTimeoutMs(options.caseTimeoutMs);
  const results = new Array<SourceSmokeCaseResult>(cases.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      const item = cases[index];
      if (!item) return;
      results[index] = await runSmokeCase(item, maxPages, coverageRequired, caseTimeoutMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, cases.length)) }, () => worker())
  );
  return results;
}

async function runSmokeCase(
  item: SmokeCase,
  maxPages: number,
  coverageRequired: boolean,
  caseTimeoutMs: number
): Promise<SourceSmokeCaseResult> {
  if (!canRunRetriever(item.retriever, item.retriever_only)) {
    return emptySmokeCaseResult(
      item,
      maxPages,
      coverageRequired,
      "skipped",
      `${item.retriever.toUpperCase()} API key is not configured`
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = caseTimeoutMs > 0
    ? new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`Smoke case timed out after ${caseTimeoutMs}ms`));
      }, caseTimeoutMs)
    })
    : null;

  try {
    const library = createLibrary({
      name: item.name,
      slug: item.id,
      docs_url: item.docs_url,
      npm_package: item.npm_package,
      source_type: item.source_type,
      source_url: item.source_url,
      freshness_days: 1,
    });
    if (process.env["CONTEXT_VERIFY_DEBUG"] === "1") {
      console.error(JSON.stringify({
        id: item.id,
        source_type: library.source_type,
        source_url: library.source_url,
        docs_url: library.docs_url,
        retrieverOnly: item.retriever_only,
      }));
    }
    const refreshPromise = refreshDocumentationSource(library.id, {
      maxPages,
      retriever: item.retriever,
      retrieverOnly: item.retriever_only,
      retrievers: buildSmokeRetrievers(item),
      signal: controller.signal,
      retrieverTimeoutMs: caseTimeoutMs,
    });
    if (timeoutPromise) refreshPromise.catch(() => undefined);
    const result = await (timeoutPromise ? Promise.race([refreshPromise, timeoutPromise]) : refreshPromise);
    const hits = searchChunks(item.query, library.id, 3);
    const failureReasons = smokeFailureReasons(result, hits.length, item.query);
    const coverageIssues = coverageFailureReasons(result, item);
    if (coverageRequired) failureReasons.push(...coverageIssues);
    const passed = failureReasons.length === 0;

    return {
      id: item.id,
      name: item.name,
      source_type: item.source_type,
      retriever: item.retriever,
      retriever_only: item.retriever_only,
      status: passed ? "passed" : "failed",
      pages_ingested: result.pages_ingested,
      max_pages: result.max_pages,
      pages_retrieved: result.pages_retrieved,
      page_limit_reached: result.page_limit_reached,
      full_docs_detected: result.full_docs_detected,
      coverage_required: coverageRequired,
      coverage_passed: !coverageRequired || coverageIssues.length === 0,
      coverage_issues: coverageIssues,
      chunks_indexed: result.chunks_indexed,
      files_written: result.files_written,
      search_hits: hits.length,
      retrieved_by: result.retrieved_by,
      source_discovery: result.source_discovery,
      error: passed ? null : failureReasons.join("; "),
    };
  } catch (error_) {
    const message = timedOut
      ? `Smoke case timed out after ${caseTimeoutMs}ms`
      : error_ instanceof Error ? error_.message : String(error_);
    return emptySmokeCaseResult(
      item,
      maxPages,
      coverageRequired,
      "failed",
      message
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function emptySmokeCaseResult(
  item: SmokeCase,
  maxPages: number,
  coverageRequired: boolean,
  status: VerificationSmokeStatus,
  error: string
): SourceSmokeCaseResult {
  return {
    id: item.id,
    name: item.name,
    source_type: item.source_type,
    retriever: item.retriever,
    retriever_only: item.retriever_only,
    status,
    pages_ingested: 0,
    max_pages: maxPages,
    pages_retrieved: 0,
    page_limit_reached: false,
    full_docs_detected: false,
    coverage_required: coverageRequired,
    coverage_passed: !coverageRequired,
    coverage_issues: coverageRequired ? ["No refresh result was produced"] : [],
    chunks_indexed: 0,
    files_written: 0,
    search_hits: 0,
    retrieved_by: null,
    source_discovery: null,
    error,
  };
}

function normalizeSmokeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SMOKE_CONCURRENCY;
  return Math.max(1, Math.min(MAX_SMOKE_CONCURRENCY, Math.floor(value)));
}

function normalizeSmokeCaseTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SMOKE_CASE_TIMEOUT_MS;
  return Math.max(0, Math.min(MAX_SMOKE_CASE_TIMEOUT_MS, Math.floor(value)));
}

function smokeFailureReasons(
  result: SourceRefreshResult,
  searchHits: number,
  query: string
): string[] {
  const reasons: string[] = [];
  if (result.pages_ingested <= 0) reasons.push("No documentation pages were ingested");
  if (result.chunks_indexed <= 0) reasons.push("No SQLite chunks were indexed");
  if (result.files_written <= 0) reasons.push("No local Markdown docs artifacts were written");
  if (searchHits <= 0) reasons.push(`No search hits for ${query}`);
  return reasons;
}

function coverageFailureReasons(
  result: SourceRefreshResult,
  item: Pick<SmokeCase, "source_type">
): string[] {
  const reasons: string[] = [];
  if (result.page_limit_reached) {
    reasons.push(
      `Page budget was saturated (${result.pages_retrieved}/${result.max_pages}); increase --pages to validate full docs.`
    );
  }
  if (item.source_type === "llms_txt" && !result.full_docs_detected) {
    reasons.push("Full documentation coverage was not detected for llms_txt source.");
  }
  return reasons;
}

function buildSmokeRetrievers(item: SmokeCase): Partial<SourceRefreshRetrievers> | undefined {
  const retrievers: Partial<SourceRefreshRetrievers> = {};

  if (item.native_pages) {
    retrievers.native = async (_library, options) =>
      (item.native_pages ?? []).slice(0, options.maxPages ?? item.native_pages?.length ?? 0);
  }

  if (item.discovered_url) {
    retrievers.discoverUrls = async () => [
      {
        url: item.discovered_url!,
        title: `${item.name} Docs`,
        score: 10,
        query: `${item.name} documentation guide`,
        source: "exa",
      },
    ];
  }

  if (item.retriever_pages) {
    const getPages = async () => item.retriever_pages ?? [];
    retrievers.firecrawl = getPages;
    retrievers.exa = getPages;
  }

  return Object.keys(retrievers).length > 0 ? retrievers : undefined;
}

function seedToSmokeCase(seed: SeedLibrary, retriever: ExternalRetrieverType): SmokeCase {
  const source = getSeedSourceMetadata(seed);
  const sourceType = source.source_type ?? (seed.tags.includes("api") ? "api" : "docs");
  const sourceUrl = source.source_url ?? seed.docs_url;

  return {
    id: `seed-${seed.slug}`,
    name: seed.name,
    source_type: sourceType as LibrarySourceType,
    source_url: sourceUrl ?? seed.docs_url ?? `https://example.invalid/${seed.slug}`,
    docs_url: seed.docs_url,
    npm_package: seed.npm_package,
    query: seedSearchQuery(seed),
    retriever,
    retriever_only: false,
  };
}

export function seedSearchQuery(seed: SeedLibrary): string {
  const tokens = [
    ...(seed.name.match(/[a-zA-Z0-9]+/g) ?? []),
    ...(seed.slug.match(/[a-zA-Z0-9]+/g) ?? []),
  ];
  return tokens.find((token) => token.length >= 3) ?? seed.slug;
}

async function runAiSmoke(provider: AiProviderId | "default"): Promise<AiSmokeResult> {
  try {
    const result = await generateWithAiSdk({
      provider: provider === "default" ? undefined : provider,
      prompt: "Reply with exactly: ok",
    });
    return {
      status: result.text.trim().toLowerCase() === "ok" ? "passed" : "failed",
      backend: result.provider,
      model: result.model,
      text: result.text,
      error: result.text.trim().toLowerCase() === "ok" ? null : "AI smoke did not return the expected text.",
    };
  } catch (error_) {
    return {
      status: "failed",
      backend: provider === "default" ? null : provider,
      model: null,
      text: null,
      error: error_ instanceof Error ? error_.message : String(error_),
    };
  }
}

async function withTemporaryContextState<T>(fn: () => Promise<T>): Promise<T> {
  const temp = mkdtempSync(join(tmpdir(), "context-verify-"));
  const oldHome = process.env["HOME"];
  const oldDb = process.env["HASNA_CONTEXT_DB_PATH"];
  const oldContextDb = process.env["CONTEXT_DB_PATH"];

  try {
    process.env["HOME"] = join(temp, "home");
    process.env["HASNA_CONTEXT_DB_PATH"] = join(temp, "context.db");
    process.env["CONTEXT_DB_PATH"] = join(temp, "context.db");
    resetDatabase();
    return await fn();
  } finally {
    resetDatabase();
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    if (oldDb === undefined) delete process.env["HASNA_CONTEXT_DB_PATH"];
    else process.env["HASNA_CONTEXT_DB_PATH"] = oldDb;
    if (oldContextDb === undefined) delete process.env["CONTEXT_DB_PATH"];
    else process.env["CONTEXT_DB_PATH"] = oldContextDb;
    rmSync(temp, { recursive: true, force: true });
    resetDatabase();
  }
}

function canRunRetriever(retriever: ExternalRetrieverType, retrieverOnly: boolean): boolean {
  if (!retrieverOnly) return true;
  if (retriever === "exa") return Boolean(process.env["EXA_API_KEY"]);
  if (retriever === "firecrawl") return Boolean(process.env["FIRECRAWL_API_KEY"]);
  return false;
}

function getRetrieverKeyStatus(): { exa: boolean; firecrawl: boolean } {
  return {
    exa: Boolean(process.env["EXA_API_KEY"]),
    firecrawl: Boolean(process.env["FIRECRAWL_API_KEY"]),
  };
}

function getDefaultRetrieverFromEnv(): ExternalRetrieverType {
  return getDefaultExternalRetriever();
}

function error(code: string, message: string): VerificationIssue {
  return { code, severity: "error", message };
}
