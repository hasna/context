import type { Database } from "../db/database.js";
import { searchChunks } from "../db/chunks.js";
import { listApiEndpoints } from "../db/api-endpoints.js";
import { listLibraries, resolveLibraryReference } from "../db/libraries.js";
import type { LibrarySourceType } from "../types/index.js";
import type { AiProviderId } from "./providers.js";
import { generateWithAiSdk } from "./providers.js";

export interface DocsContextChunk {
  chunk_id: string;
  library_id: string;
  library_slug: string;
  library_name: string;
  document_id: string;
  title: string | null;
  url: string | null;
  score: number;
  content: string;
}

export interface DocsContextEndpoint {
  id: string;
  library_id: string;
  library_slug: string;
  library_name: string;
  method: string;
  path: string;
  operation_id: string | null;
  summary: string | null;
  url: string;
  score: number | null;
  content: string;
}

export interface BuiltDocsContext {
  prompt: string;
  library: {
    id: string;
    slug: string;
    name: string;
    version: string | null;
    source_type: LibrarySourceType;
    source_url: string | null;
    docs_url: string | null;
    last_crawled_at: string | null;
    next_check_at: string | null;
  } | null;
  chunks: DocsContextChunk[];
  endpoints: DocsContextEndpoint[];
  context_text: string;
  estimated_tokens: number;
}

export interface BuildDocsContextOptions {
  prompt: string;
  library?: string;
  version?: string;
  limit?: number;
  endpointLimit?: number;
  maxTokens?: number;
}

export interface AskDocsOptions extends BuildDocsContextOptions {
  provider?: AiProviderId;
  model?: string;
  system?: string;
  generate?: typeof generateWithAiSdk;
}

export interface AskDocsResult {
  provider: AiProviderId;
  model: string;
  text: string;
  context: BuiltDocsContext;
}

export function buildDocsContext(
  options: BuildDocsContextOptions,
  db?: Database
): BuiltDocsContext {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("A prompt is required to build docs context.");

  const limit = normalizeLimit(options.limit, 5);
  const endpointLimit = normalizeLimit(options.endpointLimit, 5);
  const maxTokens = normalizeLimit(options.maxTokens, 5000);
  const libraries = listLibraries(db);
  const byId = new Map(libraries.map((library) => [library.id, library]));
  const selected = options.library
    ? resolveLibraryReference(options.library, { version: options.version }, db)
    : null;

  const chunkRows = searchChunks(prompt, selected?.id, limit, db);
  const chunks: DocsContextChunk[] = chunkRows.map((chunk) => {
    const library = byId.get(chunk.library_id) ?? selected;
    return {
      ...chunk,
      library_slug: library?.slug ?? chunk.library_id,
      library_name: library?.name ?? chunk.library_id,
    };
  });

  let endpointRows = listApiEndpoints({
    libraryId: selected?.id,
    query: prompt,
    limit: endpointLimit,
  }, db);
  if (endpointRows.length === 0 && selected && endpointLimit > 0) {
    endpointRows = listApiEndpoints({
      libraryId: selected.id,
      limit: endpointLimit,
    }, db);
  }
  const endpoints: DocsContextEndpoint[] = endpointRows.map((endpoint) => {
    const library = byId.get(endpoint.library_id) ?? selected;
    return {
      id: endpoint.id,
      library_id: endpoint.library_id,
      library_slug: library?.slug ?? endpoint.library_id,
      library_name: library?.name ?? endpoint.library_id,
      method: endpoint.method,
      path: endpoint.path,
      operation_id: endpoint.operation_id,
      summary: endpoint.summary,
      url: endpoint.url,
      score: endpoint.score,
      content: endpoint.content,
    };
  });

  const libraryContext = selected
    ? {
        id: selected.id,
        slug: selected.slug,
        name: selected.name,
        version: selected.version,
        source_type: selected.source_type,
        source_url: selected.source_url,
        docs_url: selected.docs_url,
        last_crawled_at: selected.last_crawled_at,
        next_check_at: selected.next_check_at,
      }
    : null;

  const contextText = truncateToTokenBudget(
    formatDocsContext(prompt, chunks, endpoints, libraryContext),
    maxTokens
  );

  return {
    prompt,
    library: libraryContext,
    chunks,
    endpoints,
    context_text: contextText,
    estimated_tokens: estimateTokens(contextText),
  };
}

export async function askDocs(
  options: AskDocsOptions,
  db?: Database
): Promise<AskDocsResult> {
  const context = buildDocsContext(options, db);
  const generate = options.generate ?? generateWithAiSdk;
  const system = options.system ?? [
    "Answer using only the provided documentation context.",
    "If the context does not contain the answer, say what is missing.",
    "Cite source URLs or endpoint identifiers when they are available.",
  ].join(" ");
  const prompt = [
    context.context_text,
    "",
    "# User Question",
    context.prompt,
  ].join("\n");
  const result = await generate({
    prompt,
    provider: options.provider,
    model: options.model,
    system,
  });

  return {
    provider: result.provider,
    model: result.model,
    text: result.text,
    context,
  };
}

function formatDocsContext(
  prompt: string,
  chunks: DocsContextChunk[],
  endpoints: DocsContextEndpoint[],
  library: BuiltDocsContext["library"]
): string {
  const lines = [
    "# Documentation Context",
    "",
    `Query: ${prompt}`,
    "",
  ];

  if (library) {
    lines.push(`Library: ${library.name} (/context/${library.slug})`);
    if (library.version) lines.push(`Version: ${library.version}`);
    lines.push(`Source type: ${library.source_type}`);
    if (library.docs_url) lines.push(`Docs URL: ${library.docs_url}`);
    if (library.source_url && library.source_url !== library.docs_url) lines.push(`Source URL: ${library.source_url}`);
    if (library.last_crawled_at) lines.push(`Last refreshed: ${library.last_crawled_at}`);
    if (library.next_check_at) lines.push(`Next refresh due: ${library.next_check_at}`);
    lines.push("");
  }

  if (chunks.length > 0) {
    lines.push("## Documentation Chunks", "");
    for (const chunk of chunks) {
      lines.push(`### ${chunk.library_name}${chunk.title ? ` - ${chunk.title}` : ""}`);
      if (chunk.url) lines.push(`Source: ${chunk.url}`);
      lines.push("", chunk.content.trim(), "");
    }
  }

  if (endpoints.length > 0) {
    lines.push("## API Endpoints", "");
    for (const endpoint of endpoints) {
      lines.push(`### ${endpoint.library_name} ${endpoint.method} ${endpoint.path}`);
      if (endpoint.operation_id) lines.push(`Operation: ${endpoint.operation_id}`);
      if (endpoint.summary) lines.push(`Summary: ${endpoint.summary}`);
      lines.push(`Source: ${endpoint.url}`, "", endpoint.content.trim(), "");
    }
  }

  if (chunks.length === 0 && endpoints.length === 0) {
    lines.push("No matching indexed documentation or API endpoint context was found.", "");
  }

  return lines.join("\n").trim();
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(1, maxTokens) * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[context truncated at ${maxTokens} tokens]`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
