import { randomUUID } from "crypto";
import type { Database } from "./database.js";
import { getDatabase } from "./database.js";
import type {
  ApiEndpoint,
  ApiEndpointInput,
  ApiEndpointParameter,
  ApiEndpointRequestBody,
  ApiEndpointResponse,
  ApiEndpointSearchResult,
  Library,
} from "../types/index.js";
import {
  deleteNodesForLibraryByType,
  getNodeByLibraryId,
  upsertEdge,
  upsertNode,
} from "./kg.js";

export interface ApiEndpointQuery {
  libraryId?: string;
  query?: string;
  method?: string;
  path?: string;
  operationId?: string;
  limit?: number;
}

export function replaceDocumentApiEndpoints(
  input: {
    library_id: string;
    document_id: string;
    endpoints: ApiEndpointInput[];
  },
  db?: Database
): ApiEndpoint[] {
  const database = db ?? getDatabase();
  deleteApiEndpointsForDocument(input.document_id, database);
  return input.endpoints.map((endpoint) =>
    insertApiEndpoint(
      {
        ...endpoint,
        library_id: input.library_id,
        document_id: input.document_id,
      },
      database
    )
  );
}

export function deleteApiEndpointsForDocument(documentId: string, db?: Database): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM api_endpoints WHERE document_id = ?", [documentId]);
}

export function deleteApiEndpointsForLibrary(libraryId: string, db?: Database): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM api_endpoints WHERE library_id = ?", [libraryId]);
}

export function listApiEndpoints(query: ApiEndpointQuery = {}, db?: Database): ApiEndpointSearchResult[] {
  const database = db ?? getDatabase();
  const limit = normalizeLimit(query.limit);
  const method = query.method?.trim().toUpperCase();
  const path = query.path?.trim();
  const operationId = query.operationId?.trim();

  if (query.query?.trim()) {
    const where = ["api_endpoints_fts MATCH ?"];
    const params: Array<string | number> = [escapeFts(query.query)];
    if (query.libraryId) {
      where.push("e.library_id = ?");
      params.push(query.libraryId);
    }
    if (method) {
      where.push("e.method = ?");
      params.push(method);
    }
    if (path) {
      where.push("e.path = ?");
      params.push(path);
    }
    if (operationId) {
      where.push("e.operation_id = ?");
      params.push(operationId);
    }

    params.push(limit);
    return database
      .all(
        `
          SELECT e.*, f.rank AS score
          FROM api_endpoints_fts f
          JOIN api_endpoints_fts_map m ON m.rowid = f.rowid
          JOIN api_endpoints e ON e.id = m.endpoint_id
          WHERE ${where.join(" AND ")}
          ORDER BY f.rank
          LIMIT ?
        `,
        ...params
      )
      .map((row) => rowToEndpoint(row as Record<string, unknown>, (row as { score?: number }).score ?? null));
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.libraryId) {
    where.push("library_id = ?");
    params.push(query.libraryId);
  }
  if (method) {
    where.push("method = ?");
    params.push(method);
  }
  if (path) {
    where.push("path = ?");
    params.push(path);
  }
  if (operationId) {
    where.push("operation_id = ?");
    params.push(operationId);
  }

  params.push(limit);
  return database
    .all(
      `
        SELECT *
        FROM api_endpoints
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY path, method
        LIMIT ?
      `,
      ...params
    )
    .map((row) => rowToEndpoint(row as Record<string, unknown>, null));
}

export function countApiEndpoints(libraryId: string, db?: Database): number {
  const database = db ?? getDatabase();
  const row = database.get("SELECT COUNT(*) AS count FROM api_endpoints WHERE library_id = ?", libraryId) as
    | { count: number }
    | null;
  return row?.count ?? 0;
}

