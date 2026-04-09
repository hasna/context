#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { createRequire } from "module";
import { join } from "path";
import {
  listLibraries,
  getLibraryBySlug,
} from "../db/libraries.js";
import { getDefaultCrawler } from "../crawler/index.js";
import { getDbPath } from "../db/database.js";
import { getRelatedNodes, listNodes, searchNodes } from "../db/kg.js";
import {
  getEmbeddingConfig,
} from "../db/embeddings.js";
import {
  indexRepository,
  refreshRepository,
} from "../indexer/index.js";
import {
  listContexts,
  getContextByPath,
  getRelevantContext,
  getRelatedItems,
  getCodeEntitiesByItem,
  searchContextItems,
  searchCodeEntities,
} from "../db/repositories.js";
import { registerLibraryCommands } from "./library-commands.js";
import { formatDate } from "./format.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const program = new Command()
  .name("context")
  .description("Self-hosted documentation context server for AI coding agents")
  .version(pkg.version);
registerLibraryCommands(program);

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
        .get(
          "SELECT id FROM kg_nodes WHERE library_id = ? LIMIT 1",
          lib.id
        );

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

// ─── context index ─────────────────────────────────────────────────────────────

program
  .command("index <path>")
  .description("Index a local repository to build a code knowledge graph")
  .option("-w, --watch", "Enable file watching for real-time updates")
  .action(async (path: string, opts: { watch?: boolean }) => {
    const existing = getContextByPath(path);
    if (existing) {
      console.log(chalk.yellow(`Context already indexed at ${path}`));
      console.log(`  ID: ${existing.id}`);
      console.log(`  Files: ${existing.file_count}, Entities: ${existing.entity_count}`);
      console.log(chalk.gray(`Use 'context refresh ${path}' to re-scan changed files.`));
      return;
    }

    console.log(chalk.bold(`\nIndexing context at ${path}...`));
    try {
      const result = await indexRepository(path);
      console.log(chalk.green(`\n✓ Indexed ${result.context.name}`));
      console.log(`  Type: ${result.context.type}`);
      console.log(`  Language: ${result.context.language ?? "Unknown"}`);
      console.log(`  Files: ${result.stats.filesIndexed}`);
      console.log(`  Entities: ${result.stats.entitiesExtracted}`);
      console.log(`  Relations: ${result.stats.relationsFound}`);
      if (opts.watch) {
        console.log(chalk.gray(`  Watching for changes: enabled`));
      }
    } catch (err) {
      console.error(chalk.red("Index failed:"), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── context reindex ───────────────────────────────────────────────────────────

program
  .command("reindex <path>")
  .description("Re-scan an indexed repository to pick up new/changed files")
  .action(async (path: string) => {
    const existing = getContextByPath(path);
    if (!existing) {
      console.log(chalk.yellow(`Context not indexed at ${path}`));
      console.log(chalk.gray(`Use 'context index ${path}' to index it first.`));
      return;
    }

    console.log(chalk.bold(`\nRefreshing ${existing.name}...`));
    try {
      const result = await refreshRepository(path);
      console.log(chalk.green(`\n✓ Refreshed`));
      console.log(`  Files indexed: ${result.stats.filesIndexed}`);
      console.log(`  Entities: ${result.stats.entitiesExtracted}`);
      if (result.stats.errors.length > 0) {
        console.log(chalk.yellow(`  Errors: ${result.stats.errors.slice(0, 3).join("; ")}`));
      }
    } catch (err) {
      console.error(chalk.red("Refresh failed:"), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── context repos ─────────────────────────────────────────────────────────────

program
  .command("repos")
  .description("List all locally indexed contexts")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    const contexts = listContexts();

    if (contexts.length === 0) {
      console.log(chalk.gray("No contexts indexed."));
      console.log(chalk.gray("Use 'context index <path>' to index a context."));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(contexts, null, 2));
      return;
    }

    console.log(chalk.bold(`\n${contexts.length} context ${contexts.length === 1 ? "" : "s"} indexed:\n`));
    for (const ctx of contexts) {
      const status = `${ctx.file_count} files, ${ctx.entity_count} entities`;
      const lastIndexed = ctx.last_indexed_at
        ? `last indexed ${formatDate(ctx.last_indexed_at)}`
        : "never indexed";
      console.log(`  ${chalk.bold(ctx.name)} ${chalk.gray(`(${ctx.type}: ${ctx.language ?? "Unknown"})`)}`);
      console.log(`    Path: ${chalk.cyan(ctx.path)}`);
      console.log(`    ${status} — ${chalk.gray(lastIndexed)}`);
      console.log();
    }
  });

// ─── context context ───────────────────────────────────────────────────────────

program
  .command("context <path>")
  .description("Get relevant code context for a file or query")
  .option("-q, --query <text>", "Text search query")
  .option("-e, --entity <name>", "Entity (function/class) name")
  .option("-n, --results <n>", "Max results to return", "15")
  .option("-d, --depth <n>", "Max graph traversal depth", "3")
  .option("--json", "Output as JSON")
  .action((path: string, opts: { query?: string; entity?: string; results?: string; depth?: string; json?: boolean }) => {
    const ctx = getContextByPath(path);
    if (!ctx) {
      console.log(chalk.yellow(`Context not indexed at ${path}`));
      console.log(chalk.gray(`Use 'context index ${path}' to index it first.`));
      return;
    }

    const maxResults = parseInt(opts.results ?? "15", 10);
    const maxDepth = parseInt(opts.depth ?? "3", 10);
    const searchQuery = opts.query ?? opts.entity ?? path.split("/").pop() ?? "";

    const results = getRelevantContext(
      { query: searchQuery },
      { maxResults, maxDistance: maxDepth }
    );

    if (results.length === 0) {
      console.log(chalk.gray(`No relevant context found for "${searchQuery}"`));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log(chalk.bold(`\nRelevant Context for "${searchQuery}"\n`));
    for (const result of results) {
      const score = Math.round(result.score * 100);
      console.log(`${chalk.green("─".repeat(50))}`);
      if (result.item) {
        console.log(`  ${chalk.bold(result.item.name)} ${chalk.gray(`${score}% related`)}`);
        console.log(`  Path: ${chalk.cyan(result.item.path)}`);
        console.log(`  Lines: ${result.item.line_count}`);
        const preview = (result.item.content ?? "").slice(0, 200).replace(/\n/g, " ");
        console.log(`  Preview: ${chalk.gray(preview)}...`);
      } else if (result.entity) {
        console.log(`  ${chalk.bold(result.entity.name)} ${chalk.gray(`(${result.entity.type})`)} ${chalk.green(`${score}%`)}`);
        if (result.entity.signature) {
          console.log(`  Signature: ${chalk.cyan(result.entity.signature)}`);
        }
        console.log(`  Lines: ${result.entity.start_line}-${result.entity.end_line}`);
      }
      console.log(`  ${chalk.gray("Reason:")} ${result.reason}`);
    }
    console.log();
  });

// ─── context relations ─────────────────────────────────────────────────────────

program
  .command("relations <path>")
  .description("Get all files and entities related to a file")
  .option("-f, --file <filepath>", "Specific file path within the context")
  .option("-d, --depth <n>", "Traversal depth", "2")
  .option("--json", "Output as JSON")
  .action((path: string, opts: { file?: string; depth?: string; json?: boolean }) => {
    const ctx = getContextByPath(path);
    if (!ctx) {
      console.log(chalk.yellow(`Context not indexed at ${path}`));
      console.log(chalk.gray(`Use 'context index ${path}' to index it first.`));
      return;
    }

    const targetFile = opts.file ?? path;
    const items = searchContextItems(targetFile.split("/").pop() ?? targetFile, ctx.id);
    const matched = items.find((f) => f.path.endsWith(targetFile) || f.path === targetFile);

    if (!matched) {
      console.log(chalk.yellow(`File not found: ${targetFile}`));
      return;
    }

    const entities = getCodeEntitiesByItem(matched.id);
    const relatedItems = getRelatedItems(matched.id, parseInt(opts.depth ?? "2", 10));

    if (opts.json) {
      console.log(JSON.stringify({
        file: matched,
        entities,
        relatedItems: relatedItems.map(r => ({ item: r.item, distance: r.distance, relation: r.relation }))
      }, null, 2));
      return;
    }

    console.log(chalk.bold(`\nRelations for ${matched.name}\n`));
    console.log(`Path: ${chalk.cyan(matched.path)}`);
    console.log(`Entities: ${entities.length}`);

    if (entities.length > 0) {
      console.log(chalk.bold("\nCode Entities:"));
      for (const entity of entities) {
        console.log(`  ${chalk.cyan(entity.type)} ${chalk.bold(entity.name)} (lines ${entity.start_line}-${entity.end_line})`);
      }
    }

    if (relatedItems.length > 0) {
      console.log(chalk.bold("\nRelated Files:"));
      for (const { item, distance, relation } of relatedItems.slice(0, 20)) {
        console.log(`  ${chalk.bold(item.name)} ${chalk.gray(`(distance: ${distance})`)}`);
        console.log(`    via: ${relation.relation_type}`);
      }
      if (relatedItems.length > 20) {
        console.log(chalk.gray(`  ... and ${relatedItems.length - 20} more`));
      }
    }
    console.log();
  });

// ─── context codesearch ────────────────────────────────────────────────────────

program
  .command("codesearch <query>")
  .description("Search indexed contexts for files or entities")
  .option("-r, --repo <path>", "Context path to search within")
  .option("-t, --type <type>", "Search type: all|files|entities", "all")
  .option("--json", "Output as JSON")
  .action((query: string, opts: { repo?: string; type?: string; json?: boolean }) => {
    let contextId: string | undefined;
    if (opts.repo) {
      const ctx = getContextByPath(opts.repo);
      if (!ctx) {
        console.log(chalk.yellow(`Context not found at ${opts.repo}`));
        return;
      }
      contextId = ctx.id;
    }

    const type = opts.type ?? "all";
    const results: string[] = [];

    if (type === "all" || type === "files") {
      const items = searchContextItems(query, contextId);
      if (items.length > 0) {
        results.push(chalk.bold(`\nFiles matching "${query}" (${items.length}):\n`));
        for (const item of items.slice(0, 20)) {
          results.push(`  ${chalk.bold(item.name)} ${chalk.gray(item.path)} (${item.line_count} lines)`);
        }
        if (items.length > 20) results.push(chalk.gray(`  ... and ${items.length - 20} more`));
      }
    }

    if (type === "all" || type === "entities") {
      const entities = searchCodeEntities(query, contextId);
      if (entities.length > 0) {
        results.push(chalk.bold(`\nEntities matching "${query}" (${entities.length}):\n`));
        for (const entity of entities.slice(0, 20)) {
          results.push(`  ${chalk.cyan(entity.type)} ${chalk.bold(entity.name)} in ${chalk.gray(entity.item_id)}`);
        }
        if (entities.length > 20) results.push(chalk.gray(`  ... and ${entities.length - 20} more`));
      }
    }

    if (results.length === 0) {
      console.log(chalk.gray(`No results found for "${query}"`));
      return;
    }

    console.log(results.join("\n"));
    console.log();
  });

// ─── context watch ─────────────────────────────────────────────────────────────

program
  .command("watch <path>")
  .description("Watch a context and auto-update knowledge graph on file changes")
  .option("--no-auto", "Disable automatic graph updates")
  .action(async (path: string, opts: { auto?: boolean }) => {
    const { watchContextWithHooks, createGraphUpdateHook } = await import("../hooks/index.js");

    const ctx = getContextByPath(path);
    if (!ctx) {
      console.log(chalk.yellow(`Context not indexed at ${path}`));
      console.log(chalk.gray(`Use 'context index ${path}' to index it first.`));
      return;
    }

    const hooks = opts.auto !== false ? [createGraphUpdateHook(path)] : [];
    console.log(chalk.bold(`\nWatching ${path} with ${hooks.length} hook(s)...`));
    console.log(chalk.gray("Press Ctrl+C to stop.\n"));

    watchContextWithHooks(path, hooks);

    // Keep process alive
    process.stdin.resume();
  });

// ─── context edit-context ─────────────────────────────────────────────────────

program
  .command("edit-context <path>")
  .description("Get context suggestions for editing a file")
  .option("-f, --file <filepath>", "Specific file within the context")
  .option("-n, --results <n>", "Max related files to show", "10")
  .option("--json", "Output as JSON")
  .action(async (path: string, opts: { file?: string; results?: string; json?: boolean }) => {
    const { getEditContext } = await import("../hooks/index.js");

    const ctx = getContextByPath(path);
    if (!ctx) {
      console.log(chalk.yellow(`Context not indexed at ${path}`));
      return;
    }

    // If -f flag not provided, path is the file path
    const filePath = opts.file ? join(path, opts.file) : path;
    const result = getEditContext(path, filePath, {
      maxRelated: parseInt(opts.results ?? "10", 10),
    });

    if (!result.item) {
      console.log(chalk.yellow(`File not found: ${opts.file ?? path}`));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(chalk.bold(`\nEdit Context for ${result.item.name}\n`));
    console.log(`Path: ${chalk.cyan(result.item.path)}`);
    console.log(`Entities: ${result.entities.length}`);

    if (result.entities.length > 0) {
      console.log(chalk.bold("\nCode Entities:"));
      for (const entity of result.entities.slice(0, 15)) {
        console.log(`  ${chalk.cyan(entity.type)} ${chalk.bold(entity.name)} (lines ${entity.start_line}-${entity.end_line})`);
      }
    }

    if (result.relatedItems.length > 0) {
      console.log(chalk.bold("\nRelated Files:"));
      for (const { item, distance, via } of result.relatedItems) {
        console.log(`  ${chalk.bold(item.name)} ${chalk.gray(`(${distance} hop${distance > 1 ? "s" : ""})`)}`);
        console.log(`    via: ${via}`);
      }
    }

    if (result.suggestions.length > 0) {
      console.log(chalk.bold("\nSuggestions:"));
      for (const s of result.suggestions) {
        console.log(`  ${chalk.gray(s)}`);
      }
    }
    console.log();
  });

program.parse();
