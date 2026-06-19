import { Command } from "commander";
import chalk from "chalk";
import {
  createLibrary,
  listLibraries,
  searchLibraries,
  getLibraryBySlug,
  deleteLibrary,
} from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { listApiEndpoints } from "../db/api-endpoints.js";
import {
  refreshDocumentationSource,
  getDefaultExternalRetriever,
  resolveExternalRetriever,
  type ExternalRetrieverType,
} from "../sources/refresh.js";
import { getLinks, addLink } from "../db/links.js";
import type { LinkType } from "../db/links.js";
import { listDocumentationSources } from "../sources/index.js";
import { getDocumentVersions } from "../db/versions.js";
import { listDocuments } from "../db/documents.js";
import { getRefreshPlan, listDocUpdateTasks } from "../db/update-tasks.js";
import { getLibraryDocsManifestArtifact, listDocumentArtifacts } from "../docs/artifacts.js";
import {
  getEmbeddingConfig,
  embedText,
  embeddingCoverage,
  semanticSearch,
} from "../db/embeddings.js";
import { type SeedLibraryGroup } from "../seeds/libraries.js";
import { bootstrapSeedSources } from "../seeds/bootstrap.js";
import { embedLibraryChunks } from "../semantic/index.js";
import { getSourceReadinessReport } from "../sources/readiness.js";
import { formatDate } from "./format.js";

