import Exa from "exa-js";
import { MissingApiKeyError } from "../types/index.js";
import type { RetrievedPage } from "./types.js";

export type ExaPage = RetrievedPage;

export interface DocumentationUrlCandidate {
  url: string;
  title: string | null;
  score: number;
  query: string;
  source: "exa";
}

let _exa: Exa | null = null;

function getExa(): Exa {
  if (_exa) return _exa;
  const key =
    process.env["EXA_API_KEY"] ??
    null;
  if (!key) throw new MissingApiKeyError();
  _exa = new Exa(key);
  return _exa;
}

/**
 * Discover documentation pages for a library using Exa.
 * Returns up to `maxPages` pages with their full text content.
 */
export async function discoverDocs(options: {
  name: string;
  npm_package?: string | null;
  docs_url?: string | null;
  source_url?: string | null;
  github_repo?: string | null;
  maxPages?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ExaPage[]> {
  const exa = getExa();
  const maxPages = options.maxPages ?? 30;
  const livecrawlTimeout = normalizeExaLivecrawlTimeout(options.timeoutMs);
  const pages: ExaPage[] = [];
  const seen = new Set<string>();

  // Strategy 1: If we have a docs URL, crawl it directly
  const docsUrl = options.docs_url ?? options.source_url;

  if (docsUrl) {
    try {
      throwIfAborted(options.signal);
      const contents = await abortable(exa.getContents(
        [docsUrl],
        {
          text: { maxCharacters: 8000 },
          livecrawlTimeout,
          subpages: maxPages,
          subpageTarget: ["docs", "api", "guide", "reference", "tutorial", "getting-started", "introduction"],
        }
      ), options.signal, `Exa contents retrieval aborted for ${docsUrl}`);

      for (const result of contents.results) {
        if (!result.url || seen.has(result.url)) continue;
        seen.add(result.url);
        pages.push({
          url: result.url,
          title: result.title ?? null,
          text: result.text ?? "",
        });
      }
    } catch {
      // Fallback to search
    }
  }

  // Strategy 2: Search for documentation pages
  if (pages.length < 5) {
    const queries = buildSearchQueries(options);

    for (const q of queries) {
      if (pages.length >= maxPages) break;

      try {
        throwIfAborted(options.signal);
        const results = await abortable(exa.searchAndContents(q, {
          type: "neural",
          numResults: Math.min(10, maxPages - pages.length),
          text: { maxCharacters: 8000 },
          livecrawlTimeout,
          includeDomains: docsUrl
            ? [new URL(docsUrl).hostname]
            : undefined,
        }), options.signal, `Exa search retrieval aborted for ${q}`);

        for (const result of results.results) {
          if (!result.url || seen.has(result.url)) continue;
          if (!result.text) continue;
          seen.add(result.url);
          pages.push({
            url: result.url,
            title: result.title ?? null,
            text: result.text,
          });
        }
      } catch {
        // Continue with next query
      }
    }
  }

  return pages.slice(0, maxPages);
}

/**
 * Discover likely canonical docs/source URLs for a named library, SaaS app, or API.
 * This is intentionally URL discovery only; Firecrawl or native ingestion still
 * performs the actual documentation refresh.
 */
export async function discoverDocumentationUrls(options: {
  name: string;
  npm_package?: string | null;
  github_repo?: string | null;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DocumentationUrlCandidate[]> {
  const exa = getExa();
  const limit = options.limit ?? 5;
  const livecrawlTimeout = normalizeExaLivecrawlTimeout(options.timeoutMs);
  const candidates = new Map<string, DocumentationUrlCandidate>();

  for (const query of buildSearchQueries(options)) {
    throwIfAborted(options.signal);
    if (candidates.size >= limit * 3) break;
    try {
      const results = await abortable(exa.searchAndContents(query, {
        type: "neural",
        numResults: Math.max(5, limit),
        text: { maxCharacters: 1000 },
        livecrawlTimeout,
      }), options.signal, `Exa source URL discovery aborted for ${query}`);

      for (const result of results.results) {
        if (!result.url || candidates.has(result.url)) continue;
        const score = scoreDocumentationUrl(result.url, result.title ?? null, options);
        if (score <= 0) continue;
        candidates.set(result.url, {
          url: result.url,
          title: result.title ?? null,
          score,
          query,
          source: "exa",
        });
      }
    } catch {
      // Continue with next query.
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Fetch fresh content for a specific set of URLs.
 */
export async function fetchPages(
  urls: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ExaPage[]> {
  if (urls.length === 0) return [];
  const exa = getExa();
  const livecrawlTimeout = normalizeExaLivecrawlTimeout(options.timeoutMs);

  const contents = await abortable(exa.getContents(urls, {
    text: { maxCharacters: 8000 },
    livecrawlTimeout,
  }), options.signal, "Exa page retrieval aborted");

  return contents.results
    .filter((r) => r.text)
    .map((r) => ({
      url: r.url,
      title: r.title ?? null,
      text: r.text ?? "",
    }));
}

function normalizeExaLivecrawlTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(10_000, Math.max(1, Math.floor(value)));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Exa retrieval was aborted");
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error(message);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
    }),
  ]);
}

/**
 * Build search queries to discover documentation for a library.
 */
function buildSearchQueries(options: {
  name: string;
  npm_package?: string | null;
  docs_url?: string | null;
  github_repo?: string | null;
}): string[] {
  const queries: string[] = [];
  const name = options.name;
  const pkg = options.npm_package;

  queries.push(`${name} documentation guide`);
  queries.push(`${name} API reference`);

  if (pkg && pkg !== name) {
    queries.push(`${pkg} documentation`);
    queries.push(`${pkg} API reference usage examples`);
  }

  if (options.github_repo) {
    queries.push(`site:github.com/${options.github_repo} documentation README`);
  }

  queries.push(`${name} getting started tutorial`);
  queries.push(`how to use ${name} examples`);

  return queries;
}

function scoreDocumentationUrl(
  url: string,
  title: string | null,
  options: {
    name: string;
    npm_package?: string | null;
    github_repo?: string | null;
  }
): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 0;
  }

  const hostname = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const full = `${hostname}${path}`;
  const lowerTitle = title?.toLowerCase() ?? "";
  const nameTokens = tokenizeIdentity(options.name, options.npm_package);
  let score = 0;

  if (/^(docs|doc|developer|developers|api|reference)\./.test(hostname)) score += 8;
  if (path.includes("/docs") || path.includes("/documentation")) score += 7;
  if (path.includes("/api") || path.includes("/reference") || path.includes("/developers")) score += 5;
  if (path.includes("getting-started") || path.includes("guide")) score += 3;
  if (lowerTitle.includes("documentation") || lowerTitle.includes("docs")) score += 4;
  if (lowerTitle.includes("api") || lowerTitle.includes("reference")) score += 2;

  for (const token of nameTokens) {
    if (token.length < 3) continue;
    if (full.includes(token)) score += 2;
    if (lowerTitle.includes(token)) score += 1;
  }

  if (options.github_repo && hostname === "github.com" && path.includes(options.github_repo.toLowerCase())) {
    score += 4;
  }

  if (hostname.includes("npmjs.com")) score -= 8;
  if (hostname.includes("wikipedia.org")) score -= 8;
  if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) score -= 8;
  if (hostname.includes("medium.com") || hostname.includes("dev.to")) score -= 4;
  if (hostname.includes("linkedin.com") || hostname.includes("twitter.com") || hostname.includes("x.com")) score -= 8;

  return score;
}

function tokenizeIdentity(name: string, npmPackage?: string | null): string[] {
  return [...new Set(
    [name, npmPackage ?? ""]
      .join(" ")
      .toLowerCase()
      .replace(/^@/, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )];
}
