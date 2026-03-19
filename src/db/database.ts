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

      -- FTS5 for libraries: standalone table, auto-maintained via triggers
      CREATE VIRTUAL TABLE IF NOT EXISTS libraries_fts USING fts5(
        name,
        slug,
        description,
        npm_package,
        tokenize='porter ascii'
      );

      -- Map FTS rowid → library id for joining search results
      CREATE TABLE IF NOT EXISTS libraries_fts_map (
        rowid INTEGER PRIMARY KEY,
        library_id TEXT NOT NULL UNIQUE
      );

      CREATE TRIGGER IF NOT EXISTS libraries_ai AFTER INSERT ON libraries BEGIN
        INSERT INTO libraries_fts(name, slug, description, npm_package)
        VALUES (new.name, new.slug, COALESCE(new.description,''), COALESCE(new.npm_package,''));
        INSERT INTO libraries_fts_map(rowid, library_id)
        VALUES (last_insert_rowid(), new.id);
      END;

      CREATE TRIGGER IF NOT EXISTS libraries_au AFTER UPDATE ON libraries BEGIN
        UPDATE libraries_fts SET
          name = new.name,
          slug = new.slug,
          description = COALESCE(new.description,''),
          npm_package = COALESCE(new.npm_package,'')
        WHERE rowid = (SELECT rowid FROM libraries_fts_map WHERE library_id = old.id);
      END;

      CREATE TRIGGER IF NOT EXISTS libraries_ad AFTER DELETE ON libraries BEGIN
        DELETE FROM libraries_fts WHERE rowid = (
          SELECT rowid FROM libraries_fts_map WHERE library_id = old.id
        );
        DELETE FROM libraries_fts_map WHERE library_id = old.id;
      END;

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

      -- FTS5 for chunks: standalone table, auto-maintained via triggers
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        tokenize='porter ascii'
      );

      -- Map FTS rowid → chunk id for joining search results
      CREATE TABLE IF NOT EXISTS chunks_fts_map (
        rowid INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(content) VALUES (new.content);
        INSERT INTO chunks_fts_map(rowid, chunk_id) VALUES (last_insert_rowid(), new.id);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        DELETE FROM chunks_fts WHERE rowid = (
          SELECT rowid FROM chunks_fts_map WHERE chunk_id = old.id
        );
        DELETE FROM chunks_fts_map WHERE chunk_id = old.id;
      END;

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
  {
    version: 3,
    name: "document_versions",
    sql: `
      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        crawled_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(document_id);
      CREATE INDEX IF NOT EXISTS idx_doc_versions_hash ON document_versions(content_hash);
    `,
  },
  {
    version: 4,
    name: "library_links",
    sql: `
      CREATE TABLE IF NOT EXISTS library_links (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(library_id, url)
      );

      CREATE INDEX IF NOT EXISTS idx_links_library ON library_links(library_id);
    `,
  },
  {
    version: 5,
    name: "knowledge_graph",
    sql: `
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL,
        metadata TEXT DEFAULT '{}' NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(type, name)
      );

      CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_library ON kg_nodes(library_id);

      CREATE TABLE IF NOT EXISTS kg_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0 NOT NULL,
        metadata TEXT DEFAULT '{}' NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, target_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
    `,
  },
  {
    version: 6,
    name: "chunk_embeddings",
    sql: `
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
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
