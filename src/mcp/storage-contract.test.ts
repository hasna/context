import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("context storage MCP contract", () => {
  it("registers storage tools", () => {
    const toolsSource = readFileSync(join(import.meta.dir, "storage-tools.ts"), "utf8");
    const indexSource = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

    expect(indexSource).toContain("registerContextStorageTools");
    expect(toolsSource).toContain('"storage_status"');
    expect(toolsSource).toContain('"storage_push"');
    expect(toolsSource).toContain('"storage_pull"');
    expect(toolsSource).toContain('"storage_sync"');
    expect(toolsSource).not.toContain('"cloud_status"');
    expect(toolsSource).not.toContain('"cloud_push"');
    expect(toolsSource).not.toContain('"cloud_pull"');
    expect(toolsSource).not.toContain('"cloud_sync"');
  });
});
