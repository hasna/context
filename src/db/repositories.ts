import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { getDatabase } from "./database.js";

// Types
export type ContextType = "repository" | "folder" | "project" | "workspace";

export type EntityType =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "variable"
  | "method"
  | "property"
  | "module"
  | "import";

export type RelationType =
  | "imports"
  | "exports"
  | "extends"
  | "implements"
  | "uses"
  | "calls"
  | "references"
  | "depends_on"
  | "defined_in"
  | "instance_of";

export type Visibility = "public" | "private" | "protected" | "internal";

export type ItemType = "file" | "directory";

export interface Context {
  id: string;
  name: string;
  path: string;
  type: ContextType;
  description: string | null;
  parent_context_id: string | null;
  language: string | null;
  last_indexed_at: string | null;
  file_count: number;
  entity_count: number;
  created_at: string;
  updated_at: string;
}

export interface ContextItem {
  id: string;
  context_id: string;
  path: string;
  name: string;
  item_type: ItemType;
  parent_path: string | null;
  extension: string | null;
  content_hash: string | null;
  content: string | null;
  size_bytes: number;
  line_count: number;
  last_modified: string | null;
  last_analyzed: string;
  created_at: string;
}

export interface CodeEntity {
  id: string;
  context_id: string;
  item_id: string;
  name: string;
  type: EntityType;
  signature: string | null;
  start_line: number;
  end_line: number;
  visibility: Visibility;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CodeRelation {
  id: string;
  context_id: string;
  source_item_id: string;
  target_item_id: string | null;
  source_entity_id: string | null;
  target_entity_id: string | null;
  relation_type: RelationType;
  relation_text: string | null;
  confidence: number;
  created_at: string;
}

export interface ContextWatch {
  id: string;
  context_id: string;
  path: string;
  pattern: string;
  active: boolean;
  created_at: string;
}

// Helper to hash content
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// Context operations
export function upsertContext(input: {
  name: string;
  path: string;
  type: ContextType;
  description?: string;
  language?: string;
  parent_context_id?: string;
}): Context {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = db.get("SELECT * FROM contexts WHERE path = ?", input.path) as Record<string, unknown> | null;

  if (existing) {
    db.run(
      `UPDATE contexts SET name = ?, type = ?, description = ?, language = ?,
       parent_context_id = ?, updated_at = ? WHERE id = ?`,
      [
        input.name,
        input.type,
        input.description ?? null,
        input.language ?? null,
        input.parent_context_id ?? null,
        now,
        existing["id"] as string,
      ]
    );
    return rowToContext(existing["id"] as string)!;
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO contexts (id, name, path, type, description, language, parent_context_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.path,
      input.type,
      input.description ?? null,
      input.language ?? null,
      input.parent_context_id ?? null,
      now,
      now,
    ]
  );

  return rowToContext(id)!;
}

export function getContext(id: string): Context | null {
  return rowToContext(id);
}

export function getContextByPath(path: string): Context | null {
  const row = getDatabase().get("SELECT * FROM contexts WHERE path = ?", path) as Record<string, unknown> | null;
  return row ? rowToContextFromRow(row) : null;
}

export function listContexts(): Context[] {
  return (getDatabase().all("SELECT * FROM contexts ORDER BY name ASC") as Record<string, unknown>[])
    .map(rowToContextFromRow);
}

export function listContextsByType(type: ContextType): Context[] {
  return (getDatabase().all("SELECT * FROM contexts WHERE type = ? ORDER BY name ASC", type) as Record<string, unknown>[])
    .map(rowToContextFromRow);
}

export function deleteContext(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM contexts WHERE id = ?", [id]);
}

export function updateContextCounts(id: string): void {
  const db = getDatabase();
  const fileCountRow = db.get(
    "SELECT COUNT(*) as count FROM context_items WHERE context_id = ? AND item_type = 'file'",
    id
  ) as { count: number } | undefined;
  const fileCount = fileCountRow?.count ?? 0;
  const entityCountRow = db.get(
    "SELECT COUNT(*) as count FROM code_entities WHERE context_id = ?",
    id
  ) as { count: number } | undefined;
  const entityCount = entityCountRow?.count ?? 0;

  db.run(
    `UPDATE contexts SET file_count = ?, entity_count = ?,
     last_indexed_at = ?, updated_at = ? WHERE id = ?`,
    [fileCount, entityCount, new Date().toISOString(), new Date().toISOString(), id]
  );
}

// ContextItem operations (files and directories)
export function upsertContextItem(input: {
  context_id: string;
  path: string;
  name: string;
  item_type: ItemType;
  parent_path?: string;
  extension?: string;
  content?: string;
  last_modified?: string;
}): ContextItem {
  const db = getDatabase();
  const now = new Date().toISOString();
  const content_hash = input.content ? hashContent(input.content) : null;
  const line_count = input.content ? input.content.split("\n").length : 0;
  const size_bytes = input.content ? Buffer.byteLength(input.content, "utf8") : 0;

  const existing = db.get(
    "SELECT * FROM context_items WHERE context_id = ? AND path = ?",
    input.context_id,
    input.path
  ) as Record<string, unknown> | null;

  if (existing) {
    if (input.content && existing["content_hash"] === content_hash) {
      // No change in content, just update last_analyzed
      db.run(
        "UPDATE context_items SET last_analyzed = ? WHERE id = ?",
        [now, existing["id"]]
      );
      return rowToContextItem(existing["id"] as string)!;
    }

    // Content changed or no content tracking, update
    db.run(
      `UPDATE context_items SET name = ?, item_type = ?, parent_path = ?, extension = ?,
       content_hash = ?, content = ?, size_bytes = ?, line_count = ?,
       last_modified = ?, last_analyzed = ?
       WHERE context_id = ? AND path = ?`,
      [
        input.name,
        input.item_type,
        input.parent_path ?? null,
        input.extension ?? null,
        content_hash,
        input.content ?? null,
        size_bytes,
        line_count,
        input.last_modified ?? null,
        now,
        input.context_id,
        input.path,
      ]
    );
    return rowToContextItem(
      (db.get(
        "SELECT id FROM context_items WHERE context_id = ? AND path = ?",
        input.context_id,
        input.path
      ) as Record<string, unknown>)["id"] as string
    )!;
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO context_items (id, context_id, path, name, item_type, parent_path,
     extension, content_hash, content, size_bytes, line_count, last_modified, last_analyzed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.context_id,
      input.path,
      input.name,
      input.item_type,
      input.parent_path ?? null,
      input.extension ?? null,
      content_hash,
      input.content ?? null,
      size_bytes,
      line_count,
      input.last_modified ?? null,
      now,
      now,
    ]
  );

  return rowToContextItem(id)!;
}

export function getContextItem(id: string): ContextItem | null {
  return rowToContextItem(id);
}

export function getContextItemByPath(contextId: string, path: string): ContextItem | null {
  const db = getDatabase();
  const row = db.get(
    "SELECT * FROM context_items WHERE context_id = ? AND path = ?",
    contextId,
    path
  ) as Record<string, unknown> | null;
  return row ? rowToContextItemFromRow(row) : null;
}

export function getContextItemsByExtension(
  contextId: string,
  extension: string
): ContextItem[] {
  const db = getDatabase();
  return (db.all(
    "SELECT * FROM context_items WHERE context_id = ? AND extension = ? AND item_type = 'file' ORDER BY path",
    contextId,
    extension
  ) as Record<string, unknown>[]).map(rowToContextItemFromRow);
}

export function getContextItemsByParent(
  contextId: string,
  parentPath: string | null
): ContextItem[] {
  const db = getDatabase();
  if (parentPath === null) {
    return (db.all(
      "SELECT * FROM context_items WHERE context_id = ? AND parent_path IS NULL ORDER BY name",
      contextId
    ) as Record<string, unknown>[]).map(rowToContextItemFromRow);
  }
  return (db.all(
    "SELECT * FROM context_items WHERE context_id = ? AND parent_path = ? ORDER BY name",
    contextId,
    parentPath
  ) as Record<string, unknown>[]).map(rowToContextItemFromRow);
}

export function getChildItems(contextId: string, parentPath: string): ContextItem[] {
  return getContextItemsByParent(contextId, parentPath);
}

export function getDirectories(contextId: string): ContextItem[] {
  const db = getDatabase();
  return (db.all(
    "SELECT * FROM context_items WHERE context_id = ? AND item_type = 'directory' ORDER BY name",
    contextId
  ) as Record<string, unknown>[]).map(rowToContextItemFromRow);
}

export function searchContextItems(query: string, contextId?: string): ContextItem[] {
  const db = getDatabase();
  // Escape special FTS5 characters and wrap in double quotes for exact matching
  const escapedQuery = query.replace(/['"]/g, "").trim();
  if (!escapedQuery) return [];

  let sql = `
    SELECT ci.* FROM context_items_fts fts
    JOIN context_items_fts_map map ON map.rowid = fts.rowid
    JOIN context_items ci ON ci.id = map.item_id
    WHERE context_items_fts MATCH ? AND ci.item_type = 'file'
  `;
  const params: string[] = [`"${escapedQuery}"`];

  if (contextId) {
    sql += " AND ci.context_id = ?";
    params.push(contextId);
  }

  sql += " ORDER BY rank LIMIT 50";

  return (db.all(sql, ...params) as Record<string, unknown>[]).map(rowToContextItemFromRow);
}

export function deleteContextItem(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM context_items WHERE id = ?", [id]);
}

export function deleteContextItemsByPath(contextId: string, pathPrefix: string): void {
  const db = getDatabase();
  db.run(
    "DELETE FROM context_items WHERE context_id = ? AND (path = ? OR path LIKE ?)",
    [contextId, pathPrefix, `${pathPrefix}/%`]
  );
}

// CodeEntity operations
export function upsertCodeEntity(input: {
  context_id: string;
  item_id: string;
  name: string;
  type: EntityType;
  signature?: string;
  start_line: number;
  end_line: number;
  visibility?: Visibility;
  metadata?: Record<string, unknown>;
}): CodeEntity {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = db.get(
    "SELECT * FROM code_entities WHERE item_id = ? AND name = ? AND type = ?",
    input.item_id,
    input.name,
    input.type
  ) as Record<string, unknown> | null;

  if (existing) {
    db.run(
      `UPDATE code_entities SET signature = ?, start_line = ?, end_line = ?,
       visibility = ?, metadata = ? WHERE id = ?`,
      [
        input.signature ?? null,
        input.start_line,
        input.end_line,
        input.visibility ?? "public",
        JSON.stringify(input.metadata ?? {}),
        existing["id"],
      ]
    );
    return rowToCodeEntity(existing["id"] as string)!;
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO code_entities (id, context_id, item_id, name, type, signature,
     start_line, end_line, visibility, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.context_id,
      input.item_id,
      input.name,
      input.type,
      input.signature ?? null,
      input.start_line,
      input.end_line,
      input.visibility ?? "public",
      JSON.stringify(input.metadata ?? {}),
      now,
    ]
  );

  return rowToCodeEntity(id)!;
}

export function getCodeEntitiesByItem(itemId: string): CodeEntity[] {
  const db = getDatabase();
  return (db.all(
    "SELECT * FROM code_entities WHERE item_id = ? ORDER BY start_line",
    itemId
  ) as Record<string, unknown>[]).map(rowToCodeEntityFromRow);
}

export function getCodeEntitiesByName(name: string, contextId?: string): CodeEntity[] {
  const db = getDatabase();
  let sql = "SELECT * FROM code_entities WHERE name = ?";
  const params: string[] = [name];

  if (contextId) {
    sql += " AND context_id = ?";
    params.push(contextId);
  }

  return (db.all(sql, ...params) as Record<string, unknown>[]).map(rowToCodeEntityFromRow);
}

export function searchCodeEntities(query: string, contextId?: string): CodeEntity[] {
  const db = getDatabase();
  // Escape special FTS5 characters and wrap in double quotes for exact matching
  const escapedQuery = query.replace(/['"]/g, "").trim();
  if (!escapedQuery) return [];

  let sql = `
    SELECT ce.* FROM code_entities_fts fts
    JOIN code_entities_fts_map map ON map.rowid = fts.rowid
    JOIN code_entities ce ON ce.id = map.entity_id
    WHERE code_entities_fts MATCH ?
  `;
  const params: string[] = [`"${escapedQuery}"`];

  if (contextId) {
    sql += " AND ce.context_id = ?";
    params.push(contextId);
  }

  sql += " ORDER BY rank LIMIT 50";

  return (db.all(sql, ...params) as Record<string, unknown>[]).map(rowToCodeEntityFromRow);
}

export function deleteCodeEntitiesByItem(itemId: string): void {
  const db = getDatabase();
  db.run("DELETE FROM code_entities WHERE item_id = ?", [itemId]);
}

// CodeRelation operations
export function upsertCodeRelation(input: {
  context_id: string;
  source_item_id: string;
  target_item_id?: string;
  source_entity_id?: string;
  target_entity_id?: string;
  relation_type: RelationType;
  relation_text?: string;
  confidence?: number;
}): CodeRelation {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Check if relation already exists
  if (input.source_entity_id && input.target_entity_id) {
    const existing = db.get(
      "SELECT * FROM code_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?",
      input.source_entity_id,
      input.target_entity_id,
      input.relation_type
    ) as Record<string, unknown> | null;

    if (existing) {
      db.run(
        "UPDATE code_relations SET confidence = ? WHERE id = ?",
        [input.confidence ?? 1.0, existing["id"]]
      );
      return rowToCodeRelation(existing["id"] as string)!;
    }
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO code_relations (id, context_id, source_item_id, target_item_id,
     source_entity_id, target_entity_id, relation_type, relation_text, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.context_id,
      input.source_item_id,
      input.target_item_id ?? null,
      input.source_entity_id ?? null,
      input.target_entity_id ?? null,
      input.relation_type,
      input.relation_text ?? null,
      input.confidence ?? 1.0,
      now,
    ]
  );

  return rowToCodeRelation(id)!;
}

export function getRelationsByItem(itemId: string): CodeRelation[] {
  const db = getDatabase();
  return (db.all(
    "SELECT * FROM code_relations WHERE source_item_id = ? OR target_item_id = ?",
    itemId,
    itemId
  ) as Record<string, unknown>[]).map(rowToCodeRelationFromRow);
}

export function getRelationsByEntity(entityId: string): CodeRelation[] {
  const db = getDatabase();
  return (db.all(
    "SELECT * FROM code_relations WHERE source_entity_id = ? OR target_entity_id = ?",
    entityId,
    entityId
  ) as Record<string, unknown>[]).map(rowToCodeRelationFromRow);
}

export function getRelatedItems(itemId: string, depth: number = 3): {
  item: ContextItem;
  relation: CodeRelation;
  distance: number;
}[] {
  const db = getDatabase();
  const results: {
    item: ContextItem;
    relation: CodeRelation;
    distance: number;
  }[] = [];
  const visited = new Set<string>();
  const queue: { itemId: string; distance: number }[] = [{ itemId, distance: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.itemId) || current.distance > depth) continue;
    visited.add(current.itemId);

    const relations = db.all(
      "SELECT * FROM code_relations WHERE source_item_id = ? OR target_item_id = ?",
      current.itemId,
      current.itemId
    ) as Record<string, unknown>[];

    for (const row of relations) {
      const rel = rowToCodeRelationFromRow(row);
      const targetItemId =
        row["source_item_id"] === current.itemId
          ? (row["target_item_id"] as string)
          : (row["source_item_id"] as string);

      if (targetItemId && !visited.has(targetItemId)) {
        const targetItem = getContextItem(targetItemId);
        if (targetItem) {
          results.push({ item: targetItem, relation: rel, distance: current.distance + 1 });
          queue.push({ itemId: targetItemId, distance: current.distance + 1 });
        }
      }
    }
  }

  return results.sort((a, b) => a.distance - b.distance);
}

export function deleteCodeRelationsByItem(itemId: string): void {
  const db = getDatabase();
  db.run("DELETE FROM code_relations WHERE source_item_id = ? OR target_item_id = ?", [
    itemId,
    itemId,
  ]);
}

// ContextWatch operations
export function upsertContextWatch(input: {
  context_id: string;
  path: string;
  pattern: string;
}): ContextWatch {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = db.get(
    "SELECT * FROM context_watches WHERE context_id = ? AND path = ?",
    input.context_id,
    input.path
  ) as Record<string, unknown> | null;

  if (existing) {
    db.run(
      "UPDATE context_watches SET pattern = ?, active = 1 WHERE id = ?",
      [input.pattern, existing["id"]]
    );
    return rowToContextWatch(existing["id"] as string)!;
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO context_watches (id, context_id, path, pattern, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [id, input.context_id, input.path, input.pattern, now]
  );

  return rowToContextWatch(id)!;
}

export function getActiveWatches(contextId: string): ContextWatch[] {
  const db = getDatabase();
  return (db.all(
    "SELECT * FROM context_watches WHERE context_id = ? AND active = 1",
    contextId
  ) as Record<string, unknown>[]).map(rowToContextWatchFromRow);
}

export function deactivateWatch(id: string): void {
  const db = getDatabase();
  db.run("UPDATE context_watches SET active = 0 WHERE id = ?", [id]);
}

// Row mappers
function rowToContext(id: string): Context | null {
  const db = getDatabase();
  const row = db.get("SELECT * FROM contexts WHERE id = ?", id) as Record<string, unknown> | null;
  return row ? rowToContextFromRow(row) : null;
}

function rowToContextFromRow(row: Record<string, unknown>): Context {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    path: row["path"] as string,
    type: row["type"] as ContextType,
    description: (row["description"] as string) ?? null,
    parent_context_id: (row["parent_context_id"] as string) ?? null,
    language: (row["language"] as string) ?? null,
    last_indexed_at: (row["last_indexed_at"] as string) ?? null,
    file_count: (row["file_count"] as number) ?? 0,
    entity_count: (row["entity_count"] as number) ?? 0,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function rowToContextItem(id: string): ContextItem | null {
  const db = getDatabase();
  const row = db.get("SELECT * FROM context_items WHERE id = ?", id) as Record<string, unknown> | null;
  return row ? rowToContextItemFromRow(row) : null;
}

function rowToContextItemFromRow(row: Record<string, unknown>): ContextItem {
  return {
    id: row["id"] as string,
    context_id: row["context_id"] as string,
    path: row["path"] as string,
    name: row["name"] as string,
    item_type: row["item_type"] as ItemType,
    parent_path: (row["parent_path"] as string) ?? null,
    extension: (row["extension"] as string) ?? null,
    content_hash: (row["content_hash"] as string) ?? null,
    content: (row["content"] as string) ?? null,
    size_bytes: (row["size_bytes"] as number) ?? 0,
    line_count: (row["line_count"] as number) ?? 0,
    last_modified: (row["last_modified"] as string) ?? null,
    last_analyzed: row["last_analyzed"] as string,
    created_at: row["created_at"] as string,
  };
}

function rowToCodeEntity(id: string): CodeEntity | null {
  const db = getDatabase();
  const row = db.get("SELECT * FROM code_entities WHERE id = ?", id) as Record<string, unknown> | null;
  return row ? rowToCodeEntityFromRow(row) : null;
}

function rowToCodeEntityFromRow(row: Record<string, unknown>): CodeEntity {
  return {
    id: row["id"] as string,
    context_id: row["context_id"] as string,
    item_id: row["item_id"] as string,
    name: row["name"] as string,
    type: row["type"] as EntityType,
    signature: (row["signature"] as string) ?? null,
    start_line: row["start_line"] as number,
    end_line: row["end_line"] as number,
    visibility: (row["visibility"] as Visibility) ?? "public",
    metadata: JSON.parse((row["metadata"] as string) ?? "{}"),
    created_at: row["created_at"] as string,
  };
}

function rowToCodeRelation(id: string): CodeRelation | null {
  const db = getDatabase();
  const row = db.get("SELECT * FROM code_relations WHERE id = ?", id) as Record<string, unknown> | null;
  return row ? rowToCodeRelationFromRow(row) : null;
}

function rowToCodeRelationFromRow(row: Record<string, unknown>): CodeRelation {
  return {
    id: row["id"] as string,
    context_id: row["context_id"] as string,
    source_item_id: row["source_item_id"] as string,
    target_item_id: (row["target_item_id"] as string) ?? null,
    source_entity_id: (row["source_entity_id"] as string) ?? null,
    target_entity_id: (row["target_entity_id"] as string) ?? null,
    relation_type: row["relation_type"] as RelationType,
    relation_text: (row["relation_text"] as string) ?? null,
    confidence: (row["confidence"] as number) ?? 1.0,
    created_at: row["created_at"] as string,
  };
}

function rowToContextWatch(id: string): ContextWatch | null {
  const db = getDatabase();
  const row = db.get("SELECT * FROM context_watches WHERE id = ?", id) as Record<string, unknown> | null;
  return row ? rowToContextWatchFromRow(row) : null;
}

function rowToContextWatchFromRow(row: Record<string, unknown>): ContextWatch {
  return {
    id: row["id"] as string,
    context_id: row["context_id"] as string,
    path: row["path"] as string,
    pattern: row["pattern"] as string,
    active: (row["active"] as number) === 1,
    created_at: row["created_at"] as string,
  };
}

// Context resolution - find relevant files/entities for a given file or entity
export interface RelevanceResult {
  item?: ContextItem;
  entity?: CodeEntity;
  score: number;
  reason: string;
}

export function getRelevantContext(
  input: { itemId?: string; entityId?: string; query?: string },
  options: { maxResults?: number; maxDistance?: number } = {}
): RelevanceResult[] {
  const results: RelevanceResult[] = [];
  const maxResults = options.maxResults ?? 20;
  const maxDistance = options.maxDistance ?? 3;

  if (input.itemId) {
    // Get all related items via code relations
    const related = getRelatedItems(input.itemId, maxDistance);
    for (const r of related) {
      results.push({
        item: r.item,
        score: 1.0 / (r.distance + 1),
        reason: `Connected via ${r.relation.relation_type} (distance: ${r.distance})`,
      });
    }

    // Get entities in the same item
    const entities = getCodeEntitiesByItem(input.itemId);
    for (const entity of entities) {
      results.push({
        entity,
        score: 0.9,
        reason: `Same file as source`,
      });
    }
  }

  if (input.entityId) {
    // Get relations for this entity
    const relations = getRelationsByEntity(input.entityId);
    for (const rel of relations) {
      if (rel.target_entity_id && rel.target_entity_id !== input.entityId) {
        const target = rowToCodeEntity(rel.target_entity_id);
        if (target) {
          results.push({
            entity: target,
            score: rel.confidence,
            reason: `${rel.relation_type} by ${rel.relation_text ?? "reference"}`,
          });
        }
      }
    }
  }

  if (input.query) {
    // Text search in items and entities
    const itemResults = searchContextItems(input.query);
    for (const item of itemResults) {
      results.push({
        item,
        score: 0.7,
        reason: `Text match for "${input.query}"`,
      });
    }

    const entityResults = searchCodeEntities(input.query);
    for (const entity of entityResults) {
      results.push({
        entity,
        score: 0.7,
        reason: `Entity match for "${input.query}"`,
      });
    }
  }

  // Sort by score and dedupe
  const seen = new Set<string>();
  return results
    .filter((r) => {
      const key = r.item?.id ?? r.entity?.id ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// Hierarchy helpers
export function getContextHierarchy(contextId: string): Context[] {
  const hierarchy: Context[] = [];
  let currentId: string | null = contextId;

  while (currentId) {
    const ctx = getContext(currentId);
    if (ctx) {
      hierarchy.unshift(ctx);
      currentId = ctx.parent_context_id;
    } else {
      break;
    }
  }

  return hierarchy;
}

export function getChildrenContexts(parentContextId: string): Context[] {
  return (getDatabase().all(
    "SELECT * FROM contexts WHERE parent_context_id = ? ORDER BY name",
    parentContextId
  ) as Record<string, unknown>[]).map(rowToContextFromRow);
}

export function getItemHierarchy(contextId: string, itemPath: string): ContextItem[] {
  const hierarchy: ContextItem[] = [];
  // Remove leading slash and split
  const cleanPath = itemPath.startsWith("/") ? itemPath.slice(1) : itemPath;
  const parts = cleanPath.split("/");
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const item = getContextItemByPath(contextId, "/" + currentPath);
    if (item) {
      hierarchy.push(item);
    }
  }

  return hierarchy;
}
