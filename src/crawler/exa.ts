import Exa from "exa-js";
import { MissingApiKeyError } from "../types/index.js";

export interface ExaPage {
  url: string;
  title: string | null;
  text: string;
}

let _exa: Exa | null = null;

function getExa(): Exa {
  if (_exa) return _exa;
  const key =
    process.env["EXA_API_KEY"] ??
    process.env["HASNAXYZ_EXA_LIVE_API_KEY"] ??
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
  github_repo?: string | null;
  maxPages?: number;
}): Promise<ExaPage[]> {
  const exa = getExa();
  const maxPages = options.maxPages ?? 30;
  const pages: ExaPage[] = [];
  const seen = new Set<string>();

  // Strategy 1: If we have a docs URL, crawl it directly
  if (options.docs_url) {
    try {
      const contents = await exa.getContents(
        [options.docs_url],
        {
          text: { maxCharacters: 8000 },
          subpages: maxPages,
          subpageTarget: ["docs", "api", "guide", "reference", "tutorial", "getting-started", "introduction"],
        }
      );

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
        const results = await exa.searchAndContents(q, {
          type: "neural",
          numResults: Math.min(10, maxPages - pages.length),
          text: { maxCharacters: 8000 },
          includeDomains: options.docs_url
            ? [new URL(options.docs_url).hostname]
            : undefined,
        });

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
 * Fetch fresh content for a specific set of URLs.
 */
export async function fetchPages(urls: string[]): Promise<ExaPage[]> {
  if (urls.length === 0) return [];
  const exa = getExa();

  const contents = await exa.getContents(urls, {
    text: { maxCharacters: 8000 },
  });

  return contents.results
    .filter((r) => r.text)
    .map((r) => ({
      url: r.url,
      title: r.title ?? null,
      text: r.text ?? "",
    }));
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
