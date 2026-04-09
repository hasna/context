import { randomUUID } from "crypto";
import type { SqliteAdapter } from "@hasna/cloud";
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
  db?: SqliteAdapter
): Document {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();

  const existing = database.get(
    "SELECT * FROM documents WHERE library_id = ? AND url = ?",
    input.library_id,
    input.url
  ) as Record<string, unknown> | null;

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

export function getDocumentById(id: string, db?: SqliteAdapter): Document {
  const database = db ?? getDatabase();
  const row = database.get(
    "SELECT * FROM documents WHERE id = ?",
    id
  ) as Record<string, unknown> | null;
  if (!row) throw new Error(`Document not found: ${id}`);
  return rowToDocument(row);
}

export function listDocuments(libraryId: string, db?: SqliteAdapter): Document[] {
  const database = db ?? getDatabase();
  return (database.all(
    "SELECT * FROM documents WHERE library_id = ? ORDER BY created_at ASC",
    libraryId
  ) as Record<string, unknown>[]).map(rowToDocument);
}

export function deleteDocumentsForLibrary(
  libraryId: string,
  db?: SqliteAdapter
): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM documents WHERE library_id = ?", [libraryId]);
}
