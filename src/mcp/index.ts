#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";
import { searchLibraries, getLibraryBySlug, listLibraries } from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { createLibrary } from "../db/libraries.js";
import { crawlLibrary } from "../crawler/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const server = new McpServer({
  name: "context",
  version: pkg.version,
});

/**
 * resolve-library-id
 *
 * Search for a library by name and return its ID for use with query-docs.
 * Compatible with the Context7 MCP API format.
 */
server.tool(
  "resolve-library-id",
  `Search the local documentation index for a library and return its ID.
Use this before calling query-docs to get the correct library ID.
Returns a list of matching libraries with their IDs and descriptions.`,
  {
    libraryName: z
      .string()
      .describe(
        "The name of the library to search for (e.g. 'react', 'express', 'numpy')"
      ),
  },
  async ({ libraryName }) => {
    try {
      const results = searchLibraries(libraryName, 5);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No libraries found matching "${libraryName}". Use the 'context add' CLI command to index a library first.`,
            },
          ],
        };
      }

      const formatted = results
        .map((lib) => {
          const lines = [
            `- Library ID: /context/${lib.slug}`,
            `  Name: ${lib.name}`,
          ];
          if (lib.description) lines.push(`  Description: ${lib.description}`);
          if (lib.npm_package) lines.push(`  npm: ${lib.npm_package}`);
          if (lib.version) lines.push(`  Version: ${lib.version}`);
          if (lib.docs_url) lines.push(`  Docs: ${lib.docs_url}`);
          lines.push(
            `  Indexed: ${lib.chunk_count} chunks from ${lib.document_count} pages`
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
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * query-docs
 *
 * Fetch relevant documentation chunks for a library using full-text search.
 * Compatible with the Context7 MCP API format.
 */
server.tool(
  "query-docs",
  `Fetch relevant documentation for a library from the local index.
Use resolve-library-id first to get the correct library ID.
Returns the most relevant documentation chunks for your query.`,
  {
    context7CompatibleLibraryID: z
      .string()
      .describe(
        "The library ID from resolve-library-id (e.g. '/context/react' or just 'react')"
      ),
    tokens: z
      .number()
      .optional()
      .default(5000)
      .describe("Maximum number of tokens to return (default: 5000)"),
    topic: z
      .string()
      .optional()
      .describe("Specific topic or query to search within the library docs"),
  },
  async ({ context7CompatibleLibraryID, tokens = 5000, topic }) => {
    try {
      // Normalize library ID — strip /context/ prefix if present
      const slug = context7CompatibleLibraryID
        .replace(/^\/context\//, "")
        .replace(/^\//, "")
        .trim();

      const library = getLibraryBySlug(slug);

      if (library.chunk_count === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Library "${library.name}" has no indexed documentation. Run: context refresh ${slug}`,
            },
          ],
        };
      }

      const query = topic ?? library.name;
      const maxChunks = Math.ceil(tokens / 300); // ~300 tokens per chunk

      const results = searchChunks(query, library.id, maxChunks);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No documentation found for "${query}" in ${library.name}. The library has ${library.chunk_count} chunks indexed — try a different query.`,
            },
          ],
        };
      }

      // Format output
      let output = `# ${library.name} Documentation\n`;
      if (library.version) output += `Version: ${library.version}\n`;
      if (library.docs_url) output += `Source: ${library.docs_url}\n`;
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

      return {
        content: [{ type: "text", text: output.trim() }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * add-library
 *
 * Index a new library by crawling its documentation via Exa.
 */
server.tool(
  "add-library",
  `Index a new library by crawling its documentation.
This will discover and index documentation pages using Exa search.
After indexing, use resolve-library-id and query-docs to access the docs.`,
  {
    name: z.string().describe("Library name (e.g. 'React', 'Express')"),
    npm_package: z
      .string()
      .optional()
      .describe("npm package name (e.g. 'react', 'express')"),
    docs_url: z
      .string()
      .optional()
      .describe("Official documentation URL (e.g. 'https://react.dev')"),
    github_repo: z
      .string()
      .optional()
      .describe("GitHub repo (e.g. 'facebook/react')"),
    max_pages: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum pages to crawl (default: 20)"),
  },
  async ({ name, npm_package, docs_url, github_repo, max_pages = 20 }) => {
    try {
      // Check if already exists
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
                text: `Library "${name}" is already indexed with ID /context/${existing[0].slug}. Use query-docs to access it.`,
              },
            ],
          };
        }
      } catch {
        // Not found, proceed
      }

      // Create library record
      const library = createLibrary({
        name,
        npm_package,
        docs_url,
        github_repo,
      });

      // Crawl docs
      const result = await crawlLibrary(library.id, { maxPages: max_pages });

      const lines = [
        `Successfully indexed "${name}"`,
        `Library ID: /context/${library.slug}`,
        `Pages crawled: ${result.pages_crawled}`,
        `Chunks indexed: ${result.chunks_indexed}`,
      ];

      if (result.errors.length > 0) {
        lines.push(`Warnings: ${result.errors.slice(0, 3).join("; ")}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * list-libraries
 *
 * List all indexed libraries.
 */
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
              text: "No libraries indexed yet. Use add-library or the 'context add' CLI command.",
            },
          ],
        };
      }

      const formatted = libraries
        .map(
          (lib) =>
            `- /context/${lib.slug} — ${lib.name}${lib.version ? ` v${lib.version}` : ""} (${lib.chunk_count} chunks, ${lib.document_count} pages)`
        )
        .join("\n");

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
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
