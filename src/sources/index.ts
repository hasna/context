import type { CreateLibraryInput, LibrarySourceType } from "../types/index.js";

export interface DocumentationSource {
  id: LibrarySourceType;
  name: string;
  origin: "web" | "manifest" | "api_spec" | "repository" | "package" | "manual";
  description: string;
  defaultFreshnessDays: number;
  supportsWebCrawl: boolean;
  nativeIngest: "available" | "planned";
  preferredRetriever?: "firecrawl" | "exa";
  /** @deprecated Use preferredRetriever. */
  preferredCrawler?: "firecrawl" | "exa";
  examples: string[];
}

export class InvalidSourceTypeError extends Error {
  constructor(value: string) {
    super(
      `Unknown documentation source type "${value}". Use one of: ${DOCUMENTATION_SOURCES.map((source) => source.id).join(", ")}.`
    );
    this.name = "InvalidSourceTypeError";
  }
}

export class InvalidSourceUrlError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid ${field} "${value}". Expected an absolute http(s) URL.`);
    this.name = "InvalidSourceUrlError";
  }
}

export interface InferredSourceMetadata {
  source_type: LibrarySourceType;
  docs_url: string | null;
  source_url: string | null;
  freshness_days: number;
}

export const DOCUMENTATION_SOURCES: DocumentationSource[] = [
  {
    id: "docs",
    name: "Documentation Site",
    origin: "web",
    description: "Official documentation website crawled into local Markdown artifacts and SQLite metadata.",
    defaultFreshnessDays: 7,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["https://react.dev/reference/react"],
  },
  {
    id: "website",
    name: "Website",
    origin: "web",
    description: "General website documentation or product docs without a package/repository identity.",
    defaultFreshnessDays: 7,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["https://docs.stripe.com"],
  },
  {
    id: "llms_txt",
    name: "llms.txt",
    origin: "manifest",
    description: "llms.txt or llms-full.txt source list for AI-readable documentation discovery.",
    defaultFreshnessDays: 3,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["https://ai-sdk.dev/llms.txt", "https://docs.anthropic.com/llms.txt"],
  },
  {
    id: "openapi",
    name: "OpenAPI",
    origin: "api_spec",
    description: "OpenAPI/Swagger spec source for API reference ingestion and endpoint-aware search.",
    defaultFreshnessDays: 3,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["https://api.example.com/openapi.json", "https://api.example.com/swagger.yaml"],
  },
  {
    id: "github",
    name: "GitHub Repository",
    origin: "repository",
    description: "Repository-hosted docs, README files, examples, and source references.",
    defaultFreshnessDays: 7,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["facebook/react"],
  },
  {
    id: "npm",
    name: "npm Package",
    origin: "package",
    description: "Package metadata and docs discovered from an npm package identity.",
    defaultFreshnessDays: 1,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["@ai-sdk/openai"],
  },
  {
    id: "api",
    name: "API Documentation",
    origin: "web",
    description: "Hosted API documentation that is not necessarily available as an OpenAPI spec.",
    defaultFreshnessDays: 3,
    supportsWebCrawl: true,
    nativeIngest: "available",
    preferredRetriever: "firecrawl",
    examples: ["https://api.slack.com/docs"],
  },
  {
    id: "manual",
    name: "Manual Source",
    origin: "manual",
    description: "Human-provided or locally curated documentation source.",
    defaultFreshnessDays: 30,
    supportsWebCrawl: false,
    nativeIngest: "planned",
    examples: ["docs/local-file.md"],
  },
];

const SOURCE_BY_ID = new Map(DOCUMENTATION_SOURCES.map((source) => [source.id, source]));

const SOURCE_ALIASES: Record<string, LibrarySourceType> = {
  doc: "docs",
  docs: "docs",
  documentation: "docs",
  site: "website",
  website: "website",
  web: "website",
  llms: "llms_txt",
  "llms.txt": "llms_txt",
  "llms-full.txt": "llms_txt",
  llms_txt: "llms_txt",
  llmstxt: "llms_txt",
  openapi: "openapi",
  "open-api": "openapi",
  swagger: "openapi",
  spec: "openapi",
  github: "github",
  repo: "github",
  repository: "github",
  npm: "npm",
  package: "npm",
  api: "api",
  manual: "manual",
  local: "manual",
};

export function listDocumentationSources(): DocumentationSource[] {
  return DOCUMENTATION_SOURCES;
}

export function getDocumentationSource(sourceType: LibrarySourceType | string): DocumentationSource {
  return SOURCE_BY_ID.get(normalizeSourceType(sourceType))!;
}

export function normalizeSourceType(value?: LibrarySourceType | string | null): LibrarySourceType {
  if (!value) return "docs";
  const key = value.trim().toLowerCase().replace(/\s+/g, "_");
  const normalized = SOURCE_ALIASES[key];
  if (!normalized) throw new InvalidSourceTypeError(value);
  return normalized;
}

export function coerceSourceType(value?: LibrarySourceType | string | null): LibrarySourceType {
  if (!value) return "docs";
  try {
    return normalizeSourceType(value);
  } catch {
    return "docs";
  }
}

export function canRefreshSourceNatively(input: {
  source_type: LibrarySourceType;
  source_url?: string | null;
  docs_url?: string | null;
  npm_package?: string | null;
  github_repo?: string | null;
}): boolean {
  switch (input.source_type) {
    case "docs":
    case "website":
    case "api":
    case "llms_txt":
    case "openapi":
      return Boolean(input.source_url ?? input.docs_url);
    case "npm":
      return Boolean(input.npm_package ?? input.source_url);
    case "github":
      return Boolean(input.github_repo ?? input.source_url ?? input.docs_url);
    case "manual":
      return false;
  }
}

export function inferSourceMetadata(input: CreateLibraryInput): InferredSourceMetadata {
  const docsUrl = normalizeDocsUrl(input.docs_url);
  const rawSourceUrl = input.source_url?.trim() || null;
  const rawCandidateUrl = rawSourceUrl ?? docsUrl;
  const inferredType = input.source_type
    ? normalizeSourceType(input.source_type)
    : inferSourceType({ ...input, docs_url: docsUrl ?? undefined, source_url: rawCandidateUrl ?? undefined });
  const explicitSourceUrl = normalizeSourceUrl(rawSourceUrl, inferredType);
  const candidateUrl = explicitSourceUrl ?? docsUrl;
  const source = getDocumentationSource(inferredType);

  return {
    source_type: inferredType,
    docs_url: docsUrl,
    source_url: candidateUrl ?? inferFallbackSourceUrl(input, inferredType),
    freshness_days: input.freshness_days ?? source.defaultFreshnessDays,
  };
}

function normalizeDocsUrl(value?: string | null): string | null {
  const url = value?.trim();
  if (!url) return null;
  if (isHttpUrl(url)) return url;
  throw new InvalidSourceUrlError("docs_url", url);
}

function normalizeSourceUrl(
  value: string | null,
  sourceType: LibrarySourceType
): string | null {
  if (!value) return null;
  if (isHttpUrl(value)) return value;
  if (sourceType === "github" && isGitHubRepoShorthand(value)) return value;
  if (sourceType === "manual") return value;
  throw new InvalidSourceUrlError("source_url", value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function inferSourceType(input: CreateLibraryInput): LibrarySourceType {
  const sourceUrl = input.source_url ?? input.docs_url ?? "";
  const lowerUrl = sourceUrl.toLowerCase();

  if (lowerUrl.endsWith("/llms.txt") || lowerUrl.endsWith("/llms-full.txt")) {
    return "llms_txt";
  }

  if (
    lowerUrl.includes("openapi") ||
    lowerUrl.includes("swagger") ||
    lowerUrl.endsWith(".yaml") ||
    lowerUrl.endsWith(".yml") ||
    lowerUrl.endsWith(".json")
  ) {
    return "openapi";
  }

  if (lowerUrl.includes("/api/") || lowerUrl.includes("api.")) {
    return "api";
  }

  if (input.docs_url) return "docs";
  if (input.github_repo) return "github";
  if (input.npm_package) return "npm";
  return "docs";
}

function inferFallbackSourceUrl(
  input: CreateLibraryInput,
  sourceType: LibrarySourceType
): string | null {
  if (sourceType === "github" && input.github_repo) return `https://github.com/${input.github_repo}`;
  if (sourceType === "npm" && input.npm_package) {
    return `https://www.npmjs.com/package/${encodeURIComponent(input.npm_package)}`;
  }
  return null;
}

export * from "./ingest.js";
export * from "./refresh.js";
