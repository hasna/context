import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStorageStatus, storagePull, storagePush, storageSync } from "../db/storage-sync.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(error: unknown) {
  return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}

export function registerContextStorageTools(server: McpServer): void {
  server.registerTool(
    "storage_status",
    {
      description: "Show context remote storage configuration and local sync history.",
      inputSchema: z.object({}),
    },
    async () => json(getStorageStatus()),
  );

  server.registerTool(
    "storage_push",
    {
      description: "Push local context data to remote PostgreSQL storage.",
      inputSchema: z.object({ tables: z.array(z.string()).optional() }),
    },
    async (args) => {
      try {
        return json(await storagePush({ tables: args.tables }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "storage_pull",
    {
      description: "Pull context data from remote PostgreSQL storage to local SQLite.",
      inputSchema: z.object({ tables: z.array(z.string()).optional() }),
    },
    async (args) => {
      try {
        return json(await storagePull({ tables: args.tables }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "storage_sync",
    {
      description: "Bidirectional context sync: pull then push.",
      inputSchema: z.object({ tables: z.array(z.string()).optional() }),
    },
    async (args) => {
      try {
        return json(await storageSync({ tables: args.tables }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
