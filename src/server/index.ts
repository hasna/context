#!/usr/bin/env node
import { getDatabase, getDbPath } from "../db/database.js";
import {
  createLibrary,
  listLibraries,
  searchLibraries,
  getLibraryBySlug,
  deleteLibrary,
} from "../db/libraries.js";
import { searchChunks } from "../db/chunks.js";
import { crawlLibrary } from "../crawler/index.js";

const DEFAULT_PORT = 19431;

function getPort(): number {
  const env = process.env["CONTEXT_PORT"] ?? process.env["PORT"];
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n)) return n;
  }
  return DEFAULT_PORT;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    // GET /api/health
    if (method === "GET" && path === "/api/health") {
      return json({ status: "ok", db: getDbPath() });
    }

    // GET /api/libraries
    if (method === "GET" && path === "/api/libraries") {
      const q = url.searchParams.get("q");
      const libraries = q ? searchLibraries(q) : listLibraries();
      return json({ libraries });
    }

    // POST /api/libraries
    if (method === "POST" && path === "/api/libraries") {
      const body = (await req.json()) as {
        name: string;
        npm_package?: string;
        docs_url?: string;
        github_repo?: string;
        description?: string;
      };
      const library = createLibrary(body);
      return json({ library }, 201);
    }

    // GET /api/libraries/:slug
    const libSlugMatch = path.match(/^\/api\/libraries\/([^/]+)$/);
    if (method === "GET" && libSlugMatch) {
      const slug = libSlugMatch[1]!;
      const library = getLibraryBySlug(slug);
      return json({ library });
    }

    // DELETE /api/libraries/:slug
    if (method === "DELETE" && libSlugMatch) {
      const slug = libSlugMatch[1]!;
      const library = getLibraryBySlug(slug);
      deleteLibrary(library.id);
      return json({ deleted: true });
    }

    // POST /api/libraries/:slug/crawl
    const crawlMatch = path.match(/^\/api\/libraries\/([^/]+)\/crawl$/);
    if (method === "POST" && crawlMatch) {
      const slug = crawlMatch[1]!;
      const library = getLibraryBySlug(slug);
      const body = req.headers.get("content-type")?.includes("application/json")
        ? ((await req.json()) as { max_pages?: number; refresh?: boolean })
        : {};
      const result = await crawlLibrary(library.id, {
        maxPages: body.max_pages ?? 30,
        refresh: body.refresh ?? false,
      });
      return json({ result });
    }

    // GET /api/search?q=...&library=...
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const librarySlug = url.searchParams.get("library");
      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);

      let libraryId: string | undefined;
      if (librarySlug) {
        const lib = getLibraryBySlug(librarySlug);
        libraryId = lib.id;
      }

      const results = searchChunks(q, libraryId, limit);
      return json({ results, query: q });
    }

    // GET /api/stats
    if (method === "GET" && path === "/api/stats") {
      const db = getDatabase();
      const libCount = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM libraries"
        )
        .get()?.count ?? 0;
      const docCount = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM documents"
        )
        .get()?.count ?? 0;
      const chunkCount = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM chunks"
        )
        .get()?.count ?? 0;
      return json({ libraries: libCount, documents: docCount, chunks: chunkCount });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("not found") ? 404 : 500;
    return json({ error: message }, status);
  }
}

const port = getPort();

Bun.serve({
  port,
  fetch: handle,
});

console.log(`context server running on http://localhost:${port}`);
console.log(`db: ${getDbPath()}`);
