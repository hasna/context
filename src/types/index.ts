export type LibrarySourceType =
  | "docs"
  | "website"
  | "llms_txt"
  | "openapi"
  | "github"
  | "npm"
  | "api"
  | "manual";

export interface Library {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  npm_package: string | null;
  github_repo: string | null;
  docs_url: string | null;
  version: string | null;
  source_type: LibrarySourceType;
  source_url: string | null;
  freshness_days: number;
  priority: number;
  chunk_count: number;
  document_count: number;
  last_crawled_at: string | null;
  last_checked_at: string | null;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  library_id: string;
  url: string;
  title: string | null;
  content: string | null;
  content_hash: string | null;
  file_path: string | null;
  source_type: LibrarySourceType;
  status: string;
  metadata: Record<string, unknown>;
  parsed_at: string | null;
  discovered_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Chunk {
  id: string;
  library_id: string;
  document_id: string;
  content: string;
  position: number;
  token_count: number | null;
  created_at: string;
}

export interface SearchResult {
  chunk_id: string;
  library_id: string;
  document_id: string;
  content: string;
  url: string | null;
  title: string | null;
  score: number;
}

export interface ApiEndpointParameter {
  name: string | null;
  in: string | null;
  required: boolean;
  description: string | null;
  schema?: ApiSchemaSummary | null;
}

export interface ApiEndpointRequestBody {
  required: boolean;
  description: string | null;
  content_types?: string[];
  schemas?: Record<string, ApiSchemaSummary>;
}

export interface ApiEndpointResponse {
  description: string | null;
  content_types?: string[];
  schemas?: Record<string, ApiSchemaSummary>;
}

export interface ApiSchemaProperty {
  name: string;
  type: string | null;
  ref: string | null;
  description: string | null;
  required: boolean;
}

export interface ApiSchemaSummary {
  name: string | null;
  type: string | null;
  ref: string | null;
  description: string | null;
  required: string[];
  properties: ApiSchemaProperty[];
  enum?: string[];
  items?: ApiSchemaSummary | null;
}

export interface ApiEndpoint {
  id: string;
  library_id: string;
  document_id: string;
  url: string;
  method: string;
  path: string;
  operation_id: string | null;
  summary: string | null;
  description: string | null;
  tags: string[];
  parameters: ApiEndpointParameter[];
  request_body: ApiEndpointRequestBody | null;
  responses: Record<string, ApiEndpointResponse>;
  source_format: "json" | "yaml" | "raw" | string;
  spec_version: string | null;
  api_version: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface ApiEndpointInput {
  url: string;
  method: string;
  path: string;
  operation_id?: string | null;
  summary?: string | null;
  description?: string | null;
  tags?: string[];
  parameters?: ApiEndpointParameter[];
  request_body?: ApiEndpointRequestBody | null;
  responses?: Record<string, ApiEndpointResponse>;
  source_format?: "json" | "yaml" | "raw" | string;
  spec_version?: string | null;
  api_version?: string | null;
  content: string;
}

export interface ApiEndpointSearchResult extends ApiEndpoint {
  score: number | null;
}

export interface SourceRefreshEmbeddingReport {
  generated_at: string;
  library_id: string;
  library_slug: string;
  library_name: string;
  provider: string;
  model: string;
  total_chunks: number;
  previously_embedded: number;
  selected_chunks: number;
  embedded_count: number;
  failed_count: number;
  failures: Array<{ chunk_id: string; error: string }>;
}

export interface CreateLibraryInput {
  name: string;
  slug?: string;
  description?: string;
  npm_package?: string;
  github_repo?: string;
  docs_url?: string;
  version?: string;
  source_type?: LibrarySourceType | string;
  source_url?: string;
  freshness_days?: number;
  priority?: number;
}

export interface SourceRefreshResult {
  library_id: string;
  source_type: LibrarySourceType;
  ingest_mode: "native" | "crawler";
  retriever: string;
  retrieved_by: string;
  /** @deprecated Use retriever/external_retriever. Kept for CLI/API compatibility. */
  crawler: string;
  external_retriever: "exa" | "firecrawl" | null;
  pages_ingested: number;
  /** @deprecated Use pages_ingested. */
  pages_crawled: number;
  max_pages: number;
  pages_retrieved: number;
  page_limit_reached: boolean;
  full_docs_detected: boolean;
  chunks_indexed: number;
  api_endpoints_indexed: number;
  files_written: number;
  refreshed_at: string;
  errors: string[];
  embeddings: SourceRefreshEmbeddingReport | null;
  source_discovery: {
    status: "skipped" | "found" | "not_found" | "failed";
    provider: "exa";
    url: string | null;
    title: string | null;
    query: string | null;
    candidates: Array<{ url: string; title: string | null; score: number }>;
    error: string | null;
  } | null;
}

/** @deprecated Use SourceRefreshResult. */
export type CrawlResult = SourceRefreshResult;

export interface QueryDocsResult {
  library_id: string;
  library_name: string;
  chunks: Array<{
    content: string;
    url: string | null;
    title: string | null;
  }>;
}

export class ContextError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "ContextError";
  }
}

export class LibraryNotFoundError extends ContextError {
  constructor(slug: string) {
    super(`Library not found: ${slug}`, "LIBRARY_NOT_FOUND");
  }
}

export class CrawlError extends ContextError {
  constructor(message: string) {
    super(message, "CRAWL_ERROR");
  }
}

export class EmptyCrawlError extends CrawlError {
  constructor(message: string) {
    super(message);
    this.name = "EmptyCrawlError";
  }
}

export class MissingApiKeyError extends ContextError {
  constructor() {
    super(
      "EXA_API_KEY environment variable is required. Get a key at https://exa.ai",
      "MISSING_API_KEY"
    );
  }
}
