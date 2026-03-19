export interface Library {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  npm_package: string | null;
  github_repo: string | null;
  docs_url: string | null;
  version: string | null;
  chunk_count: number;
  document_count: number;
  last_crawled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  library_id: string;
  url: string;
  title: string | null;
  content: string | null;
  parsed_at: string | null;
  created_at: string;
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

export interface CreateLibraryInput {
  name: string;
  slug?: string;
  description?: string;
  npm_package?: string;
  github_repo?: string;
  docs_url?: string;
  version?: string;
}

export interface CrawlResult {
  library_id: string;
  pages_crawled: number;
  chunks_indexed: number;
  errors: string[];
}

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

export class MissingApiKeyError extends ContextError {
  constructor() {
    super(
      "EXA_API_KEY environment variable is required. Get a key at https://exa.ai",
      "MISSING_API_KEY"
    );
  }
}
