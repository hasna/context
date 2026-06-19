import type { Database } from "../db/database.js";
import {
  createLibrary,
  getLibraryBySlug,
  searchLibraries,
  updateLibraryMetadata,
} from "../db/libraries.js";
import { syncLinks, type LinkType } from "../db/links.js";
import { upsertNode } from "../db/kg.js";
import {
  refreshDocumentationSource,
  getDefaultExternalRetriever,
  type ExternalRetrieverType,
} from "../sources/refresh.js";
import type { CreateLibraryInput, Library, SourceRefreshResult } from "../types/index.js";
import {
  getSeedSourceMetadata,
  selectSeedLibraries,
  type SeedLibrary,
  type SeedLibraryGroup,
} from "./libraries.js";
import { loadOpenConnectorSeeds } from "./open-connectors.js";

export interface SeedBootstrapOptions {
  groups?: SeedLibraryGroup[];
  slugs?: string[];
  limit?: number;
  crawl?: boolean;
  newOnly?: boolean;
  maxPages?: number;
  retriever?: ExternalRetrieverType;
  retrieverOnly?: boolean;
  writeFiles?: boolean;
  embed?: boolean;
  embedAll?: boolean;
  embedLimit?: number;
  refreshableOnly?: boolean;
  openConnectorsPath?: string;
  openConnectorsEnabledOnly?: boolean;
  openConnectorsOnly?: boolean;
}

export interface SeedBootstrapItem {
  seed_slug: string;
  library_id: string | null;
  library_slug: string | null;
  library_name: string;
  source_type: string | null;
  source_url: string | null;
  status: "added" | "updated" | "failed";
  refreshed: boolean;
  refresh_skipped: boolean;
  result: SourceRefreshResult | null;
  error: string | null;
}

export interface SeedBootstrapReport {
  generated_at: string;
  selected_count: number;
  added_count: number;
  updated_count: number;
  refreshed_count: number;
  refresh_skipped_count: number;
  failed_count: number;
  retriever: ExternalRetrieverType;
  max_pages: number;
  crawl: boolean;
  new_only: boolean;
  items: SeedBootstrapItem[];
}

