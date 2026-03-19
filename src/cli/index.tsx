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
import { crawlLibrary, getDefaultCrawler } from "../crawler/index.js";
import type { CrawlerType } from "../crawler/index.js";
import { getDbPath } from "../db/database.js";
import { getLinks, addLink, syncLinks } from "../db/links.js";
import type { LinkType } from "../db/links.js";
import { getRelatedNodes, listNodes, searchNodes, upsertNode } from "../db/kg.js";
import { getDocumentVersions } from "../db/versions.js";
import { listDocuments } from "../db/documents.js";
import {
  getEmbeddingConfig,
  embedText,
  saveEmbedding,
  embeddingCoverage,
  semanticSearch,
} from "../db/embeddings.js";
import { SEED_LIBRARIES } from "../seeds/libraries.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const program = new Command()
  .name("context")
  .description("Self-hosted documentation context server for AI coding agents")
  .version(pkg.version);

// ─── context add ──────────────────────────────────────────────────────────────

program
  .command("add <name>")
  .description("Index a library by crawling its documentation")
  .option("-n, --npm <package>", "npm package name")
  .option("-u, --url <url>", "official docs URL")
  .option("-g, --github <repo>", "GitHub repo (e.g. facebook/react)")
  .option("-d, --description <text>", "library description")
  .option("-p, --pages <n>", "max pages to crawl", "30")
  .option(
    "-c, --crawler <type>",
    "crawler to use: exa|firecrawl",
    getDefaultCrawler()
  )
  .option("--no-crawl", "register library without crawling docs")
  .action(
    async (
      name: string,
      opts: {
        npm?: string;
        url?: string;
        github?: string;
        description?: string;
        pages?: string;
        crawler?: string;
        crawl?: boolean;
      }
    ) => {
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
          console.log(chalk.gray(`Use 'context refresh ${existing[0].slug}' to re-crawl.`));
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

      console.log(chalk.bold(`\nIndexing ${name}...`));
      console.log(chalk.gray(`  ID: /context/${library.slug}`));

      if (opts.crawl === false) {
        console.log(chalk.green(`✓ Registered ${chalk.bold(name)} (no crawl)`));
        return;
      }

      const crawler = (opts.crawler ?? getDefaultCrawler()) as CrawlerType;
      console.log(chalk.gray(`  Crawler: ${crawler}`));

      const maxPages = parseInt(opts.pages ?? "30", 10);
      const result = await crawlLibrary(library.id, { maxPages, crawler });

      console.log(
        chalk.green(`\n✓ Indexed ${chalk.bold(name)}`) +
          chalk.gray(` — ${result.pages_crawled} pages, ${result.chunks_indexed} chunks`)
      );
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
  .description("Populate the database with metadata for popular tools/services (no crawling)")
  .option("--crawl", "Also crawl docs for each library after seeding")
  .option("-p, --pages <n>", "max pages per library when --crawl is set", "10")
  .option(
    "-c, --crawler <type>",
    "crawler to use: exa|firecrawl",
    getDefaultCrawler()
  )
  .action(
    async (opts: { crawl?: boolean; pages?: string; crawler?: string }) => {
      console.log(chalk.bold(`\nSeeding ${SEED_LIBRARIES.length} libraries...\n`));
      let added = 0;
      let skipped = 0;

      for (const seed of SEED_LIBRARIES) {
        try {
          const existing = searchLibraries(seed.name, 1);
          if (
            existing.length > 0 &&
            existing[0] &&
            (existing[0].slug === seed.slug || existing[0].name.toLowerCase() === seed.name.toLowerCase())
          ) {
            skipped++;
            continue;
          }

          const library = createLibrary({
            name: seed.name,
            slug: seed.slug,
            description: seed.description,
            npm_package: seed.npm_package,
            github_repo: seed.github_repo,
            docs_url: seed.docs_url,
          });

          // Sync links
          if (seed.links) {
            syncLinks(
              library.id,
              seed.links.map((l) => ({
                type: l.type as LinkType,
                url: l.url,
                label: l.label,
              }))
            );
          }

          // Create KG node
          upsertNode({
            type: "library",
            name: seed.name,
            description: seed.description,
            library_id: library.id,
            metadata: { slug: seed.slug, tags: seed.tags },
          });

          added++;
          process.stdout.write(chalk.green(`  + ${seed.name}\n`));

          if (opts.crawl) {
            const crawler = (opts.crawler ?? getDefaultCrawler()) as CrawlerType;
            const maxPages = parseInt(opts.pages ?? "10", 10);
            const result = await crawlLibrary(library.id, { maxPages, crawler });
            process.stdout.write(
              chalk.gray(
                `    → ${result.pages_crawled} pages, ${result.chunks_indexed} chunks\n`
              )
            );
          }
        } catch (err) {
          console.log(chalk.red(`  ✗ ${seed.name}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      console.log(
        `\n${chalk.green(`✓ Seeded ${added} libraries`)}${skipped > 0 ? chalk.gray(` (${skipped} already existed)`) : ""}`
      );
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
        : chalk.yellow(" (not crawled)");
      console.log(`  ${id}  ${name}${version}${crawled}`);
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
            chalk.red("Semantic search requires CONTEXT_EMBEDDING_PROVIDER=openai|anthropic")
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
          "Set CONTEXT_EMBEDDING_PROVIDER=openai|anthropic to enable embeddings"
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

    const { getDatabase } = await import("../db/database.js");
    const db = getDatabase();
    let sql = "SELECT id, content FROM chunks WHERE library_id = ?";
    if (!opts.all) {
      sql +=
        " AND id NOT IN (SELECT chunk_id FROM chunk_embeddings)";
    }

    const chunks = db
      .query<{ id: string; content: string }, [string]>(sql)
      .all(library.id);

    let done = 0;
    let failed = 0;

    for (const chunk of chunks) {
      try {
        const vec = await embedText(chunk.content, config);
        saveEmbedding(chunk.id, config.model, vec, db);
        done++;
        if (done % 10 === 0 || done === chunks.length) {
          process.stdout.write(`\r  ${done}/${chunks.length} chunks embedded`);
        }
      } catch {
        failed++;
      }
    }

    console.log(
      `\n\n${chalk.green(`✓ Embedded ${done} chunks`)}` +
        (failed > 0 ? chalk.red(` (${failed} failed)`) : "")
    );
  });

// ─── context refresh ──────────────────────────────────────────────────────────

program
  .command("refresh <slug>")
  .description("Re-crawl and re-index a library")
  .option("-p, --pages <n>", "max pages to crawl", "30")
  .option("-c, --crawler <type>", "crawler: exa|firecrawl", getDefaultCrawler())
  .action(async (slug: string, opts: { pages?: string; crawler?: string }) => {
    const library = getLibraryBySlug(slug);
    const maxPages = parseInt(opts.pages ?? "30", 10);
    const crawler = (opts.crawler ?? getDefaultCrawler()) as CrawlerType;

    console.log(
      chalk.bold(`\nRefreshing ${library.name}`) + chalk.gray(` via ${crawler}...`)
    );

    const result = await crawlLibrary(library.id, { maxPages, refresh: true, crawler });

    console.log(
      chalk.green(`\n✓ Refreshed ${chalk.bold(library.name)}`) +
        chalk.gray(` — ${result.pages_crawled} pages, ${result.chunks_indexed} chunks`)
    );

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
    if (lib.version) console.log(`  Version:     ${lib.version}`);
    console.log(`  Chunks:      ${lib.chunk_count}`);
    console.log(`  Pages:       ${lib.document_count}`);
    if (embedded > 0) {
      console.log(`  Embeddings:  ${embedded}/${total} chunks`);
    }
    if (lib.last_crawled_at) {
      console.log(`  Crawled:     ${formatDate(lib.last_crawled_at)}`);
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
  .option("-t, --type <type>", "Link type: docs|npm|github|api|examples|tutorial|changelog|playground")
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
  .description("Show version history of crawled documents for a library")
  .option("--json", "Output as JSON")
  .action((slug: string, opts: { json?: boolean }) => {
    const lib = getLibraryBySlug(slug);
    const docs = listDocuments(lib.id);

    if (docs.length === 0) {
      console.log(chalk.gray(`No crawled pages for ${lib.name}`));
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

// ─── context kg ───────────────────────────────────────────────────────────────

program
  .command("kg")
  .description("Explore the knowledge graph")
  .option("-s, --search <query>", "Search KG nodes")
  .option("-l, --library <slug>", "Show relations for a specific library")
  .option("--json", "Output as JSON")
  .action((opts: { search?: string; library?: string; json?: boolean }) => {
    if (opts.search) {
      const nodes = searchNodes(opts.search);
      if (opts.json) {
        console.log(JSON.stringify(nodes, null, 2));
        return;
      }
      console.log(chalk.bold(`\nKG nodes matching "${opts.search}":\n`));
      for (const n of nodes) {
        console.log(`  ${chalk.gray(`[${n.type}]`)} ${chalk.bold(n.name)}`);
        if (n.description) console.log(`    ${chalk.gray(n.description)}`);
      }
      console.log();
      return;
    }

    if (opts.library) {
      const lib = getLibraryBySlug(opts.library);
      const { getDatabase } = require("../db/database.js") as typeof import("../db/database.js");
      const db = getDatabase();
      const node = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM kg_nodes WHERE library_id = ? LIMIT 1"
        )
        .get(lib.id);

      if (!node) {
        console.log(chalk.gray(`No KG node for ${lib.name}. Run: context seed`));
        return;
      }

      const withRels = getRelatedNodes(node.id);

      if (opts.json) {
        console.log(JSON.stringify(withRels, null, 2));
        return;
      }

      console.log(chalk.bold(`\n${lib.name} — Knowledge Graph:\n`));
      if (withRels.relations.length === 0) {
        console.log(chalk.gray("  No relations found"));
      }
      for (const rel of withRels.relations) {
        const arrow = rel.direction === "outgoing" ? "→" : "←";
        console.log(
          `  ${arrow} ${chalk.gray(rel.relation.padEnd(16))} ${chalk.bold(rel.node.name)} ${chalk.gray(`[${rel.node.type}]`)}`
        );
      }
      console.log();
      return;
    }

    // List all nodes
    const nodes = listNodes();
    if (opts.json) {
      console.log(JSON.stringify(nodes, null, 2));
      return;
    }
    console.log(chalk.bold(`\nKnowledge Graph — ${nodes.length} nodes:\n`));
    const byType = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const list = byType.get(n.type) ?? [];
      list.push(n);
      byType.set(n.type, list);
    }
    for (const [type, typeNodes] of byType) {
      console.log(chalk.gray(`  ${type}:`));
      for (const n of typeNodes) {
        console.log(`    ${chalk.bold(n.name)}`);
      }
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
    const config = getEmbeddingConfig();

    console.log(chalk.bold("\nopen-context status\n"));
    console.log(`  DB:              ${db}`);
    console.log(`  Libraries:       ${libraries.length}`);
    console.log(`  Pages:           ${totalDocs}`);
    console.log(`  Chunks:          ${totalChunks}`);
    console.log(`  Embedding:       ${config ? `${config.provider} / ${config.model}` : "disabled"}`);
    console.log(`  Default crawler: ${getDefaultCrawler()}`);
    console.log();
  });

// ─── context serve ────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the HTTP API server")
  .option("-p, --port <n>", "Port (default: 19431)")
  .action((opts: { port?: string }) => {
    if (opts.port) process.env["CONTEXT_PORT"] = opts.port;
    import("../server/index.js").catch((err: unknown) => {
      console.error(chalk.red("Failed to start server:"), err);
      process.exit(1);
    });
  });

program.parse();

function formatDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
