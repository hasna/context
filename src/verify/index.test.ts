import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import {
  runExternalRetrieverSmoke,
  runLocalSourceSmoke,
  runRefreshLoopSmoke,
  runSemanticSearchSmoke,
  runVerification,
  requiredCorpusSmokeSlugs,
  seedSearchQuery,
  selectRequiredCorpusSmokeSeeds,
  selectSeedSmokeSeeds,
} from "./index.js";

let tempHome: string;
let oldHome: string | undefined;
let oldDb: string | undefined;
let oldContextDb: string | undefined;
let oldExa: string | undefined;
let oldFirecrawl: string | undefined;
let oldRetriever: string | undefined;
let oldCrawler: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "context-verify-test-"));
  oldHome = process.env["HOME"];
  oldDb = process.env["HASNA_CONTEXT_DB_PATH"];
  oldContextDb = process.env["CONTEXT_DB_PATH"];
  oldExa = process.env["EXA_API_KEY"];
  oldFirecrawl = process.env["FIRECRAWL_API_KEY"];
  oldRetriever = process.env["CONTEXT_RETRIEVER"];
  oldCrawler = process.env["CONTEXT_CRAWLER"];
  process.env["HOME"] = tempHome;
  process.env["HASNA_CONTEXT_DB_PATH"] = ":memory:";
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  delete process.env["EXA_API_KEY"];
  delete process.env["FIRECRAWL_API_KEY"];
  delete process.env["CONTEXT_RETRIEVER"];
  delete process.env["CONTEXT_CRAWLER"];
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  restoreEnv("HOME", oldHome);
  restoreEnv("HASNA_CONTEXT_DB_PATH", oldDb);
  restoreEnv("CONTEXT_DB_PATH", oldContextDb);
  restoreEnv("EXA_API_KEY", oldExa);
  restoreEnv("FIRECRAWL_API_KEY", oldFirecrawl);
  restoreEnv("CONTEXT_RETRIEVER", oldRetriever);
  restoreEnv("CONTEXT_CRAWLER", oldCrawler);
  rmSync(tempHome, { recursive: true, force: true });
});

