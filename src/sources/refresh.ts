import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { getLibraryById, syncLibraryCounts, updateLibraryCounts, updateLibrarySource } from "../db/libraries.js";
import { deleteDocumentsForLibrary, listDocuments, upsertDocument } from "../db/documents.js";
import {
  insertChunk,
  deleteChunksForDocument,
  deleteChunksForLibrary,
} from "../db/chunks.js";
import {
  deleteApiEndpointsForLibrary,
  replaceDocumentApiEndpoints,
  syncApiEndpointsToKnowledgeGraph,
} from "../db/api-endpoints.js";
import { discoverDocs } from "../crawler/exa.js";
import { discoverDocumentationUrls } from "../crawler/exa.js";
import type { DocumentationUrlCandidate } from "../crawler/exa.js";
import type { RetrievedPage } from "../crawler/types.js";
import { discoverDocsFirecrawl } from "../crawler/firecrawl.js";
import { cleanText, splitIntoChunks, deduplicateChunks, estimateTokens } from "../crawler/parser.js";
import { hashContent, saveDocumentVersion } from "../db/versions.js";
import { clearLibraryDocumentArtifacts, writeDocumentArtifact, writeLibraryDocsManifest } from "../docs/artifacts.js";
import { markPendingDocUpdateTasksDone } from "../db/update-tasks.js";
import { emitWebhookEvent } from "../db/webhooks.js";
import { ingestNativeSource } from "./ingest.js";
import { embedLibraryChunks } from "../semantic/index.js";
import { EmptyCrawlError, type SourceRefreshResult } from "../types/index.js";
import type { ApiEndpoint, ApiEndpointInput, Library } from "../types/index.js";
import type { SourcePage } from "./ingest.js";

export type ExternalRetrieverType = "exa" | "firecrawl";
export type SourceDiscoveryProvider = "exa";

export function parseExternalRetriever(value: string | null | undefined): ExternalRetrieverType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "firecrawl" || normalized === "exa") return normalized;
  return undefined;
}

export function resolveExternalRetriever(
  value: string | null | undefined,
  fallback?: ExternalRetrieverType
): ExternalRetrieverType {
  const parsed = parseExternalRetriever(value);
  if (parsed) return parsed;
  if (!value) return fallback ?? getDefaultExternalRetriever();
  throw new Error(`Invalid retriever "${value}". Expected firecrawl or exa.`);
}

export function getDefaultExternalRetriever(): ExternalRetrieverType {
  const env = process.env["CONTEXT_RETRIEVER"] ?? process.env["CONTEXT_CRAWLER"];
  const retriever = parseExternalRetriever(env);
  if (retriever) return retriever;
  if (env) throw new Error(`Invalid retriever "${env}". Expected firecrawl or exa.`);
  return "firecrawl";
}

export interface SourceRefreshOptions {
  maxPages?: number;
  refresh?: boolean;
  retriever?: ExternalRetrieverType;
  /** @deprecated Use retriever. */
  crawler?: ExternalRetrieverType;
  retrieverOnly?: boolean;
  writeFiles?: boolean;
  embed?: boolean;
  embedAll?: boolean;
  embedLimit?: number;
  signal?: AbortSignal;
  retrieverTimeoutMs?: number;
  retrievers?: Partial<SourceRefreshRetrievers>;
}

