import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";
import type { Document } from "../types/index.js";

function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: row["id"] as string,
    library_id: row["library_id"] as string,
    url: row["url"] as string,
    title: (row["title"] as string) ?? null,
    content: (row["content"] as string) ?? null,
    parsed_at: (row["parsed_at"] as string) ?? null,
    created_at: row["created_at"] as string,
  };
}

export function upsertDocument(
  input: {
    library_id: string;
    url: string;
    title?: string;
    content?: string;
  },
  db?: Database
): Document {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();

  const existing = database
    .query<Record<string, unknown>, [string, string]>(
      "SELECT * FROM documents WHERE library_id = ? AND url = ?"
    )
    .get(input.library_id, input.url);

  if (existing) {
    database.run(
      `UPDATE documents SET title = ?, content = ?, parsed_at = ? WHERE id = ?`,
      [
        input.title ?? (existing["title"] as string) ?? null,
        input.content ?? (existing["content"] as string) ?? null,
        now,
        existing["id"] as string,
      ]
    );
    return getDocumentById(existing["id"] as string, database);
  }

  const id = randomUUID();
  database.run(
    `INSERT INTO documents (id, library_id, url, title, content, parsed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.library_id,
      input.url,
      input.title ?? null,
      input.content ?? null,
      now,
      now,
    ]
  );

  return getDocumentById(id, database);
}

export function getDocumentById(id: string, db?: Database): Document {
  const database = db ?? getDatabase();
  const row = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM documents WHERE id = ?"
    )
    .get(id);
  if (!row) throw new Error(`Document not found: ${id}`);
  return rowToDocument(row);
}

export function listDocuments(libraryId: string, db?: Database): Document[] {
  const database = db ?? getDatabase();
  return database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM documents WHERE library_id = ? ORDER BY created_at ASC"
    )
    .all(libraryId)
    .map(rowToDocument);
}

export function deleteDocumentsForLibrary(
  libraryId: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM documents WHERE library_id = ?", [libraryId]);
}
