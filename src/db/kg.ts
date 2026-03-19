import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";

export type NodeType =
  | "library"
  | "framework"
  | "language"
  | "concept"
  | "api"
  | "package"
  | "tool";

export type EdgeRelation =
  | "depends_on"
  | "alternative_to"
  | "used_with"
  | "wraps"
  | "extends"
  | "part_of"
  | "replaced_by";

export interface KgNode {
  id: string;
  type: NodeType;
  name: string;
  description: string | null;
  library_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface KgEdge {
  id: string;
  source_id: string;
  target_id: string;
  relation: EdgeRelation;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface KgNodeWithRelations extends KgNode {
  relations: Array<{
    direction: "outgoing" | "incoming";
    relation: EdgeRelation;
    node: KgNode;
    weight: number;
  }>;
}

function rowToNode(row: Record<string, unknown>): KgNode {
  return {
    id: row["id"] as string,
    type: row["type"] as NodeType,
    name: row["name"] as string,
    description: (row["description"] as string) ?? null,
    library_id: (row["library_id"] as string) ?? null,
    metadata: JSON.parse((row["metadata"] as string) ?? "{}"),
    created_at: row["created_at"] as string,
  };
}

function rowToEdge(row: Record<string, unknown>): KgEdge {
  return {
    id: row["id"] as string,
    source_id: row["source_id"] as string,
    target_id: row["target_id"] as string,
    relation: row["relation"] as EdgeRelation,
    weight: (row["weight"] as number) ?? 1.0,
    metadata: JSON.parse((row["metadata"] as string) ?? "{}"),
    created_at: row["created_at"] as string,
  };
}

export function upsertNode(
  input: {
    type: NodeType;
    name: string;
    description?: string;
    library_id?: string;
    metadata?: Record<string, unknown>;
  },
  db?: Database
): KgNode {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();

  const existing = database
    .query<Record<string, unknown>, [string, string]>(
      "SELECT * FROM kg_nodes WHERE type = ? AND name = ?"
    )
    .get(input.type, input.name);

  if (existing) {
    database.run(
      "UPDATE kg_nodes SET description = ?, library_id = ?, metadata = ? WHERE id = ?",
      [
        input.description ?? (existing["description"] as string) ?? null,
        input.library_id ?? (existing["library_id"] as string) ?? null,
        JSON.stringify(input.metadata ?? {}),
        existing["id"] as string,
      ]
    );
    return rowToNode(
      database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM kg_nodes WHERE id = ?"
        )
        .get(existing["id"] as string)!
    );
  }

  const id = randomUUID();
  database.run(
    `INSERT INTO kg_nodes (id, type, name, description, library_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.type,
      input.name,
      input.description ?? null,
      input.library_id ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
    ]
  );

  return rowToNode(
    database
      .query<Record<string, unknown>, [string]>("SELECT * FROM kg_nodes WHERE id = ?")
      .get(id)!
  );
}

export function upsertEdge(
  input: {
    source_id: string;
    target_id: string;
    relation: EdgeRelation;
    weight?: number;
    metadata?: Record<string, unknown>;
  },
  db?: Database
): KgEdge {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();

  const existing = database
    .query<Record<string, unknown>, [string, string, string]>(
      "SELECT * FROM kg_edges WHERE source_id = ? AND target_id = ? AND relation = ?"
    )
    .get(input.source_id, input.target_id, input.relation);

  if (existing) {
    database.run(
      "UPDATE kg_edges SET weight = ?, metadata = ? WHERE id = ?",
      [
        input.weight ?? (existing["weight"] as number),
        JSON.stringify(input.metadata ?? {}),
        existing["id"] as string,
      ]
    );
    return rowToEdge(
      database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM kg_edges WHERE id = ?"
        )
        .get(existing["id"] as string)!
    );
  }

  const id = randomUUID();
  database.run(
    `INSERT INTO kg_edges (id, source_id, target_id, relation, weight, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.source_id,
      input.target_id,
      input.relation,
      input.weight ?? 1.0,
      JSON.stringify(input.metadata ?? {}),
      now,
    ]
  );

  return rowToEdge(
    database
      .query<Record<string, unknown>, [string]>("SELECT * FROM kg_edges WHERE id = ?")
      .get(id)!
  );
}

export function getNodeByLibraryId(
  libraryId: string,
  db?: Database
): KgNode | null {
  const database = db ?? getDatabase();
  const row = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM kg_nodes WHERE library_id = ? LIMIT 1"
    )
    .get(libraryId);
  return row ? rowToNode(row) : null;
}