export type ExternalSourceRetriever = (options: {
  name: string;
  npm_package?: string | null;
  docs_url?: string | null;
  source_url?: string | null;
  github_repo?: string | null;
  maxPages?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<Array<SourcePage | RetrievedPage>>;

export type SourceUrlDiscovery = (options: {
  name: string;
  npm_package?: string | null;
  github_repo?: string | null;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<DocumentationUrlCandidate[]>;

export interface SourceRefreshRetrievers {
  native: (library: Library, options: { maxPages?: number; signal?: AbortSignal }) => Promise<SourcePage[] | null>;
  exa: ExternalSourceRetriever;
  firecrawl: ExternalSourceRetriever;
  discoverUrls: SourceUrlDiscovery;
}

interface PreparedRefreshPage {
  page: SourcePage | RetrievedPage;
  cleaned: string;
  contentHash: string;
  chunks: string[];
}

export async function refreshDocumentationSource(
  libraryId: string,
  options: SourceRefreshOptions = {},
  db?: Database
): Promise<SourceRefreshResult> {
  const database = db ?? getDatabase();
  let library = getLibraryById(libraryId, database);
  const retriever = resolveExternalRetriever(options.retriever ?? options.crawler);
  const maxPages = options.maxPages ?? 30;
  const refreshedAt = new Date().toISOString();
  const retrievers: SourceRefreshRetrievers = {
    native: options.retrievers?.native ?? ingestNativeSource,
    exa: options.retrievers?.exa ?? discoverDocs,
    firecrawl: options.retrievers?.firecrawl ?? discoverDocsFirecrawl,
    discoverUrls: options.retrievers?.discoverUrls ?? discoverDocumentationUrls,
  };

  const result: SourceRefreshResult = {
    library_id: libraryId,
    source_type: library.source_type,
    ingest_mode: "crawler",
    retriever,
    retrieved_by: retriever,
    crawler: retriever,
    external_retriever: retriever,
    pages_ingested: 0,
    pages_crawled: 0,
    max_pages: maxPages,
    pages_retrieved: 0,
    page_limit_reached: false,
    full_docs_detected: false,
    chunks_indexed: 0,
    api_endpoints_indexed: 0,
    files_written: 0,
    refreshed_at: refreshedAt,
    errors: [],
    embeddings: null,
    source_discovery: null,
  };

  let pages: Array<SourcePage | RetrievedPage>;
  let retrievedBy: string = retriever;
  try {
    const discovered = await discoverMissingSourceUrl(
      library,
      retrievers,
      result,
      options.signal,
      options.retrieverTimeoutMs
    );
    if (discovered) {
      library = updateLibrarySource(
        library.id,
        {
          docs_url: discovered.url,
          source_url: discovered.url,
          source_type: library.source_type === "manual" ? "docs" : library.source_type,
        },
        database
      );
    }

    throwIfAborted(options.signal);
    const shouldSkipNative = options.retrieverOnly
      || (retriever === "firecrawl" && result.source_discovery?.status === "found")
      || !hasNativeRefreshAddress(library);
    const nativePages = shouldSkipNative
      ? null
      : await retrievers.native(library, {
          maxPages,
          signal: options.signal,
        });

    throwIfAborted(options.signal);
    if (nativePages && nativePages.length > 0) {
      pages = nativePages;
      retrievedBy = `native:${library.source_type}`;
      result.ingest_mode = "native";
      result.retriever = retrievedBy;
      result.retrieved_by = retrievedBy;
      result.crawler = retrievedBy;
      result.external_retriever = null;
    } else if (retriever === "firecrawl") {
      pages = await retrievers.firecrawl({
        name: library.name,
        npm_package: library.npm_package,
        docs_url: library.docs_url,
        source_url: library.source_url,
        github_repo: library.github_repo,
        maxPages,
        signal: options.signal,
        timeoutMs: options.retrieverTimeoutMs,
      });
    } else {
      pages = await retrievers.exa({
        name: library.name,
        npm_package: library.npm_package,
        docs_url: library.docs_url,
        source_url: library.source_url,
        github_repo: library.github_repo,
        maxPages,
        signal: options.signal,
        timeoutMs: options.retrieverTimeoutMs,
      });
    }
  } catch (err) {
    result.errors.push(
      `Failed to ingest source (${retrievedBy}): ${err instanceof Error ? err.message : String(err)}`
    );
    await emitRefreshWebhook("docs.refresh_failed", library, result);
    throw new EmptyCrawlError(result.errors[0] ?? `Failed to ingest source with ${retrievedBy}`);
  }

  result.pages_retrieved = pages.length;
  result.full_docs_detected = pages.some(isFullDocsPage);
  result.page_limit_reached = maxPages > 0 && pages.length >= maxPages && !result.full_docs_detected;

  const preparedPages: PreparedRefreshPage[] = [];
  for (const page of pages) {
    try {
      await yieldIfAbortable(options.signal);
      const cleaned = cleanText(page.text);
      if (!cleaned || cleaned.length < 100) continue;
      await yieldIfAbortable(options.signal);
      const contentHash = hashContent(cleaned);
      const rawChunks = splitIntoChunks(cleaned);
      const chunks = deduplicateChunks(rawChunks, 0.85);
      if (chunks.length === 0) continue;
      await yieldIfAbortable(options.signal);
      preparedPages.push({ page, cleaned, contentHash, chunks });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      result.errors.push(
        `Error preparing ${page.url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throwIfAborted(options.signal);

  if (preparedPages.length === 0) {
    syncLibraryCounts(libraryId, database);
    const reason = result.errors[0] ?? `No usable documentation pages were ingested for ${library.name}`;
    result.errors.push(reason);
    await emitRefreshWebhook("docs.refresh_failed", library, result);
    throw new EmptyCrawlError(reason);
  }

  if (options.refresh) {
    clearLibraryDocumentArtifacts(library.slug);
    deleteDocumentsForLibrary(libraryId, database);
    deleteChunksForLibrary(libraryId, database);
    deleteApiEndpointsForLibrary(libraryId, database);
  }

  const indexedApiEndpointsForGraph: ApiEndpoint[] = [];

  for (const prepared of preparedPages) {
    const { page, cleaned, contentHash, chunks } = prepared;
    try {
      let filePath: string | undefined;
      const pageMetadata = publicPageMetadata(page);

      if (options.writeFiles !== false) {
        try {
          const artifact = writeDocumentArtifact({
            librarySlug: library.slug,
            libraryName: library.name,
            url: page.url,
            title: page.title ?? undefined,
            content: cleaned,
            contentHash,
            retrievedBy,
            sourceType: library.source_type,
            sourceUrl: library.source_url,
            freshnessDays: library.freshness_days,
            refreshedAt: result.refreshed_at,
            metadata: {
              npm_package: library.npm_package,
              github_repo: library.github_repo,
              docs_url: library.docs_url,
              source_url: library.source_url,
              source_discovery: result.source_discovery,
              ...(pageMetadata ?? {}),
            },
          });
          filePath = artifact.relativePath;
          result.files_written++;
        } catch (err) {
          result.errors.push(
            `Error writing docs artifact for ${page.url}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const doc = upsertDocument(
        {
          library_id: libraryId,
          url: page.url,
          title: page.title ?? undefined,
          content: cleaned,
          content_hash: contentHash,
          file_path: filePath,
          source_type: library.source_type,
          status: "active",
          metadata: {
            retrieved_by: retrievedBy,
            refreshed_at: result.refreshed_at,
            source_url: library.source_url,
            source_discovery: result.source_discovery,
            ...(pageMetadata ?? {}),
          },
        },
        database
      );

      const apiEndpoints = openApiEndpointsFromPage(page);
      const indexedEndpoints = replaceDocumentApiEndpoints(
        {
          library_id: libraryId,
          document_id: doc.id,
          endpoints: apiEndpoints,
        },
        database
      );
      result.api_endpoints_indexed += indexedEndpoints.length;
      indexedApiEndpointsForGraph.push(...indexedEndpoints);

      saveDocumentVersion(
        {
          document_id: doc.id,
          url: page.url,
          title: page.title ?? undefined,
          content: cleaned,
        },
        database
      );

      deleteChunksForDocument(doc.id, database);

      for (let i = 0; i < chunks.length; i++) {
        if (i % 25 === 0) await yieldIfAbortable(options.signal);
        const chunk = chunks[i];
        if (!chunk) continue;
        insertChunk(
          {
            library_id: libraryId,
            document_id: doc.id,
            content: chunk,
            position: i,
            token_count: estimateTokens(chunk),
          },
          database
        );
        result.chunks_indexed++;
      }

      result.pages_ingested++;
      result.pages_crawled = result.pages_ingested;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      result.errors.push(
        `Error processing ${page.url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throwIfAborted(options.signal);

  syncApiEndpointsToKnowledgeGraph(library, indexedApiEndpointsForGraph, database);

  updateLibraryCounts(libraryId, database);
  if (options.writeFiles !== false) {
    try {
      writeLibraryDocsManifest({
        library,
        documents: listDocuments(libraryId, database),
        endpoints: indexedApiEndpointsForGraph,
        refresh: result,
      });
    } catch (err) {
      result.errors.push(
        `Error writing docs manifest for ${library.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (options.embed) {
    try {
      result.embeddings = await embedLibraryChunks(
        libraryId,
        {
          all: options.embedAll,
          limit: options.embedLimit,
        },
        database
      );
      if (result.embeddings.failed_count > 0) {
        throw new Error(`${result.embeddings.failed_count} chunk embedding(s) failed`);
      }
    } catch (err) {
      const reason = `Embedding failed for ${library.name}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(reason);
      await emitRefreshWebhook("docs.refresh_failed", library, result);
      throw new EmptyCrawlError(reason);
    }
  }

  markPendingDocUpdateTasksDone(libraryId, "refresh", database);
  await emitRefreshWebhook("docs.refreshed", library, result);

  return result;
}

export const crawlLibrary = refreshDocumentationSource;

async function discoverMissingSourceUrl(
  library: Library,
  retrievers: SourceRefreshRetrievers,
  result: SourceRefreshResult,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<DocumentationUrlCandidate | null> {
  if (
    library.docs_url ||
    library.source_url ||
    library.source_type === "npm" ||
    library.source_type === "github" ||
    library.source_type === "manual"
  ) {
    result.source_discovery = {
      status: "skipped",
      provider: "exa",
      url: null,
      title: null,
      query: null,
      candidates: [],
      error: null,
    };
    return null;
  }

  try {
    const candidates = await retrievers.discoverUrls({
      name: library.name,
      npm_package: library.npm_package,
      github_repo: library.github_repo,
      limit: 5,
      signal,
      timeoutMs,
    });
    const candidate = candidates[0] ?? null;
    result.source_discovery = {
      status: candidate ? "found" : "not_found",
      provider: "exa",
      url: candidate?.url ?? null,
      title: candidate?.title ?? null,
      query: candidate?.query ?? null,
      candidates: candidates.map(({ url, title, score }) => ({ url, title, score })),
      error: null,
    };
    if (!candidate) {
      result.errors.push(`Source discovery via Exa found no candidate documentation URLs for ${library.name}.`);
    }
    return candidate;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.source_discovery = {
      status: "failed",
      provider: "exa",
      url: null,
      title: null,
      query: null,
      candidates: [],
      error: message,
    };
    result.errors.push(`Source discovery via Exa failed for ${library.name}: ${message}`);
    return null;
  }
}

function hasNativeRefreshAddress(library: Library): boolean {
  switch (library.source_type) {
    case "docs":
    case "website":
    case "api":
    case "llms_txt":
    case "openapi":
      return Boolean(library.source_url ?? library.docs_url);
    case "npm":
      return Boolean(library.npm_package ?? library.source_url);
    case "github":
      return Boolean(library.github_repo ?? library.source_url ?? library.docs_url);
    case "manual":
      return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Source refresh was aborted");
}

function publicPageMetadata(page: SourcePage | RetrievedPage): Record<string, unknown> | undefined {
  const metadata = pageMetadata(page);
  if (!metadata) return undefined;
  const { openapi_endpoints: _openapiEndpoints, ...publicMetadata } = metadata;
  return publicMetadata;
}

function openApiEndpointsFromPage(page: SourcePage | RetrievedPage): ApiEndpointInput[] {
  const endpoints = pageMetadata(page)?.["openapi_endpoints"];
  if (!Array.isArray(endpoints)) return [];
  return endpoints.filter(isApiEndpointInput);
}

function pageMetadata(page: SourcePage | RetrievedPage): Record<string, unknown> | undefined {
  if (!("metadata" in page) || !isRecord(page.metadata)) return undefined;
  return page.metadata;
}

function isApiEndpointInput(value: unknown): value is ApiEndpointInput {
  return (
    isRecord(value) &&
    typeof value["url"] === "string" &&
    typeof value["method"] === "string" &&
    typeof value["path"] === "string" &&
    typeof value["content"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function yieldIfAbortable(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

async function emitRefreshWebhook(
  event: "docs.refreshed" | "docs.refresh_failed",
  library: ReturnType<typeof getLibraryById>,
  result: SourceRefreshResult
): Promise<void> {
  try {
    await emitWebhookEvent(event, {
      library_id: library.id,
      library_slug: library.slug,
      library_name: library.name,
      source_type: result.source_type,
      ingest_mode: result.ingest_mode,
      retriever: result.retriever,
      retrieved_by: result.retrieved_by,
      crawler: result.crawler,
      external_retriever: result.external_retriever,
      pages_ingested: result.pages_ingested,
      pages_crawled: result.pages_crawled,
      max_pages: result.max_pages,
      pages_retrieved: result.pages_retrieved,
      page_limit_reached: result.page_limit_reached,
      full_docs_detected: result.full_docs_detected,
      chunks_indexed: result.chunks_indexed,
      api_endpoints_indexed: result.api_endpoints_indexed,
      files_written: result.files_written,
      refreshed_at: result.refreshed_at,
      source_discovery: result.source_discovery,
      errors: result.errors,
    });
  } catch {
    // Webhook delivery must not change refresh success semantics.
  }
}

function isFullDocsPage(page: SourcePage | RetrievedPage): boolean {
  if (/\/llms-full\.txt(?:$|[?#])/i.test(page.url) || /(^|\/)llms-full\.txt$/i.test(page.url)) {
    return true;
  }

  if (!("metadata" in page) || !page.metadata) return false;
  return page.metadata["source_role"] === "llms_full_txt" || page.metadata["full_docs_complete"] === true;
}
