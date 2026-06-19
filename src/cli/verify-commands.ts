import type { Command } from "commander";
import chalk from "chalk";
import { runVerification } from "../verify/index.js";
import type { SeedSmokeGroup } from "../verify/index.js";
import type { AiProviderId } from "../ai/providers.js";
import { parseExternalRetriever, resolveExternalRetriever, type ExternalRetrieverType } from "../sources/refresh.js";

export function registerVerifyCommands(program: Command): void {
  program
    .command("verify")
    .description("Run a docs intelligence readiness audit")
    .option("--no-publish", "Skip package publish readiness checks")
    .option("--registry", "Check npm registry publishability")
    .option("--no-corpus", "Skip seed corpus coverage audit")
    .option("--smoke", "Run isolated local source refresh/search smokes")
    .option("--seed-smoke [groups]", "Run isolated seeded source smokes for groups: llm,saas,all")
    .option("--required-smoke [groups]", "Run fetch/search smokes for required corpus groups: llm,saas,all")
    .option("--required-live-smoke [groups]", "Run live update cycle smoke for required corpus groups: llm,saas,all")
    .option("--seed-slugs <slugs>", "Comma-separated seed slugs for --seed-smoke")
    .option("--seed-limit <n>", "Maximum seeded sources to smoke", "6")
    .option("--seed-retriever <type>", "Retriever fallback for seeded source smokes: firecrawl|exa", "firecrawl")
    .option("--external-smoke", "Run isolated Firecrawl/Exa retriever smokes when keys are configured")
    .option("--retrievers <types>", "Comma-separated external retrievers for --external-smoke: firecrawl,exa", "firecrawl,exa")
    .option("--pages <n>", "Max pages per smoke source", "2")
    .option("--concurrency <n>", "Max concurrent smoke refreshes", "4")
    .option("--case-timeout-ms <ms>", "Max milliseconds per smoke source; 0 disables", "45000")
    .option("--require-full-docs", "Fail smoke checks when page limits are reached or llms.txt full docs are missing")
    .option("--ai-smoke [backend]", "Run a tiny AI SDK generation smoke with a backend id or default")
    .option("--json", "Output JSON")
    .action(async (opts: {
      registry?: boolean;
      publish?: boolean;
      smoke?: boolean;
      seedSmoke?: boolean | string;
      requiredSmoke?: boolean | string;
      requiredLiveSmoke?: boolean | string;
      seedSlugs?: string;
      seedLimit?: string;
      seedRetriever?: string;
      externalSmoke?: boolean;
      retrievers?: string;
      pages?: string;
      concurrency?: string;
      caseTimeoutMs?: string;
      requireFullDocs?: boolean;
      aiSmoke?: boolean | string;
      corpus?: boolean;
      json?: boolean;
    }) => {
      const report = await runVerification({
        includePublish: opts.publish,
        includeRegistry: opts.registry,
        includeCorpusCoverage: opts.corpus,
        includeLocalSmoke: opts.smoke,
        includeSeedSmoke: Boolean(opts.seedSmoke),
        includeRequiredCorpusSmoke: Boolean(opts.requiredSmoke),
        includeRequiredCorpusLiveUpdateSmoke: Boolean(opts.requiredLiveSmoke),
        seedGroups: parseSeedGroups(opts.seedSmoke),
        requiredCorpusGroups: parseRequiredGroups(opts.requiredSmoke),
        requiredLiveUpdateGroups: parseRequiredGroups(opts.requiredLiveSmoke),
        seedSlugs: parseList(opts.seedSlugs),
        seedLimit: parseInt(opts.seedLimit ?? "6", 10),
        seedRetriever: parseRetriever(opts.seedRetriever),
        includeExternalSmoke: opts.externalSmoke,
        retrievers: parseRetrievers(opts.retrievers),
        maxPages: parseInt(opts.pages ?? "2", 10),
        smokeConcurrency: parsePositiveInt(opts.concurrency, 4),
        smokeCaseTimeoutMs: parseNonNegativeInt(opts.caseTimeoutMs, 45_000),
        requireFullDocs: opts.requireFullDocs,
        aiSmoke: parseAiSmoke(opts.aiSmoke),
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (!report.ready) process.exitCode = 1;
        return;
      }

      printVerificationReport(report);
      if (!report.ready) process.exitCode = 1;
    });
}

type VerificationReport = Awaited<ReturnType<typeof runVerification>>;

function printVerificationReport(report: VerificationReport): void {
  console.log(chalk.bold("\nContext Verification\n"));
  console.log(`  Status:     ${report.ready ? chalk.green("ready") : chalk.red("not ready")}`);
  if (report.publish) {
    console.log(`  Package:    ${report.publish.package.name}@${report.publish.package.version}`);
    console.log(`  Publish:    ${report.publish.ready ? chalk.green("ready") : chalk.red("not ready")}`);
    if (report.publish.package.latest_registry_version) {
      console.log(`  npm latest: ${report.publish.package.latest_registry_version}`);
    }
  }
  console.log(`  AI SDK:     ${report.ai.configured.length > 0 ? report.ai.configured.join(", ") : "no keys configured"}`);
  console.log(`  Retrievers: exa=${formatBool(report.retrievers.exa)} firecrawl=${formatBool(report.retrievers.firecrawl)}`);
  if (report.sources) {
    console.log(
      `  Sources:    ${report.sources.totals.indexed}/${report.sources.totals.libraries} indexed, ` +
        `${report.sources.totals.with_errors} error(s), ${report.sources.totals.due} due`
    );
  }
  if (report.corpus) {
    console.log(
      `  Corpus:     ${report.corpus.ready ? chalk.green("ready") : chalk.red("not ready")} ` +
        `(${report.corpus.totals.seeds} seeds, ${report.corpus.totals.llm} LLM, ${report.corpus.totals.saas} SaaS)`
    );
  }

  if (report.ai.smoke) {
    console.log(chalk.bold("\nAI Smoke"));
    const smoke = report.ai.smoke;
    console.log(`  ${formatStatus(smoke.status)} ${smoke.backend ?? "default"}${smoke.model ? ` (${smoke.model})` : ""}`);
    if (smoke.error) console.log(chalk.gray(`    ${smoke.error}`));
  }

  printSmokeGroup("Local Source Smokes", report.smoke.local);
  printRefreshLoopSmoke(report.smoke.refresh_loop);
  printSemanticSmoke(report.smoke.semantic);
  printCorpusCoverage(report.corpus);
  printRequiredLiveUpdateSmoke(report.smoke.required_live_update);
  printSmokeGroup("Required Corpus Smokes", report.smoke.required_corpus);
  printSmokeGroup("Seed Source Smokes", report.smoke.seed);
  printSmokeGroup("External Retriever Smokes", report.smoke.external);

  if (report.issues.length > 0) {
    console.log(chalk.bold("\nIssues"));
    for (const issue of report.issues) {
      const color = issue.severity === "error" ? chalk.red : issue.severity === "warning" ? chalk.yellow : chalk.gray;
      console.log(color(`  ${issue.severity}: ${issue.message}`));
    }
  }
  console.log();
}

function printCorpusCoverage(corpus: VerificationReport["corpus"]): void {
  if (!corpus) return;
  console.log(chalk.bold("\nSeed Corpus Coverage"));
  console.log(
    `  ${corpus.ready ? chalk.green("pass") : chalk.red("fail")} required providers/apps/source abstractions`
  );
  console.log(
    chalk.gray(
      `    LLM ${corpus.required.llm.present.length}/${corpus.required.llm.required.length}, ` +
        `SaaS ${corpus.required.saas.present.length}/${corpus.required.saas.required.length}, ` +
        `source types ${corpus.required.source_types.supported.length}/${corpus.required.source_types.required.length}`
    )
  );
  const stale = corpus.freshness.stale.map((item) => item.slug);
  if (stale.length > 0) console.log(chalk.gray(`    stale daily LLM sources: ${stale.join(", ")}`));
  const missingOrigins = corpus.origins.filter((origin) => !origin.ready);
  for (const origin of missingOrigins) {
    console.log(chalk.gray(`    ${origin.label}: ${origin.count}/${origin.minimum}`));
  }
}

function printRequiredLiveUpdateSmoke(smoke: VerificationReport["smoke"]["required_live_update"]): void {
  if (!smoke) return;
  console.log(chalk.bold("\nRequired Corpus Live Update Smoke"));
  console.log(
    `  ${formatStatus(smoke.status)} ${smoke.refreshed_count}/${smoke.selected_count} refreshed, ` +
      `${smoke.task_done_count}/${smoke.selected_count} tasks done`
  );
  console.log(
    chalk.gray(
      `    docs=${smoke.docs_ready_count}/${smoke.selected_count}, ` +
        `search=${smoke.search_ready_count}/${smoke.selected_count}, ` +
        (smoke.coverage_required ? `coverage=${smoke.coverage_ready_count}/${smoke.selected_count}, ` : "") +
        `pages=${smoke.total_pages_ingested}, chunks=${smoke.total_chunks_indexed}, files=${smoke.total_files_written}`
    )
  );
  for (const failure of smoke.failures.slice(0, 5)) {
    console.log(chalk.gray(`    ${failure.library_slug}: ${failure.error}`));
  }
  if (smoke.failures.length > 5) {
    console.log(chalk.gray(`    ...${smoke.failures.length - 5} more failure(s)`));
  }
}

function printRefreshLoopSmoke(smoke: VerificationReport["smoke"]["refresh_loop"]): void {
  if (!smoke) return;
  console.log(chalk.bold("\nRefresh Loop Smoke"));
  const detail = smoke.status === "skipped"
    ? smoke.error
    : `${smoke.pages_ingested} pages, ${smoke.chunks_indexed} chunks, ${smoke.search_hits} hits, ` +
      `task=${smoke.task_completed ? "done" : "missing"}, webhook=${smoke.webhook_delivered ? "delivered" : "missing"}`;
  console.log(`  ${formatStatus(smoke.status)} update task + webhook refresh`);
  if (detail) console.log(chalk.gray(`    ${detail}`));
}

function printSemanticSmoke(smoke: VerificationReport["smoke"]["semantic"]): void {
  if (!smoke) return;
  console.log(chalk.bold("\nSemantic Search Smoke"));
  const detail = smoke.status === "skipped"
    ? smoke.error
    : `${smoke.embedded}/${smoke.total_chunks} embedded, top score ${smoke.top_score?.toFixed(3) ?? "n/a"}`;
  console.log(`  ${formatStatus(smoke.status)} SQLite embedding search`);
  if (detail) console.log(chalk.gray(`    ${detail}`));
}

function printSmokeGroup(
  title: string,
  smokes: VerificationReport["smoke"]["local"]
): void {
  if (smokes.length === 0) return;
  console.log(chalk.bold(`\n${title}`));
  for (const smoke of smokes) {
    const detail = smoke.status === "skipped"
      ? smoke.error
      : [
          `${smoke.pages_ingested} pages`,
          `${smoke.chunks_indexed} chunks`,
          `${smoke.files_written} files`,
          `${smoke.search_hits} hits`,
          `retrieved ${smoke.pages_retrieved}/${smoke.max_pages}`,
          smoke.page_limit_reached ? "page limit reached" : null,
          smoke.full_docs_detected ? "llms-full detected" : null,
          smoke.coverage_required && !smoke.coverage_passed ? "coverage failed" : null,
        ].filter(Boolean).join(", ");
    console.log(`  ${formatStatus(smoke.status)} ${smoke.name} ${chalk.gray(`[${smoke.source_type}]`)}`);
    if (detail) console.log(chalk.gray(`    ${detail}`));
    if (smoke.source_discovery?.status === "found" && smoke.source_discovery.url) {
      console.log(chalk.gray(`    discovered: ${smoke.source_discovery.provider} -> ${smoke.source_discovery.url}`));
    }
    for (const issue of smoke.coverage_required ? smoke.coverage_issues : []) {
      console.log(chalk.gray(`    coverage: ${issue}`));
    }
  }
}

function parseRetrievers(value?: string): ExternalRetrieverType[] {
  const parsed = parseList(value ?? "firecrawl,exa");
  const invalid = parsed.find((item) => !parseExternalRetriever(item));
  if (invalid) fail(`Invalid retriever "${invalid}". Expected firecrawl or exa.`);
  const retrievers = parsed
    .map((item) => parseExternalRetriever(item))
    .filter((item): item is ExternalRetrieverType => Boolean(item));
  return retrievers.length > 0 ? retrievers : ["firecrawl", "exa"];
}

function parseRetriever(value?: string): ExternalRetrieverType {
  try {
    return resolveExternalRetriever(value, "firecrawl");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function parseSeedGroups(value?: boolean | string): SeedSmokeGroup[] {
  if (!value || value === true) return ["llm"];
  const groups = parseList(value).filter((item): item is SeedSmokeGroup =>
    item === "llm" || item === "saas" || item === "all"
  );
  return groups.length > 0 ? groups : ["llm"];
}

function parseRequiredGroups(value?: boolean | string): SeedSmokeGroup[] {
  if (!value || value === true) return ["all"];
  const groups = parseList(value).filter((item): item is SeedSmokeGroup =>
    item === "llm" || item === "saas" || item === "all"
  );
  return groups.length > 0 ? groups : ["all"];
}

function parseList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseAiSmoke(value?: boolean | string): AiProviderId | "default" | undefined {
  if (!value) return undefined;
  if (value === true) return "default";
  return value as AiProviderId;
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function formatBool(value: boolean): string {
  return value ? chalk.green("yes") : chalk.gray("no");
}

function formatStatus(status: string): string {
  if (status === "passed") return chalk.green("pass");
  if (status === "skipped") return chalk.yellow("skip");
  return chalk.red("fail");
}
