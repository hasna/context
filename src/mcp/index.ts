#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";
import {
  searchLibraries,
  getLibraryBySlug,
  listLibraries,
  createLibrary,
} from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { crawlLibrary, getDefaultCrawler } from "../crawler/index.js";
import type { CrawlerType } from "../crawler/index.js";
import { getLinks } from "../db/links.js";
import { getRelatedNodes } from "../db/kg.js";
import {
  getEmbeddingConfig,
  embedText,
  semanticSearch,
} from "../db/embeddings.js";
import { SEED_LIBRARIES } from "../seeds/libraries.js";
import { syncLinks } from "../db/links.js";
import type { LinkType } from "../db/links.js";
import { upsertNode } from "../db/kg.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const server = new McpServer({ name: "context", version: pkg.version });

// ─── resolve-library-id ───────────────────────────────────────────────────────

server.tool(
  "resolve-library-id",
  `Search the local documentation index for a library and return its ID.
Use this before query-docs to get the correct library ID.
Returns matching libraries with IDs, descriptions, and links.`,
  {
    libraryName: z
      .string()
      .describe("Library name to search for (e.g. 'react', 'express', 'numpy')"),
  },
  async ({ libraryName }) => {
    try {
      const results = searchLibraries(libraryName, 5);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No libraries found matching "${libraryName}".\nRun: context add "${libraryName}" to index it, or context seed to populate popular libraries.`,
            },
          ],
        };
      }

      const formatted = results
        .map((lib) => {
          const links = getLinks(lib.id);
          const lines = [
            `- Library ID: /context/${lib.slug}`,
            `  Name: ${lib.name}`,
          ];
          if (lib.description) lines.push(`  Description: ${lib.description}`);
          if (lib.npm_package) lines.push(`  npm: ${lib.npm_package}`);
          if (lib.version) lines.push(`  Version: ${lib.version}`);

          const docsLink = links.find((l) => l.type === "docs") ?? links.find((l) => l.type === "api");
          if (docsLink) lines.push(`  Docs: ${docsLink.url}`);
          if (lib.github_repo) lines.push(`  GitHub: https://github.com/${lib.github_repo}`);

          lines.push(
            `  Indexed: ${lib.chunk_count > 0 ? `${lib.chunk_count} chunks from ${lib.document_count} pages` : "not yet crawled"}`
          );
          return lines.join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} matching librar${results.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── query-docs ───────────────────────────────────────────────────────────────

server.tool(
  "query-docs",
  `Fetch relevant documentation chunks for a library.
Uses FTS5 full-text search, with semantic search as fallback when embeddings are available.
Provide a specific topic or query to get the most relevant chunks.`,
  {
    context7CompatibleLibraryID: z
      .string()
      .describe("Library ID from resolve-library-id (e.g. '/context/react' or 'react')"),
    tokens: z
      .number()
      .optional()
      .default(5000)
      .describe("Max tokens to return (default: 5000)"),
    topic: z
      .string()
      .optional()
      .describe("Specific topic or query to search within the library docs"),
  },
  async ({ context7CompatibleLibraryID, tokens = 5000, topic }) => {
    try {
      const slug = context7CompatibleLibraryID
        .replace(/^\/context\//, "")
        .replace(/^\//, "")
        .trim();

      const library = getLibraryBySlug(slug);

      if (library.chunk_count === 0) {
        const links = getLinks(library.id);
        const docsUrl = links.find((l) => l.type === "docs")?.url ?? library.docs_url;
        return {
          content: [
            {
              type: "text",
              text: `Library "${library.name}" has no indexed documentation yet.\n` +
                (docsUrl ? `Official docs: ${docsUrl}\n` : "") +
                `Run: context add ${slug}  (or: context refresh ${slug})`,
            },
          ],
        };
      }

      const query = topic ?? library.name;
      const maxChunks = Math.ceil(tokens / 300);

      // Try semantic search first if available
      const embConfig = getEmbeddingConfig();
      let results;

      if (embConfig) {
        try {
          const queryVec = await embedText(query, embConfig);
          const semantic = semanticSearch(queryVec, library.id, maxChunks);
          // Merge with FTS5 results for hybrid ranking
          const fts = searchChunks(query, library.id, maxChunks);
          const seen = new Set<string>();
          results = [];
          for (const r of [...semantic.slice(0, Math.ceil(maxChunks * 0.6)), ...fts]) {
            if (seen.has(r.chunk_id)) continue;
            seen.add(r.chunk_id);
            results.push(r);
            if (results.length >= maxChunks) break;
          }
        } catch {
          results = searchChunks(query, library.id, maxChunks);
        }
      } else {
        results = searchChunks(query, library.id, maxChunks);
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No documentation found for "${query}" in ${library.name}. The library has ${library.chunk_count} chunks — try a different query.`,
            },
          ],
        };
      }

      const links = getLinks(library.id);
      let output = `# ${library.name} Documentation\n`;
      if (library.version) output += `Version: ${library.version}\n`;
      const docsLink = links.find((l) => l.type === "docs") ?? links.find((l) => l.type === "api");
      if (docsLink) output += `Source: ${docsLink.url}\n`;
      output += "\n";

      let totalTokens = 0;
      for (const result of results) {
        const chunkTokens = Math.ceil(result.content.length / 4);
        if (totalTokens + chunkTokens > tokens) break;

        if (result.title || result.url) {
          output += `---\n`;
          if (result.title) output += `### ${result.title}\n`;
          if (result.url) output += `Source: ${result.url}\n`;
          output += "\n";
        }

        output += result.content + "\n\n";
        totalTokens += chunkTokens;
      }

      return { content: [{ type: "text", text: output.trim() }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── add-library ──────────────────────────────────────────────────────────────

server.tool(
  "add-library",
  `Index a new library by crawling its documentation via Exa or Firecrawl.
After indexing, use resolve-library-id and query-docs to access the docs.`,
  {
    name: z.string().describe("Library name (e.g. 'React', 'Express')"),
    npm_package: z.string().optional().describe("npm package name"),
    docs_url: z.string().optional().describe("Official documentation URL"),
    github_repo: z.string().optional().describe("GitHub repo (e.g. 'facebook/react')"),
    max_pages: z.number().optional().default(20).describe("Max pages to crawl (default: 20)"),
    crawler: z
      .enum(["exa", "firecrawl"])
      .optional()
      .describe("Crawler to use: exa (default) or firecrawl"),
  },
  async ({ name, npm_package, docs_url, github_repo, max_pages = 20, crawler }) => {
    try {
      const existing = searchLibraries(name, 1);
      if (
        existing.length > 0 &&
        existing[0] &&
        existing[0].name.toLowerCase() === name.toLowerCase()
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Library "${name}" is already indexed with ID /context/${existing[0].slug}.`,
            },
          ],
        };
      }

      const library = createLibrary({ name, npm_package, docs_url, github_repo });
      const result = await crawlLibrary(library.id, {
        maxPages: max_pages,
        crawler: (crawler ?? getDefaultCrawler()) as CrawlerType,
      });

      const lines = [
        `Indexed "${name}"`,
        `Library ID: /context/${library.slug}`,
        `Pages crawled: ${result.pages_crawled}`,
        `Chunks indexed: ${result.chunks_indexed}`,
      ];
      if (result.errors.length > 0) {
        lines.push(`Warnings: ${result.errors.slice(0, 2).join("; ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── list-libraries ───────────────────────────────────────────────────────────

server.tool(
  "list-libraries",
  "List all libraries indexed in the local documentation store.",
  {},
  async () => {
    try {
      const libraries = listLibraries();

      if (libraries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No libraries indexed yet. Use add-library or run: context seed",
            },
          ],
        };
      }

      const formatted = libraries.map((lib) => {
        const status =
          lib.chunk_count > 0
            ? `${lib.chunk_count} chunks, ${lib.document_count} pages`
            : "not crawled";
        return `- /context/${lib.slug} — ${lib.name}${lib.version ? ` v${lib.version}` : ""} (${status})`;
      }).join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} indexed:\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── get-library-links ────────────────────────────────────────────────────────

server.tool(
  "get-library-links",
  "Get all links (docs, npm, github, api, etc.) for a library.",
  {
    libraryId: z
      .string()
      .describe("Library slug or /context/<slug> ID"),
  },
  async ({ libraryId }) => {
    try {
      const slug = libraryId.replace(/^\/context\//, "").trim();
      const library = getLibraryBySlug(slug);
      const links = getLinks(library.id);

      if (links.length === 0) {
        return {
          content: [{ type: "text", text: `No links registered for ${library.name}.` }],
        };
      }

      const formatted = links
        .map((l) => `- [${l.type}] ${l.label ? `${l.label}: ` : ""}${l.url}`)
        .join("\n");

      return {
        content: [{ type: "text", text: `${library.name} — Links:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── get-related-libraries ────────────────────────────────────────────────────

server.tool(
  "get-related-libraries",
  "Find libraries related to a given library via the knowledge graph (alternatives, dependencies, commonly used together).",
  {
    libraryId: z.string().describe("Library slug or /context/<slug> ID"),
    relation: z
      .enum([
        "depends_on",
        "alternative_to",
        "used_with",
        "wraps",
        "extends",
        "part_of",
        "replaced_by",
      ])
      .optional()
      .describe("Filter by relation type"),
  },
  async ({ libraryId, relation }) => {
    try {
      const slug = libraryId.replace(/^\/context\//, "").trim();
      const library = getLibraryBySlug(slug);

      const { getDatabase } = await import("../db/database.js");
      const db = getDatabase();
      const node = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM kg_nodes WHERE library_id = ? LIMIT 1"
        )
        .get(library.id);

      if (!node) {
        return {
          content: [
            {
              type: "text",
              text: `No knowledge graph node for ${library.name}. Run: context seed`,
            },
          ],
        };
      }

      const withRels = getRelatedNodes(node.id, relation as Parameters<typeof getRelatedNodes>[1]);

      if (withRels.relations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No ${relation ?? ""}relations found for ${library.name} in the knowledge graph.`,
            },
          ],
        };
      }

      const lines = [`${library.name} — Related Libraries:`, ""];
      for (const rel of withRels.relations) {
        const arrow = rel.direction === "outgoing" ? "→" : "←";
        lines.push(`${arrow} [${rel.relation}] ${rel.node.name} (${rel.node.type})`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── seed-libraries ───────────────────────────────────────────────────────────

server.tool(
  "seed-libraries",
  "Populate the database with metadata for popular tools and services (names, links, KG nodes). Does NOT crawl docs.",
  {},
  async () => {
    try {
      let added = 0;
      let skipped = 0;

      for (const seed of SEED_LIBRARIES) {
        try {
          const existing = searchLibraries(seed.name, 1);
          if (
            existing.length > 0 &&
            existing[0] &&
            existing[0].slug === seed.slug
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

          if (seed.links) {
            syncLinks(
              library.id,
              seed.links.map((l) => ({ type: l.type as LinkType, url: l.url, label: l.label }))
            );
          }

          upsertNode({
            type: "library",
            name: seed.name,
            description: seed.description,
            library_id: library.id,
            metadata: { slug: seed.slug, tags: seed.tags },
          });

          added++;
        } catch {
          // Skip failures silently
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Seeded ${added} libraries (${skipped} already existed).\nUse add-library to crawl docs for any of them.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