export function syncApiEndpointsToKnowledgeGraph(
  library: Library,
  endpoints: ApiEndpoint[],
  db?: Database
): void {
  const database = db ?? getDatabase();
  const libraryNode = getNodeByLibraryId(library.id, database) ??
    upsertNode(
      {
        type: "library",
        name: library.name,
        description: library.description ?? undefined,
        library_id: library.id,
        metadata: {
          slug: library.slug,
          source_type: library.source_type,
          source_url: library.source_url,
        },
      },
      database
    );

  deleteNodesForLibraryByType(library.id, "endpoint", database);

  for (const endpoint of endpoints) {
    const endpointNode = upsertNode(
      {
        type: "endpoint",
        name: `${library.slug} ${endpoint.method} ${endpoint.path}`,
        description: endpoint.summary ?? endpoint.description ?? endpoint.operation_id ?? undefined,
        library_id: library.id,
        metadata: {
          kind: "api_endpoint",
          endpoint_id: endpoint.id,
          library_slug: library.slug,
          method: endpoint.method,
          path: endpoint.path,
          operation_id: endpoint.operation_id,
          url: endpoint.url,
          tags: endpoint.tags,
          source_format: endpoint.source_format,
          request_schema_names: schemaNames(endpoint.request_body?.schemas),
          response_schema_names: Object.fromEntries(
            Object.entries(endpoint.responses).map(([status, response]) => [
              status,
              schemaNames(response.schemas),
            ])
          ),
        },
      },
      database
    );

    upsertEdge(
      {
        source_id: endpointNode.id,
        target_id: libraryNode.id,
        relation: "part_of",
        weight: 1,
        metadata: {
          endpoint_id: endpoint.id,
          method: endpoint.method,
          path: endpoint.path,
          operation_id: endpoint.operation_id,
        },
      },
      database
    );
  }
}

function insertApiEndpoint(
  input: ApiEndpointInput & { library_id: string; document_id: string },
  db: Database
): ApiEndpoint {
  const id = randomUUID();
  const now = new Date().toISOString();
  const method = input.method.trim().toUpperCase();
  const endpointKey = `${method} ${input.path}`;

  db.run(
    `INSERT INTO api_endpoints (
       id, library_id, document_id, url, endpoint_key, method, path, operation_id,
       summary, description, tags, parameters, request_body, responses,
       source_format, spec_version, api_version, content, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.library_id,
      input.document_id,
      input.url,
      endpointKey,
      method,
      input.path,
      input.operation_id ?? null,
      input.summary ?? null,
      input.description ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.parameters ?? []),
      input.request_body ? JSON.stringify(input.request_body) : null,
      JSON.stringify(input.responses ?? {}),
      input.source_format ?? "raw",
      input.spec_version ?? null,
      input.api_version ?? null,
      input.content,
      now,
      now,
    ]
  );

  return rowToEndpoint(db.get("SELECT * FROM api_endpoints WHERE id = ?", id) as Record<string, unknown>, null);
}

function schemaNames(schemas: Record<string, { name: string | null; ref: string | null }> | undefined): string[] {
  if (!schemas) return [];
  return Object.values(schemas)
    .map((schema) => schema.name ?? schema.ref)
    .filter((value): value is string => Boolean(value));
}

function rowToEndpoint(row: Record<string, unknown>, score: number | null): ApiEndpointSearchResult {
  return {
    id: row["id"] as string,
    library_id: row["library_id"] as string,
    document_id: row["document_id"] as string,
    url: row["url"] as string,
    method: row["method"] as string,
    path: row["path"] as string,
    operation_id: (row["operation_id"] as string | null) ?? null,
    summary: (row["summary"] as string | null) ?? null,
    description: (row["description"] as string | null) ?? null,
    tags: parseJsonArray<string>(row["tags"], []),
    parameters: parseJsonArray<ApiEndpointParameter>(row["parameters"], []),
    request_body: parseJsonValue<ApiEndpointRequestBody | null>(row["request_body"], null),
    responses: parseJsonValue<Record<string, ApiEndpointResponse>>(row["responses"], {}),
    source_format: (row["source_format"] as string | null) ?? "raw",
    spec_version: (row["spec_version"] as string | null) ?? null,
    api_version: (row["api_version"] as string | null) ?? null,
    content: row["content"] as string,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    score,
  };
}

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
  const parsed = parseJsonValue<unknown>(value, fallback);
  return Array.isArray(parsed) ? parsed as T[] : fallback;
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeLimit(limit: number | undefined): number {
  return Number.isFinite(limit) && limit && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
}

function escapeFts(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}*"`)
    .join(" ");
}
