import { randomUUID } from "crypto";
import type { SqliteAdapter } from "@hasna/cloud";
import { getDatabase } from "./database.js";

export type LinkType =
  | "docs"
  | "npm"
  | "github"
  | "changelog"
  | "examples"
  | "api"
  | "tutorial"
  | "playground"
  | "other";

export interface LibraryLink {
  id: string;
  library_id: string;
  url: string;
  type: LinkType;
  label: string | null;
  created_at: string;
}

export function addLink(
  input: {
    library_id: string;
    url: string;
    type: LinkType;
    label?: string;
  },
  db?: SqliteAdapter
): LibraryLink {
  const database = db ?? getDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();

  database.run(
    `INSERT OR IGNORE INTO library_links (id, library_id, url, type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.library_id, input.url, input.type, input.label ?? null, now]
  );

  return (
    database.get(
      "SELECT * FROM library_links WHERE library_id = ? AND url = ?",
      input.library_id,
      input.url
    ) as LibraryLink | null ?? {
      id,
      library_id: input.library_id,
      url: input.url,
      type: input.type,
      label: input.label ?? null,
      created_at: now,
    }
  );
}

export function getLinks(libraryId: string, db?: SqliteAdapter): LibraryLink[] {
  const database = db ?? getDatabase();
  return database.all(
    "SELECT * FROM library_links WHERE library_id = ? ORDER BY type ASC",
    libraryId
  ) as LibraryLink[];
}

export function deleteLink(id: string, db?: SqliteAdapter): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM library_links WHERE id = ?", [id]);
}

export function syncLinks(
  libraryId: string,
  links: Array<{ type: LinkType; url: string; label?: string }>,
  db?: SqliteAdapter
): void {
  const database = db ?? getDatabase();
  for (const link of links) {
    addLink({ library_id: libraryId, ...link }, database);
  }
}
