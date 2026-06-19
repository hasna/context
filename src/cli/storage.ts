import type { Command } from "commander";
import {
  getStorageStatus,
  storagePull,
  storagePush,
  storageSync,
  type StorageSyncResult,
} from "../db/storage-sync.js";

function parseTables(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((table) => table.trim()).filter(Boolean);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printResults(results: StorageSyncResult[], label: string): void {
  const total = results.reduce((sum, result) => sum + result.rowsWritten, 0);
  for (const result of results) {
    const errors = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
    console.log(`  ${result.table}: ${result.rowsWritten}/${result.rowsRead} rows ${label}${errors}`);
  }
  console.log(`Done. ${total} rows ${label}.`);
}

function buildStatus() {
  return getStorageStatus();
}

function installStorageSubcommands(storageCmd: Command): void {
  storageCmd.command("status").description("Show remote storage config and local sync state").option("--json", "Output as JSON").action((opts: { json?: boolean }) => {
    const info = buildStatus();
    if (opts.json) { printJson(info); return; }
    console.log(`Storage mode: ${info.mode}`);
    console.log(`Remote storage configured: ${info.configured ? "yes" : "no"}`);
    console.log(`Tables: ${info.tables.join(", ")}`);
    if (info.sync.length === 0) console.log("Sync: no local sync history");
    for (const entry of info.sync) console.log(`  ${entry.table_name} ${entry.direction}: ${entry.last_synced_at ?? "never"}`);
  });

  storageCmd.command("push").description("Push local context data to remote PostgreSQL storage").option("--tables <tables>", "Comma-separated table names").option("--json", "Output as JSON").action(async (opts: { tables?: string; json?: boolean }) => {
    try {
      const results = await storagePush({ tables: parseTables(opts.tables) });
      if (opts.json) { printJson(results); return; }
      printResults(results, "pushed");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

  storageCmd.command("pull").description("Pull context data from remote PostgreSQL storage to local SQLite").option("--tables <tables>", "Comma-separated table names").option("--json", "Output as JSON").action(async (opts: { tables?: string; json?: boolean }) => {
    try {
      const results = await storagePull({ tables: parseTables(opts.tables) });
      if (opts.json) { printJson(results); return; }
      printResults(results, "pulled");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

  storageCmd.command("sync").description("Bidirectional sync: pull then push").option("--tables <tables>", "Comma-separated table names").option("--json", "Output as JSON").action(async (opts: { tables?: string; json?: boolean }) => {
    try {
      const result = await storageSync({ tables: parseTables(opts.tables) });
      if (opts.json) { printJson(result); return; }
      printResults(result.pull, "pulled");
      printResults(result.push, "pushed");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
}

export function registerStorageCommands(program: Command): void {
  installStorageSubcommands(program.command("storage").description("Manage context local/remote storage sync"));
}
