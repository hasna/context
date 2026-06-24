#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
import { z } from "zod";
import { createRequire } from "module";
import {
  indexRepository,
  refreshRepository,
  watchRepository,
} from "../indexer/index.js";
import {
  listContexts,
  getContextByPath,
  getCodeEntitiesByItem,
  getRelationsByItem,
  getRelatedItems,
  searchContextItems,
  searchCodeEntities,
  getRelevantContext,
} from "../db/repositories.js";
import { registerContextStorageTools } from "./storage-tools.js";
import { registerLibraryTools } from "./library-tools.js";
import { isStdioMode, resolveMcpHttpPort, startMcpHttpServer } from "./http.js";
import {
  generateWithAiSdk,
  getAiProviderStatuses,
  type AiProviderId,
} from "../ai/providers.js";
import { getPublishReadinessReport } from "../publish/readiness.js";
import { DEFAULT_LIST_LIMIT, takeWithMore } from "../cli/format.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

function printHelp(): void {
  console.log(`Usage: context-mcp [options]

Start the open-context MCP server over stdio.

Options:
  -V, --version  output the version number
  -h, --help     display help for command
`);
}

function handleMetaArgs(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("-V") || args.includes("--version")) {
    console.log(pkg.version);
    return true;
  }

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return true;
  }

  return false;
}

if (handleMetaArgs()) {
  process.exit(0);
}

