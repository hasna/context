import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetDatabase } from "../db/database.js";
import { createLibrary, getLibraryById } from "../db/libraries.js";
import { listDocUpdateTasks } from "../db/update-tasks.js";
import { runLiveUpdateCycle } from "./index.js";

let server: Server | null = null;
let oldHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "context-live-cycle-"));
  process.env["HOME"] = tempHome;
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  delete process.env["EXA_API_KEY"];
  delete process.env["FIRECRAWL_API_KEY"];
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  resetDatabase();
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  delete process.env["CONTEXT_DB_PATH"];
  rmSync(tempHome, { recursive: true, force: true });
});

describe("runLiveUpdateCycle", () => {
  it("returns planned actions in plan-only mode", async () => {
    createLibrary({
      name: "React",
      docs_url: "https://react.dev/reference/react",
    });

    const cycle = await runLiveUpdateCycle({ planOnly: true });

    expect(cycle.plan_count).toBe(1);
    expect(cycle.planned_count).toBe(1);
    expect(cycle.skipped_count).toBe(0);
    expect(cycle.actions[0]?.status).toBe("planned");
  });

  it("skips non-native sources in native-only mode", async () => {
    createLibrary({
      name: "Manual Docs",
      source_type: "manual",
      source_url: "docs/manual.md",
    });

    const cycle = await runLiveUpdateCycle({ nativeOnly: true });

    expect(cycle.plan_count).toBe(1);
    expect(cycle.skipped_count).toBe(1);
    expect(cycle.actions[0]?.status).toBe("skipped");
    expect(cycle.actions[0]?.skip_reason).toContain("native-only mode");
  });

  it("refreshes native website sources without crawler keys", async () => {
    const baseUrl = serveText({
      "/docs": `
        <html><head><title>Live Docs</title></head>
        <body><main>
          <h1>Live Docs</h1>
          <p>Live update documentation explains refresh loops, source readiness, native source ingestion, task planning, and artifact writing for production documentation systems.</p>
        </main></body></html>
      `,
    });
    const library = createLibrary({
      name: "Live Docs",
      docs_url: `${baseUrl}/docs`,
    });

    const cycle = await runLiveUpdateCycle({ nativeOnly: true, maxPages: 1 });

    expect(cycle.plan_count).toBe(1);
    expect(cycle.refreshed_count).toBe(1);
    expect(cycle.actions[0]?.status).toBe("refreshed");
    expect(cycle.actions[0]?.result?.ingest_mode).toBe("native");
    expect(cycle.actions[0]?.result?.retriever).toBe("native:docs");

    const updated = getLibraryById(library.id);
    expect(updated.document_count).toBe(1);
    expect(updated.chunk_count).toBeGreaterThan(0);
  });

  it("fails a slow source when the per-source timeout is reached", async () => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(`
          <main>
            <h1>Slow Live Docs</h1>
            <p>Slow live update documentation should be cancelled by the per-source refresh timeout.</p>
          </main>
        `, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
    createLibrary({
      name: "Slow Live Docs",
      docs_url: `${server.url.origin}/docs`,
    });

    const cycle = await runLiveUpdateCycle({ maxPages: 1, refreshTimeoutMs: 10, createTasks: true });

    expect(cycle.plan_count).toBe(1);
    expect(cycle.failed_count).toBe(1);
    expect(cycle.actions[0]?.status).toBe("failed");
    expect(cycle.actions[0]?.error).toContain("Live refresh timed out after 10ms");

    const tasks = listDocUpdateTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[0]?.error).toContain("Live refresh timed out after 10ms");
    expect(tasks[0]?.started_at).not.toBeNull();
    expect(tasks[0]?.finished_at).not.toBeNull();
  });

  it("attempts source discovery for bare docs sources when Exa is configured", async () => {
    process.env["EXA_API_KEY"] = "test-exa-key";
    createLibrary({
      name: "Bare Live Discovery",
    });

    const cycle = await runLiveUpdateCycle({
      maxPages: 1,
      retrievers: {
        discoverUrls: async () => [
          {
            url: "https://docs.example.com/live",
            title: "Live Discovery Docs",
            score: 10,
            query: "Bare Live Discovery documentation",
            source: "exa",
          },
        ],
        firecrawl: async (options) => [
          {
            url: `${options.docs_url}/getting-started`,
            title: "Live Discovery",
            text: "# Live Discovery\n\nlive-discovery-token proves live update cycles can resolve bare docs sources before Firecrawl refreshes and indexes searchable source artifacts.",
          },
        ],
      },
    });

    expect(cycle.plan_count).toBe(1);
    expect(cycle.refreshed_count).toBe(1);
    expect(cycle.actions[0]?.status).toBe("refreshed");
    expect(cycle.actions[0]?.result?.source_discovery?.status).toBe("found");
    expect(cycle.actions[0]?.result?.pages_ingested).toBe(1);
  });
});

function serveText(routes: Record<string, string>): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const body = routes[url.pathname];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  return server.url.origin;
}
