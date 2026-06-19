/**
 * PostgreSQL migrations for open-context remote storage sync.
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

  // Migration 12: repository/code context tables (version 8)
  `CREATE TABLE IF NOT EXISTS contexts (
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_contexts_path ON contexts(path)`,
  `CREATE INDEX IF NOT EXISTS idx_contexts_type ON contexts(type)`,
  `CREATE INDEX IF NOT EXISTS idx_contexts_parent ON contexts(parent_context_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contexts_language ON contexts(language)`,

  `CREATE TABLE IF NOT EXISTS context_items (
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_context_items_context ON context_items(context_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_items_path ON context_items(path)`,
  `CREATE INDEX IF NOT EXISTS idx_context_items_parent ON context_items(parent_path)`,
  `CREATE INDEX IF NOT EXISTS idx_context_items_extension ON context_items(extension)`,
  `CREATE INDEX IF NOT EXISTS idx_context_items_hash ON context_items(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_context_items_type ON context_items(item_type)`,

  `CREATE TABLE IF NOT EXISTS code_entities (
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_code_entities_context ON code_entities(context_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_entities_item ON code_entities(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_entities_name ON code_entities(name)`,
  `CREATE INDEX IF NOT EXISTS idx_code_entities_type ON code_entities(type)`,

  `CREATE TABLE IF NOT EXISTS code_relations (
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_code_relations_context ON code_relations(context_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_relations_source_item ON code_relations(source_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_relations_target_item ON code_relations(target_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_relations_source_entity ON code_relations(source_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_relations_target_entity ON code_relations(target_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_code_relations_type ON code_relations(relation_type)`,

  `CREATE TABLE IF NOT EXISTS context_watches (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    pattern TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TEXT NOT NULL,
    UNIQUE(context_id, path)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_context_watches_context ON context_watches(context_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_watches_active ON context_watches(active)`,

  // Migration 13: docs artifact provenance and update tasks (version 9)
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'docs' NOT NULL`,
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS source_url TEXT`,
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS freshness_days INTEGER DEFAULT 7 NOT NULL`,
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0 NOT NULL`,
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS last_checked_at TEXT`,
  `ALTER TABLE libraries ADD COLUMN IF NOT EXISTS next_check_at TEXT`,

  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_path TEXT`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'docs' NOT NULL`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' NOT NULL`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS discovered_at TEXT`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata TEXT DEFAULT '{}' NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`,
  `CREATE INDEX IF NOT EXISTS idx_libraries_next_check ON libraries(next_check_at)`,
  `CREATE INDEX IF NOT EXISTS idx_libraries_source ON libraries(source_type)`,

  `CREATE TABLE IF NOT EXISTS doc_update_tasks (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    task_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    priority INTEGER DEFAULT 0 NOT NULL,
    scheduled_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_doc_tasks_library ON doc_update_tasks(library_id)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_tasks_status ON doc_update_tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_tasks_scheduled ON doc_update_tasks(scheduled_at)`,

  `CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    events TEXT DEFAULT '[]' NOT NULL,
    active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active ON webhook_endpoints(active)`,

  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    response_status INTEGER,
    error TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries(event)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status)`,
];
