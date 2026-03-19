import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

let _db: Database | null = null;

function resolveDbPath(): string {
  if (process.env["CONTEXT_DB_PATH"]) {
    return process.env["CONTEXT_DB_PATH"];
  }

  // Walk up from cwd looking for .context/context.db
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".context", "context.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Default: ~/.context/context.db
  return join(homedir(), ".context", "context.db");
}

export function getDatabase(): Database {
  if (_db) return _db;

  const path = resolveDbPath();

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);
  _db = db;
  return db;
}

export function resetDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getDbPath(): string {
  return resolveDbPath();
}

const migrations = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        npm_package TEXT,
        github_repo TEXT,
        docs_url TEXT,
        version TEXT,
        chunk_count INTEGER DEFAULT 0 NOT NULL,
        document_count INTEGER DEFAULT 0 NOT NULL,
        last_crawled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_libraries_slug ON libraries(slug);
      CREATE INDEX IF NOT EXISTS idx_libraries_npm ON libraries(npm_package);

      CREATE VIRTUAL TABLE IF NOT EXISTS libraries_fts USING fts5(
        name,
        slug,
        description,
        npm_package,
        library_id UNINDEXED,
        content='libraries',
        content_rowid='rowid'
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT,
        content TEXT,
        parsed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(library_id, url)
      );

      CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library_id);
      CREATE INDEX IF NOT EXISTS idx_documents_url ON documents(url);

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        position INTEGER NOT NULL,
        token_count INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_library ON chunks(library_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        library_id UNINDEXED,
        chunk_id UNINDEXED,
        content='chunks',
        content_rowid='rowid'
      );

      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "library_tags",
    sql: `
      ALTER TABLE libraries ADD COLUMN tags TEXT DEFAULT '[]' NOT NULL;
      ALTER TABLE libraries ADD COLUMN crawl_depth INTEGER DEFAULT 2 NOT NULL;
    `,
  },
];

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM _schema_version")
      .all()
      .map((r) => r.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        "INSERT INTO _schema_version (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, new Date().toISOString()]
      );
    })();
  }
}
