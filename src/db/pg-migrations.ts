/**
 * PostgreSQL migrations for open-context cloud sync.
 *
 * Equivalent to the SQLite schema in database.ts, translated for PostgreSQL.
 * FTS5 virtual tables and SQLite triggers are omitted (not available in PostgreSQL).
 * Full-text search should use PostgreSQL tsvector/tsquery or pg_trgm instead.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 1: _schema_version tracking table
  `CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,

  // Migration 2: libraries table
  `CREATE TABLE IF NOT EXISTS libraries (
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_libraries_slug ON libraries(slug)`,

  `CREATE INDEX IF NOT EXISTS idx_libraries_npm ON libraries(npm_package)`,

  // Migration 3: documents table
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    content TEXT,
    parsed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(library_id, url)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library_id)`,

  `CREATE INDEX IF NOT EXISTS idx_documents_url ON documents(url)`,

  // Migration 4: chunks table
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    position INTEGER NOT NULL,
    token_count INTEGER,
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chunks_library ON chunks(library_id)`,

  `CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)`,

  // Migration 5: library_tags and crawl_depth columns (version 2)
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]' NOT NULL`,

  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS crawl_depth INTEGER DEFAULT 2 NOT NULL`,

  // Migration 6: document_versions table (version 3)
  `CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    crawled_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(document_id)`,

  `CREATE INDEX IF NOT EXISTS idx_doc_versions_hash ON document_versions(content_hash)`,

  // Migration 7: library_links table (version 4)
  `CREATE TABLE IF NOT EXISTS library_links (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(library_id, url)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_links_library ON library_links(library_id)`,

  // Migration 8: knowledge graph nodes (version 5)
  `CREATE TABLE IF NOT EXISTS kg_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL,
    metadata TEXT DEFAULT '{}' NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(type, name)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type)`,

  `CREATE INDEX IF NOT EXISTS idx_kg_nodes_library ON kg_nodes(library_id)`,

  // Migration 9: knowledge graph edges (version 5)
  `CREATE TABLE IF NOT EXISTS kg_edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    weight REAL DEFAULT 1.0 NOT NULL,
    metadata TEXT DEFAULT '{}' NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source_id, target_id, relation)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id)`,

  `CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id)`,

  // Migration 10: chunk_embeddings table (version 6)
  `CREATE TABLE IF NOT EXISTS chunk_embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    embedding BYTEA NOT NULL,
    dimensions INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,

  // Migration 11: feedback table (version 7)
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
];
