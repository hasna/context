#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { createRequire } from "module";
import {
  createLibrary,
  listLibraries,
  searchLibraries,
  getLibraryBySlug,
  deleteLibrary,
} from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { crawlLibrary } from "../crawler/index.js";
import { getDbPath } from "../db/database.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const program = new Command()
  .name("context")
  .description(
    "Self-hosted documentation context server for AI coding agents"
  )
  .version(pkg.version);

// ─── context add ──────────────────────────────────────────────────────────────

program
  .command("add <name>")
  .description("Index a library by crawling its documentation via Exa")
  .option("-n, --npm <package>", "npm package name")
  .option("-u, --url <url>", "official docs URL")
  .option("-g, --github <repo>", "GitHub repo (e.g. facebook/react)")
  .option("-d, --description <text>", "library description")
  .option("-p, --pages <n>", "max pages to crawl", "30")
  .action(
    async (
      name: string,
      opts: {
        npm?: string;
        url?: string;
        github?: string;
        description?: string;
        pages?: string;
      }
    ) => {
      console.log(chalk.bold(`\nIndexing ${name}...`));

      // Check duplicate
      try {
        const existing = searchLibraries(name, 1);
        if (
          existing.length > 0 &&
          existing[0] &&
          existing[0].name.toLowerCase() === name.toLowerCase()
        ) {
          console.log(
            chalk.yellow(
              `Library "${name}" is already indexed as /context/${existing[0].slug}`
            )
          );
          console.log(
            chalk.gray(
              `Use 'context refresh ${existing[0].slug}' to re-crawl.`
            )
          );
          process.exit(0);
        }
      } catch {
        // Not found, proceed
      }

      const library = createLibrary({
        name,
        npm_package: opts.npm,
        docs_url: opts.url,
        github_repo: opts.github,
        description: opts.description,
      });

      console.log(chalk.gray(`Library ID: /context/${library.slug}`));
      console.log(chalk.gray("Crawling docs..."));

      const maxPages = parseInt(opts.pages ?? "30", 10);
      const result = await crawlLibrary(library.id, { maxPages });

      console.log(
        chalk.green(`\n✓ Indexed ${chalk.bold(name)}`) +
          chalk.gray(
            ` — ${result.pages_crawled} pages, ${result.chunks_indexed} chunks`
          )
      );
      console.log(chalk.cyan(`  Library ID: /context/${library.slug}`));

      if (result.errors.length > 0) {
        console.log(chalk.yellow(`\nWarnings (${result.errors.length}):`));
        result.errors.slice(0, 3).forEach((e) => console.log(chalk.gray(`  ${e}`)));
      }
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
      console.log(chalk.gray("Run: context add <library-name>"));
      return;
    }

    console.log(chalk.bold(`\n${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} indexed:\n`));

    for (const lib of libraries) {
      const id = chalk.cyan(`/context/${lib.slug}`);
      const name = chalk.bold(lib.name);
      const version = lib.version ? chalk.gray(` v${lib.version}`) : "";
      const stats = chalk.gray(
        ` (${lib.chunk_count} chunks, ${lib.document_count} pages)`
      );
      const crawled = lib.last_crawled_at
        ? chalk.gray(` · last crawled ${formatDate(lib.last_crawled_at)}`)
        : "";
      console.log(`  ${id}  ${name}${version}${stats}${crawled}`);
      if (lib.description) {
        console.log(`    ${chalk.gray(lib.description)}`);
      }
    }
    console.log();
  });

