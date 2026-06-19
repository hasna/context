import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";
import { getDataDir } from "../db/database.js";
import type { ApiEndpoint, Document, Library, SourceRefreshResult } from "../types/index.js";

export interface DocumentArtifactInput {
  librarySlug: string;
  libraryName: string;
  url: string;
  title?: string | null;
  content: string;
  contentHash: string;
  retrievedBy: string;
  sourceType?: string;
  sourceUrl?: string | null;
  freshnessDays?: number;
  refreshedAt?: string;
  /** @deprecated Use refreshedAt. */
  crawledAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentArtifact {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  contentHash: string;
}

export interface ListedDocumentArtifact {
  relativePath: string;
  absolutePath: string;
  size_bytes: number;
  modified_at: string;
}

export interface LibraryDocsManifest {
  schema_version: 1;
  generated_at: string;
  library: {
    id: string;
    slug: string;
    name: string;
    version: string | null;
    source_type: string;
    source_url: string | null;
    docs_url: string | null;
    npm_package: string | null;
    github_repo: string | null;
    freshness_days: number;
    priority: number;
  };
  refresh: {
    refreshed_at: string;
    retrieved_by: string;
    retriever: string;
    pages_ingested: number;
    pages_retrieved: number;
    page_limit_reached: boolean;
    full_docs_detected: boolean;
    chunks_indexed: number;
    api_endpoints_indexed: number;
    source_discovery: SourceRefreshResult["source_discovery"];
    errors: string[];
  };
  counts: {
    documents: number;
    endpoints: number;
  };
  documents: Array<{
    id: string;
    url: string;
    title: string | null;
    file_path: string | null;
    content_hash: string | null;
    source_type: string;
    status: string;
    parsed_at: string | null;
    discovered_at: string | null;
  }>;
  endpoints: Array<{
    id: string;
    method: string;
    path: string;
    operation_id: string | null;
    summary: string | null;
    url: string;
    tags: string[];
    source_format: string;
    spec_version: string | null;
    api_version: string | null;
  }>;
}

export function getDocsRoot(): string {
  return join(getDataDir(), "docs");
}

export function getLibraryDocsRoot(slug: string): string {
  return join(getDocsRoot(), sanitizePathPart(slug));
}

export function resolveDocumentArtifactPath(relativePath: string): string {
  return join(getDataDir(), relativePath);
}

export function getLibraryDocsManifestPath(slug: string): string {
  return join(getLibraryDocsRoot(slug), "manifest.json");
}

export function writeDocumentArtifact(input: DocumentArtifactInput): DocumentArtifact {
  const root = getLibraryDocsRoot(input.librarySlug);
  mkdirSync(root, { recursive: true });

  const filename = documentFilename(input.url, input.contentHash);
  const absolutePath = join(root, filename);
  const relativePath = relative(getDataDir(), absolutePath);
  const refreshedAt = input.refreshedAt ?? input.crawledAt ?? new Date().toISOString();
  const body = renderMarkdownArtifact(input, refreshedAt);

  writeFileSync(absolutePath, body, "utf-8");
  const stats = statSync(absolutePath);

  return {
    relativePath,
    absolutePath,
    bytes: stats.size,
    contentHash: input.contentHash,
  };
}

export function writeLibraryDocsManifest(input: {
  library: Library;
  documents: Document[];
  endpoints: ApiEndpoint[];
  refresh: SourceRefreshResult;
}): ListedDocumentArtifact {
  const root = getLibraryDocsRoot(input.library.slug);
  mkdirSync(root, { recursive: true });

  const absolutePath = getLibraryDocsManifestPath(input.library.slug);
  const manifest: LibraryDocsManifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    library: {
      id: input.library.id,
      slug: input.library.slug,
      name: input.library.name,
      version: input.library.version,
      source_type: input.library.source_type,
      source_url: input.library.source_url,
      docs_url: input.library.docs_url,
      npm_package: input.library.npm_package,
      github_repo: input.library.github_repo,
      freshness_days: input.library.freshness_days,
      priority: input.library.priority,
    },
    refresh: {
      refreshed_at: input.refresh.refreshed_at,
      retrieved_by: input.refresh.retrieved_by,
      retriever: input.refresh.retriever,
      pages_ingested: input.refresh.pages_ingested,
      pages_retrieved: input.refresh.pages_retrieved,
      page_limit_reached: input.refresh.page_limit_reached,
      full_docs_detected: input.refresh.full_docs_detected,
      chunks_indexed: input.refresh.chunks_indexed,
      api_endpoints_indexed: input.refresh.api_endpoints_indexed,
      source_discovery: input.refresh.source_discovery,
      errors: input.refresh.errors,
    },
    counts: {
      documents: input.documents.length,
      endpoints: input.endpoints.length,
    },
    documents: input.documents.map((document) => ({
      id: document.id,
      url: document.url,
      title: document.title,
      file_path: document.file_path,
      content_hash: document.content_hash,
      source_type: document.source_type,
      status: document.status,
      parsed_at: document.parsed_at,
      discovered_at: document.discovered_at,
    })),
    endpoints: input.endpoints.map((endpoint) => ({
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      operation_id: endpoint.operation_id,
      summary: endpoint.summary,
      url: endpoint.url,
      tags: endpoint.tags,
      source_format: endpoint.source_format,
      spec_version: endpoint.spec_version,
      api_version: endpoint.api_version,
    })),
  };