export function registerLibraryCommands(program: Command): void {
  // ─── context add ──────────────────────────────────────────────────────────────

  program
    .command("add <name>")
    .description("Index a library by refreshing its documentation source")
    .option("-n, --npm <package>", "npm package name")
    .option("-u, --url <url>", "official docs URL")
    .option("-g, --github <repo>", "GitHub repo (e.g. facebook/react)")
    .option("-d, --description <text>", "library description")
    .option("--doc-version <version>", "indexed documentation version")
    .option("--source-type <type>", "source type: docs|website|llms_txt|openapi|github|npm|api|manual")
    .option("--source-url <url>", "canonical source URL for docs updates")
    .option("--freshness-days <n>", "days before this source is due for refresh")
    .option("--priority <n>", "refresh priority for update planning", "0")
    .option("-p, --pages <n>", "max pages to ingest", "30")
    .option("--no-files", "do not write structured markdown docs files")
    .option(
      "-c, --crawler <type>",
      "deprecated alias for --retriever"
    )
    .option("-r, --retriever <type>", "retrieval backend fallback: firecrawl|exa")
    .option("--retriever-only", "skip native source ingestion and use the selected retriever directly")
    .option("--embed", "generate semantic embeddings after refreshing docs")
    .option("--embed-all", "re-embed existing chunks when --embed is set")
    .option("--embed-limit <n>", "maximum chunks to embed after refresh")
    .option("--no-crawl", "register library without refreshing docs")
    .action(
      async (
        name: string,
        opts: {
          npm?: string;
          url?: string;
          github?: string;
          description?: string;
          docVersion?: string;
          sourceType?: string;
          sourceUrl?: string;
          freshnessDays?: string;
          priority?: string;
          pages?: string;
          retriever?: string;
          retrieverOnly?: boolean;
          embed?: boolean;
          embedAll?: boolean;
          embedLimit?: string;
          crawler?: string;
          crawl?: boolean;
          files?: boolean;
        }
      ) => {
        const retriever = getSelectedRetriever(opts);

        // Check duplicate
        try {
          const existing = searchLibraries(name, 1);
          if (
            existing.length > 0 &&
            existing[0] &&
            existing[0].name.toLowerCase() === name.toLowerCase()
          ) {
            console.log(
              chalk.yellow(`Library "${name}" already indexed as /context/${existing[0].slug}`)
            );
            console.log(chalk.gray(`Use 'context refresh ${existing[0].slug}' to refresh it.`));
            process.exit(0);
          }
        } catch {
          // Not found, proceed
        }

        let library;
        try {
          library = createLibrary({
            name,
            npm_package: opts.npm,
            docs_url: opts.url,
            github_repo: opts.github,
            description: opts.description,
            version: opts.docVersion,
            source_type: opts.sourceType,
            source_url: opts.sourceUrl,
            freshness_days: opts.freshnessDays ? parseInt(opts.freshnessDays, 10) : undefined,
            priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
          });
        } catch (err) {
          console.error(
            chalk.red(`\nCould not register ${name}: ${err instanceof Error ? err.message : String(err)}`)
          );
          process.exit(1);
        }

        console.log(chalk.bold(`\nIndexing ${name}...`));
        console.log(chalk.gray(`  ID: /context/${library.slug}`));
        console.log(chalk.gray(`  Source: ${library.source_type}${library.source_url ? ` (${library.source_url})` : ""}`));

        if (opts.crawl === false) {
          console.log(chalk.green(`✓ Registered ${chalk.bold(name)} (no refresh)`));
          return;
        }

        console.log(chalk.gray(`  Retriever fallback: ${retriever}`));

        const maxPages = parseInt(opts.pages ?? "30", 10);
        let result;
        try {
          result = await refreshDocumentationSource(library.id, {
            maxPages,
            retriever,
            retrieverOnly: opts.retrieverOnly,
            writeFiles: opts.files,
            embed: opts.embed,
            embedAll: opts.embedAll,
            embedLimit: parsePositiveInt(opts.embedLimit),
          });
        } catch (err) {
          console.error(
            chalk.red(`\nIndex failed for ${name}: ${err instanceof Error ? err.message : String(err)}`)
          );
          process.exit(1);
        }

        console.log(
          chalk.green(`\n✓ Indexed ${chalk.bold(name)}`) +
            chalk.gray(
              ` — ${result.pages_ingested} pages, ${result.chunks_indexed} chunks, ${result.files_written} files` +
                (result.api_endpoints_indexed > 0 ? `, ${result.api_endpoints_indexed} endpoints` : "")
            )
        );
        printEmbeddingSummary(result);
        console.log(chalk.gray(`  Ingest: ${formatIngestMode(result)}`));
        printRefreshCoverage(result, "  ");
        printSourceDiscovery(result);
        console.log(chalk.cyan(`  Library ID: /context/${library.slug}`));

        if (result.errors.length > 0) {
          console.log(chalk.yellow(`\nWarnings (${result.errors.length}):`));
          result.errors.slice(0, 3).forEach((e) => console.log(chalk.gray(`  ${e}`)));
        }
      }
    );

  // ─── context seed ─────────────────────────────────────────────────────────────

  program
    .command("seed")
    .description("Populate or update source metadata for popular tools/services")
    .option("--groups <groups>", "Comma-separated seed groups: llm,saas,all", "all")
    .option("--slugs <slugs>", "Comma-separated seed slugs to process")
    .option("--limit <n>", "Maximum selected seeds to process; 0 means no limit", "0")
    .option("--crawl", "Also refresh docs for each library after seeding")
    .option("--new-only", "When --crawl is set, only refresh newly created libraries")
    .option("-p, --pages <n>", "max pages per library when --crawl is set", "10")
    .option("--no-files", "do not write structured markdown docs files when refreshing")
    .option(
      "-c, --crawler <type>",
      "deprecated alias for --retriever"
    )
    .option("-r, --retriever <type>", "retrieval backend fallback: firecrawl|exa")
    .option("--retriever-only", "skip native source ingestion and use the selected retriever directly")
    .option("--embed", "generate semantic embeddings after refreshing seeded docs")
    .option("--embed-all", "re-embed existing chunks when --embed is set")
    .option("--embed-limit <n>", "maximum chunks to embed per refreshed source")
    .option("--open-connectors <path>", "include source seeds imported from a local open-connectors checkout")
    .option("--open-connectors-enabled-only", "only import open-connectors entries enabled in .connectors/manifest.json")
    .option("--open-connectors-only", "only process imported open-connectors source seeds")
    .option("--json", "Output the full seed report as JSON")
    .action(
      async (opts: {
        groups?: string;
        slugs?: string;
        limit?: string;
        crawl?: boolean;
        newOnly?: boolean;
        pages?: string;
        retriever?: string;
        retrieverOnly?: boolean;
        embed?: boolean;
        embedAll?: boolean;
        embedLimit?: string;
        openConnectors?: string;
        openConnectorsEnabledOnly?: boolean;
        openConnectorsOnly?: boolean;
        crawler?: string;
        files?: boolean;
        json?: boolean;
      }) => {
        const retriever = getSelectedRetriever(opts);
        const maxPages = parseInt(opts.pages ?? "10", 10);
        const report = await bootstrapSeedSources({
          groups: parseSeedGroups(opts.groups),
          slugs: parseList(opts.slugs),
          limit: parseSeedLimit(opts.limit),
          crawl: opts.crawl,
          newOnly: opts.newOnly,
          maxPages,
          retriever,
          retrieverOnly: opts.retrieverOnly,
          writeFiles: opts.files,
          embed: opts.embed,
          embedAll: opts.embedAll,
          embedLimit: parsePositiveInt(opts.embedLimit),
          openConnectorsPath: opts.openConnectors,
          openConnectorsEnabledOnly: opts.openConnectorsEnabledOnly,
          openConnectorsOnly: opts.openConnectorsOnly,
        });

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          if (report.failed_count > 0) process.exitCode = 1;
          return;
        }

        console.log(chalk.bold(`\nSeeding ${report.selected_count} source${report.selected_count === 1 ? "" : "s"}...\n`));
        if (opts.crawl) {
          console.log(chalk.gray(`  Retriever fallback: ${report.retriever}`));
          console.log(chalk.gray(`  Pages per source: ${report.max_pages}`));
          if (opts.newOnly) console.log(chalk.gray("  Refresh mode: new libraries only"));
          console.log();
        }

        for (const item of report.items) {
          if (item.status === "failed") {
            console.log(chalk.red(`  ✗ ${item.library_name}: ${item.error}`));
            continue;
          }
          const prefix = item.status === "added" ? chalk.green("  +") : chalk.cyan("  =");
          process.stdout.write(`${prefix} ${item.library_name}\n`);
          if (item.result) {
            process.stdout.write(
              chalk.gray(
                `    → ${item.result.pages_ingested} pages, ${item.result.chunks_indexed} chunks, ${item.result.files_written} files via ${formatIngestMode(item.result)}\n`
              )
            );
            printEmbeddingSummary(item.result);
            printRefreshCoverage(item.result, "    ");
            printSourceDiscovery(item.result);
          } else if (item.refresh_skipped) {
            process.stdout.write(chalk.gray("    → refresh skipped (--new-only)\n"));
          }
        }

        const summary = [
          `${report.added_count} added`,
          `${report.updated_count} updated`,
          opts.crawl ? `${report.refreshed_count} refreshed` : null,
          report.refresh_skipped_count > 0 ? `${report.refresh_skipped_count} refresh skipped` : null,
          report.failed_count > 0 ? `${report.failed_count} failed` : null,
        ].filter(Boolean).join(", ");
        console.log(`\n${report.failed_count > 0 ? chalk.yellow("!") : chalk.green("✓")} Seeded ${summary}`);
        if (report.failed_count > 0) process.exitCode = 1;
      }
    );

  // ─── context list ─────────────────────────────────────────────────────────────

  program
    .command("list")
    .description("List all indexed libraries")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const libraries = listLibraries();

      if (opts.json) {
        console.log(JSON.stringify(libraries, null, 2));
        return;
      }

      if (libraries.length === 0) {
        console.log(chalk.gray("No libraries indexed yet."));
        console.log(chalk.gray("Run: context add <name>  or  context seed"));
        return;
      }

      console.log(chalk.bold(`\n${libraries.length} librar${libraries.length === 1 ? "y" : "ies"}:\n`));
      for (const lib of libraries) {
        const id = chalk.cyan(`/context/${lib.slug}`);
        const name = chalk.bold(lib.name);
        const version = lib.version ? chalk.gray(` v${lib.version}`) : "";
        const crawled = lib.chunk_count > 0
          ? chalk.gray(` (${lib.chunk_count} chunks)`)
          : chalk.yellow(" (not indexed)");
        console.log(`  ${id}  ${name}${version}${crawled} ${chalk.gray(`[${lib.source_type}]`)}`);
        if (lib.description) console.log(`    ${chalk.gray(lib.description)}`);
      }
      console.log();
    });

  // ─── context search ───────────────────────────────────────────────────────────

  program
    .command("search <query>")
    .description("Search docs across indexed libraries (FTS5 + optional semantic)")
    .option("-l, --library <slug>", "Limit to a specific library")
    .option("-n, --limit <n>", "Max results", "5")
    .option("--semantic", "Use semantic search (requires CONTEXT_EMBEDDING_PROVIDER)")
    .option("--json", "Output as JSON")
    .action(
      async (
        query: string,
        opts: { library?: string; limit?: string; semantic?: boolean; json?: boolean }
      ) => {
        let libraryId: string | undefined;
        let libraryName: string | undefined;

        if (opts.library) {
          const lib = getLibraryBySlug(opts.library);
          libraryId = lib.id;
          libraryName = lib.name;
        }

        const limit = parseInt(opts.limit ?? "5", 10);

        // Semantic search
        if (opts.semantic) {
          const config = getEmbeddingConfig();
          if (!config) {
            console.error(
              chalk.red("Semantic search requires CONTEXT_EMBEDDING_PROVIDER=openai|voyage")
            );
            process.exit(1);
          }
          const queryVec = await embedText(query, config);
          const results = semanticSearch(queryVec, libraryId, limit);

          if (opts.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
          }

          if (results.length === 0) {
            console.log(chalk.gray(`No semantic results for "${query}"`));
            return;
          }

          console.log(chalk.bold(`\n${results.length} semantic results for "${query}":\n`));
          for (const r of results) {
            if (r.title || r.url) {
              console.log(chalk.cyan(r.title ?? r.url ?? ""));
            }
            console.log(chalk.gray(`score: ${r.score.toFixed(3)}`));
            console.log(r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""));
            console.log();
          }
          return;
        }

        // FTS5 search
        const results = searchChunks(query, libraryId, limit);

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log(chalk.gray(`No results for "${query}"`));
          return;
        }

        const scope = libraryName ? ` in ${chalk.bold(libraryName)}` : "";
        console.log(chalk.bold(`\n${results.length} results for "${query}"${scope}:\n`));
        for (const r of results) {
          if (r.title || r.url) console.log(chalk.cyan(r.title ?? r.url ?? ""));
          if (r.url && r.title) console.log(chalk.gray(r.url));
          console.log(r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""));
          console.log();
        }
      }
    );

  program
    .command("endpoints <library>")
    .description("List or search indexed API endpoints for an OpenAPI source")
    .option("-q, --query <query>", "Full-text endpoint query")
    .option("--method <method>", "Filter by HTTP method")
    .option("--path <path>", "Filter by exact API path")
    .option("--operation <id>", "Filter by exact operationId")
    .option("-n, --limit <n>", "Max endpoints", "20")
    .option("--json", "Output as JSON")
    .action((librarySlug: string, opts: {
      query?: string;
      method?: string;
      path?: string;
      operation?: string;
      limit?: string;
      json?: boolean;
    }) => {
      const library = getLibraryBySlug(librarySlug);
      const endpoints = listApiEndpoints({
        libraryId: library.id,
        query: opts.query,
        method: opts.method,
        path: opts.path,
        operationId: opts.operation,
        limit: parsePositiveInt(opts.limit) ?? 20,
      });

      if (opts.json) {
        console.log(JSON.stringify({ library, endpoints }, null, 2));
        return;
      }

      if (endpoints.length === 0) {
        console.log(chalk.gray(`No API endpoints found for ${library.name}`));
        return;
      }

      console.log(chalk.bold(`\n${endpoints.length} API endpoints for ${library.name}:\n`));
      for (const endpoint of endpoints) {
        console.log(chalk.cyan(`${endpoint.method} ${endpoint.path}`));
        if (endpoint.operation_id) console.log(chalk.gray(`  operationId: ${endpoint.operation_id}`));
        if (endpoint.summary) console.log(`  ${endpoint.summary}`);
        if (endpoint.tags.length) console.log(chalk.gray(`  tags: ${endpoint.tags.join(", ")}`));
        if (endpoint.url) console.log(chalk.gray(`  source: ${endpoint.url}`));
        console.log();
      }
    });

  // ─── context embed ────────────────────────────────────────────────────────────

  program
    .command("embed <slug>")
    .description("Generate semantic embeddings for a library's chunks")
    .option("--all", "Re-embed even already-embedded chunks")
    .action(async (slug: string, opts: { all?: boolean }) => {
      const config = getEmbeddingConfig();
      if (!config) {
        console.error(
          chalk.red(
            "Set CONTEXT_EMBEDDING_PROVIDER=openai|voyage to enable embeddings"
          )
        );
        process.exit(1);
      }

      const library = getLibraryBySlug(slug);
      const { total, embedded } = embeddingCoverage(library.id);

      if (total === 0) {
        console.log(chalk.yellow(`No chunks found for ${library.name}. Run: context add ${slug}`));
        return;
      }

      const toEmbed = opts.all ? total : total - embedded;
      if (toEmbed === 0) {
        console.log(chalk.gray(`All ${total} chunks already embedded for ${library.name}.`));
        return;
      }

      console.log(
        chalk.bold(`\nEmbedding ${library.name}`) +
          chalk.gray(` — ${toEmbed} chunks with ${config.model}...\n`)
      );

      const report = await embedLibraryChunks(library.id, {
        all: opts.all,
        onProgress: ({ done, total }) => {
          if (done % 10 === 0 || done === total) {
            process.stdout.write(`\r  ${done}/${total} chunks embedded`);
          }
        },
      });

      console.log(
        `\n\n${chalk.green(`✓ Embedded ${report.embedded_count} chunks`)}` +
          (report.failed_count > 0 ? chalk.red(` (${report.failed_count} failed)`) : "")
      );
    });

  // ─── context refresh ──────────────────────────────────────────────────────────

  program
    .command("refresh <slug>")
    .description("Refresh and re-index a library's documentation source")
    .option("-p, --pages <n>", "max pages to ingest", "30")
    .option("-r, --retriever <type>", "retrieval backend fallback: firecrawl|exa")
    .option("-c, --crawler <type>", "deprecated alias for --retriever")
    .option("--retriever-only", "skip native source ingestion and use the selected retriever directly")
    .option("--no-files", "do not write structured markdown docs files")
    .option("--embed", "generate semantic embeddings after refreshing docs")
    .option("--embed-all", "re-embed existing chunks when --embed is set")
    .option("--embed-limit <n>", "maximum chunks to embed after refresh")
    .action(async (slug: string, opts: { pages?: string; retriever?: string; retrieverOnly?: boolean; crawler?: string; files?: boolean; embed?: boolean; embedAll?: boolean; embedLimit?: string }) => {
      const library = getLibraryBySlug(slug);
      const maxPages = parseInt(opts.pages ?? "30", 10);
      const retriever = getSelectedRetriever(opts);

      console.log(
        chalk.bold(`\nRefreshing ${library.name}`) +
          chalk.gray(` from ${library.source_type}${library.source_url ? ` (${library.source_url})` : ""}; retriever fallback ${retriever}...`)
      );

      let result;
      try {
        result = await refreshDocumentationSource(library.id, {
          maxPages,
          refresh: true,
          retriever,
          retrieverOnly: opts.retrieverOnly,
          writeFiles: opts.files,
          embed: opts.embed,
          embedAll: opts.embedAll,
          embedLimit: parsePositiveInt(opts.embedLimit),
        });
      } catch (err) {
        console.error(
          chalk.red(`\nRefresh failed for ${library.name}: ${err instanceof Error ? err.message : String(err)}`)
        );
        process.exit(1);
      }

      console.log(
        chalk.green(`\n✓ Refreshed ${chalk.bold(library.name)}`) +
          chalk.gray(
            ` — ${result.pages_ingested} pages, ${result.chunks_indexed} chunks, ${result.files_written} files` +
              (result.api_endpoints_indexed > 0 ? `, ${result.api_endpoints_indexed} endpoints` : "")
          )
      );
      printEmbeddingSummary(result);
      console.log(chalk.gray(`  Ingest: ${formatIngestMode(result)}`));
      printRefreshCoverage(result, "  ");
      printSourceDiscovery(result);

      if (result.errors.length > 0) {
        console.log(chalk.yellow(`\nWarnings (${result.errors.length}):`));
        result.errors.slice(0, 3).forEach((e) => console.log(chalk.gray(`  ${e}`)));
      }
    });

  // ─── context remove ───────────────────────────────────────────────────────────

  program
    .command("remove <slug>")
    .description("Remove a library and all its indexed data")
    .action((slug: string) => {
      const library = getLibraryBySlug(slug);
      deleteLibrary(library.id);
      console.log(chalk.green(`✓ Removed ${library.name}`));
    });

  // ─── context info ─────────────────────────────────────────────────────────────

  program
    .command("info <slug>")
    .description("Show details for an indexed library")
    .option("--json", "Output as JSON")
    .action((slug: string, opts: { json?: boolean }) => {
      const lib = getLibraryBySlug(slug);
      const links = getLinks(lib.id);
      const { total, embedded } = embeddingCoverage(lib.id);

      if (opts.json) {
        console.log(JSON.stringify({ ...lib, links, embeddings: { total, embedded } }, null, 2));
        return;
      }

      console.log(chalk.bold(`\n${lib.name}`));
      console.log(`  ID:          /context/${lib.slug}`);
      if (lib.description) console.log(`  Description: ${lib.description}`);
      if (lib.npm_package) console.log(`  npm:         ${lib.npm_package}`);
      if (lib.github_repo) console.log(`  GitHub:      ${lib.github_repo}`);
      if (lib.docs_url) console.log(`  Docs URL:    ${lib.docs_url}`);
      console.log(`  Source:      ${lib.source_type}`);
      if (lib.source_url) console.log(`  Source URL:  ${lib.source_url}`);
      console.log(`  Freshness:   ${lib.freshness_days} day${lib.freshness_days === 1 ? "" : "s"}`);
      console.log(`  Priority:    ${lib.priority}`);
      if (lib.version) console.log(`  Version:     ${lib.version}`);
      console.log(`  Chunks:      ${lib.chunk_count}`);
      console.log(`  Pages:       ${lib.document_count}`);
      if (embedded > 0) {
        console.log(`  Embeddings:  ${embedded}/${total} chunks`);
      }
      if (lib.last_crawled_at) {
        console.log(`  Refreshed:   ${formatDate(lib.last_crawled_at)}`);
      }

      if (links.length > 0) {
        console.log(`\n  Links:`);
        for (const link of links) {
          console.log(`    ${chalk.gray(`[${link.type}]`)} ${link.label ? `${link.label}: ` : ""}${chalk.cyan(link.url)}`);
        }
      }
      console.log();
    });

  // ─── context links ────────────────────────────────────────────────────────────

  program
    .command("links <slug>")
    .description("Manage links for a library")
    .option("--add <url>", "Add a link URL")
    .option("-t, --type <type>", "Link type: docs|npm|github|api|openapi|llms|examples|tutorial|changelog|playground")
    .option("--label <text>", "Link label")
    .option("--json", "Output as JSON")
    .action(
      (slug: string, opts: { add?: string; type?: string; label?: string; json?: boolean }) => {
        const lib = getLibraryBySlug(slug);

        if (opts.add) {
          const link = addLink({
            library_id: lib.id,
            url: opts.add,
            type: (opts.type as LinkType) ?? "docs",
            label: opts.label,
          });
          console.log(chalk.green(`✓ Added ${link.type} link: ${link.url}`));
          return;
        }

        const links = getLinks(lib.id);

        if (opts.json) {
          console.log(JSON.stringify(links, null, 2));
          return;
        }

        if (links.length === 0) {
          console.log(chalk.gray(`No links for ${lib.name}`));
          return;
        }

        console.log(chalk.bold(`\n${lib.name} — Links:\n`));
        for (const link of links) {
          console.log(
            `  ${chalk.gray(`[${link.type}]`)}  ${link.label ? chalk.bold(link.label) + " " : ""}${chalk.cyan(link.url)}`
          );
        }
        console.log();
      }
    );

  // ─── context history ──────────────────────────────────────────────────────────

  program
    .command("history <slug>")
    .description("Show version history of refreshed documents for a library")
    .option("--json", "Output as JSON")
    .action((slug: string, opts: { json?: boolean }) => {
      const lib = getLibraryBySlug(slug);
      const docs = listDocuments(lib.id);

      if (docs.length === 0) {
        console.log(chalk.gray(`No refreshed pages for ${lib.name}`));
        return;
      }

      if (opts.json) {
        const all = docs.map((d) => ({
          ...d,
          versions: getDocumentVersions(d.id),
        }));
        console.log(JSON.stringify(all, null, 2));
        return;
      }

      console.log(chalk.bold(`\n${lib.name} — Document History:\n`));
      for (const doc of docs) {
        const versions = getDocumentVersions(doc.id);
        if (versions.length === 0) continue;
        console.log(`  ${chalk.cyan(doc.url ?? doc.id)}`);
        for (const v of versions) {
          console.log(
            `    v${v.version_number}  ${chalk.gray(formatDate(v.crawled_at))}  ${chalk.gray(`hash:${v.content_hash}`)}`
          );
        }
      }
      console.log();
    });

  // ─── context sources ────────────────────────────────────────────────────────

  program
    .command("sources")
    .description("List supported documentation source types")
    .option("--readiness", "Audit readiness of indexed libraries by source")
    .option("-l, --library <slug>", "Limit readiness audit to one library")
    .option("--json", "Output as JSON")
    .action((opts: { readiness?: boolean; library?: string; json?: boolean }) => {
      if (opts.readiness) {
        const report = getSourceReadinessReport({ slug: opts.library });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log(chalk.bold(`\nSource Readiness:\n`));
        console.log(
          chalk.gray(
            `  ${report.totals.libraries} libraries, ${report.totals.ready_for_native_refresh} native-refresh ready, ` +
              `${report.totals.indexed} indexed, ${report.totals.due} due`
          )
        );
        for (const row of report.libraries) {
          const hasError = row.issues.some((issue) => issue.severity === "error");
          const marker = hasError ? chalk.red("error") : row.issues.length > 0 ? chalk.yellow("check") : chalk.green("ready");
          console.log(`\n  ${chalk.cyan(`/context/${row.library_slug}`)} ${chalk.bold(row.library_name)} ${chalk.gray(`[${row.source_type}]`)} ${marker}`);
          console.log(`    source: ${row.source_url ?? "(none)"}`);
          console.log(`    native refresh: ${row.can_refresh_without_external_retriever ? "yes" : "no"}`);
          console.log(`    indexed: ${row.documents} docs, ${row.chunks} chunks, ${row.artifacts} files`);
          for (const issue of row.issues) {
            const color = issue.severity === "error" ? chalk.red : issue.severity === "warning" ? chalk.yellow : chalk.gray;
            console.log(color(`    ${issue.severity}: ${issue.message}`));
          }
        }
        console.log();
        return;
      }

      const sources = listDocumentationSources();

      if (opts.json) {
        console.log(JSON.stringify(sources, null, 2));
        return;
      }

      console.log(chalk.bold(`\nDocumentation Sources:\n`));
      for (const source of sources) {
        const status = source.nativeIngest === "available"
          ? chalk.green("available")
          : chalk.yellow("planned");
        console.log(`  ${chalk.cyan(source.id)} ${chalk.bold(source.name)} ${chalk.gray(`(${status})`)}`);
        console.log(`    freshness: ${source.defaultFreshnessDays} day${source.defaultFreshnessDays === 1 ? "" : "s"}`);
        console.log(`    origin: ${source.origin}`);
        console.log(`    retrieval: ${source.supportsWebCrawl ? `native + ${source.preferredRetriever ?? source.preferredCrawler ?? "external"} fallback` : "manual"}`);
        console.log(`    ${chalk.gray(source.description)}`);
      }
      console.log();
    });

  // ─── context docs ────────────────────────────────────────────────────────────

  program
    .command("docs <slug>")
    .description("List structured local docs files for a library")
    .option("--json", "Output as JSON")
    .action((slug: string, opts: { json?: boolean }) => {
      const lib = getLibraryBySlug(slug);
      const docs = listDocuments(lib.id);
      const artifacts = listDocumentArtifacts(lib.slug);
      const manifest = getLibraryDocsManifestArtifact(lib.slug);

      if (opts.json) {
        console.log(JSON.stringify({ library: lib, documents: docs, artifacts, manifest }, null, 2));
        return;
      }

      console.log(chalk.bold(`\n${lib.name} — Docs Files:\n`));
      if (docs.length === 0) {
        console.log(chalk.gray("  No indexed documents yet."));
        console.log(chalk.gray(`  Run: context refresh ${lib.slug}`));
        return;
      }

      for (const doc of docs) {
        console.log(`  ${chalk.cyan(doc.file_path ?? "(missing file)")}`);
        console.log(`    ${doc.title ?? doc.url}`);
        if (doc.content_hash) console.log(`    hash: ${chalk.gray(doc.content_hash)}`);
      }

      const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0);
      console.log(chalk.gray(`\n  ${artifacts.length} artifact file(s), ${totalBytes} bytes`));
      if (manifest) console.log(chalk.gray(`  Manifest: ${manifest.relativePath}`));
      console.log();
    });

  // ─── context updates ─────────────────────────────────────────────────────────

  program
    .command("updates")
    .description("Plan documentation refresh/update tasks")
    .option("-l, --library <slug>", "Limit to a specific library")
    .option("--create-tasks", "Persist pending refresh tasks for due libraries")
    .option("--tasks", "List persisted update tasks instead of computing a plan")
    .option("--json", "Output as JSON")
    .action((opts: { library?: string; createTasks?: boolean; tasks?: boolean; json?: boolean }) => {
      if (opts.tasks) {
        const tasks = listDocUpdateTasks();
        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2));
          return;
        }
        if (tasks.length === 0) {
          console.log(chalk.gray("No docs update tasks."));
          return;
        }
        console.log(chalk.bold(`\nDocs Update Tasks:\n`));
        for (const task of tasks) {
          console.log(`  ${chalk.cyan(task.id)} ${chalk.gray(`[${task.status}]`)} ${task.task_type}`);
          console.log(`    library: ${task.library_id}`);
          console.log(`    reason: ${task.reason}`);
          console.log(`    scheduled: ${formatDate(task.scheduled_at)}`);
        }
        console.log();
        return;
      }

      const plan = getRefreshPlan({
        slug: opts.library,
        createTasks: opts.createTasks,
      });

      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }

      if (plan.length === 0) {
        console.log(chalk.gray("No libraries are due for docs refresh."));
        return;
      }

      console.log(chalk.bold(`\nDocs Refresh Plan:\n`));
      for (const item of plan) {
        const id = `/context/${item.library.slug}`;
        console.log(`  ${chalk.cyan(id)} ${chalk.bold(item.library.name)}`);
        console.log(`    reason: ${item.reason}`);
        console.log(`    due: ${formatDate(item.due_at)}`);
        if (item.task) console.log(`    task: ${item.task.id}`);
      }
      console.log();
    });
}

