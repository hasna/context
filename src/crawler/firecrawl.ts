import { FirecrawlClient } from "@mendable/firecrawl-js";
import type { ExaPage } from "./exa.js";

let _firecrawl: FirecrawlClient | null = null;

function getFirecrawl(): FirecrawlClient {
  if (_firecrawl) return _firecrawl;
  const key =
    process.env["FIRECRAWL_API_KEY"] ??
    process.env["HASNAXYZ_FIRECRAWL_LIVE_API_KEY"] ??
    null;
  if (!key) {
    throw new Error(
      "FIRECRAWL_API_KEY environment variable is required. Get a key at https://firecrawl.dev"
    );
  }
  _firecrawl = new FirecrawlClient({ apiKey: key });
  return _firecrawl;
}

/**
 * Discover and fetch documentation pages for a library using Firecrawl.
 * Firecrawl crawls entire sites and returns clean markdown.
 */
export async function discoverDocsFirecrawl(options: {
  name: string;
  npm_package?: string | null;
  docs_url?: string | null;
  github_repo?: string | null;
  maxPages?: number;
}): Promise<ExaPage[]> {
  const app = getFirecrawl();
  const maxPages = options.maxPages ?? 30;
  const pages: ExaPage[] = [];

  // Strategy 1: Crawl the docs URL directly
  if (options.docs_url) {
    try {
      const result = await app.crawl(options.docs_url, {
        limit: maxPages,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
        },
      });

      if (result.data) {
        for (const page of result.data) {
          const markdown = (page as { markdown?: string }).markdown;
          const metadata = (page as { metadata?: Record<string, string> }).metadata;
          if (!markdown || markdown.length < 100) continue;
          pages.push({
            url: metadata?.["url"] ?? metadata?.["sourceURL"] ?? options.docs_url,
            title: metadata?.["title"] ?? null,
            text: markdown,
          });
          if (pages.length >= maxPages) break;
        }
      }
    } catch {
      // Fallback to single scrape
    }
  }

  // Strategy 2: Scrape single page if crawl yielded nothing
  if (pages.length === 0 && options.docs_url) {
    try {
      const result = await app.scrape(options.docs_url, {
        formats: ["markdown"],
        onlyMainContent: true,
      });

      const markdown = (result as { markdown?: string }).markdown;
      const metadata = (result as { metadata?: Record<string, string> }).metadata;
      if (markdown) {
        pages.push({
          url: options.docs_url,
          title: metadata?.["title"] ?? null,
          text: markdown,
        });
      }
    } catch {
      // Ignore
    }
  }

  return pages;
}

/**
 * Fetch fresh content for a list of URLs using Firecrawl.
 */
export async function fetchPagesFirecrawl(urls: string[]): Promise<ExaPage[]> {
  if (urls.length === 0) return [];
  const app = getFirecrawl();
  const results: ExaPage[] = [];

  for (const url of urls) {
    try {
      const result = await app.scrape(url, {
        formats: ["markdown"],
        onlyMainContent: true,
      });
      const markdown = (result as { markdown?: string }).markdown;
      const metadata = (result as { metadata?: Record<string, string> }).metadata;
      if (markdown) {
        results.push({
          url,
          title: metadata?.["title"] ?? null,
          text: markdown,
        });
      }
    } catch {
      // Skip failed URLs
    }
  }

  return results;
}
