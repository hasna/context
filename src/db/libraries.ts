import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";
import type { Library, CreateLibraryInput } from "../types/index.js";
import { LibraryNotFoundError } from "../types/index.js";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function rowToLibrary(row: Record<string, unknown>): Library {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    slug: row["slug"] as string,
    description: (row["description"] as string) ?? null,
    npm_package: (row["npm_package"] as string) ?? null,
    github_repo: (row["github_repo"] as string) ?? null,
    docs_url: (row["docs_url"] as string) ?? null,
    version: (row["version"] as string) ?? null,
    chunk_count: (row["chunk_count"] as number) ?? 0,
    document_count: (row["document_count"] as number) ?? 0,
    last_crawled_at: (row["last_crawled_at"] as string) ?? null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export function createLibrary(
  input: CreateLibraryInput,
  db?: Database
): Library {
  const database = db ?? getDatabase();
  const id = randomUUID();
  const slug = input.slug ?? toSlug(input.name);
  const now = new Date().toISOString();

  database.run(
    `INSERT INTO libraries (id, name, slug, description, npm_package, github_repo, docs_url, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      slug,
      input.description ?? null,
      input.npm_package ?? null,
      input.github_repo ?? null,
      input.docs_url ?? null,
      input.version ?? null,
      now,
      now,
    ]
  );
  // FTS is maintained by trigger

  return getLibraryById(id, database);
}

export function getLibraryById(id: string, db?: Database): Library {
  const database = db ?? getDatabase();
  const row = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM libraries WHERE id = ?"
    )
    .get(id);
  if (!row) throw new LibraryNotFoundError(id);
  return rowToLibrary(row);
}

export function getLibraryBySlug(slug: string, db?: Database): Library {
  const database = db ?? getDatabase();
  const row = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM libraries WHERE slug = ?"
    )
    .get(slug);
  if (!row) throw new LibraryNotFoundError(slug);
  return rowToLibrary(row);
}

export function listLibraries(db?: Database): Library[] {
  const database = db ?? getDatabase();
  return database
    .query<Record<string, unknown>, []>(
      "SELECT * FROM libraries ORDER BY name ASC"
    )
    .all()
    .map(rowToLibrary);
}

export function searchLibraries(
  query: string,
  limit = 10,
  db?: Database
): Library[] {
  const database = db ?? getDatabase();
  const escaped = escapeFts(query);

  let rows: Record<string, unknown>[] = [];
  try {
    rows = database
      .query<Record<string, unknown>, [string, number]>(
        `SELECT l.* FROM libraries l
         JOIN libraries_fts_map m ON l.id = m.library_id
         JOIN libraries_fts f ON f.rowid = m.rowid
         WHERE libraries_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(escaped, limit);
  } catch {
    // FTS error fallback
  }

  if (rows.length === 0) {
    // Fallback: LIKE search
    return database
      .query<Record<string, unknown>, [string, string, string, number]>(
        `SELECT * FROM libraries
         WHERE name LIKE ? OR slug LIKE ? OR npm_package LIKE ?
         ORDER BY name ASC LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
      .map(rowToLibrary);
  }

  return rows.map(rowToLibrary);
}

export function updateLibraryCounts(id: string, db?: Database): void {
  const database = db ?? getDatabase();
  database.run(
    `UPDATE libraries SET
       chunk_count = (SELECT COUNT(*) FROM chunks WHERE library_id = ?),
       document_count = (SELECT COUNT(*) FROM documents WHERE library_id = ?),
       last_crawled_at = ?,
       updated_at = ?
     WHERE id = ?`,
    [id, id, new Date().toISOString(), new Date().toISOString(), id]
  );
}

export function updateLibraryVersion(
  id: string,
  version: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  database.run(
    "UPDATE libraries SET version = ?, updated_at = ? WHERE id = ?",
    [version, new Date().toISOString(), id]
  );
}

export function deleteLibrary(id: string, db?: Database): void {
  const database = db ?? getDatabase();
  // FK cascade deletes documents, chunks. Trigger handles FTS cleanup.
  database.run("DELETE FROM libraries WHERE id = ?", [id]);
}

function escapeFts(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}*"`)
    .join(" ");
}
