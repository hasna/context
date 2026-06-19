import { describe, expect, it } from "bun:test";
import { getSeedCorpusCoverageReport, REQUIRED_LLM_SEED_SLUGS, REQUIRED_SAAS_SEED_SLUGS } from "./coverage.js";
import { getSeedSourceMetadata, seedMatchesGroup, selectSeedLibraries, SEED_LIBRARIES } from "./libraries.js";

describe("getSeedSourceMetadata", () => {
  it("treats API-tagged seeds as API documentation sources", () => {
    const source = getSeedSourceMetadata({
      name: "Example API",
      slug: "example-api",
      description: "Example API docs",
      docs_url: "https://example.com/docs",
      tags: ["saas", "api"],
    });

    expect(source.source_type).toBe("api");
    expect(source.freshness_days).toBe(3);
    expect(source.priority).toBe(10);
  });

  it("preserves explicit seed source overrides", () => {
    const source = getSeedSourceMetadata({
      name: "Example OpenAPI",
      slug: "example-openapi",
      description: "Example OpenAPI docs",
      docs_url: "https://example.com/openapi.json",
      source_type: "openapi",
      source_url: "https://example.com/openapi.json",
      freshness_days: 1,
      priority: 50,
      tags: ["api"],
    });

    expect(source.source_type).toBe("openapi");
    expect(source.source_url).toBe("https://example.com/openapi.json");
    expect(source.freshness_days).toBe(1);
    expect(source.priority).toBe(50);
  });

  it("uses llms.txt sources for LLM docs that publish AI-readable full docs", () => {
    const llmsSeedSlugs = [
      "vercel-ai-sdk",
      "anthropic",
      "mistral",
      "cohere",
      "groq",
      "perplexity",
      "together-ai",
    ];

    for (const slug of llmsSeedSlugs) {
      const seed = SEED_LIBRARIES.find((item) => item.slug === slug);
      expect(seed, slug).toBeTruthy();
      const source = getSeedSourceMetadata(seed!);
      expect(source.source_type, slug).toBe("llms_txt");
      expect(source.source_url, slug).toEndWith("/llms.txt");
      expect(source.freshness_days, slug).toBe(1);
      expect(source.priority, slug).toBe(25);
    }
  });

  it("keeps required LLM provider docs on daily high-priority refresh", () => {
    for (const slug of REQUIRED_LLM_SEED_SLUGS) {
      const seed = SEED_LIBRARIES.find((item) => item.slug === slug);
      expect(seed, slug).toBeTruthy();
      const source = getSeedSourceMetadata(seed!);
      expect(source.freshness_days, slug).toBeLessThanOrEqual(1);
      expect(source.priority, slug).toBeGreaterThanOrEqual(25);
    }
  });
});

describe("getSeedCorpusCoverageReport", () => {
  it("proves required provider, SaaS, origin, and source abstraction coverage", () => {
    const report = getSeedCorpusCoverageReport();

    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.required.llm.missing).toEqual([]);
    expect(report.required.saas.missing).toEqual([]);
    expect(report.required.source_types.missing).toEqual([]);
    expect(report.required.llm.present).toEqual([...REQUIRED_LLM_SEED_SLUGS]);
    expect(report.required.saas.present).toEqual([...REQUIRED_SAAS_SEED_SLUGS]);
    expect(report.origins.every((origin) => origin.ready)).toBe(true);
    expect(report.freshness.stale).toEqual([]);
  });
});

describe("selectSeedLibraries", () => {
  it("selects LLM and SaaS groups through shared source metadata", () => {
    const llm = selectSeedLibraries({ groups: ["llm"], limit: 3 });
    const saas = selectSeedLibraries({ groups: ["saas"], limit: 3 });

    expect(llm.length).toBe(3);
    expect(llm.some((seed) => seed.slug === "openai" || seed.slug === "anthropic")).toBe(true);
    expect(llm.every((seed) => seed.tags.includes("llm") || seed.tags.includes("ai"))).toBe(true);

    expect(saas.length).toBe(3);
    expect(saas.every((seed) => seedMatchesGroup(seed, "saas"))).toBe(true);
  });

  it("filters by explicit slugs before group defaults", () => {
    const selected = selectSeedLibraries({
      groups: ["llm"],
      slugs: ["slack", "stripe"],
      limit: 0,
    });

    expect(selected.map((seed) => seed.slug).sort()).toEqual(["slack", "stripe"]);
  });
});
