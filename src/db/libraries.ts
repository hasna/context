import { randomUUID } from "crypto";
import type { Database } from "./database.js";
import { getDatabase } from "./database.js";
import type { Library, CreateLibraryInput } from "../types/index.js";
import type { LibrarySourceType } from "../types/index.js";
import { LibraryNotFoundError } from "../types/index.js";
import { coerceSourceType, inferSourceMetadata } from "../sources/index.js";

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
    source_type: coerceSourceType((row["source_type"] as string) ?? "docs"),
    source_url: (row["source_url"] as string) ?? null,
    freshness_days: (row["freshness_days"] as number) ?? 7,
    priority: (row["priority"] as number) ?? 0,
    chunk_count: (row["chunk_count"] as number) ?? 0,
    document_count: (row["document_count"] as number) ?? 0,
    last_crawled_at: (row["last_crawled_at"] as string) ?? null,
    last_checked_at: (row["last_checked_at"] as string) ?? null,
    next_check_at: (row["next_check_at"] as string) ?? null,
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
  const source = inferSourceMetadata(input);

  database.run(
    `INSERT INTO libraries (
       id, name, slug, description, npm_package, github_repo, docs_url, version,
       source_type, source_url, freshness_days, priority, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      slug,
      input.description ?? null,
      input.npm_package ?? null,
      input.github_repo ?? null,
      source.docs_url,
      input.version ?? null,
      source.source_type,
      source.source_url,
      source.freshness_days,
      input.priority ?? 0,
      now,
      now,
    ]
  );
  // FTS is maintained by trigger

  return getLibraryById(id, database);
}

export function getLibraryById(id: string, db?: Database): Library {
  const database = db ?? getDatabase();
  const row = database.get("SELECT * FROM libraries WHERE id = ?", id) as Record<string, unknown> | null;
  if (!row) throw new LibraryNotFoundError(id);
  return rowToLibrary(row);
}

export function getLibraryBySlug(slug: string, db?: Database): Library {
  const database = db ?? getDatabase();
  const row = database.get("SELECT * FROM libraries WHERE slug = ?", slug) as Record<string, unknown> | null;
  if (!row) throw new LibraryNotFoundError(slug);
  return rowToLibrary(row);
}

export function resolveLibraryReference(
  reference: string,
  options: { version?: string | null } = {},
  db?: Database
): Library {
  const database = db ?? getDatabase();
  const parsed = parseLibraryReference(reference);
  const requestedVersion = normalizeVersion(options.version ?? parsed.version);
  const slug = parsed.slug;

  const exactRow = database.get("SELECT * FROM libraries WHERE slug = ?", slug) as Record<string, unknown> | null;
  if (exactRow) {
    const exact = rowToLibrary(exactRow);
    if (!requestedVersion || versionMatches(exact.version, requestedVersion)) return exact;
  }

  if (requestedVersion) {
    const candidates = listLibraries(database).filter((library) =>
      libraryMatchesReference(library, slug) && versionMatches(library.version, requestedVersion)
    );
    if (candidates.length > 0) return bestVersionCandidate(candidates, slug, requestedVersion);
  }

  if (exactRow) {
    throw new LibraryNotFoundError(`${reference} version ${requestedVersion}`);
  }

  throw new LibraryNotFoundError(reference);
}

export function listLibraries(db?: Database): Library[] {
  const database = db ?? getDatabase();
  const rows = database.all("SELECT * FROM libraries ORDER BY name ASC") as Record<string, unknown>[];
  return rows.map(rowToLibrary);
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
    rows = database.all(
      `SELECT l.* FROM libraries l
       JOIN libraries_fts_map m ON l.id = m.library_id
       JOIN libraries_fts f ON f.rowid = m.rowid
       WHERE libraries_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      escaped,
      limit
    ) as Record<string, unknown>[];
  } catch {
    // FTS error fallback
  }

  if (rows.length === 0) return fallbackSearchLibraries(query, limit, database);

  return rows.map(rowToLibrary);
}

export function updateLibraryCounts(id: string, db?: Database): void {
  const database = db ?? getDatabase();
  syncLibraryCounts(id, database);
  const row = database.get(
    "SELECT freshness_days FROM libraries WHERE id = ?",
    id
  ) as { freshness_days: number } | null;
  const now = new Date();
  const nowIso = now.toISOString();
  const freshnessDays = Math.max(1, row?.freshness_days ?? 7);
  const nextCheckAt = new Date(now.getTime() + freshnessDays * 24 * 60 * 60 * 1000).toISOString();

  database.run(
    `UPDATE libraries SET
       last_crawled_at = ?,
       last_checked_at = ?,
       next_check_at = ?,
       updated_at = ?
     WHERE id = ?`,
    [nowIso, nowIso, nextCheckAt, nowIso, id]
  );
}

export function syncLibraryCounts(id: string, db?: Database): void {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();
  database.run(
    `UPDATE libraries SET
       chunk_count = (SELECT COUNT(*) FROM chunks WHERE library_id = ?),
       document_count = (SELECT COUNT(*) FROM documents WHERE library_id = ?),
       updated_at = ?
     WHERE id = ?`,
    [id, id, now, id]
  );
}