export async function bootstrapSeedSources(
  options: SeedBootstrapOptions = {},
  db?: Database
): Promise<SeedBootstrapReport> {
  const seeds = selectSeedLibraries({
    groups: options.openConnectorsOnly ? [] : options.groups,
    slugs: options.openConnectorsOnly ? [] : options.slugs,
    limit: options.openConnectorsOnly ? undefined : options.limit,
    refreshableOnly: options.refreshableOnly,
  });
  const selectedSeeds = selectBootstrapSeeds(seeds, options);
  const retriever = options.retriever ?? getDefaultExternalRetriever();
  const maxPages = options.maxPages ?? 10;
  const items: SeedBootstrapItem[] = [];

  for (const seed of selectedSeeds) {
    try {
      const existing = findSeedLibrary(seed, db);
      const wasExisting = Boolean(existing);
      const library = existing
        ? updateLibraryMetadata(existing.id, seedToLibraryInput(seed), db)
        : createLibrary(seedToLibraryInput(seed), db);

      syncSeedReferences(library, seed, db);

      let result: SourceRefreshResult | null = null;
      let refreshed = false;
      let refreshSkipped = false;
      if (options.crawl && (!options.newOnly || !wasExisting)) {
        result = await refreshDocumentationSource(
          library.id,
          {
            maxPages,
            retriever,
            retrieverOnly: options.retrieverOnly,
            writeFiles: options.writeFiles,
            embed: options.embed,
            embedAll: options.embedAll,
            embedLimit: options.embedLimit,
          },
          db
        );
        refreshed = true;
      } else if (options.crawl && options.newOnly && wasExisting) {
        refreshSkipped = true;
      }

      items.push({
        seed_slug: seed.slug,
        library_id: library.id,
        library_slug: library.slug,
        library_name: library.name,
        source_type: library.source_type,
        source_url: library.source_url,
        status: wasExisting ? "updated" : "added",
        refreshed,
        refresh_skipped: refreshSkipped,
        result,
        error: null,
      });
    } catch (error) {
      items.push({
        seed_slug: seed.slug,
        library_id: null,
        library_slug: null,
        library_name: seed.name,
        source_type: null,
        source_url: null,
        status: "failed",
        refreshed: false,
        refresh_skipped: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    selected_count: selectedSeeds.length,
    added_count: items.filter((item) => item.status === "added").length,
    updated_count: items.filter((item) => item.status === "updated").length,
    refreshed_count: items.filter((item) => item.refreshed).length,
    refresh_skipped_count: items.filter((item) => item.refresh_skipped).length,
    failed_count: items.filter((item) => item.status === "failed").length,
    retriever,
    max_pages: maxPages,
    crawl: options.crawl ?? false,
    new_only: options.newOnly ?? false,
    items,
  };
}

function selectBootstrapSeeds(
  baseSeeds: SeedLibrary[],
  options: SeedBootstrapOptions
): SeedLibrary[] {
  const slugFilter = new Set(options.slugs?.map((slug) => slug.trim().toLowerCase()).filter(Boolean));
  const connectorSeeds = options.openConnectorsPath
    ? loadOpenConnectorSeeds({
        rootPath: options.openConnectorsPath,
        enabledOnly: options.openConnectorsEnabledOnly,
      })
    : [];
  const candidates = options.openConnectorsOnly ? connectorSeeds : mergeSeedSources(baseSeeds, connectorSeeds);
  const filtered = slugFilter.size > 0
    ? candidates.filter((seed) => slugFilter.has(seed.slug.toLowerCase()))
    : candidates;
  const deduped = dedupeSeeds(filtered);
  if (options.refreshableOnly) {
    const refreshable = deduped.filter((seed) => Boolean(seed.docs_url || seed.source_url || seed.npm_package || seed.github_repo));
    return limitSeeds(refreshable, options.limit);
  }
  return limitSeeds(deduped, options.limit);
}

function mergeSeedSources(baseSeeds: SeedLibrary[], connectorSeeds: SeedLibrary[]): SeedLibrary[] {
  if (connectorSeeds.length === 0) return baseSeeds;
  const bySlug = new Map<string, SeedLibrary>();
  for (const seed of baseSeeds) bySlug.set(seed.slug, seed);
  for (const connectorSeed of connectorSeeds) {
    const existing = bySlug.get(connectorSeed.slug);
    bySlug.set(
      connectorSeed.slug,
      existing ? mergeConnectorSeed(existing, connectorSeed) : connectorSeed
    );
  }
  return Array.from(bySlug.values());
}

function mergeConnectorSeed(base: SeedLibrary, connector: SeedLibrary): SeedLibrary {
  return {
    ...base,
    ...connector,
    description: connector.description || base.description,
    npm_package: connector.npm_package ?? base.npm_package,
    github_repo: connector.github_repo ?? base.github_repo,
    docs_url: connector.docs_url ?? base.docs_url,
    source_url: connector.source_url ?? (connector.source_type === base.source_type ? base.source_url : undefined),
    links: mergeSeedLinks(base.links, connector.links),
    tags: uniqueStrings([...(base.tags ?? []), ...(connector.tags ?? [])]),
  };
}

function mergeSeedLinks(
  baseLinks: SeedLibrary["links"],
  connectorLinks: SeedLibrary["links"]
): SeedLibrary["links"] {
  const byUrl = new Map<string, NonNullable<SeedLibrary["links"]>[number]>();
  for (const link of baseLinks ?? []) byUrl.set(link.url, link);
  for (const link of connectorLinks ?? []) byUrl.set(link.url, link);
  return Array.from(byUrl.values());
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function dedupeSeeds(seeds: SeedLibrary[]): SeedLibrary[] {
  const bySlug = new Map<string, SeedLibrary>();
  for (const seed of seeds) {
    if (!bySlug.has(seed.slug)) bySlug.set(seed.slug, seed);
  }
  return Array.from(bySlug.values());
}

function limitSeeds(seeds: SeedLibrary[], limit: number | undefined): SeedLibrary[] {
  return limit && limit > 0 ? seeds.slice(0, limit) : seeds;
}

export function seedToLibraryInput(seed: SeedLibrary): CreateLibraryInput {
  return {
    name: seed.name,
    slug: seed.slug,
    description: seed.description,
    npm_package: seed.npm_package,
    github_repo: seed.github_repo,
    docs_url: seed.docs_url,
    version: seed.version,
    ...getSeedSourceMetadata(seed),
  };
}

export function syncSeedReferences(library: Library, seed: SeedLibrary, db?: Database): void {
  if (seed.links) {
    syncLinks(
      library.id,
      seed.links.map((link) => ({
        type: link.type as LinkType,
        url: link.url,
        label: link.label,
      })),
      db
    );
  }

  upsertNode(
    {
      type: "library",
      name: seed.name,
      description: seed.description,
      library_id: library.id,
      metadata: { slug: seed.slug, tags: seed.tags, source_type: library.source_type },
    },
    db
  );
}

function findSeedLibrary(seed: SeedLibrary, db?: Database): Library | null {
  try {
    return getLibraryBySlug(seed.slug, db);
  } catch {
    const matches = searchLibraries(seed.name, 1, db);
    const exact = matches.find((item) => item.name.toLowerCase() === seed.name.toLowerCase());
    return exact ?? null;
  }
}