function getSelectedRetriever(opts: { retriever?: string; crawler?: string }): ExternalRetrieverType {
  try {
    return resolveExternalRetriever(opts.retriever ?? opts.crawler, getDefaultExternalRetriever());
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

function printRefreshCoverage(
  result: {
    max_pages?: number;
    pages_retrieved?: number;
    page_limit_reached?: boolean;
    full_docs_detected?: boolean;
  },
  indent: string
): void {
  if (result.max_pages === undefined || result.pages_retrieved === undefined) return;
  const flags = [
    result.page_limit_reached ? "page limit reached" : null,
    result.full_docs_detected ? "llms-full detected" : null,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  console.log(chalk.gray(`${indent}Coverage: retrieved ${result.pages_retrieved}/${result.max_pages} pages${suffix}`));
}

function parseSeedGroups(value?: string): SeedLibraryGroup[] | undefined {
  const groups = parseList(value).filter((item): item is SeedLibraryGroup =>
    item === "llm" || item === "saas" || item === "all"
  );
  return groups.length > 0 ? Array.from(new Set(groups)) : undefined;
}

function parseSeedLimit(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parsePositiveInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatIngestMode(result: { ingest_mode: string; source_type: string; retriever?: string; crawler: string }): string {
  return result.ingest_mode === "native"
    ? `native source (${result.source_type})`
    : `retriever (${result.retriever ?? result.crawler})`;
}

function printSourceDiscovery(result: {
  source_discovery?: {
    status: string;
    provider: string;
    url: string | null;
    title: string | null;
  } | null;
}): void {
  if (result.source_discovery?.status !== "found" || !result.source_discovery.url) return;
  console.log(
    chalk.gray(
      `  Source discovery: ${result.source_discovery.provider} → ${result.source_discovery.url}` +
        (result.source_discovery.title ? ` (${result.source_discovery.title})` : "")
    )
  );
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
      `  Embeddings: ${report.embedded_count}/${report.selected_chunks} chunks via ${report.provider}/${report.model}${failed}`
    )
  );
}
