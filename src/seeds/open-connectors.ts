import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SeedLibrary } from "./types.js";

export interface OpenConnectorSeedOptions {
  rootPath: string;
  enabledOnly?: boolean;
}

interface ConnectorPackageJson {
  name?: string;
  description?: string;
  keywords?: string[];
  repository?: string | { url?: string };
  homepage?: string;
}

interface OpenConnectorsManifest {
  connectors?: string[];
}

type SeedLink = NonNullable<SeedLibrary["links"]>[number];

export function loadOpenConnectorSeeds(options: OpenConnectorSeedOptions): SeedLibrary[] {
  const rootPath = options.rootPath.trim();
  if (!rootPath) return [];

  const connectorsDir = join(rootPath, "connectors");
  if (!existsSync(connectorsDir) || !statSync(connectorsDir).isDirectory()) {
    throw new Error(`Open connectors directory not found: ${connectorsDir}`);
  }

  const enabled = options.enabledOnly ? readEnabledConnectorSet(rootPath) : null;
  const seeds: SeedLibrary[] = [];

  for (const entry of readdirSync(connectorsDir).sort()) {
    const connectorDir = join(connectorsDir, entry);
    if (!statSync(connectorDir).isDirectory()) continue;
    const packagePath = join(connectorDir, "package.json");
    if (!existsSync(packagePath)) continue;

    const packageJson = readJsonFile<ConnectorPackageJson>(packagePath);
    const slug = normalizeConnectorSlug(entry, packageJson.name);
    if (!slug) continue;
    if (enabled && !enabled.has(slug)) continue;

    const displayName = connectorDisplayName(slug, packageJson.name);
    const npmPackage = packageJson.name?.startsWith("@hasna/connect-")
      ? packageJson.name
      : `@hasna/connect-${slug}`;
    const repo = repositorySlug(packageJson.repository);
    const docsUrl = preferredDocsUrl(packageJson.homepage, connectorDir);

    seeds.push({
      name: displayName,
      slug,
      description: packageJson.description ?? `${displayName} API documentation source imported from open-connectors.`,
      npm_package: npmPackage,
      github_repo: repo ?? "hasna/connectors",
      docs_url: docsUrl ?? undefined,
      source_type: "api",
      freshness_days: 3,
      priority: 15,
      tags: unique(["api", "saas", "open-connectors", ...(packageJson.keywords ?? [])]),
      links: uniqueLinks([
        docsUrl ? { type: "docs", url: docsUrl, label: "Official docs" } : null,
        { type: "npm", url: `https://npmjs.com/package/${encodeURIComponent(npmPackage)}`, label: npmPackage },
        repo ? { type: "github", url: `https://github.com/${repo}`, label: repo } : null,
      ]),
    });
  }

  return seeds;
}

function readEnabledConnectorSet(rootPath: string): Set<string> {
  const manifestPath = join(rootPath, ".connectors", "manifest.json");
  if (!existsSync(manifestPath)) return new Set();
  const manifest = readJsonFile<OpenConnectorsManifest>(manifestPath);
  return new Set((manifest.connectors ?? []).map((item) => normalizeConnectorSlug(item)).filter(Boolean));
}

function normalizeConnectorSlug(entry: string, packageName?: string): string {
  const source = packageName?.startsWith("@hasna/connect-")
    ? packageName.slice("@hasna/connect-".length)
    : entry.replace(/^connect-/, "");
  return source
    .trim()
    .toLowerCase()
    .replace(/^connect-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function connectorDisplayName(slug: string, packageName?: string): string {
  const packageBase = packageName?.split("/").at(-1)?.replace(/^connect-/, "");
  const source = packageBase || slug;
  return source
    .split("-")
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function preferredDocsUrl(homepage: string | undefined, connectorDir: string): string | null {
  if (homepage && isExternalDocsUrl(homepage)) return homepage;
  const readmePath = join(connectorDir, "README.md");
  if (!existsSync(readmePath)) return null;
  const readme = readFileSync(readmePath, "utf8");
  const urls = readme.match(/https?:\/\/[^\s)>'"]+/g) ?? [];
  return urls.find(isExternalDocsUrl) ?? null;
}

function isExternalDocsUrl(url: string): boolean {
  try {
    if (url.includes("...") || url.includes("<") || url.includes(">")) return false;
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes(".") || host.includes("...")) return false;
    if (host === "example.com" || host.endsWith(".example.com")) return false;
    if (host === "github.com" || host.endsWith(".github.com")) return false;
    if (host === "npmjs.com" || host.endsWith(".npmjs.com")) return false;
    if (host.includes("hasna")) return false;
    return hasDocsSignal(parsed);
  } catch {
    return false;
  }
}

function hasDocsSignal(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return (
    host === "docs.com" ||
    host.startsWith("docs.") ||
    host.includes(".docs.") ||
    path.includes("/docs") ||
    path.includes("/developers") ||
    path.includes("/developer") ||
    path.includes("/reference") ||
    path.includes("/api-reference")
  );
}

function repositorySlug(repository: ConnectorPackageJson["repository"]): string | null {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;
  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "");
  return cleaned.includes("/") ? cleaned : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueLinks(links: Array<SeedLink | null>): SeedLink[] {
  const seen = new Set<string>();
  return links.filter((link): link is SeedLink => {
    if (!link || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
