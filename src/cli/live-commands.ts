import type { Command } from "commander";
import chalk from "chalk";
import { getDefaultExternalRetriever, resolveExternalRetriever } from "../sources/refresh.js";
import { runLiveUpdateCycle } from "../live/index.js";
import { DEFAULT_LIST_LIMIT, parseLimit, takeWithMore, truncateText } from "./format.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatIngestMode(result: { ingest_mode: string; source_type: string; retriever?: string; crawler: string }): string {
  return result.ingest_mode === "native"
    ? `native source (${result.source_type})`
    : `retriever (${result.retriever ?? result.crawler})`;
}

export function registerLiveCommands(program: Command): void {
  program
    .command("live")
    .description("Run a live docs update loop for due libraries")
    .option("-i, --interval <seconds>", "Seconds between update checks", "86400")
    .option("-p, --pages <n>", "Max pages per library refresh", "30")
    .option("-r, --retriever <type>", "retrieval backend fallback: firecrawl|exa")
    .option("-c, --crawler <type>", "deprecated alias for --retriever")
    .option("--case-timeout-ms <ms>", "Max milliseconds per source refresh; 0 disables", "45000")
    .option("--once", "Run one planning/refresh cycle and exit")
    .option("--plan-only", "Only print due libraries; do not refresh")
    .option("--native-only", "Only refresh sources that can ingest without Exa/Firecrawl")
    .option("--embed", "generate semantic embeddings after each refreshed source")
    .option("--embed-all", "re-embed existing chunks when --embed is set")
    .option("--embed-limit <n>", "maximum chunks to embed per refreshed source")
    .option("-n, --limit <n>", "Max actions to show per cycle", String(DEFAULT_LIST_LIMIT))
    .option("--json", "Output JSON for --once")
    .action(async (opts: {
      interval?: string;
      pages?: string;
      retriever?: string;
      crawler?: string;
      caseTimeoutMs?: string;
      once?: boolean;
      planOnly?: boolean;
      nativeOnly?: boolean;
      embed?: boolean;
      embedAll?: boolean;
      embedLimit?: string;
      limit?: string;
      json?: boolean;
    }) => {
      const intervalMs = Math.max(1, parseInt(opts.interval ?? "86400", 10)) * 1000;
      const maxPages = parseInt(opts.pages ?? "30", 10);
      let retriever;
      try {
        retriever = resolveExternalRetriever(opts.retriever ?? opts.crawler, getDefaultExternalRetriever());
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      do {
        const cycle = await runLiveUpdateCycle({
          maxPages,
          retriever,
          refreshTimeoutMs: parseNonNegativeInt(opts.caseTimeoutMs, 45_000),
          planOnly: opts.planOnly,
          nativeOnly: opts.nativeOnly,
          embed: opts.embed,
          embedAll: opts.embedAll,
          embedLimit: parsePositiveInt(opts.embedLimit),
        });
        if (opts.json && opts.once) {
          console.log(JSON.stringify(cycle, null, 2));
          return;
        }

        if (cycle.plan_count === 0) {
          console.log(chalk.gray(`[${new Date().toISOString()}] no docs due for refresh`));
        } else {
          console.log(
            chalk.bold(
              `[${new Date().toISOString()}] ${cycle.plan_count} docs refresh task(s)` +
                chalk.gray(` (${cycle.refreshed_count} refreshed, ${cycle.skipped_count} skipped, ${cycle.failed_count} failed)`)
            )
          );
        }

        const limit = parseLimit(opts.limit);
        const { visible, remaining } = takeWithMore(cycle.actions, limit);
        for (const action of visible) {
          const id = `/context/${action.library_slug}`;
          if (action.status === "planned") {
            console.log(chalk.cyan(`  planned ${id} (${action.reason})`));
          } else if (action.status === "skipped") {
            console.log(chalk.yellow(`  skipped ${id}: ${action.skip_reason}`));
          } else if (action.status === "refreshed" && action.result) {
            console.log(
              chalk.green(
                `  ✓ ${id}: ${action.result.pages_ingested} pages, ${action.result.chunks_indexed} chunks, ${action.result.files_written} files via ${formatIngestMode(action.result)}`
              )
            );
            printRefreshCoverage(action.result);
            printEmbeddingSummary(action.result);
          } else if (action.status === "failed") {
            console.log(chalk.red(`  ✗ ${id}: ${truncateText(action.error, 180)}`));
          }
        }
        if (remaining > 0) {
          console.log(chalk.gray(`  ...${remaining} more action(s). Use --limit ${cycle.actions.length} to show all, or --json with --once for raw records.`));
        }

        if (opts.once) return;
        await sleep(intervalMs);
      } while (true);
    });
}

function parsePositiveInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function printEmbeddingSummary(result: {
  embeddings?: {
    provider: string;
    model: string;
    selected_chunks: number;
    embedded_count: number;
    failed_count: number;
  } | null;
}): void {
  if (!result.embeddings) return;
  const report = result.embeddings;
  const failed = report.failed_count > 0 ? `, ${report.failed_count} failed` : "";
  console.log(
    chalk.gray(
      `    embeddings: ${report.embedded_count}/${report.selected_chunks} chunks via ${report.provider}/${report.model}${failed}`
    )
  );
}

function printRefreshCoverage(result: {
  max_pages?: number;
  pages_retrieved?: number;
  page_limit_reached?: boolean;
  full_docs_detected?: boolean;
}): void {
  if (result.max_pages === undefined || result.pages_retrieved === undefined) return;
  const flags = [
    result.page_limit_reached ? "page limit reached" : null,
    result.full_docs_detected ? "llms-full detected" : null,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  console.log(chalk.gray(`    coverage: retrieved ${result.pages_retrieved}/${result.max_pages} pages${suffix}`));
}
