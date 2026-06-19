import type { LibrarySourceType } from "../types/index.js";
import { DOCUMENTATION_SOURCES } from "../sources/index.js";
import { getSeedSourceMetadata, selectSeedLibraries, SEED_LIBRARIES } from "./libraries.js";
import type { SeedLibrary } from "./types.js";

export type CorpusCoverageSeverity = "info" | "warning" | "error";

export interface CorpusCoverageIssue {
  code: string;
  severity: CorpusCoverageSeverity;
  message: string;
}

export interface CorpusSlugCoverage {
  required: string[];
  present: string[];
  missing: string[];
}

export interface CorpusOriginCoverage {
  id: CorpusOriginRequirementId;
  label: string;
  count: number;
  minimum: number;
  ready: boolean;
}

export interface CorpusFreshnessCoverage {
  required_daily_llm_slugs: string[];
  ready: string[];
  stale: Array<{
    slug: string;
    freshness_days: number;
    priority: number;
  }>;
}

export interface SeedCorpusCoverageReport {
  generated_at: string;
  ready: boolean;
  totals: {
    seeds: number;
    refreshable: number;
    llm: number;
    saas: number;
  };
  required: {
    llm: CorpusSlugCoverage;
    saas: CorpusSlugCoverage;
    source_types: {
      required: LibrarySourceType[];
      supported: LibrarySourceType[];
      missing: LibrarySourceType[];
    };
  };
  origins: CorpusOriginCoverage[];
  freshness: CorpusFreshnessCoverage;
  duplicate_slugs: string[];
  issues: CorpusCoverageIssue[];
}

export const REQUIRED_LLM_SEED_SLUGS = [
  "vercel-ai-sdk",
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
] as const;

export const REQUIRED_SAAS_SEED_SLUGS = [
  "stripe",
  "slack",
  "notion",
  "linear",
  "github-rest",
  "jira",
  "shopify",
  "hubspot",
  "discord",
] as const;

export const REQUIRED_SOURCE_TYPES: LibrarySourceType[] = [
  "docs",
  "website",
  "llms_txt",
  "openapi",
  "github",
  "npm",
  "api",
  "manual",
];

type CorpusOriginRequirementId =
  | "docs_url"
  | "source_url"
  | "npm_package"
  | "github_repo"
  | "api_link"
  | "llms_txt_source";

const ORIGIN_REQUIREMENTS: Array<{
  id: CorpusOriginRequirementId;
  label: string;
  minimum: number;
  count: (seed: SeedLibrary) => boolean;
}> = [
  {
    id: "docs_url",
    label: "official docs URLs",
    minimum: 100,
    count: (seed) => Boolean(seed.docs_url),
  },
  {
    id: "source_url",
    label: "explicit source URLs",
    minimum: 7,
    count: (seed) => Boolean(seed.source_url),
  },
  {
    id: "npm_package",
    label: "npm package identities",
    minimum: 80,
    count: (seed) => Boolean(seed.npm_package),
  },
  {
    id: "github_repo",
    label: "GitHub repository identities",
    minimum: 80,
    count: (seed) => Boolean(seed.github_repo),
  },
  {
    id: "api_link",
    label: "API reference links",
    minimum: 50,
    count: (seed) => Boolean(seed.links?.some((link) => link.type === "api")),
  },
  {
    id: "llms_txt_source",
    label: "llms.txt sources",
    minimum: 7,
    count: (seed) => seed.source_type === "llms_txt" || Boolean(seed.source_url?.endsWith("/llms.txt")),
  },
];

