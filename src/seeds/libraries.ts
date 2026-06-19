import { BACKEND_SEED_LIBRARIES } from "./backend.js";
import { ECOSYSTEM_SEED_LIBRARIES } from "./ecosystem.js";
import { FRONTEND_SEED_LIBRARIES } from "./frontend.js";
import type { SeedLibrary } from "./types.js";
import type { CreateLibraryInput } from "../types/index.js";

export type { SeedLibrary } from "./types.js";
export type SeedLibraryGroup = "llm" | "saas" | "all";

export interface SeedSelectionOptions {
  groups?: SeedLibraryGroup[];
  slugs?: string[];
  limit?: number;
  refreshableOnly?: boolean;
}

export const SEED_LIBRARIES: SeedLibrary[] = [
  ...FRONTEND_SEED_LIBRARIES,
  ...BACKEND_SEED_LIBRARIES,
  ...ECOSYSTEM_SEED_LIBRARIES,
];

export function getSeedSourceMetadata(
  seed: SeedLibrary
): Pick<CreateLibraryInput, "source_type" | "source_url" | "freshness_days" | "priority"> {
  const apiTagged = seed.tags.includes("api");

  return {
    source_type: seed.source_type ?? (apiTagged ? "api" : undefined),
    source_url: seed.source_url,
    freshness_days: seed.freshness_days ?? (apiTagged ? 3 : undefined),
    priority: seed.priority ?? (apiTagged ? 10 : undefined),
  };
}

export function selectSeedLibraries(
  input: SeedSelectionOptions = {}
): SeedLibrary[] {
  const groups: SeedLibraryGroup[] = input.groups?.length ? input.groups : ["all"];
  const slugFilter = new Set(input.slugs?.map((slug) => slug.trim()).filter(Boolean));
  const limit = input.limit ?? 0;
  const canSelect = input.refreshableOnly ? isRefreshableSeed : () => true;

  if (slugFilter.size > 0) {
    const explicit = SEED_LIBRARIES.filter((seed) => slugFilter.has(seed.slug) && canSelect(seed));
    return limit > 0 ? explicit.slice(0, limit) : explicit;
  }

  if (groups.includes("all")) {
    const all = SEED_LIBRARIES.filter(canSelect);
    return limit > 0 ? all.slice(0, limit) : all;
  }

  const grouped = groups.map((group) =>
    SEED_LIBRARIES.filter((seed) => seedMatchesGroup(seed, group) && canSelect(seed))
  );
  const selected: SeedLibrary[] = [];
  const seen = new Set<string>();
  const maxGroupLength = Math.max(0, ...grouped.map((items) => items.length));

  for (let index = 0; index < maxGroupLength; index++) {
    for (const items of grouped) {
      const seed = items[index];
      if (!seed || seen.has(seed.slug)) continue;
      selected.push(seed);
      seen.add(seed.slug);
      if (limit > 0 && selected.length >= limit) return selected;
    }
  }

  return selected;
}

export function isRefreshableSeed(seed: SeedLibrary): boolean {
  return Boolean(seed.docs_url || seed.source_url || seed.npm_package || seed.github_repo);
}

export function seedMatchesGroup(seed: SeedLibrary, group: SeedLibraryGroup): boolean {
  if (group === "all") return true;
  if (group === "llm") {
    return seed.tags.includes("llm") || seed.tags.includes("ai") || [
      "openai",
      "anthropic",
      "xai",
      "deepseek",
      "gemini",
      "mistral",
      "cohere",
      "groq",
      "perplexity",
      "together-ai",
      "vercel-ai-sdk",
    ].includes(seed.slug);
  }
  if (group === "saas") {
    return seed.tags.includes("saas") || [
      "stripe",
      "slack",
      "notion",
      "linear",
      "github-rest",
      "jira",
      "shopify",
      "hubspot",
      "discord",
    ].includes(seed.slug);
  }
  return false;
}