export function getRelatedNodes(
  nodeId: string,
  relation?: EdgeRelation,
  db?: Database
): KgNodeWithRelations {
  const database = db ?? getDatabase();

  const node = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM kg_nodes WHERE id = ?"
    )
    .get(nodeId);

  if (!node) throw new Error(`KG node not found: ${nodeId}`);

  let outgoingQuery = `
    SELECT e.*, n.id AS n_id, n.type AS n_type, n.name AS n_name,
           n.description AS n_desc, n.library_id AS n_lib_id,
           n.metadata AS n_meta, n.created_at AS n_created
    FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_id
    WHERE e.source_id = ?`;
  let incomingQuery = `
    SELECT e.*, n.id AS n_id, n.type AS n_type, n.name AS n_name,
           n.description AS n_desc, n.library_id AS n_lib_id,
           n.metadata AS n_meta, n.created_at AS n_created
    FROM kg_edges e JOIN kg_nodes n ON n.id = e.source_id
    WHERE e.target_id = ?`;

  if (relation) {
    outgoingQuery += " AND e.relation = ?";
    incomingQuery += " AND e.relation = ?";
  }

  const outgoing = relation
    ? database
        .query<Record<string, unknown>, [string, string]>(outgoingQuery)
        .all(nodeId, relation)
    : database
        .query<Record<string, unknown>, [string]>(outgoingQuery)
        .all(nodeId);

  const incoming = relation
    ? database
        .query<Record<string, unknown>, [string, string]>(incomingQuery)
        .all(nodeId, relation)
    : database
        .query<Record<string, unknown>, [string]>(incomingQuery)
        .all(nodeId);

  const relations: KgNodeWithRelations["relations"] = [];

  for (const row of outgoing) {
    relations.push({
      direction: "outgoing",
      relation: row["relation"] as EdgeRelation,
      weight: row["weight"] as number,
      node: {
        id: row["n_id"] as string,
        type: row["n_type"] as NodeType,
        name: row["n_name"] as string,
        description: (row["n_desc"] as string) ?? null,
        library_id: (row["n_lib_id"] as string) ?? null,
        metadata: JSON.parse((row["n_meta"] as string) ?? "{}"),
        created_at: row["n_created"] as string,
      },
    });
  }

  for (const row of incoming) {
    relations.push({
      direction: "incoming",
      relation: row["relation"] as EdgeRelation,
      weight: row["weight"] as number,
      node: {
        id: row["n_id"] as string,
        type: row["n_type"] as NodeType,
        name: row["n_name"] as string,
        description: (row["n_desc"] as string) ?? null,
        library_id: (row["n_lib_id"] as string) ?? null,
        metadata: JSON.parse((row["n_meta"] as string) ?? "{}"),
        created_at: row["n_created"] as string,
      },
    });
  }

  return { ...rowToNode(node), relations };
}

export function searchNodes(query: string, db?: Database): KgNode[] {
  const database = db ?? getDatabase();
  return database
    .query<Record<string, unknown>, [string, string]>(
      "SELECT * FROM kg_nodes WHERE name LIKE ? OR description LIKE ? ORDER BY name LIMIT 20"
    )
    .all(`%${query}%`, `%${query}%`)
    .map(rowToNode);
}

export function listNodes(db?: Database): KgNode[] {
  const database = db ?? getDatabase();
  return database
    .query<Record<string, unknown>, []>(
      "SELECT * FROM kg_nodes ORDER BY type ASC, name ASC"
    )
    .all()
    .map(rowToNode);
}
