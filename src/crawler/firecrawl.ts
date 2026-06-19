import { FirecrawlClient } from "@mendable/firecrawl-js";
import type { RetrievedPage } from "./types.js";

let _firecrawl: FirecrawlClient | null = null;

function getFirecrawl(): FirecrawlClient {
  if (_firecrawl) return _firecrawl;
  const key =
    process.env["FIRECRAWL_API_KEY"] ??
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
  source_url?: string | null;
  github_repo?: string | null;
  maxPages?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RetrievedPage[]> {
  const app = getFirecrawl();
  const maxPages = options.maxPages ?? 30;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const crawlTimeoutSeconds = timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : undefined;
  const pages: RetrievedPage[] = [];
  const docsUrl = options.docs_url ?? options.source_url;

  // Strategy 1: Crawl the docs URL directly
  if (docsUrl) {
    try {
      throwIfAborted(options.signal);
      const result = await abortable(app.crawl(docsUrl, {
        limit: maxPages,
        pollInterval: 1,
        timeout: crawlTimeoutSeconds,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
          timeout: timeoutMs > 0 ? timeoutMs : undefined,
        },
      }), options.signal, `Firecrawl crawl aborted for ${docsUrl}`);

      if (result.data) {
        for (const page of result.data) {
          const markdown = (page as { markdown?: string }).markdown;
          const metadata = (page as { metadata?: Record<string, string> }).metadata;
          if (!markdown || markdown.length < 100) continue;
          pages.push({
            url: metadata?.["url"] ?? metadata?.["sourceURL"] ?? docsUrl,
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
  if (pages.length === 0 && docsUrl) {
    try {
      throwIfAborted(options.signal);
      const result = await abortable(app.scrape(docsUrl, {
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
      }), options.signal, `Firecrawl scrape aborted for ${docsUrl}`);

      const markdown = (result as { markdown?: string }).markdown;
      const metadata = (result as { metadata?: Record<string, string> }).metadata;
      if (markdown) {
        pages.push({
          url: docsUrl,
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
export async function fetchPagesFirecrawl(
  urls: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RetrievedPage[]> {
  if (urls.length === 0) return [];
  const app = getFirecrawl();
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const results: RetrievedPage[] = [];

  for (const url of urls) {
    try {
      throwIfAborted(options.signal);
      const result = await abortable(app.scrape(url, {
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
      }), options.signal, `Firecrawl scrape aborted for ${url}`);
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

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Firecrawl retrieval was aborted");
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