export function buildServer(): McpServer {
const server = new McpServer({ name: "context", version: pkg.version });
registerContextStorageTools(server);

server.tool(
  "ai_status",
  "Show configured AI SDK generation backends and required API key environment variables.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(getAiProviderStatuses(), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "ai_generate",
  "Generate text using the configured AI SDK backend.",
  {
    prompt: z.string(),
    backend: z.string().optional(),
    model: z.string().optional(),
    system: z.string().optional(),
  },
  async (params) => {
    try {
      const result = await generateWithAiSdk({
        prompt: params.prompt,
        provider: params.backend as AiProviderId | undefined,
        model: params.model,
        system: params.system,
      });
      return { content: [{ type: "text", text: result.text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "publish_readiness",
  "Audit package readiness before publishing to npm.",
  {
    includeRegistry: z.boolean().optional().default(false),
    latestRegistryVersion: z.string().optional(),
  },
  async ({ includeRegistry = false, latestRegistryVersion }) => {
    try {
      const report = await getPublishReadinessReport({
        includeRegistry,
        registryLatestVersion: latestRegistryVersion,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        isError: !report.ready,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }
);

// --- in-memory agent registry ---
interface _CtxAgent { id: string; name: string; session_id?: string; last_seen_at: string; project_id?: string; }
const _ctxAgents = new Map<string, _CtxAgent>();

registerLibraryTools(server);

server.tool(
  "send_feedback",
  "Send feedback about this service",
  { message: z.string(), email: z.string().optional(), category: z.enum(["bug", "feature", "general"]).optional() },
  async (params) => {
    try {
      const { getDatabase } = await import("../db/database.js");
      const db = getDatabase();
      db.prepare("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)").run(params.message, params.email || null, params.category || "general", pkg.version);
      return { content: [{ type: "text", text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// --- Agent Tools ---

server.tool("register_agent", "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.", {
  name: z.string(),
  session_id: z.string().optional(),
}, async (params) => {
  const existing = [..._ctxAgents.values()].find(a => a.name === params.name);
  if (existing) { existing.last_seen_at = new Date().toISOString(); if (params.session_id) existing.session_id = params.session_id; return { content: [{ type: "text", text: JSON.stringify(existing) }] }; }
  const id = Math.random().toString(36).slice(2, 10);
  const ag: _CtxAgent = { id, name: params.name, session_id: params.session_id, last_seen_at: new Date().toISOString() };
  _ctxAgents.set(id, ag);
  return { content: [{ type: "text", text: JSON.stringify(ag) }] };
});

server.tool("heartbeat", "Update last_seen_at to signal agent is active.", {
  agent_id: z.string(),
}, async (params) => {
  const ag = _ctxAgents.get(params.agent_id);
  if (!ag) return { content: [{ type: "text", text: `Agent not found: ${params.agent_id}` }], isError: true };
  ag.last_seen_at = new Date().toISOString();
  return { content: [{ type: "text", text: JSON.stringify({ agent_id: ag.id, last_seen_at: ag.last_seen_at }) }] };
});

server.tool("set_focus", "Set active project context for this agent session.", {
  agent_id: z.string(),
  project_id: z.string().optional(),
}, async (params) => {
  const ag = _ctxAgents.get(params.agent_id);
  if (!ag) return { content: [{ type: "text", text: `Agent not found: ${params.agent_id}` }], isError: true };
  ag.project_id = params.project_id;
  return { content: [{ type: "text", text: JSON.stringify({ agent_id: ag.id, project_id: ag.project_id ?? null }) }] };
});

server.tool("list_agents", "List all registered agents.", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify([..._ctxAgents.values()]) }] };
});

// ─── Repository Indexing Tools ─────────────────────────────────────────────────

server.tool(
  "index-repository",
  "Index a local repository (folder) to build a code knowledge graph. Scans all supported files, extracts code entities (functions, classes, interfaces), and tracks relationships.",
  {
    path: z.string().describe("Absolute path to the repository folder to index"),
    watch: z.boolean().optional().default(false).describe("Enable file watching for real-time updates"),
  },
  async ({ path, watch: enableWatch }) => {
    try {
      // Check if already indexed
      const existing = getContextByPath(path);
      if (existing) {
        return {
          content: [
            {
              type: "text",
              text: `Context already indexed at ${path}.\n` +
                `ID: ${existing.id}\n` +
                `Files: ${existing.file_count}, Entities: ${existing.entity_count}\n` +
                `Last indexed: ${existing.last_indexed_at ?? "never"}\n\n` +
                `Use refresh-repository to re-scan changed files.`,
            },
          ],
        };
      }

      // Index the repository
      const result = await indexRepository(path, {
        onProgress: () => {
          // Could emit progress here if needed
        },
      });

      // Enable watching if requested
      if (enableWatch) {
        try {
          watchRepository(path);
        } catch {
          // Watch might fail if permissions issue, not critical
        }
      }

      const lines = [
        `Indexed context: ${result.context.name}`,
        `Path: ${result.context.path}`,
        `Context ID: ${result.context.id}`,
        `Language: ${result.context.language ?? "Unknown"}`,
        `Files indexed: ${result.stats.filesIndexed}`,
        `Code entities extracted: ${result.stats.entitiesExtracted}`,
        `Relations found: ${result.stats.relationsFound}`,
      ];

      if (result.stats.errors.length > 0) {
        lines.push(`Errors: ${result.stats.errors.slice(0, 3).join("; ")}`);
      }

      if (enableWatch) {
        lines.push(`Watching for changes: enabled`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error indexing context: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "refresh-repository",
  "Re-scan an indexed repository to pick up new and changed files.",
  {
    path: z.string().describe("Absolute path to the repository folder"),
  },
  async ({ path }) => {
    try {
      const existing = getContextByPath(path);
      if (!existing) {
        return {
          content: [
            {
              type: "text",
              text: `Context not found at ${path}.\nRun index-repository first.`,
            },
          ],
        };
      }

      const result = await refreshRepository(path);

      const lines = [
        `Refreshed context: ${result.context.name}`,
        `New/changed files indexed: ${result.stats.filesIndexed}`,
        `Total entities: ${result.stats.entitiesExtracted}`,
      ];

      if (result.stats.errors.length > 0) {
        lines.push(`Errors: ${result.stats.errors.slice(0, 3).join("; ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error refreshing context: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "list-repositories",
  "List all locally indexed repositories.",
  {},
  async () => {
    try {
      const contexts = listContexts();

      if (contexts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No contexts indexed yet.\nUse index-repository to index a local folder.",
            },
          ],
        };
      }

      const formatted = contexts.map((ctx) => {
        const status = `${ctx.file_count} files, ${ctx.entity_count} entities`;
        const lastIndexed = ctx.last_indexed_at
          ? `last indexed ${new Date(ctx.last_indexed_at).toLocaleDateString()}`
          : "never indexed";
        return `- ${ctx.name} (${ctx.language ?? "Unknown"})\n  Path: ${ctx.path}\n  ${status} — ${lastIndexed}`;
      }).join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `${contexts.length} context ${contexts.length === 1 ? "indexed" : "indexed"}:\n\n${formatted}`,
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

server.tool(
  "get-relevant-context",
  "Get relevant code context for a file or entity. Returns related files, imports, and dependent code based on the knowledge graph.",
  {
    repositoryPath: z.string().describe("Path to the repository"),
    filePath: z.string().optional().describe("Path to the file to get context for"),
    entityName: z.string().optional().describe("Name of a specific entity (function, class) to find context for"),
    query: z.string().optional().describe("Text search query across the codebase"),
    maxResults: z.number().optional().default(15).describe("Maximum number of results to return"),
    maxDistance: z.number().optional().default(3).describe("Maximum graph traversal depth"),
  },
  async ({ repositoryPath, filePath, entityName, query, maxResults = 15, maxDistance = 3 }) => {
    try {
      const ctx = getContextByPath(repositoryPath);
      if (!ctx) {
        return {
          content: [
            {
              type: "text",
              text: `Context not indexed at ${repositoryPath}.\nRun index-repository first.`,
            },
          ],
        };
      }

      // If filePath provided, get file ID
      let fileId: string | undefined;
      if (filePath) {
        // Search for the file
        const files = searchContextItems(filePath.split("/").pop() ?? filePath, ctx.id);
        const matched = files.find((f) => f.path.endsWith(filePath) || f.path === filePath);
        if (matched) {
          fileId = matched.id;
        }
      }

      // If entityName provided, find it
      let entityId: string | undefined;
      if (entityName) {
        const entities = searchCodeEntities(entityName, ctx.id);
        const matched = entities.find((e) => e.name === entityName);
        if (matched) {
          entityId = matched.id;
        }
      }

      // Get relevant context
      const results = getRelevantContext(
        {
          itemId: fileId,
          entityId,
          query: query ?? (entityName ?? filePath),
        },
        { maxResults, maxDistance }
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No relevant context found${entityName ? ` for "${entityName}"` : ""}${filePath ? ` in ${filePath}` : ""}.`,
            },
          ],
        };
      }

      const lines: string[] = [
        `# Relevant Context${entityName ? ` for ${entityName}` : ""}${filePath ? ` in ${filePath}` : ""}`,
        `Found ${results.length} relevant ${results.length === 1 ? "item" : "items"}:\n`,
      ];

      for (const result of results) {
        const score = Math.round(result.score * 100);
        if (result.item) {
          const ext = result.item.extension;
          lines.push(`## ${result.item.name} ${score}% related`);
          lines.push(`Path: ${result.item.path}`);
          lines.push(`Type: ${ext} file`);
          lines.push(`Lines: ${result.item.line_count}`);
          // Include a snippet of content
          const preview = (result.item.content ?? "").slice(0, 300).replace(/\n/g, " ");
          lines.push(`Preview: ${preview}...`);
        } else if (result.entity) {
          lines.push(`## ${result.entity.name} (${result.entity.type}) ${score}% related`);
          lines.push(`File: ${result.entity.item_id}`);
          if (result.entity.signature) {
            lines.push(`Signature: ${result.entity.signature}`);
          }
          lines.push(`Lines: ${result.entity.start_line}-${result.entity.end_line}`);
        }
        lines.push(`Reason: ${result.reason}\n`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error getting context: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "resolve-file-relations",
  "Get all files and entities that a given file relates to (imports, dependencies, dependents).",
  {
    repositoryPath: z.string().describe("Path to the repository"),
    filePath: z.string().describe("Path to the file to analyze"),
    depth: z.number().optional().default(2).describe("Traversal depth for related files"),
    limit: z.number().optional().default(DEFAULT_LIST_LIMIT).describe("Maximum entities, relationships per type, and related files to include"),
    json: z.boolean().optional().default(false).describe("Return raw JSON"),
  },
  async ({ repositoryPath, filePath, depth = 2, limit = DEFAULT_LIST_LIMIT, json = false }) => {
    try {
      const ctx = getContextByPath(repositoryPath);
      if (!ctx) {
        return {
          content: [
            {
              type: "text",
              text: `Context not indexed at ${repositoryPath}.\nRun index-repository first.`,
            },
          ],
        };
      }

      // Find the file
      const files = searchContextItems(filePath.split("/").pop() ?? filePath, ctx.id);
      const matched = files.find((f) => f.path.endsWith(filePath) || f.path === filePath);
      if (!matched) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
        };
      }

      const file = matched;
      const entities = getCodeEntitiesByItem(file.id);
      const relations = getRelationsByItem(file.id);
      const relatedFiles = getRelatedItems(file.id, depth);

      if (json) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ file, entities, relations, relatedFiles }, null, 2),
          }],
        };
      }

      let output = `# Relations for ${file.name}\n`;
      output += `Path: ${file.path}\n`;
      output += `Entities: ${entities.length}\n\n`;

      if (entities.length > 0) {
        output += `## Code Entities\n`;
        const { visible, remaining } = takeWithMore(entities, limit);
        for (const entity of visible) {
          output += `- ${entity.type} ${entity.name} (lines ${entity.start_line}-${entity.end_line})\n`;
        }
        if (remaining > 0) output += `- ...${remaining} more entities. Increase limit or use json=true for raw records.\n`;
        output += "\n";
      }

      if (relations.length > 0) {
        output += `## Relationships (${relations.length})\n`;
        // Group by relation type
        const byType = new Map<string, typeof relations>();
        for (const rel of relations) {
          const existing = byType.get(rel.relation_type) ?? [];
          existing.push(rel);
          byType.set(rel.relation_type, existing);
        }

        for (const [type, rels] of byType) {
          output += `### ${type} (${rels.length})\n`;
          const { visible, remaining } = takeWithMore(rels, limit);
          for (const rel of visible) {
            output += `- ${rel.relation_text ?? type}\n`;
          }
          if (remaining > 0) output += `- ...${remaining} more. Increase limit or use json=true for raw records.\n`;
        }
      }

      if (relatedFiles.length > 0) {
        output += `\n## Related Files (${relatedFiles.length})\n`;
        const { visible, remaining } = takeWithMore(relatedFiles, limit);
        for (const { item: relatedFile, distance, relation } of visible) {
          output += `- ${relatedFile.name} (distance: ${distance}, via: ${relation.relation_type})\n`;
        }
        if (remaining > 0) output += `- ...${remaining} more related files. Increase limit or use json=true for raw records.\n`;
      }
      output += "\nIncrease limit for more rows or set json=true for the full relation graph.";

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error resolving relations: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "search-codebase",
  "Search the indexed codebase for files or entities matching a query.",
  {
    repositoryPath: z.string().optional().describe("Path to the repository (optional, searches all if not provided)"),
    query: z.string().describe("Search query"),
    type: z.enum(["all", "files", "entities"]).optional().default("all").describe("What to search"),
    limit: z.number().optional().default(DEFAULT_LIST_LIMIT).describe("Maximum files/entities per result group"),
  },
  async ({ repositoryPath, query, type = "all", limit = DEFAULT_LIST_LIMIT }) => {
    try {
      let ctxId: string | undefined;
      if (repositoryPath) {
        const ctx = getContextByPath(repositoryPath);
        if (!ctx) {
          return {
            content: [{ type: "text", text: `Context not found at ${repositoryPath}` }],
            isError: true,
          };
        }
        ctxId = ctx.id;
      }

      const results: string[] = [];

      if (type === "all" || type === "files") {
        const files = searchContextItems(query, ctxId);
        if (files.length > 0) {
          results.push(`## Files matching "${query}" (${files.length})\n`);
          const { visible, remaining } = takeWithMore(files, limit);
          for (const file of visible) {
            results.push(`- ${file.path} (${file.line_count} lines)`);
          }
          if (remaining > 0) results.push(`...${remaining} more files. Increase limit for more rows.`);
        }
      }

      if (type === "all" || type === "entities") {
        const entities = searchCodeEntities(query, ctxId);
        if (entities.length > 0) {
          results.push(`\n## Entities matching "${query}" (${entities.length})\n`);
          const { visible, remaining } = takeWithMore(entities, limit);
          for (const entity of visible) {
            results.push(`- ${entity.type} ${entity.name} in ${entity.item_id}`);
          }
          if (remaining > 0) results.push(`...${remaining} more entities. Increase limit for more rows.`);
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}"` }],
        };
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error searching: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get-edit-context",
  "Get context suggestions when AI is about to edit a file. Returns related files, entities, and smart suggestions for what else might need to change.",
  {
    repositoryPath: z.string().describe("Path to the repository"),
    filePath: z.string().describe("Path to the file being edited"),
    maxRelated: z.number().optional().default(10).describe("Max number of related files to return"),
  },
  async ({ repositoryPath, filePath, maxRelated = 10 }) => {
    try {
      const { getEditContext } = await import("../hooks/index.js");
      const result = getEditContext(repositoryPath, filePath, { maxRelated });

      if (!result.item) {
        return {
          content: [
            {
              type: "text",
              text: `File not found in repository: ${filePath}\nIndex the repository first with index-repository.`,
            },
          ],
        };
      }

      let output = `# Edit Context for ${result.item.name}\n\n`;

      output += `## Current File\n`;
      output += `Path: ${result.item.path}\n`;
      output += `Lines: ${result.item.line_count}\n`;
      output += `Entities: ${result.entities.length}\n\n`;

      if (result.entities.length > 0) {
        output += `### Entities in this file\n`;
        for (const entity of result.entities.slice(0, 20)) {
          output += `- ${entity.type} ${entity.name} (lines ${entity.start_line}-${entity.end_line})\n`;
        }
        if (result.entities.length > 20) {
          output += `- ... and ${result.entities.length - 20} more\n`;
        }
        output += "\n";
      }

      if (result.relatedItems.length > 0) {
        output += `## Related Files (${result.relatedItems.length})\n`;
        output += `These files may need attention when editing ${result.item.name}:\n\n`;
        for (const { item, distance, via } of result.relatedItems.slice(0, maxRelated)) {
          output += `### ${item.name} ${distance > 1 ? `(distance: ${distance})` : ""}\n`;
          output += `- Path: ${item.path}\n`;
          output += `- Related via: ${via}\n`;
        }
        output += "\n";
      }

      if (result.suggestions.length > 0) {
        output += `## Smart Suggestions\n`;
        for (const suggestion of result.suggestions) {
          output += `- ${suggestion}\n`;
        }
      }

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting edit context: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "watch-repository-hooks",
  "Start watching a repository with hooks for automatic knowledge graph updates.",
  {
    repositoryPath: z.string().describe("Path to the repository to watch"),
    enableAutoUpdate: z.boolean().optional().default(true).describe("Enable automatic graph updates on file changes"),
  },
  async ({ repositoryPath, enableAutoUpdate = true }) => {
    try {
      const { watchContextWithHooks, createGraphUpdateHook } = await import("../hooks/index.js");

      const ctx = getContextByPath(repositoryPath);
      if (!ctx) {
        return {
          content: [
            {
              type: "text",
              text: `Context not indexed at ${repositoryPath}.\nRun index-repository first.`,
            },
          ],
        };
      }

      const hooks = enableAutoUpdate ? [createGraphUpdateHook(repositoryPath)] : [];
      watchContextWithHooks(repositoryPath, hooks);

      return {
        content: [
          {
            type: "text",
            text: `Watching ${repositoryPath} with ${hooks.length} hook(s) enabled.\nKnowledge graph will auto-update on file changes.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error watching repository: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

registerCloudTools(server, "context");
return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (isStdioMode(args)) {
    const transport = new StdioServerTransport();
    await buildServer().connect(transport);
    return;
  }

  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  startMcpHttpServer({ name: "context", port: resolveMcpHttpPort(args), buildServer });
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("mcp/index.ts") ||
  process.argv[1]?.endsWith("mcp/index.js");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
