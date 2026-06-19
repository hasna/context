import { parse as parseYaml } from "yaml";
import type {
  ApiEndpointInput,
  ApiEndpointParameter,
  ApiEndpointResponse,
  ApiSchemaSummary,
  Library,
} from "../types/index.js";

const DEFAULT_SOURCE_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_LLMS_FULL_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS = 3_000;
const MAX_OPENAPI_REF_DOCUMENTS = 8;

export interface SourcePage {
  url: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SourceIngestOptions {
  maxPages?: number;
  signal?: AbortSignal;
}

export async function ingestNativeSource(
  library: Library,
  options: SourceIngestOptions = {}
): Promise<SourcePage[] | null> {
  if (library.source_type === "docs" || library.source_type === "website" || library.source_type === "api") {
    return ingestWebsiteSource(library, options);
  }

  if (library.source_type === "llms_txt") {
    return ingestLlmsTxt(library, options);
  }

  if (library.source_type === "openapi") {
    return ingestOpenApi(library, options);
  }

  if (library.source_type === "npm") {
    return ingestNpmPackage(library, options);
  }

  if (library.source_type === "github") {
    return ingestGitHubRepository(library, options);
  }

  return null;
}

async function ingestWebsiteSource(
  library: Library,
  options: SourceIngestOptions
): Promise<SourcePage[]> {
  const sourceUrl = getRequiredSourceUrl(library);
  const maxPages = Math.max(1, options.maxPages ?? 30);
  const queue = [normalizeCrawlUrl(sourceUrl)];
  const shouldRunDiscovery = maxPages > 2 || library.source_type !== "api";
  const llmsPages = shouldRunDiscovery ? await discoverLlmsTxtPages(library, sourceUrl, maxPages, options.signal) : [];
  const llmsSeeded = new Set(llmsPages.map((page) => normalizeCrawlUrl(page.url)));
  const sitemapUrls = shouldRunDiscovery ? await discoverSitemapUrls(sourceUrl, maxPages, options.signal) : [];
  const sitemapSeeded = new Set(sitemapUrls);
  for (const llmsPage of llmsPages) {
    if (queue.length >= maxPages) break;
    if (!queue.includes(llmsPage.url)) queue.push(llmsPage.url);
  }
  for (const sitemapUrl of sitemapUrls) {
    if (queue.length >= maxPages) break;
    if (!queue.includes(sitemapUrl)) queue.push(sitemapUrl);
  }
  const preloadedPages = new Map(llmsPages.map((page) => [normalizeCrawlUrl(page.url), page]));
  const seen = new Set<string>();
  const pages: SourcePage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    throwIfAborted(options.signal);
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const preloadedPage = preloadedPages.get(url);

    if (preloadedPage) {
      pages.push(preloadedPage);
      for (const link of extractMarkdownLinks(preloadedPage.url, preloadedPage.text)) {
        if (pages.length + queue.length >= maxPages) break;
        const linkUrl = normalizeCrawlUrl(link.url);
        if (!shouldCrawlLinkedUrl(sourceUrl, linkUrl) || seen.has(linkUrl) || queue.includes(linkUrl)) continue;
        queue.push(linkUrl);
      }
      continue;
    }

    let fetched: FetchedText;
    try {
      fetched = await fetchTextWithMetadata(url, undefined, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      continue;
    }

    const rendered = renderFetchedDocument(fetched);
    if (!rendered.text.trim()) continue;

    pages.push({
      url: fetched.url,
      title: rendered.title ?? library.name,
      text: rendered.text,
      metadata: {
        source_type: library.source_type,
        source_role: pages.length === 0
          ? "entry"
          : llmsSeeded.has(normalizeCrawlUrl(fetched.url))
            ? "llms_txt"
          : sitemapSeeded.has(normalizeCrawlUrl(fetched.url))
            ? "sitemap_page"
            : "linked_page",
        content_type: fetched.contentType,
      },
    });

    if (isHtmlContent(fetched.contentType) || looksLikeHtml(fetched.text)) {
      for (const link of extractHtmlLinks(fetched.url, fetched.text)) {
        if (pages.length + queue.length >= maxPages) break;
        if (!shouldCrawlLinkedUrl(sourceUrl, link) || seen.has(link) || queue.includes(link)) continue;
        queue.push(link);
      }
    }
  }

  return pages;
}

async function ingestLlmsTxt(
  library: Library,
  options: SourceIngestOptions
): Promise<SourcePage[]> {
  const sourceUrl = getRequiredSourceUrl(library);
  const maxPages = Math.max(1, options.maxPages ?? 30);
  const llmsText = await fetchText(sourceUrl, undefined, options.signal);
  const pages: SourcePage[] = [
    {
      url: sourceUrl,
      title: firstHeading(llmsText) ?? `${library.name} llms.txt`,
      text: llmsText,
      metadata: { source_type: "llms_txt", source_role: "manifest" },
    },
  ];
  const manifestMetadata = pages[0]!.metadata!;
  const seen = new Set([normalizeCrawlUrl(sourceUrl)]);
  let fullDocsFound = false;

  if (looksLikeInlineFullLlmsTxt(llmsText)) {
    manifestMetadata["full_docs_mode"] = "llms_txt_inline_full";
    manifestMetadata["full_docs_complete"] = true;
    return pages;
  }

  for (const fullUrl of llmsFullSiblingCandidates(sourceUrl)) {
    throwIfAborted(options.signal);
    if (pages.length >= maxPages || seen.has(fullUrl)) continue;
    seen.add(fullUrl);
    try {
      const text = await fetchText(fullUrl, getLlmsFullFetchTimeoutMs(), options.signal);
      pages.push({
        url: fullUrl,
        title: firstHeading(text) ?? `${library.name} llms-full.txt`,
        text,
        metadata: { source_type: "llms_txt", source_role: "llms_full_txt" },
      });
      fullDocsFound = true;
      manifestMetadata["full_docs_mode"] = "llms_full_txt";
      manifestMetadata["full_docs_complete"] = true;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // llms-full.txt is optional; keep ingesting linked docs from the manifest.
    }
  }

  if (fullDocsFound) return pages;

  const links = extractMarkdownLinks(sourceUrl, llmsText);
  manifestMetadata["llms_links_total"] = links.length;
  let linkedDocsFetched = 0;
  let linkedDocsFailed = 0;
  let linkedDocsSkipped = 0;

  for (const link of links) {
    throwIfAborted(options.signal);
    if (pages.length >= maxPages) {
      linkedDocsSkipped++;
      continue;
    }
    const linkUrl = normalizeCrawlUrl(link.url);
    if (seen.has(linkUrl)) {
      linkedDocsSkipped++;
      continue;
    }
    seen.add(linkUrl);
    try {
      const text = await fetchText(link.url, undefined, options.signal);
      linkedDocsFetched++;
      pages.push({
        url: link.url,
        title: firstHeading(text) ?? link.title,
        text,
        metadata: { source_type: "llms_txt", source_role: "linked_doc" },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      linkedDocsFailed++;
      // Keep the manifest even when an individual linked doc cannot be fetched.
    }
  }

  manifestMetadata["llms_links_fetched"] = linkedDocsFetched;
  manifestMetadata["llms_links_failed"] = linkedDocsFailed;
  manifestMetadata["llms_links_skipped"] = linkedDocsSkipped;
  manifestMetadata["full_docs_mode"] = "llms_manifest_links";
  manifestMetadata["full_docs_complete"] = links.length > 0 &&
    linkedDocsFetched + linkedDocsSkipped === links.length &&
    linkedDocsFailed === 0 &&
    linkedDocsSkipped === 0;

  return pages;
}

function llmsFullSiblingCandidates(sourceUrl: string): string[] {
  const parsed = new URL(sourceUrl);
  const candidates: string[] = [];
  const filename = parsed.pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();

  if (filename === "llms-full.txt") return [];

  if (filename === "llms.txt") {
    const sibling = new URL(parsed.toString());
    sibling.pathname = sibling.pathname.replace(/llms\.txt$/i, "llms-full.txt");
    candidates.push(sibling.toString());
  }

  candidates.push(new URL("/llms-full.txt", parsed.origin).toString());
  return unique(candidates.map(normalizeCrawlUrl));
}

function looksLikeInlineFullLlmsTxt(text: string): boolean {
  return text.length >= 100_000 && /^===[^=\n]+===$/m.test(text);
}

async function discoverLlmsTxtPages(
  library: Library,
  sourceUrl: string,
  limit: number,
  signal?: AbortSignal
): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];
  const seen = new Set<string>();

  for (const candidate of llmsCandidates(sourceUrl)) {
    throwIfAborted(signal);
    if (pages.length >= limit || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const text = await fetchText(candidate, getSourceDiscoveryFetchTimeoutMs(), signal);
      pages.push({
        url: candidate,
        title: firstHeading(text) ?? `${library.name} llms.txt`,
        text,
        metadata: {
          source_type: library.source_type,
          source_role: candidate.endsWith("/llms-full.txt") ? "llms_full_txt" : "llms_txt",
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Most sites do not have both llms-full.txt and llms.txt.
    }
  }

  return pages;
}

async function ingestOpenApi(library: Library, options: SourceIngestOptions): Promise<SourcePage[]> {
  const sourceUrl = getRequiredSourceUrl(library);
  const raw = await fetchText(sourceUrl, undefined, options.signal);
  const parsed = parseOpenApiSpec(raw);
  const context = parsed
    ? await loadOpenApiResolveContext(parsed.spec, sourceUrl, options.signal)
    : null;
  const endpoints = parsed && context
    ? extractOpenApiEndpoints(parsed.spec, sourceUrl, parsed.format, context)
    : [];
  const text = parsed
    ? renderOpenApiMarkdown(parsed.spec, sourceUrl, endpoints)
    : renderRawOpenApiMarkdown(raw, sourceUrl);

  return [
    {
      url: sourceUrl,
      title: parsed?.spec.info?.title ?? `${library.name} OpenAPI`,
      text,
      metadata: {
        source_type: "openapi",
        source_role: "openapi_spec",
        full_docs_mode: "openapi_spec",
        full_docs_complete: true,
        source_format: parsed?.format ?? "raw",
        version: parsed?.spec.info?.version ?? null,
        openapi_endpoints: endpoints,
      },
    },
  ];
}

async function ingestNpmPackage(library: Library, options: SourceIngestOptions): Promise<SourcePage[]> {
  const packageName = library.npm_package ?? packageNameFromSourceUrl(library.source_url) ?? library.name;
  const registryUrl = library.source_url && !library.source_url.includes("npmjs.com/package/")
    ? library.source_url
    : `https://registry.npmjs.org/${encodeURIComponent(packageName).replace("%2F", "%2f")}`;
  const raw = await fetchText(registryUrl, undefined, options.signal);
  const pkg = parseNpmRegistryPackage(raw);
  const latestVersion = pkg["dist-tags"]?.latest;
  const latest = latestVersion ? pkg.versions?.[latestVersion] : undefined;
  const readme = latest?.readme ?? pkg.readme ?? "";
  const text = renderNpmPackageMarkdown({
    name: pkg.name ?? packageName,
    version: latestVersion ?? latest?.version,
    description: latest?.description ?? pkg.description ?? library.description ?? undefined,
    homepage: latest?.homepage ?? pkg.homepage,
    repository: repositoryUrl(latest?.repository ?? pkg.repository),
    readme,
  });

  return [
    {
      url: registryUrl,
      title: `${pkg.name ?? packageName} npm package`,
      text,
      metadata: {
        source_type: "npm",
        source_role: "package_readme",
        package_name: pkg.name ?? packageName,
        version: latestVersion ?? latest?.version ?? null,
      },
    },
  ];
}

async function ingestGitHubRepository(
  library: Library,
  options: SourceIngestOptions
): Promise<SourcePage[]> {
  if (library.source_url && !isGitHubUrl(library.source_url)) {
    return ingestWebsiteSource(library, options);
  }

  const repo = parseGitHubRepo(library.github_repo ?? library.source_url ?? "");
  if (!repo) {
    return ingestWebsiteSource(library, options);
  }

  const maxPages = Math.max(1, options.maxPages ?? 5);
  const candidates = githubRawCandidates(repo.owner, repo.name).slice(0, maxPages + 3);
  const pages: SourcePage[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    if (pages.length >= maxPages || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    try {
      const text = await fetchText(candidate.url, undefined, options.signal);
      pages.push({
        url: candidate.sourceUrl,
        title: firstHeading(text) ?? `${repo.owner}/${repo.name} ${candidate.path}`,
        text,
        metadata: {
          source_type: "github",
          source_role: candidate.path.toLowerCase().includes("readme") ? "readme" : "repo_doc",
          github_repo: `${repo.owner}/${repo.name}`,
          raw_url: candidate.url,
        },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Try the next likely docs file.
    }
  }

  if (pages.length > 0) return pages;
  return ingestWebsiteSource(
    {
      ...library,
      source_url: `https://github.com/${repo.owner}/${repo.name}`,
      docs_url: `https://github.com/${repo.owner}/${repo.name}`,
    },
    options
  );
}

function getRequiredSourceUrl(library: Library): string {
  const sourceUrl = library.source_url ?? library.docs_url;
  if (!sourceUrl) {
    throw new Error(`${library.source_type} source requires source_url or docs_url`);
  }
  return sourceUrl;
}

interface FetchedText {
  url: string;
  text: string;
  contentType: string;
}

async function fetchText(url: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
  return (await fetchTextWithMetadata(url, timeoutMs, signal)).text;
}

async function fetchTextWithMetadata(
  url: string,
  timeoutMs = getSourceFetchTimeoutMs(),
  signal?: AbortSignal
): Promise<FetchedText> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/plain,*/*",
        "User-Agent": "@hasna/context native source",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return {
      url: response.url || url,
      text: await response.text(),
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    if (controller.signal.aborted) {
      if (!timedOut && signal?.aborted) {
        throw new Error(`Aborted fetching ${url}`);
      }
      throw new Error(`Timed out fetching ${url} after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function getSourceFetchTimeoutMs(): number {
  const value = process.env["CONTEXT_SOURCE_FETCH_TIMEOUT_MS"] ?? process.env["HASNA_CONTEXT_SOURCE_FETCH_TIMEOUT_MS"];
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_SOURCE_FETCH_TIMEOUT_MS;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SOURCE_FETCH_TIMEOUT_MS;
}

function getLlmsFullFetchTimeoutMs(): number {
  const value =
    process.env["CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS"] ??
    process.env["HASNA_CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS"];
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_LLMS_FULL_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LLMS_FULL_FETCH_TIMEOUT_MS;
  const sourceTimeout = getSourceFetchTimeoutMs();
  return sourceTimeout > 0 ? Math.min(parsed, sourceTimeout) : parsed;
}

function getSourceDiscoveryFetchTimeoutMs(): number {
  const value =
    process.env["CONTEXT_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS"] ??
    process.env["HASNA_CONTEXT_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS"];
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS;
  const sourceTimeout = getSourceFetchTimeoutMs();
  return sourceTimeout > 0 ? Math.min(parsed, sourceTimeout) : parsed;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Source ingest was aborted");
}

function extractMarkdownLinks(baseUrl: string, markdown: string): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const regex = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown))) {
    const title = match[1]?.trim();
    const href = match[2]?.trim();
    if (!title || !href || href.startsWith("#") || href.startsWith("mailto:")) continue;

    try {
      const url = new URL(href, baseUrl).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ title, url });
    } catch {
      // Ignore malformed links.
    }
  }

  return links;
}

function firstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function renderFetchedDocument(fetched: FetchedText): { title: string | null; text: string } {
  if (isHtmlContent(fetched.contentType) || looksLikeHtml(fetched.text)) {
    return htmlToMarkdownLike(fetched.text, fetched.url);
  }

  return {
    title: firstHeading(fetched.text),
    text: fetched.text,
  };
}

function htmlToMarkdownLike(html: string, url: string): { title: string | null; text: string } {
  const title = decodeHtml(
    matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ??
      matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ??
      new URL(url).pathname.split("/").filter(Boolean).at(-1) ??
      url
  );
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<\/(p|div|section|article|main|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = decodeHtml(body)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return {
    title,
    text: [`# ${title}`, "", `Source: ${url}`, "", body].join("\n").trim(),
  };
}

function extractHtmlLinks(baseUrl: string, html: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html))) {
    const href = match[1]?.trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const url = normalizeCrawlUrl(new URL(href, baseUrl).toString());
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(url);
    } catch {
      // Ignore malformed links.
    }
  }

  return links;
}

async function discoverSitemapUrls(rootUrl: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  const seenSitemaps = new Set<string>();
  const queue = unique([
    ...(await robotsSitemapCandidates(rootUrl, signal)),
    ...sitemapCandidates(rootUrl),
  ]);

  while (queue.length > 0 && urls.length < limit) {
    throwIfAborted(signal);
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    let xml: string;
    try {
      xml = await fetchText(sitemapUrl, getSourceDiscoveryFetchTimeoutMs(), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }

    const locs = extractSitemapLocs(xml, sitemapUrl);
    if (isSitemapIndex(xml)) {
      for (const loc of locs) {
        if (seenSitemaps.has(loc) || queue.includes(loc)) continue;
        queue.push(loc);
      }
      continue;
    }

    for (const loc of locs) {
      if (urls.length >= limit) break;
      if (!shouldCrawlLinkedUrl(rootUrl, loc) || seenUrls.has(loc)) continue;
      seenUrls.add(loc);
      urls.push(loc);
    }
  }

  return urls;
}

function sitemapCandidates(rootUrl: string): string[] {
  const parsed = new URL(rootUrl);
  const candidates = [new URL("/sitemap.xml", parsed.origin).toString()];
  const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  const scoped = new URL(`${path}sitemap.xml`, parsed.origin).toString();
  if (!candidates.includes(scoped)) candidates.push(scoped);
  return candidates.map(normalizeCrawlUrl);
}

async function robotsSitemapCandidates(rootUrl: string, signal?: AbortSignal): Promise<string[]> {
  const parsed = new URL(rootUrl);
  const robotsUrl = new URL("/robots.txt", parsed.origin).toString();
  try {
    const robots = await fetchText(robotsUrl, getSourceDiscoveryFetchTimeoutMs(), signal);
    return extractRobotsSitemapUrls(robots, robotsUrl)
      .filter((url) => {
        try {
          return new URL(url).origin === parsed.origin;
        } catch {
          return false;
        }
      });
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

function extractRobotsSitemapUrls(robots: string, robotsUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const line of robots.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(.+?)\s*$/i);
    const value = match?.[1]?.trim();
    if (!value) continue;
    try {
      const url = normalizeCrawlUrl(new URL(value, robotsUrl).toString());
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    } catch {
      // Ignore malformed robots.txt Sitemap values.
    }
  }

  return urls;
}

function llmsCandidates(rootUrl: string): string[] {
  const parsed = new URL(rootUrl);
  const candidates = [
    new URL("/llms-full.txt", parsed.origin).toString(),
    new URL("/llms.txt", parsed.origin).toString(),
  ];
  const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  for (const filename of ["llms-full.txt", "llms.txt"]) {
    const scoped = new URL(`${path}${filename}`, parsed.origin).toString();
    if (!candidates.includes(scoped)) candidates.push(scoped);
  }
  return candidates.map(normalizeCrawlUrl);
}

function extractSitemapLocs(xml: string, sitemapUrl: string): string[] {
  const locs: string[] = [];
  const seen = new Set<string>();
  const regex = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml))) {
    const value = match[1]?.trim();
    if (!value) continue;
    try {
      const url = normalizeCrawlUrl(new URL(decodeHtml(value), sitemapUrl).toString());
      if (seen.has(url)) continue;
      seen.add(url);
      locs.push(url);
    } catch {
      // Ignore malformed sitemap URLs.
    }
  }

  return locs;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function shouldCrawlLinkedUrl(rootUrl: string, nextUrl: string): boolean {
  const root = new URL(rootUrl);
  const next = new URL(nextUrl);
  if (root.origin !== next.origin) return false;
  if (isLikelyAssetPath(next.pathname)) return false;
  if (isLowSignalDocumentationPath(next.pathname)) return false;
  if (!root.pathname.startsWith("/zh-cn") && next.pathname.startsWith("/zh-cn/")) return false;

  const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
  if (root.pathname === "/") return true;
  if (next.pathname === root.pathname || next.pathname.startsWith(rootPath)) return true;
  if (hasFileExtension(root.pathname)) return next.pathname.startsWith(`${dirnamePath(root.pathname)}/`);
  return false;
}

function normalizeCrawlUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

function isHtmlContent(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html");
}

function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]|<body[\s>]|<main[\s>]/i.test(text);
}

function isLikelyAssetPath(pathname: string): boolean {
  return /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp4|mov|avi)$/i.test(pathname);
}

function isLowSignalDocumentationPath(pathname: string): boolean {
  return /(^|\/)(blog|news|archive|authors?|tags?|categories)(\/|$)/i.test(pathname) ||
    /\/quick_start\/agent_integrations\//i.test(pathname);
}

function hasFileExtension(pathname: string): boolean {
  return /\.[a-z0-9]+$/i.test(pathname);
}

function dirnamePath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`;
}

function matchFirst(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

interface NpmRegistryPackage {
  name?: string;
  description?: string;
  readme?: string;
  homepage?: string;
  repository?: unknown;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, {
    version?: string;
    description?: string;
    readme?: string;
    homepage?: string;
    repository?: unknown;
  }>;
}

function parseNpmRegistryPackage(raw: string): NpmRegistryPackage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid npm registry response");
  return parsed as NpmRegistryPackage;
}

function renderNpmPackageMarkdown(input: {
  name: string;
  version?: string;
  description?: string;
  homepage?: string;
  repository?: string | null;
  readme: string;
}): string {
  const lines = [`# ${input.name}`];
  if (input.version) lines.push("", `Version: ${input.version}`);
  if (input.description) lines.push("", input.description);
  if (input.homepage) lines.push("", `Homepage: ${input.homepage}`);
  if (input.repository) lines.push("", `Repository: ${input.repository}`);
  if (input.readme.trim()) lines.push("", "## README", "", input.readme.trim());
  return lines.join("\n");
}

function repositoryUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  return null;
}

function packageNameFromSourceUrl(sourceUrl?: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    const packageIndex = parsed.pathname.indexOf("/package/");
    if (packageIndex === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(packageIndex + "/package/".length));
  } catch {
    return null;
  }
}

function isGitHubUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "github.com";
  } catch {
    return false;
  }
}

function parseGitHubRepo(value: string): { owner: string; name: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = trimmed.match(/^([^/\s]+)\/([^/\s#?]+)$/);
  if (direct?.[1] && direct[2]) return { owner: direct[1], name: direct[2].replace(/\.git$/, "") };

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") return null;
    const [owner, name] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !name) return null;
    return { owner, name: name.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function githubRawCandidates(owner: string, repo: string): Array<{ path: string; url: string; sourceUrl: string }> {
  const branches = ["HEAD", "main", "master"];
  const paths = ["README.md", "docs/README.md", "docs/index.md", "CONTRIBUTING.md"];
  const candidates: Array<{ path: string; url: string; sourceUrl: string }> = [];
  for (const branch of branches) {
    for (const path of paths) {
      candidates.push({
        path,
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
        sourceUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${path}`,
      });
    }
  }
  return candidates;
}

interface OpenApiLike {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url?: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    requestBodies?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Array<{
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
    schema?: unknown;
  }>;
  requestBody?: {
    $ref?: string;
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, { $ref?: string; description?: string; content?: Record<string, { schema?: unknown }> }>;
}

type OpenApiSourceFormat = "json" | "yaml";

interface ParsedOpenApiSpec {
  spec: OpenApiLike;
  format: OpenApiSourceFormat;
}

interface OpenApiResolveContext {
  rootUrl: string;
  root: OpenApiLike;
  documents: Map<string, unknown>;
}

interface OpenApiResolvedValue {
  value: unknown;
  baseUrl: string;
  ref: string | null;
}

function parseOpenApiSpec(raw: string): ParsedOpenApiSpec | null {
  const json = parseJsonObject(raw);
  if (isOpenApiLike(json)) return { spec: json, format: "json" };

  try {
    const yaml = parseYaml(raw) as unknown;
    if (isOpenApiLike(yaml)) return { spec: yaml, format: "yaml" };
  } catch {
    // Keep the raw spec fallback when YAML parsing fails.
  }

  return null;
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseStructuredObject(raw: string): unknown | null {
  const json = parseJsonObject(raw);
  if (isRecord(json)) return json;
  try {
    const yaml = parseYaml(raw) as unknown;
    return isRecord(yaml) ? yaml : null;
  } catch {
    return null;
  }
}

function isOpenApiLike(value: unknown): value is OpenApiLike {
  if (!isRecord(value)) return false;
  return (
    typeof value["openapi"] === "string" ||
    typeof value["swagger"] === "string" ||
    isRecord(value["paths"]) ||
    isRecord(value["info"])
  );
}

async function loadOpenApiResolveContext(
  spec: OpenApiLike,
  sourceUrl: string,
  signal?: AbortSignal
): Promise<OpenApiResolveContext> {
  const rootUrl = canonicalOpenApiDocumentUrl(sourceUrl);
  const documents = new Map<string, unknown>([[rootUrl, spec]]);
  const queue = collectExternalRefDocumentUrls(spec, sourceUrl, rootUrl);
  const queued = new Set(queue);

  while (queue.length > 0 && documents.size < MAX_OPENAPI_REF_DOCUMENTS + 1) {
    throwIfAborted(signal);
    const refUrl = queue.shift();
    if (!refUrl || documents.has(refUrl)) continue;

    try {
      const raw = await fetchText(refUrl, undefined, signal);
      const parsed = parseStructuredObject(raw);
      if (!parsed) continue;
      documents.set(refUrl, parsed);
      for (const nested of collectExternalRefDocumentUrls(parsed, refUrl, rootUrl)) {
        if (documents.has(nested) || queued.has(nested)) continue;
        queued.add(nested);
        queue.push(nested);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Keep ingestion usable when optional external schema docs are unavailable.
    }
  }

  return { rootUrl, root: spec, documents };
}

function collectExternalRefDocumentUrls(value: unknown, baseUrl: string, rootUrl: string): string[] {
  const root = new URL(rootUrl);
  const refs: string[] = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;

    const ref = stringOrNull(candidate["$ref"]);
    const refUrl = ref ? externalRefDocumentUrl(ref, baseUrl, root) : null;
    if (refUrl && !seen.has(refUrl)) {
      seen.add(refUrl);
      refs.push(refUrl);
    }

    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return refs;
}

function externalRefDocumentUrl(ref: string, baseUrl: string, root: URL): string | null {
  if (ref.startsWith("#")) return null;
  const documentPart = ref.split("#", 1)[0];
  if (!documentPart) return null;
  try {
    const url = new URL(documentPart, baseUrl);
    if (url.origin !== root.origin) return null;
    return canonicalOpenApiDocumentUrl(url.toString());
  } catch {
    return null;
  }
}

function canonicalOpenApiDocumentUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderOpenApiMarkdown(
  spec: OpenApiLike,
  sourceUrl: string,
  endpoints?: ApiEndpointInput[]
): string {
  const lines: string[] = [];
  const title = spec.info?.title ?? "OpenAPI Specification";
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Source: ${sourceUrl}`);
  if (spec.openapi || spec.swagger) lines.push(`Spec version: ${spec.openapi ?? spec.swagger}`);
  if (spec.info?.version) lines.push(`API version: ${spec.info.version}`);
  if (spec.info?.description) {
    lines.push("");
    lines.push(spec.info.description.trim());
  }

  if (spec.servers?.length) {
    lines.push("");
    lines.push("## Servers");
    for (const server of spec.servers) {
      if (!server.url) continue;
      lines.push(`- ${server.url}${server.description ? ` - ${server.description}` : ""}`);
    }
  }

  if (endpoints) {
    if (endpoints.length > 0) {
      lines.push("");
      lines.push("## Endpoints");
      for (const endpoint of endpoints) {
        lines.push("");
        lines.push(endpoint.content);
      }
    }
    return lines.join("\n").trim();
  }

  const paths = spec.paths ?? {};
  if (Object.keys(paths).length > 0) {
    lines.push("");
    lines.push("## Endpoints");
  }

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const methods = pathItem as Record<string, unknown>;
    for (const [method, candidate] of Object.entries(methods)) {
      if (!isHttpMethod(method)) continue;
      if (!isRecord(candidate)) continue;
      const operation = candidate as OpenApiOperation;
      lines.push("");
      lines.push(`### ${method.toUpperCase()} ${path}`);
      if (operation.summary) lines.push(operation.summary);
      if (operation.description) lines.push(operation.description);
      if (operation.operationId) lines.push(`Operation ID: ${operation.operationId}`);
      if (operation.tags?.length) lines.push(`Tags: ${operation.tags.join(", ")}`);

      if (operation.parameters?.length) {
        lines.push("");
        lines.push("Parameters:");
        for (const param of operation.parameters) {
          lines.push(
            `- ${param.name ?? "unnamed"} (${param.in ?? "unknown"}${param.required ? ", required" : ""})` +
              `${param.description ? ` - ${param.description}` : ""}`
          );
        }
      }

      if (operation.requestBody) {
        lines.push("");
        lines.push(
          `Request body${operation.requestBody.required ? " (required)" : ""}: ` +
            `${operation.requestBody.description ?? "schema defined in spec"}`
        );
      }

      if (operation.responses && Object.keys(operation.responses).length > 0) {
        lines.push("");
        lines.push("Responses:");
        for (const [status, response] of Object.entries(operation.responses)) {
          lines.push(`- ${status}: ${response?.description ?? "response"}`);
        }
      }
    }
  }

  return lines.join("\n").trim();
}

function extractOpenApiEndpoints(
  spec: OpenApiLike,
  sourceUrl: string,
  format: OpenApiSourceFormat,
  context: OpenApiResolveContext
): ApiEndpointInput[] {
  const endpoints: ApiEndpointInput[] = [];
  const paths = spec.paths ?? {};
  const specVersion = spec.openapi ?? spec.swagger ?? null;
  const apiVersion = spec.info?.version ?? null;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const methods = pathItem as Record<string, unknown>;
    for (const [method, candidate] of Object.entries(methods)) {
      if (!isHttpMethod(method)) continue;
      if (!isRecord(candidate)) continue;
      const operation = candidate as OpenApiOperation;
      const endpoint: ApiEndpointInput = {
        url: sourceUrl,
        method: method.toUpperCase(),
        path,
        operation_id: stringOrNull(operation.operationId),
        summary: stringOrNull(operation.summary),
        description: stringOrNull(operation.description),
        tags: normalizeStringArray(operation.tags),
        parameters: normalizeParameters(operation.parameters, context, sourceUrl),
        request_body: normalizeRequestBody(operation.requestBody, context, sourceUrl),
        responses: normalizeResponses(operation.responses, context, sourceUrl),
        source_format: format,
        spec_version: specVersion,
        api_version: apiVersion,
        content: "",
      };
      endpoint.content = renderApiEndpointMarkdown(endpoint);
      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

function renderApiEndpointMarkdown(endpoint: ApiEndpointInput): string {
  const lines = [`### ${endpoint.method.toUpperCase()} ${endpoint.path}`];
  if (endpoint.summary) lines.push(endpoint.summary);
  if (endpoint.description) lines.push(endpoint.description);
  if (endpoint.operation_id) lines.push(`Operation ID: ${endpoint.operation_id}`);
  if (endpoint.tags?.length) lines.push(`Tags: ${endpoint.tags.join(", ")}`);

  if (endpoint.parameters?.length) {
    lines.push("", "Parameters:");
    for (const param of endpoint.parameters) {
      lines.push(
        `- ${param.name ?? "unnamed"} (${param.in ?? "unknown"}${param.required ? ", required" : ""})` +
          `${param.description ? ` - ${param.description}` : ""}`
      );
      if (param.schema) lines.push(`  Schema: ${formatSchemaSummary(param.schema)}`);
    }
  }

  if (endpoint.request_body) {
    lines.push("");
    lines.push(
      `Request body${endpoint.request_body.required ? " (required)" : ""}: ` +
        `${endpoint.request_body.description ?? "schema defined in spec"}`
    );
    if (endpoint.request_body.content_types?.length) {
      lines.push(`Content types: ${endpoint.request_body.content_types.join(", ")}`);
    }
    for (const [contentType, schema] of Object.entries(endpoint.request_body.schemas ?? {})) {
      lines.push(`- ${contentType}: ${formatSchemaSummary(schema)}`);
      for (const property of schema.properties.slice(0, 12)) {
        lines.push(
          `  - ${property.name}${property.required ? " (required)" : ""}: ` +
            `${property.type ?? property.ref ?? "unknown"}` +
            `${property.description ? ` - ${property.description}` : ""}`
        );
      }
    }
  }

  if (endpoint.responses && Object.keys(endpoint.responses).length > 0) {
    lines.push("", "Responses:");
    for (const [status, response] of Object.entries(endpoint.responses)) {
      lines.push(`- ${status}: ${response.description ?? "response"}`);
      if (response.content_types?.length) {
        lines.push(`  Content types: ${response.content_types.join(", ")}`);
      }
      for (const [contentType, schema] of Object.entries(response.schemas ?? {})) {
        lines.push(`  - ${contentType}: ${formatSchemaSummary(schema)}`);
        for (const property of schema.properties.slice(0, 12)) {
          lines.push(
            `    - ${property.name}${property.required ? " (required)" : ""}: ` +
              `${property.type ?? property.ref ?? "unknown"}` +
              `${property.description ? ` - ${property.description}` : ""}`
          );
        }
      }
    }
  }

  return lines.join("\n").trim();
}

function normalizeParameters(
  parameters: OpenApiOperation["parameters"],
  context: OpenApiResolveContext,
  baseUrl: string
): ApiEndpointParameter[] {
  if (!Array.isArray(parameters)) return [];
  return parameters
    .filter(isRecord)
    .map((param) => dereference(param, context, baseUrl))
    .filter((resolved) => isRecord(resolved.value))
    .map((resolved) => {
      const param = resolved.value as Record<string, unknown>;
      const schema = summarizeSchema(param["schema"], context, resolved.baseUrl);
      return {
        name: stringOrNull(param["name"]),
        in: stringOrNull(param["in"]),
        required: Boolean(param["required"]),
        description: stringOrNull(param["description"]),
        schema,
      };
    });
}

function normalizeRequestBody(
  requestBody: OpenApiOperation["requestBody"],
  context: OpenApiResolveContext,
  baseUrl: string
): ApiEndpointInput["request_body"] {
  const resolved = dereference(requestBody, context, baseUrl);
  if (!isRecord(resolved.value)) return null;
  const schemas = summarizeContentSchemas(resolved.value["content"], context, resolved.baseUrl);
  return {
    required: Boolean(resolved.value["required"]),
    description: stringOrNull(resolved.value["description"]),
    content_types: Object.keys(schemas),
    schemas,
  };
}

function normalizeResponses(
  responses: OpenApiOperation["responses"],
  context: OpenApiResolveContext,
  baseUrl: string
): Record<string, ApiEndpointResponse> {
  if (!isRecord(responses)) return {};
  const normalized: Record<string, ApiEndpointResponse> = {};
  for (const [status, response] of Object.entries(responses)) {
    const resolved = dereference(response, context, baseUrl);
    const schemas = isRecord(resolved.value)
      ? summarizeContentSchemas(resolved.value["content"], context, resolved.baseUrl)
      : {};
    normalized[status] = {
      description: isRecord(resolved.value) ? stringOrNull(resolved.value["description"]) : null,
      content_types: Object.keys(schemas),
      schemas,
    };
  }
  return normalized;
}

function summarizeContentSchemas(
  value: unknown,
  context: OpenApiResolveContext,
  baseUrl: string
): Record<string, ApiSchemaSummary> {
  if (!isRecord(value)) return {};
  const schemas: Record<string, ApiSchemaSummary> = {};
  for (const [contentType, media] of Object.entries(value)) {
    if (!isRecord(media)) continue;
    const schema = summarizeSchema(media["schema"], context, baseUrl);
    if (schema) schemas[contentType] = schema;
  }
  return schemas;
}

function summarizeSchema(
  value: unknown,
  context: OpenApiResolveContext,
  baseUrl: string,
  seen = new Set<string>()
): ApiSchemaSummary | null {
  const ref = isRecord(value) ? stringOrNull(value["$ref"]) : null;
  const resolved = dereference(value, context, baseUrl, seen);
  if (!isRecord(resolved.value)) {
    return ref
      ? {
          name: schemaNameFromRef(ref),
          type: null,
          ref,
          description: null,
          required: [],
          properties: [],
        }
      : null;
  }

  const name = ref ? schemaNameFromRef(ref) : null;
  const required = Array.isArray(resolved.value["required"])
    ? resolved.value["required"].filter((item): item is string => typeof item === "string")
    : [];
  const properties: ApiSchemaSummary["properties"] = [];
  const rawProperties = resolved.value["properties"];
  if (isRecord(rawProperties)) {
    for (const [propertyName, propertySchema] of Object.entries(rawProperties)) {
      const propertyRef = isRecord(propertySchema) ? stringOrNull(propertySchema["$ref"]) : null;
      const propertyResolved = dereference(propertySchema, context, resolved.baseUrl, new Set(seen));
      properties.push({
        name: propertyName,
        type: schemaType(propertyResolved.value),
        ref: propertyRef,
        description: isRecord(propertyResolved.value) ? stringOrNull(propertyResolved.value["description"]) : null,
        required: required.includes(propertyName),
      });
    }
  }

  const items = isRecord(resolved.value["items"])
    ? summarizeSchema(resolved.value["items"], context, resolved.baseUrl, new Set(seen))
    : null;
  const enumValues = Array.isArray(resolved.value["enum"])
    ? resolved.value["enum"].map((item) => String(item))
    : undefined;

  return {
    name,
    type: schemaType(resolved.value),
    ref,
    description: stringOrNull(resolved.value["description"]),
    required,
    properties,
    ...(enumValues ? { enum: enumValues } : {}),
    ...(items ? { items } : {}),
  };
}

function dereference(
  value: unknown,
  context: OpenApiResolveContext,
  baseUrl: string,
  seen = new Set<string>()
): OpenApiResolvedValue {
  if (!isRecord(value)) return { value, baseUrl, ref: null };
  const ref = stringOrNull(value["$ref"]);
  if (!ref) return { value, baseUrl, ref: null };
  const resolvedRef = resolveOpenApiRef(context, ref, baseUrl);
  const seenKey = resolvedRef ? `${resolvedRef.baseUrl}#${resolvedRef.pointer}` : ref;
  if (!resolvedRef || seen.has(seenKey)) return { value, baseUrl, ref };
  seen.add(seenKey);
  if (!isRecord(resolvedRef.value)) return { value, baseUrl, ref };
  const { $ref: _ref, ...overrides } = value;
  const resolved = dereference(resolvedRef.value, context, resolvedRef.baseUrl, seen);
  return {
    value: {
      ...(isRecord(resolved.value) ? resolved.value : {}),
      ...overrides,
    },
    baseUrl: resolved.baseUrl,
    ref,
  };
}

function resolveOpenApiRef(
  context: OpenApiResolveContext,
  ref: string,
  baseUrl: string
): { value: unknown; baseUrl: string; pointer: string } | null {
  const hashIndex = ref.indexOf("#");
  const documentPart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const pointer = hashIndex === -1 ? "" : ref.slice(hashIndex + 1);
  const documentUrl = documentPart
    ? canonicalOpenApiDocumentUrl(new URL(documentPart, baseUrl).toString())
    : canonicalOpenApiDocumentUrl(baseUrl);
  const document = context.documents.get(documentUrl);
  if (!document) return null;
  if (!pointer) return { value: document, baseUrl: documentUrl, pointer: "" };
  if (!pointer.startsWith("/")) return null;
  return {
    value: resolveJsonPointer(document, pointer),
    baseUrl: documentUrl,
    pointer,
  };
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const segment of segments) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return current;
}

function schemaType(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value["type"] === "string") return value["type"];
  if (Array.isArray(value["oneOf"])) return "oneOf";
  if (Array.isArray(value["anyOf"])) return "anyOf";
  if (Array.isArray(value["allOf"])) return "allOf";
  if (isRecord(value["properties"])) return "object";
  if (isRecord(value["items"])) return "array";
  return null;
}

function schemaNameFromRef(ref: string): string | null {
  const segment = ref.split("/").filter(Boolean).at(-1);
  return segment ? decodeURIComponent(segment.replace(/~1/g, "/").replace(/~0/g, "~")) : null;
}

function formatSchemaSummary(schema: ApiSchemaSummary): string {
  const parts = [
    schema.name,
    schema.type,
    schema.ref && !schema.name ? schema.ref : null,
    schema.enum?.length ? `enum: ${schema.enum.join(", ")}` : null,
    schema.items ? `items: ${schema.items.name ?? schema.items.type ?? schema.items.ref ?? "schema"}` : null,
    schema.required.length ? `required: ${schema.required.join(", ")}` : null,
  ].filter(Boolean);
  return parts.join("; ") || "schema";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function renderRawOpenApiMarkdown(raw: string, sourceUrl: string): string {
  return [
    "# OpenAPI Specification",
    "",
    `Source: ${sourceUrl}`,
    "",
    "The source could not be parsed as JSON or YAML. Raw spec content follows.",
    "",
    "```yaml",
    raw.trim(),
    "```",
  ].join("\n");
}

function isHttpMethod(value: string): boolean {
  return ["get", "put", "post", "delete", "patch", "options", "head", "trace"].includes(
    value.toLowerCase()
  );
}