export function getSeedCorpusCoverageReport(): SeedCorpusCoverageReport {
  const issues: CorpusCoverageIssue[] = [];
  const bySlug = new Map<string, SeedLibrary>();
  const duplicateSlugs: string[] = [];

  for (const seed of SEED_LIBRARIES) {
    if (bySlug.has(seed.slug)) duplicateSlugs.push(seed.slug);
    bySlug.set(seed.slug, seed);
  }

  const llm = slugCoverage(REQUIRED_LLM_SEED_SLUGS, bySlug);
  const saas = slugCoverage(REQUIRED_SAAS_SEED_SLUGS, bySlug);
  const supportedSourceTypes = DOCUMENTATION_SOURCES.map((source) => source.id);
  const missingSourceTypes = REQUIRED_SOURCE_TYPES.filter((type) => !supportedSourceTypes.includes(type));
  const origins = ORIGIN_REQUIREMENTS.map((requirement) => {
    const count = SEED_LIBRARIES.filter(requirement.count).length;
    return {
      id: requirement.id,
      label: requirement.label,
      count,
      minimum: requirement.minimum,
      ready: count >= requirement.minimum,
    };
  });
  const freshness = dailyLlmFreshness(bySlug);

  if (duplicateSlugs.length > 0) {
    issues.push(error("duplicate_seed_slugs", `Duplicate seed slugs: ${duplicateSlugs.join(", ")}`));
  }
  if (llm.missing.length > 0) {
    issues.push(error("missing_llm_seeds", `Missing required LLM provider seeds: ${llm.missing.join(", ")}`));
  }
  if (saas.missing.length > 0) {
    issues.push(error("missing_saas_seeds", `Missing required SaaS/API seeds: ${saas.missing.join(", ")}`));
  }
  if (missingSourceTypes.length > 0) {
    issues.push(error("missing_source_types", `Missing source abstractions: ${missingSourceTypes.join(", ")}`));
  }
  for (const origin of origins) {
    if (!origin.ready) {
      issues.push(error(
        `insufficient_${origin.id}`,
        `Seed corpus has ${origin.count} ${origin.label}; expected at least ${origin.minimum}.`
      ));
    }
  }
  if (freshness.stale.length > 0) {
    issues.push(error(
      "stale_llm_seed_freshness",
      `Required LLM seeds must refresh daily with priority >= 25: ${freshness.stale.map((item) => item.slug).join(", ")}`
    ));
  }

  const llmSeeds = selectSeedLibraries({ groups: ["llm"] });
  const saasSeeds = selectSeedLibraries({ groups: ["saas"] });

  return {
    generated_at: new Date().toISOString(),
    ready: !issues.some((issue) => issue.severity === "error"),
    totals: {
      seeds: SEED_LIBRARIES.length,
      refreshable: SEED_LIBRARIES.filter(isRefreshable).length,
      llm: llmSeeds.length,
      saas: saasSeeds.length,
    },
    required: {
      llm,
      saas,
      source_types: {
        required: REQUIRED_SOURCE_TYPES,
        supported: supportedSourceTypes,
        missing: missingSourceTypes,
      },
    },
    origins,
    freshness,
    duplicate_slugs: duplicateSlugs,
    issues,
  };
}

function slugCoverage(
  requiredSlugs: readonly string[],
  bySlug: Map<string, SeedLibrary>
): CorpusSlugCoverage {
  const required = [...requiredSlugs];
  const present = required.filter((slug) => bySlug.has(slug));
  const missing = required.filter((slug) => !bySlug.has(slug));
  return { required, present, missing };
}

function dailyLlmFreshness(bySlug: Map<string, SeedLibrary>): CorpusFreshnessCoverage {
  const ready: string[] = [];
  const stale: CorpusFreshnessCoverage["stale"] = [];

  for (const slug of REQUIRED_LLM_SEED_SLUGS) {
    const seed = bySlug.get(slug);
    if (!seed) continue;
    const source = getSeedSourceMetadata(seed);
    const freshnessDays = source.freshness_days ?? 7;
    const priority = source.priority ?? 0;
    if (freshnessDays <= 1 && priority >= 25) {
      ready.push(slug);
    } else {
      stale.push({ slug, freshness_days: freshnessDays, priority });
    }
  }

  return {
    required_daily_llm_slugs: [...REQUIRED_LLM_SEED_SLUGS],
    ready,
    stale,
  };
}

function isRefreshable(seed: SeedLibrary): boolean {
  return Boolean(seed.docs_url || seed.source_url || seed.npm_package || seed.github_repo);
}

function error(code: string, message: string): CorpusCoverageIssue {
  return { code, severity: "error", message };
}
