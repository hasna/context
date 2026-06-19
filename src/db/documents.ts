import { randomUUID } from "crypto";
import type { Database } from "./database.js";
import { getDatabase } from "./database.js";
import type { Document, LibrarySourceType } from "../types/index.js";
import { coerceSourceType, normalizeSourceType } from "../sources/index.js";

function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: row["id"] as string,
    library_id: row["library_id"] as string,
    url: row["url"] as string,
    title: (row["title"] as string) ?? null,
    content: (row["content"] as string) ?? null,
    content_hash: (row["content_hash"] as string) ?? null,
    file_path: (row["file_path"] as string) ?? null,
    source_type: coerceSourceType((row["source_type"] as string) ?? "docs"),
    status: (row["status"] as string) ?? "active",
    metadata: parseMetadata(row["metadata"]),
    parsed_at: (row["parsed_at"] as string) ?? null,
    discovered_at: (row["discovered_at"] as string) ?? null,
    created_at: row["created_at"] as string,
    updated_at: (row["updated_at"] as string) ?? null,
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function upsertDocument(
  input: {
    library_id: string;
    url: string;
    title?: string;
    content?: string;
    content_hash?: string;
    file_path?: string;
    source_type?: LibrarySourceType | string;
    status?: string;
    metadata?: Record<string, unknown>;
  },
  db?: Database
): Document {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();
  const metadata = JSON.stringify(input.metadata ?? {});

  const existing = database.get(
    "SELECT * FROM documents WHERE library_id = ? AND url = ?",
    input.library_id,
    input.url
  ) as Record<string, unknown> | null;

  if (existing) {
    database.run(
      `UPDATE documents SET
         title = ?,
         content = ?,
         content_hash = ?,
         file_path = ?,
         source_type = ?,
         status = ?,
         metadata = ?,
         parsed_at = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? (existing["title"] as string) ?? null,
        input.content ?? (existing["content"] as string) ?? null,
        input.content_hash ?? (existing["content_hash"] as string) ?? null,
        input.file_path ?? (existing["file_path"] as string) ?? null,
        normalizeSourceType(input.source_type ?? (existing["source_type"] as string) ?? "docs"),
        input.status ?? (existing["status"] as string) ?? "active",
        input.metadata ? metadata : (existing["metadata"] as string) ?? "{}",
        now,
        now,
        existing["id"] as string,
      ]
    );
    return getDocumentById(existing["id"] as string, database);
  }

  const id = randomUUID();
  database.run(
    `INSERT INTO documents (
       id, library_id, url, title, content, content_hash, file_path,
       source_type, status, metadata, parsed_at, discovered_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.library_id,
      input.url,
      input.title ?? null,
      input.content ?? null,
      input.content_hash ?? null,
      input.file_path ?? null,
      normalizeSourceType(input.source_type ?? "docs"),
      input.status ?? "active",
      metadata,
      now,
      now,
      now,
      now,
    ]
  );

  return getDocumentById(id, database);
}

export function getDocumentById(id: string, db?: Database): Document {
  const database = db ?? getDatabase();
  const row = database.get(
    "SELECT * FROM documents WHERE id = ?",
    id
  ) as Record<string, unknown> | null;
  if (!row) throw new Error(`Document not found: ${id}`);
  return rowToDocument(row);
}

export function listDocuments(libraryId: string, db?: Database): Document[] {
  const database = db ?? getDatabase();
  return (database.all(
    "SELECT * FROM documents WHERE library_id = ? ORDER BY created_at ASC",
    libraryId
  ) as Record<string, unknown>[]).map(rowToDocument);
}

export function deleteDocumentsForLibrary(
  libraryId: string,
  db?: Database
): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM documents WHERE library_id = ?", [libraryId]);
}