describe("runVerification", () => {
  it("builds a read-only readiness report", async () => {
    const report = await runVerification({
      includePublish: false,
      includeSourceReadiness: true,
    });

    expect(report.publish).toBeNull();
    expect(report.sources?.totals.libraries).toBe(0);
    expect(report.retrievers.default).toBe("firecrawl");
    expect(report.retrievers.exa).toBe(false);
    expect(report.retrievers.firecrawl).toBe(false);
    expect(report.corpus?.ready).toBe(true);
    expect(report.corpus?.required.llm.missing).toEqual([]);
    expect(report.smoke.local).toHaveLength(0);
    expect(report.smoke.refresh_loop).toBeNull();
    expect(report.smoke.semantic).toBeNull();
  });

  it("can skip the seed corpus coverage audit", async () => {
    const report = await runVerification({
      includePublish: false,
      includeSourceReadiness: false,
      includeCorpusCoverage: false,
    });

    expect(report.corpus).toBeNull();
  });

  it("reports Exa as the default only when explicitly configured", async () => {
    process.env["CONTEXT_RETRIEVER"] = "exa";
    const report = await runVerification({
      includePublish: false,
      includeSourceReadiness: false,
    });

    expect(report.retrievers.default).toBe("exa");
  });

  it("runs isolated local source smoke cases across native source types", async () => {
    const results = await runLocalSourceSmoke(2);

    expect(results.map((item) => item.id)).toEqual([
      "local-docs",
      "local-llms-txt",
      "local-website",
      "local-openapi",
      "local-github",
      "local-npm",
      "local-api",
      "local-discovered-firecrawl",
    ]);
    expect(results.every((item) => item.status === "passed")).toBe(true);
    expect(results.every((item) => item.pages_ingested > 0)).toBe(true);
    expect(results.every((item) => item.chunks_indexed > 0)).toBe(true);
    expect(results.every((item) => item.files_written > 0)).toBe(true);
    expect(results.every((item) => item.search_hits > 0)).toBe(true);
    expect(results.every((item) => item.max_pages === 2)).toBe(true);
    expect(results.every((item) => item.pages_retrieved > 0)).toBe(true);
    expect(results.every((item) => typeof item.full_docs_detected === "boolean")).toBe(true);
    const discovered = results.find((item) => item.id === "local-discovered-firecrawl");
    expect(discovered?.retrieved_by).toBe("firecrawl");
    expect(discovered?.source_discovery?.status).toBe("found");
    expect(discovered?.source_discovery?.url).toBe("https://verify.local/discovered-docs");
  });

  it("can require full-doc coverage for smoke cases", async () => {
    const results = await runLocalSourceSmoke(1, { requireFullDocs: true });

    expect(results.every((item) => item.coverage_required)).toBe(true);
    expect(results.every((item) => item.status === "failed")).toBe(true);
    expect(results.every((item) => item.coverage_passed === false)).toBe(true);
    expect(results.every((item) => item.coverage_issues.some((issue) => issue.includes("Page budget was saturated")))).toBe(true);
    expect(results.find((item) => item.id === "local-llms-txt")?.coverage_issues).toContain(
      "Full documentation coverage was not detected for llms_txt source."
    );
  });

  it("passes strict full-doc coverage when the page budget includes llms-full", async () => {
    const results = await runLocalSourceSmoke(2, { requireFullDocs: true });

    expect(results.every((item) => item.status === "passed")).toBe(true);
    expect(results.every((item) => item.coverage_required)).toBe(true);
    expect(results.every((item) => item.coverage_passed)).toBe(true);
    expect(results.find((item) => item.id === "local-llms-txt")?.full_docs_detected).toBe(true);
  });

  it("runs an isolated refresh loop smoke for update tasks and webhooks", async () => {
    const result = await runRefreshLoopSmoke(2);

    expect(result.status).toBe("passed");
    expect(result.task_created).toBe(true);
    expect(result.task_completed).toBe(true);
    expect(result.webhook_delivered).toBe(true);
    expect(result.event_received).toBe("docs.refreshed");
    expect(result.pages_ingested).toBeGreaterThan(0);
    expect(result.search_hits).toBeGreaterThan(0);
  });

  it("runs an isolated semantic search smoke with deterministic embeddings", async () => {
    const result = await runSemanticSearchSmoke();

    expect(result.status).toBe("passed");
    expect(result.embedded).toBe(2);
    expect(result.total_chunks).toBe(2);
    expect(result.top_hit).toContain("semantic-react-hook-token");
    expect(result.top_score).toBeGreaterThan(0.9);
  });

  it("skips external retriever smoke cases when keys are not configured", async () => {
    const results = await runExternalRetrieverSmoke(["firecrawl", "exa"], 1);

    expect(results).toHaveLength(2);
    expect(results.every((item) => item.status === "skipped")).toBe(true);
    expect(results.map((item) => item.retriever).sort()).toEqual(["exa", "firecrawl"]);
  });

  it("selects seeded LLM and SaaS source smoke matrices", () => {
    const llm = selectSeedSmokeSeeds({ groups: ["llm"], limit: 4 });
    expect(llm.map((seed) => seed.slug)).toContain("vercel-ai-sdk");
    expect(llm.every((seed) => seed.tags.includes("ai") || seed.tags.includes("llm"))).toBe(true);

    const saas = selectSeedSmokeSeeds({ groups: ["saas"], limit: 4 });
    expect(saas.map((seed) => seed.slug)).toContain("slack");
    expect(saas.every((seed) => seed.tags.includes("saas") || seed.slug === "stripe")).toBe(true);

    const explicit = selectSeedSmokeSeeds({ slugs: ["stripe", "anthropic"], limit: 10 });
    expect(explicit.map((seed) => seed.slug)).toEqual(["anthropic", "stripe"]);

    const mixed = selectSeedSmokeSeeds({ groups: ["llm", "saas"], limit: 6 });
    expect(mixed.some((seed) => seed.slug === "vercel-ai-sdk")).toBe(true);
    expect(mixed.some((seed) => seed.slug === "stripe")).toBe(true);
  });

  it("selects the full required corpus smoke matrix without arbitrary limits", () => {
    expect(requiredCorpusSmokeSlugs(["llm"])).toEqual([
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
    ]);
    expect(requiredCorpusSmokeSlugs(["saas"])).toEqual([
      "stripe",
      "slack",
      "notion",
      "linear",
      "github-rest",
      "jira",
      "shopify",
      "hubspot",
      "discord",
    ]);

    const required = selectRequiredCorpusSmokeSeeds();
    expect(required).toHaveLength(20);
    expect(required[0]?.slug).toBe("vercel-ai-sdk");
    expect(required.at(-1)?.slug).toBe("discord");
  });

  it("uses punctuation-safe search tokens for seeded source smokes", () => {
    expect(seedSearchQuery({
      name: "LangChain.js",
      slug: "langchainjs",
      description: "LangChain docs",
      tags: ["llm"],
    })).toBe("LangChain");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