export function updateLibrarySchedule(
  id: string,
  input: {
    last_checked_at?: string | null;
    next_check_at?: string | null;
    freshness_days?: number;
    priority?: number;
  },
  db?: Database
): Library {
  const database = db ?? getDatabase();
  const existing = getLibraryById(id, database);
  const now = new Date().toISOString();
  database.run(
    `UPDATE libraries SET
       last_checked_at = ?,
       next_check_at = ?,
       freshness_days = ?,
       priority = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      input.last_checked_at ?? existing.last_checked_at,
      input.next_check_at ?? existing.next_check_at,
      input.freshness_days ?? existing.freshness_days,
      input.priority ?? existing.priority,
      now,
      id,
    ]
  );
  return getLibraryById(id, database);
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

export function updateLibraryMetadata(
  id: string,
  input: Partial<CreateLibraryInput>,
  db?: Database
): Library {
  const database = db ?? getDatabase();
  const existing = getLibraryById(id, database);
  const nextInput: CreateLibraryInput = {
    name: input.name ?? existing.name,
    slug: input.slug ?? existing.slug,
    description: input.description ?? existing.description ?? undefined,
    npm_package: input.npm_package ?? existing.npm_package ?? undefined,
    github_repo: input.github_repo ?? existing.github_repo ?? undefined,
    docs_url: input.docs_url ?? existing.docs_url ?? undefined,
    version: input.version ?? existing.version ?? undefined,
    source_type: input.source_type ?? existing.source_type,
    source_url: input.source_url ?? (input.docs_url === undefined ? existing.source_url ?? undefined : undefined),
    freshness_days: input.freshness_days ?? existing.freshness_days,
    priority: input.priority ?? existing.priority,
  };
  const source = inferSourceMetadata(nextInput);
  const now = new Date().toISOString();

  database.run(
    `UPDATE libraries SET
       name = ?,
       description = ?,
       npm_package = ?,
       github_repo = ?,
       docs_url = ?,
       version = ?,
       source_type = ?,
       source_url = ?,
       freshness_days = ?,
       priority = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      nextInput.name,
      nextInput.description ?? null,
      nextInput.npm_package ?? null,
      nextInput.github_repo ?? null,
      source.docs_url,
      nextInput.version ?? null,
      source.source_type,
      source.source_url,
      source.freshness_days,
      nextInput.priority ?? 0,
      now,
      id,
    ]
  );

  return getLibraryById(id, database);
}

export function updateLibrarySource(
  id: string,
  input: {
    docs_url?: string | null;
    source_url?: string | null;
    source_type?: LibrarySourceType;
  },
  db?: Database
): Library {
  const database = db ?? getDatabase();
  const existing = getLibraryById(id, database);
  const sourceType = input.source_type ?? existing.source_type;
  const source = inferSourceMetadata({
    name: existing.name,
    npm_package: existing.npm_package ?? undefined,
    github_repo: existing.github_repo ?? undefined,
    docs_url: input.docs_url ?? existing.docs_url ?? undefined,
    source_type: sourceType,
    source_url: input.source_url ?? existing.source_url ?? undefined,
    freshness_days: existing.freshness_days,
    priority: existing.priority,
  });
  const now = new Date().toISOString();

  database.run(
    `UPDATE libraries SET
       docs_url = ?,
       source_url = ?,
       source_type = ?,
       updated_at = ?
     WHERE id = ?`,
    [source.docs_url, source.source_url, source.source_type, now, id]
  );

  return getLibraryById(id, database);
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

function parseLibraryReference(reference: string): { slug: string; version: string | null } {
  const cleaned = reference.replace(/^\/context\//, "").replace(/^\//, "").trim();
  const at = cleaned.lastIndexOf("@");
  if (at > 0 && at < cleaned.length - 1) {
    return { slug: cleaned.slice(0, at), version: cleaned.slice(at + 1) };
  }
  return { slug: cleaned, version: null };
}

function normalizeVersion(version?: string | null): string | null {
  const normalized = version?.trim().replace(/^v/i, "");
  return normalized || null;
}

function versionMatches(actual: string | null, requested: string): boolean {
  const actualVersion = normalizeVersion(actual);
  const requestedVersion = normalizeVersion(requested);
  if (!actualVersion || !requestedVersion) return false;
  return actualVersion === requestedVersion || actualVersion.startsWith(`${requestedVersion}.`);
}

function libraryMatchesReference(library: Library, reference: string): boolean {
  const normalized = reference.trim().toLowerCase();
  return [
    library.slug,
    toSlug(library.name),
    library.npm_package,
    library.github_repo,
  ].some((value) => value?.toLowerCase() === normalized);
}

function bestVersionCandidate(candidates: Library[], reference: string, version: string): Library {
  return [...candidates].sort((a, b) => {
    const aExactSlug = a.slug === reference ? 0 : 1;
    const bExactSlug = b.slug === reference ? 0 : 1;
    if (aExactSlug !== bExactSlug) return aExactSlug - bExactSlug;

    const aExactVersion = normalizeVersion(a.version) === normalizeVersion(version) ? 0 : 1;
    const bExactVersion = normalizeVersion(b.version) === normalizeVersion(version) ? 0 : 1;
    if (aExactVersion !== bExactVersion) return aExactVersion - bExactVersion;

    return a.name.localeCompare(b.name);
  })[0]!;
}

function fallbackSearchLibraries(query: string, limit: number, db: Database): Library[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return (db.all("SELECT * FROM libraries ORDER BY name ASC") as Record<string, unknown>[])
    .map(rowToLibrary)
    .filter((library) => {
      const haystack = [
        library.name,
        library.slug,
        library.description,
        library.npm_package,
        library.github_repo,
        library.version,
        library.source_type,
      ].filter(Boolean).join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0, limit);
}