  writeFileSync(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return listedArtifact(absolutePath);
}

export function readLibraryDocsManifest(slug: string): LibraryDocsManifest | null {
  const absolutePath = getLibraryDocsManifestPath(slug);
  if (!existsSync(absolutePath)) return null;
  return JSON.parse(readFileSync(absolutePath, "utf-8")) as LibraryDocsManifest;
}

export function getLibraryDocsManifestArtifact(slug: string): ListedDocumentArtifact | null {
  const absolutePath = getLibraryDocsManifestPath(slug);
  if (!existsSync(absolutePath)) return null;
  return listedArtifact(absolutePath);
}

export function clearLibraryDocumentArtifacts(slug: string): void {
  const root = getLibraryDocsRoot(slug);
  if (!existsSync(root)) return;
  rmSync(root, { recursive: true, force: true });
}

export function listDocumentArtifacts(slug?: string): ListedDocumentArtifact[] {
  const root = slug ? getLibraryDocsRoot(slug) : getDocsRoot();
  if (!existsSync(root)) return [];

  const files: ListedDocumentArtifact[] = [];
  walkMarkdownFiles(root, files);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function listedArtifact(absolutePath: string): ListedDocumentArtifact {
  const stats = statSync(absolutePath);
  return {
    relativePath: relative(getDataDir(), absolutePath),
    absolutePath,
    size_bytes: stats.size,
    modified_at: stats.mtime.toISOString(),
  };
}

function walkMarkdownFiles(dir: string, files: ListedDocumentArtifact[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(absolutePath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const stats = statSync(absolutePath);
    files.push({
      relativePath: relative(getDataDir(), absolutePath),
      absolutePath,
      size_bytes: stats.size,
      modified_at: stats.mtime.toISOString(),
    });
  }
}

function renderMarkdownArtifact(input: DocumentArtifactInput, refreshedAt: string): string {
  const metadata = {
    library: input.libraryName,
    slug: input.librarySlug,
    url: input.url,
    title: input.title ?? null,
    content_hash: input.contentHash,
    source_type: input.sourceType ?? "docs",
    source_url: input.sourceUrl ?? null,
    freshness_days: input.freshnessDays ?? null,
    retrieved_by: input.retrievedBy,
    refreshed_at: refreshedAt,
    crawled_at: refreshedAt,
    ...input.metadata,
  };

  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value ?? null)}`)
    .join("\n");

  return `---\n${frontmatter}\n---\n\n${input.content.trim()}\n`;
}

function documentFilename(url: string, contentHash: string): string {
  const base = urlToName(url);
  return `${base}-${contentHash}.md`;
}

function urlToName(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = [parsed.hostname, ...parsed.pathname.split("/")]
      .filter(Boolean)
      .join("-");
    return sanitizePathPart(parts || "index").slice(0, 120);
  } catch {
    return sanitizePathPart(url).slice(0, 120) || shortHash(url);
  }
}

function sanitizePathPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
