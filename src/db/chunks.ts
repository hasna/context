import { randomUUID } from "crypto";
import type { SqliteAdapter as Database } from "@hasna/cloud";
import { getDatabase } from "./database.js";
import type { Chunk, SearchResult } from "../types/index.js";

function rowToChunk(row: Record<string, unknown>): Chunk {
  return {
    id: row["id"] as string,
    library_id: row["library_id"] as string,
    document_id: row["document_id"] as string,
    content: row["content"] as string,
    position: row["position"] as number,
    token_count: (row["token_count"] as number) ?? null,
    created_at: row["created_at"] as string,
  };
}

export function insertChunk(
  input: {
    library_id: string;
    document_id: string;
    content: string;
    position: number;
    token_count?: number;
  },
  db?: Database
): Chunk {
  const database = db ?? getDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();

  database.run(
    `INSERT INTO chunks (id, library_id, document_id, content, position, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.library_id,
      input.document_id,
      input.content,
      input.position,
      input.token_count ?? null,
      now,
    ]
  );
  // FTS is maintained by trigger

  return rowToChunk(
    database.get("SELECT * FROM chunks WHERE id = ?", id) as Record<string, unknown>
  );
}

export function deleteChunksForDocument(
  documentId: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  // Trigger handles FTS cleanup on DELETE
  database.run("DELETE FROM chunks WHERE document_id = ?", [documentId]);
}

export function deleteChunksForLibrary(
  libraryId: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  // Trigger handles FTS cleanup on DELETE
  database.run("DELETE FROM chunks WHERE library_id = ?", [libraryId]);
}

export function searchChunks(
  query: string,
  libraryId?: string,
  limit = 10,
  db?: Database
): SearchResult[] {
  const database = db ?? getDatabase();
  const escaped = escapeFts(query);

  let sql: string;
  let params: (string | number)[];

  if (libraryId) {
    sql = `
      SELECT
        c.id AS chunk_id,
        c.library_id,
        c.document_id,
        c.content,
        d.url,
        d.title,
        f.rank AS score
      FROM chunks_fts f
      JOIN chunks_fts_map m ON m.rowid = f.rowid
      JOIN chunks c ON c.id = m.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ? AND c.library_id = ?
      ORDER BY rank
      LIMIT ?
    `;
    params = [escaped, libraryId, limit];
  } else {
    sql = `
      SELECT
        c.id AS chunk_id,
        c.library_id,
        c.document_id,
        c.content,
        d.url,
        d.title,
        f.rank AS score
      FROM chunks_fts f
      JOIN chunks_fts_map m ON m.rowid = f.rowid
      JOIN chunks c ON c.id = m.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    params = [escaped, limit];
  }

  try {
    return (database.all(sql, ...params) as {
      chunk_id: string;
      library_id: string;
      document_id: string;
      content: string;
      url: string | null;
      title: string | null;
      score: number;
    }[]).map((r) => ({
        chunk_id: r.chunk_id,
        library_id: r.library_id,
        document_id: r.document_id,
        content: r.content,
        url: r.url,
        title: r.title,
        score: r.score,
      }));
  } catch {
    return [];
  }
}

export function countChunks(libraryId: string, db?: Database): number {
  const database = db ?? getDatabase();
  const row = database.get(
    "SELECT COUNT(*) AS count FROM chunks WHERE library_id = ?",
    libraryId
  ) as { count: number } | null;
  return row?.count ?? 0;
}

function escapeFts(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}*"`)
    .join(" ");
}
