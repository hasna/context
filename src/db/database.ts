import { SqliteAdapter as Database } from "@hasna/cloud";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

let _db: Database | null = null;

export function getDataDir(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || homedir();
  const newDir = join(home, ".hasna", "context");
  const oldDir = join(home, ".context");

  // Auto-migrate old dir to new location
  if (existsSync(oldDir) && !existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
    for (const file of readdirSync(oldDir)) {
      const oldPath = join(oldDir, file);
      if (statSync(oldPath).isFile()) {
        copyFileSync(oldPath, join(newDir, file));
      }
    }
  }

  mkdirSync(newDir, { recursive: true });
  return newDir;
}

function resolveDbPath(): string {
  if (process.env["HASNA_CONTEXT_DB_PATH"]) {
    return process.env["HASNA_CONTEXT_DB_PATH"];
  }
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

  // Default: ~/.hasna/context/context.db
  return join(getDataDir(), "context.db");
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
  {
    version: 7,
    name: "feedback",
    sql: `
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        message TEXT NOT NULL,
        email TEXT,
        category TEXT DEFAULT 'general',
        version TEXT,
        machine_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 8,
    name: "code_context",
    sql: `
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('repository', 'folder', 'project', 'workspace')),
        description TEXT,
        parent_context_id TEXT REFERENCES contexts(id) ON DELETE SET NULL,
        language TEXT,
        last_indexed_at TEXT,
        file_count INTEGER DEFAULT 0,
        entity_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contexts_path ON contexts(path);
      CREATE INDEX IF NOT EXISTS idx_contexts_type ON contexts(type);
      CREATE INDEX IF NOT EXISTS idx_contexts_parent ON contexts(parent_context_id);
      CREATE INDEX IF NOT EXISTS idx_contexts_language ON contexts(language);

      CREATE TABLE IF NOT EXISTS context_items (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        item_type TEXT NOT NULL CHECK(item_type IN ('file', 'directory')),
        parent_path TEXT,
        extension TEXT,
        content_hash TEXT,
        content TEXT,
        size_bytes INTEGER DEFAULT 0,
        line_count INTEGER DEFAULT 0,
        last_modified TEXT,
        last_analyzed TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(context_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_context_items_context ON context_items(context_id);
      CREATE INDEX IF NOT EXISTS idx_context_items_path ON context_items(path);
      CREATE INDEX IF NOT EXISTS idx_context_items_parent ON context_items(parent_path);
      CREATE INDEX IF NOT EXISTS idx_context_items_extension ON context_items(extension);
      CREATE INDEX IF NOT EXISTS idx_context_items_hash ON context_items(content_hash);
      CREATE INDEX IF NOT EXISTS idx_context_items_type ON context_items(item_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS context_items_fts USING fts5(
        path,
        name,
        content,
        tokenize='porter ascii'
      );

      CREATE TABLE IF NOT EXISTS context_items_fts_map (
        rowid INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE
      );

      CREATE TRIGGER IF NOT EXISTS context_items_ai AFTER INSERT ON context_items WHEN new.item_type = 'file' BEGIN
        INSERT INTO context_items_fts(path, name, content)
        VALUES (new.path, new.name, COALESCE(new.content, ''));
        INSERT INTO context_items_fts_map(rowid, item_id)
        VALUES (last_insert_rowid(), new.id);
      END;

      CREATE TRIGGER IF NOT EXISTS context_items_au AFTER UPDATE ON context_items WHEN new.item_type = 'file' BEGIN
        UPDATE context_items_fts SET
          path = new.path,
          name = new.name,
          content = COALESCE(new.content, '')
        WHERE rowid = (SELECT rowid FROM context_items_fts_map WHERE item_id = old.id);
      END;

      CREATE TRIGGER IF NOT EXISTS context_items_ad AFTER DELETE ON context_items WHEN old.item_type = 'file' BEGIN
        DELETE FROM context_items_fts WHERE rowid = (
          SELECT rowid FROM context_items_fts_map WHERE item_id = old.id
        );
        DELETE FROM context_items_fts_map WHERE item_id = old.id;
      END;

      CREATE TABLE IF NOT EXISTS code_entities (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        signature TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        visibility TEXT DEFAULT 'public',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(item_id, name, type)
      );

      CREATE INDEX IF NOT EXISTS idx_code_entities_context ON code_entities(context_id);
      CREATE INDEX IF NOT EXISTS idx_code_entities_item ON code_entities(item_id);
      CREATE INDEX IF NOT EXISTS idx_code_entities_name ON code_entities(name);
      CREATE INDEX IF NOT EXISTS idx_code_entities_type ON code_entities(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS code_entities_fts USING fts5(
        name,
        signature,
        tokenize='porter ascii'
      );

      CREATE TABLE IF NOT EXISTS code_entities_fts_map (
        rowid INTEGER PRIMARY KEY,
        entity_id TEXT NOT NULL UNIQUE
      );

      CREATE TRIGGER IF NOT EXISTS code_entities_ai AFTER INSERT ON code_entities BEGIN
        INSERT INTO code_entities_fts(name, signature)
        VALUES (new.name, COALESCE(new.signature, ''));
        INSERT INTO code_entities_fts_map(rowid, entity_id)
        VALUES (last_insert_rowid(), new.id);
      END;

      CREATE TRIGGER IF NOT EXISTS code_entities_ad AFTER DELETE ON code_entities BEGIN
        DELETE FROM code_entities_fts WHERE rowid = (
          SELECT rowid FROM code_entities_fts_map WHERE entity_id = old.id
        );
        DELETE FROM code_entities_fts_map WHERE entity_id = old.id;
      END;

      CREATE TABLE IF NOT EXISTS code_relations (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        source_item_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
        target_item_id TEXT REFERENCES context_items(id) ON DELETE CASCADE,
        source_entity_id TEXT REFERENCES code_entities(id) ON DELETE CASCADE,
        target_entity_id TEXT REFERENCES code_entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        relation_text TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_code_relations_context ON code_relations(context_id);
      CREATE INDEX IF NOT EXISTS idx_code_relations_source_item ON code_relations(source_item_id);
      CREATE INDEX IF NOT EXISTS idx_code_relations_target_item ON code_relations(target_item_id);
      CREATE INDEX IF NOT EXISTS idx_code_relations_source_entity ON code_relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_code_relations_target_entity ON code_relations(target_entity_id);
      CREATE INDEX IF NOT EXISTS idx_code_relations_type ON code_relations(relation_type);

      CREATE TABLE IF NOT EXISTS context_watches (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        pattern TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(context_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_context_watches_context ON context_watches(context_id);
      CREATE INDEX IF NOT EXISTS idx_context_watches_active ON context_watches(active);
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
    .all("SELECT version FROM _schema_version")
    .map((r) => (r as { version: number }).version)
);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    try {
      // Split SQL intelligently to handle BEGIN...END blocks (triggers)
      const statements: string[] = [];
      const lines = migration.sql.split('\n');
      let currentStmt = '';
      let inBlock = false;

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('--')) continue;

        currentStmt += line + '\n';

        if (!inBlock && trimmed.startsWith('CREATE')) {
          // Start of a new statement
          if (trimmed.includes('BEGIN')) {
            inBlock = true;
          }
        }

        if (inBlock && trimmed === 'END;') {
          // End of a block
          inBlock = false;
          statements.push(currentStmt.trim());
          currentStmt = '';
        } else if (!inBlock && trimmed.endsWith(';') && !trimmed.includes('BEGIN')) {
          // End of a simple statement
          statements.push(currentStmt.trim());
          currentStmt = '';
        }
      }

      // Execute each statement
      for (const stmt of statements) {
        if (stmt.length > 0) {
          db.exec(stmt);
        }
      }

      db.run(
        "INSERT INTO _schema_version (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, new Date().toISOString()]
      );
    } catch (err) {
      console.error(`Migration ${migration.version} (${migration.name}) failed: ${err}`);
      throw err;
    }
  }
}
