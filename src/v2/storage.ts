import { createHash } from "crypto";
import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { listApiEndpoints } from "../db/api-endpoints.js";
import { searchChunks } from "../db/chunks.js";
import { getDocumentById } from "../db/documents.js";
import { listLibraries, resolveLibraryReference } from "../db/libraries.js";
import { searchNodes } from "../db/kg.js";
import type { ApiEndpointSearchResult, Document, Library, SearchResult } from "../types/index.js";
import type {
  ContextHubStorage,
  V2ApiRetrievalRequest,
  V2CitationSpan,
  V2FreshnessStatus,
  V2KnowledgeGraphEvidence,
  V2ResolvedLibrary,
  V2RetrievalEvidence,
  V2RetrievalRequest,
} from "./types.js";

export function createV1ContextHubStorage(db?: Database): ContextHubStorage {
  const database = db ?? getDatabase();

  return {
    resolveLibrary(reference?: string, version?: string | null): V2ResolvedLibrary | null {
      if (!reference?.trim()) return null;
      try {
        const normalized = reference.replace(/^\/context\//, "").replace(/^\//, "").trim();
        return toResolvedLibrary(resolveLibraryReference(normalized, { version }, database));
      } catch {
        return null;
      }
    },

    getFreshness(library: V2ResolvedLibrary | null): V2FreshnessStatus {
      return freshnessForLibrary(library);
    },

    searchText(request: V2RetrievalRequest): V2RetrievalEvidence[] {
      const libraries = libraryMap(database);
      let rows = searchChunks(request.query, request.library_id, request.limit, database);
      if (rows.length === 0) {
        rows = fallbackSearchQueries(request.query)
          .flatMap((query) => searchChunks(query, request.library_id, request.limit, database))
          .filter(uniqueSearchResult())
          .slice(0, request.limit);
      }
      return rows
        .map((row, index) => chunkEvidence(row, index, libraries, database));
    },

    searchApiEndpoints(request: V2ApiRetrievalRequest): V2RetrievalEvidence[] {
      const libraries = libraryMap(database);
      let endpoints = listApiEndpoints({
        libraryId: request.library_id,
        query: request.query,
        limit: request.limit,
      }, database);
      if (endpoints.length === 0 && request.library_id && request.fallback_to_library_endpoints) {
        endpoints = listApiEndpoints({
          libraryId: request.library_id,
          limit: request.limit,
        }, database);
      }
      return endpoints.map((endpoint, index) => endpointEvidence(endpoint, index, libraries, database));
    },

    searchKnowledgeGraph(request: V2RetrievalRequest): V2RetrievalEvidence[] {
      const libraries = libraryMap(database);
      return searchNodes(request.query, database)
        .filter((node) => !request.library_id || node.library_id === request.library_id)
        .slice(0, request.limit)
        .map((node, index) => {
          const library = node.library_id ? libraries.get(node.library_id) ?? null : null;
          const metadata = node.metadata;
          const sourceUrl = metadataString(metadata, "url");
          const citation: V2CitationSpan | null = sourceUrl
            ? {
                source_url: sourceUrl,
                source_title: node.name,
                source_type: library?.source_type ?? null,
                source_revision_id: null,
                source_revision: null,
                source_hash: null,
                artifact_uri: null,
                artifact_path: null,
                library_id: library?.id ?? null,
                library_slug: library?.slug ?? null,
                document_id: null,
                chunk_id: null,
                endpoint_id: metadataString(metadata, "endpoint_id"),
                start_offset: null,
                end_offset: null,
                quote: node.description ?? node.name,
              }
            : null;
          const graph: V2KnowledgeGraphEvidence = {
            node_id: node.id,
            node_type: node.type,
            name: node.name,
            description: node.description,
            metadata,
          };
          return {
            evidence_id: stableId("kg", `${node.id}:${request.query}`),
            channel: "kg",
            kind: "knowledge_graph",
            title: node.name,
            text: node.description ?? node.name,
            score: normalizeScore(null, index),
            scores: { catalog: normalizeScore(null, index) },
            library,
            citation,
            api_endpoint: null,
            knowledge_graph: graph,
            reasons: citation ? ["kg_match", "source_url_present"] : ["kg_match", "navigational_only"],
          };
        });
    },
  };
}

function libraryMap(db: Database): Map<string, V2ResolvedLibrary> {
  return new Map(listLibraries(db).map((library) => [library.id, toResolvedLibrary(library)]));
}

function toResolvedLibrary(library: Library): V2ResolvedLibrary {
  return {
    id: library.id,
    slug: library.slug,
    name: library.name,
    version: library.version,
    source_type: library.source_type,
    source_url: library.source_url,
    docs_url: library.docs_url,
    npm_package: library.npm_package,
    github_repo: library.github_repo,
    freshness_days: library.freshness_days,
    priority: library.priority,
    document_count: library.document_count,
    chunk_count: library.chunk_count,
    last_crawled_at: library.last_crawled_at,
    last_checked_at: library.last_checked_at,
    next_check_at: library.next_check_at,
  };
}

function freshnessForLibrary(library: V2ResolvedLibrary | null): V2FreshnessStatus {
  const checkedAt = new Date().toISOString();
  if (!library) {
    return {
      state: "unknown",
      checked_at: checkedAt,
      last_refreshed_at: null,
      next_check_at: null,
      freshness_days: null,
      warnings: ["No library was selected, so freshness could not be evaluated."],
    };
  }

  if (library.document_count === 0 || library.chunk_count === 0 || !library.last_crawled_at) {
    return {
      state: "empty",
      checked_at: checkedAt,
      last_refreshed_at: library.last_crawled_at,
      next_check_at: library.next_check_at,
      freshness_days: library.freshness_days,
      warnings: [`${library.name} has no indexed documentation chunks yet.`],
    };
  }

  const nextCheck = library.next_check_at ? Date.parse(library.next_check_at) : Number.NaN;
  if (!Number.isNaN(nextCheck) && nextCheck <= Date.now()) {
    return {
      state: "due",
      checked_at: checkedAt,
      last_refreshed_at: library.last_crawled_at,
      next_check_at: library.next_check_at,
      freshness_days: library.freshness_days,
      warnings: [`${library.name} is due for a freshness refresh.`],
    };
  }

  return {
    state: "fresh",
    checked_at: checkedAt,
    last_refreshed_at: library.last_crawled_at,
    next_check_at: library.next_check_at,
    freshness_days: library.freshness_days,
    warnings: [],
  };
}

function chunkEvidence(
  row: SearchResult,
  index: number,
  libraries: Map<string, V2ResolvedLibrary>,
  db: Database
): V2RetrievalEvidence {
  const library = libraries.get(row.library_id) ?? null;
  const document = safeDocument(row.document_id, db);
  const score = normalizeScore(row.score, index);
  return {
    evidence_id: stableId("chunk", `${row.chunk_id}:${row.document_id}:${row.url ?? ""}`),
    channel: "fts",
    kind: "documentation_chunk",
    title: row.title,
    text: row.content,
    score,
    scores: { fts: score },
    library,
    citation: citationForDocument({
      library,
      document,
      sourceUrl: row.url,
      title: row.title,
      quote: row.content,
      chunkId: row.chunk_id,
      endpointId: null,
    }),
    api_endpoint: null,
    knowledge_graph: null,
    reasons: ["fts_match", "v1_chunk"],
  };
}

function endpointEvidence(
  endpoint: ApiEndpointSearchResult,
  index: number,
  libraries: Map<string, V2ResolvedLibrary>,
  db: Database
): V2RetrievalEvidence {
  const library = libraries.get(endpoint.library_id) ?? null;
  const document = safeDocument(endpoint.document_id, db);
  const score = normalizeScore(endpoint.score, index);
  const title = endpoint.operation_id ?? `${endpoint.method} ${endpoint.path}`;
  return {
    evidence_id: stableId("endpoint", endpoint.id),
    channel: "api",
    kind: "api_endpoint",
    title,
    text: endpoint.content,
    score,
    scores: { api: score },
    library,
    citation: citationForDocument({
      library,
      document,
      sourceUrl: endpoint.url,
      title,
      quote: endpoint.content,
      chunkId: null,
      endpointId: endpoint.id,
    }),
    api_endpoint: {
      endpoint_id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      operation_id: endpoint.operation_id,
      summary: endpoint.summary,
      tags: endpoint.tags,
      parameters: endpoint.parameters,
      request_body: endpoint.request_body,
      responses: endpoint.responses,
      source_format: endpoint.source_format,
      spec_version: endpoint.spec_version,
      api_version: endpoint.api_version,
    },
    knowledge_graph: null,
    reasons: endpoint.score === null ? ["api_library_fallback"] : ["api_match"],
  };
}

function citationForDocument(input: {
  library: V2ResolvedLibrary | null;
  document: Document | null;
  sourceUrl: string | null;
  title: string | null;
  quote: string;
  chunkId: string | null;
  endpointId: string | null;
}): V2CitationSpan {
  const metadata = input.document?.metadata ?? {};
  const sourceRevision = metadataString(metadata, "revision") ??
    metadataString(metadata, "version") ??
    metadataString(metadata, "refreshed_at") ??
    input.document?.updated_at ??
    input.document?.parsed_at ??
    null;
  return {
    source_url: input.sourceUrl ?? input.document?.url ?? null,
    source_title: input.title ?? input.document?.title ?? null,
    source_type: input.document?.source_type ?? input.library?.source_type ?? null,
    source_revision_id: input.document?.id ?? null,
    source_revision: sourceRevision,
    source_hash: input.document?.content_hash ?? null,
    artifact_uri: input.document?.file_path ? `context-artifact://${input.document.file_path}` : null,
    artifact_path: input.document?.file_path ?? null,
    library_id: input.library?.id ?? input.document?.library_id ?? null,
    library_slug: input.library?.slug ?? null,
    document_id: input.document?.id ?? null,
    chunk_id: input.chunkId,
    endpoint_id: input.endpointId,
    start_offset: null,
    end_offset: null,
    quote: input.quote,
  };
}

function safeDocument(documentId: string, db: Database): Document | null {
  try {
    return getDocumentById(documentId, db);
  } catch {
    return null;
  }
}

function normalizeScore(score: number | null | undefined, index: number): number {
  if (typeof score === "number" && Number.isFinite(score)) {
    return roundScore(1 / (1 + Math.abs(score)));
  }
  return roundScore(1 / (index + 1));
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function roundScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}

function fallbackSearchQueries(query: string): string[] {
  const dropped = new Set([
    "latest",
    "current",
    "recent",
    "new",
    "newest",
    "today",
    "api",
    "sdk",
    "endpoint",
    "endpoints",
    "docs",
    "documentation",
    "how",
    "integrate",
    "integration",
  ]);
  const terms = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((term) => term.length > 2 && !dropped.has(term))
    .slice(0, 6) ?? [];
  if (terms.length === 0) return [];
  return [terms.join(" "), ...terms];
}

function uniqueSearchResult(): (row: SearchResult) => boolean {
  const seen = new Set<string>();
  return (row: SearchResult) => {
    if (seen.has(row.chunk_id)) return false;
    seen.add(row.chunk_id);
    return true;
  };
}
