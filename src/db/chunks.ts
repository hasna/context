import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
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

  // Index in FTS
  database.run(
    "INSERT INTO chunks_fts (content, library_id, chunk_id) VALUES (?, ?, ?)",
    [input.content, input.library_id, id]
  );

  return rowToChunk(
    database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM chunks WHERE id = ?"
      )
      .get(id)!
  );
}

export function deleteChunksForDocument(
  documentId: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  // Get chunk IDs first for FTS cleanup
  const chunkIds = database
    .query<{ id: string }, [string]>(
      "SELECT id FROM chunks WHERE document_id = ?"
    )
    .all(documentId)
    .map((r) => r.id);

  database.run("DELETE FROM chunks WHERE document_id = ?", [documentId]);

  for (const chunkId of chunkIds) {
    database.run("DELETE FROM chunks_fts WHERE chunk_id = ?", [chunkId]);
  }
}

export function deleteChunksForLibrary(
  libraryId: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  const chunkIds = database
    .query<{ id: string }, [string]>(
      "SELECT id FROM chunks WHERE library_id = ?"
    )
    .all(libraryId)
    .map((r) => r.id);

  database.run("DELETE FROM chunks WHERE library_id = ?", [libraryId]);

  for (const chunkId of chunkIds) {
    database.run("DELETE FROM chunks_fts WHERE chunk_id = ?", [chunkId]);
  }
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
        rank AS score
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ? AND f.library_id = ?
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
        rank AS score
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    params = [escaped, limit];
  }

  return database
    .query<
      {
        chunk_id: string;
        library_id: string;
        document_id: string;
        content: string;
        url: string | null;
        title: string | null;
        score: number;
      },
      (string | number)[]
    >(sql)
    .all(...params)
    .map((r) => ({
      chunk_id: r.chunk_id,
      library_id: r.library_id,
      document_id: r.document_id,
      content: r.content,
      url: r.url,
      title: r.title,
      score: r.score,
    }));
}

export function countChunks(libraryId: string, db?: Database): number {
  const database = db ?? getDatabase();
  const row = database
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM chunks WHERE library_id = ?"
    )
    .get(libraryId);
  return row?.count ?? 0;
}

function escapeFts(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}*"`)
    .join(" ");
}