// ─── context search ───────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search docs across all indexed libraries")
  .option("-l, --library <slug>", "Limit to a specific library")
  .option("-n, --limit <n>", "Max results", "5")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: { library?: string; limit?: string; json?: boolean }
    ) => {
      let libraryId: string | undefined;
      let libraryName: string | undefined;

      if (opts.library) {
        const lib = getLibraryBySlug(opts.library);
        libraryId = lib.id;
        libraryName = lib.name;
      }

      const limit = parseInt(opts.limit ?? "5", 10);
      const results = searchChunks(query, libraryId, limit);

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.gray(`No results for "${query}"`));
        if (!libraryId) {
          console.log(
            chalk.gray("Have you indexed any libraries? Run: context list")
          );
        }
        return;
      }

      const scope = libraryName
        ? ` in ${chalk.bold(libraryName)}`
        : "";
      console.log(
        chalk.bold(`\n${results.length} results for "${query}"${scope}:\n`)
      );

      for (const r of results) {
        if (r.title || r.url) {
          console.log(chalk.cyan(r.title ?? r.url ?? ""));
          if (r.url && r.title) console.log(chalk.gray(r.url));
        }
        console.log(r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""));
        console.log();
      }
    }
  );

// ─── context refresh ──────────────────────────────────────────────────────────

program
  .command("refresh <slug>")
  .description("Re-crawl and re-index a library")
  .option("-p, --pages <n>", "max pages to crawl", "30")
  .action(async (slug: string, opts: { pages?: string }) => {
    const library = getLibraryBySlug(slug);
    const maxPages = parseInt(opts.pages ?? "30", 10);

    console.log(chalk.bold(`\nRefreshing ${library.name}...`));

    const result = await crawlLibrary(library.id, {
      maxPages,
      refresh: true,
    });

    console.log(
      chalk.green(`\n✓ Refreshed ${chalk.bold(library.name)}`) +
        chalk.gray(
          ` — ${result.pages_crawled} pages, ${result.chunks_indexed} chunks`
        )
    );

    if (result.errors.length > 0) {
      console.log(chalk.yellow(`\nWarnings (${result.errors.length}):`));
      result.errors
        .slice(0, 3)
        .forEach((e) => console.log(chalk.gray(`  ${e}`)));
    }
  });

// ─── context remove ───────────────────────────────────────────────────────────

program
  .command("remove <slug>")
  .description("Remove a library and all its indexed docs")
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

    if (opts.json) {
      console.log(JSON.stringify(lib, null, 2));
      return;
    }

    console.log(chalk.bold(`\n${lib.name}`));
    console.log(`  ID:        /context/${lib.slug}`);
    if (lib.description) console.log(`  Desc:      ${lib.description}`);
    if (lib.npm_package) console.log(`  npm:       ${lib.npm_package}`);
    if (lib.github_repo) console.log(`  GitHub:    ${lib.github_repo}`);
    if (lib.docs_url) console.log(`  Docs URL:  ${lib.docs_url}`);
    if (lib.version) console.log(`  Version:   ${lib.version}`);
    console.log(`  Chunks:    ${lib.chunk_count}`);
    console.log(`  Pages:     ${lib.document_count}`);
    if (lib.last_crawled_at) {
      console.log(`  Crawled:   ${formatDate(lib.last_crawled_at)}`);
    }
    console.log();
  });

// ─── context status ───────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show database info and stats")
  .action(() => {
    const db = getDbPath();
    const libraries = listLibraries();
    const totalChunks = libraries.reduce((s, l) => s + l.chunk_count, 0);
    const totalDocs = libraries.reduce((s, l) => s + l.document_count, 0);

    console.log(chalk.bold("\nopen-context status\n"));
    console.log(`  DB:        ${db}`);
    console.log(`  Libraries: ${libraries.length}`);
    console.log(`  Pages:     ${totalDocs}`);
    console.log(`  Chunks:    ${totalChunks}`);
    console.log();
  });

// ─── context serve ────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the HTTP API server")
  .option("-p, --port <n>", "Port to listen on (default: 19431)")
  .action((opts: { port?: string }) => {
    if (opts.port) {
      process.env["CONTEXT_PORT"] = opts.port;
    }
    // Dynamically import and run server
    import("../server/index.js").catch((err: unknown) => {
      console.error(chalk.red("Failed to start server:"), err);
      process.exit(1);
    });
  });

program.parse();

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
