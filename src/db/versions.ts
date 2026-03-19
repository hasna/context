import { randomUUID, createHash } from "crypto";
import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";

export interface DocumentVersion {
  id: string;
  document_id: string;
  url: string;
  title: string | null;
  content: string;
  content_hash: string;
  version_number: number;
  crawled_at: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function saveDocumentVersion(
  input: {
    document_id: string;
    url: string;
    title?: string | null;
    content: string;
  },
  db?: Database
): DocumentVersion | null {
  const database = db ?? getDatabase();
  const hash = hashContent(input.content);

  // Check if this exact content already exists
  const existing = database
    .query<{ content_hash: string; version_number: number }, [string]>(
      "SELECT content_hash, version_number FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1"
    )
    .get(input.document_id);

  if (existing && existing.content_hash === hash) {
    return null; // No change
  }

  const versionNumber = existing ? existing.version_number + 1 : 1;
  const id = randomUUID();
  const now = new Date().toISOString();

  database.run(
    `INSERT INTO document_versions (id, document_id, url, title, content, content_hash, version_number, crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.document_id,
      input.url,
      input.title ?? null,
      input.content,
      hash,
      versionNumber,
      now,
    ]
  );

  return {
    id,
    document_id: input.document_id,
    url: input.url,
    title: input.title ?? null,
    content: input.content,
    content_hash: hash,
    version_number: versionNumber,
    crawled_at: now,
  };
}

export function getDocumentVersions(
  documentId: string,
  db?: Database
): DocumentVersion[] {
  const database = db ?? getDatabase();
  return database
    .query<DocumentVersion, [string]>(
      "SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC"
    )
    .all(documentId);
}

export function getDocumentVersionCount(
  documentId: string,
  db?: Database
): number {
  const database = db ?? getDatabase();
  return (
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?"
      )
      .get(documentId)?.count ?? 0
  );
}

export function getLatestVersion(
  documentId: string,
  db?: Database
): DocumentVersion | null {
  const database = db ?? getDatabase();
  return (
    database
      .query<DocumentVersion, [string]>(
        "SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1"
      )
      .get(documentId) ?? null
  );
}

export function pruneOldVersions(
  documentId: string,
  keepCount = 5,
  db?: Database
): void {
  const database = db ?? getDatabase();
  database.run(
    `DELETE FROM document_versions
     WHERE document_id = ? AND id NOT IN (
       SELECT id FROM document_versions WHERE document_id = ?
       ORDER BY version_number DESC LIMIT ?
     )`,
    [documentId, documentId, keepCount]
  );
}
