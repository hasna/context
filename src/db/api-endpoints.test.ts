import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase } from "./database.js";
import { createLibrary, getLibraryById } from "./libraries.js";
import { upsertDocument } from "./documents.js";
import {
  countApiEndpoints,
  deleteApiEndpointsForDocument,
  listApiEndpoints,
  replaceDocumentApiEndpoints,
  syncApiEndpointsToKnowledgeGraph,
} from "./api-endpoints.js";
import { getNodeByLibraryId, getRelatedNodes, searchNodes } from "./kg.js";

let libraryId: string;
let documentId: string;

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
  const library = createLibrary({ name: "Endpoint API", source_type: "openapi" });
  libraryId = library.id;
  const document = upsertDocument({
    library_id: library.id,
    url: "https://api.example.com/openapi.yaml",
    title: "Endpoint API",
    source_type: "openapi",
  });
  documentId = document.id;
});

afterEach(() => {
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
});

describe("api endpoint catalog", () => {
  it("stores and searches OpenAPI endpoints as first-class rows", () => {
    replaceDocumentApiEndpoints({
      library_id: libraryId,
      document_id: documentId,
      endpoints: [
        {
          url: "https://api.example.com/openapi.yaml",
          method: "post",
          path: "/widgets",
          operation_id: "createWidget",
          summary: "Create widget",
          tags: ["widgets"],
          parameters: [
            {
              name: "workspace_id",
              in: "query",
              required: true,
              description: "Workspace identifier",
              schema: {
                name: null,
                type: "string",
                ref: null,
                description: null,
                required: [],
                properties: [],
              },
            },
          ],
          request_body: {
            required: true,
            description: "Widget create payload",
            content_types: ["application/json"],
            schemas: {
              "application/json": {
                name: "WidgetCreate",
                type: "object",
                ref: "#/components/schemas/WidgetCreate",
                description: null,
                required: ["name"],
                properties: [
                  {
                    name: "name",
                    type: "string",
                    ref: null,
                    description: "Display name",
                    required: true,
                  },
                ],
              },
            },
          },
          responses: { "201": { description: "Widget created" } },
          source_format: "yaml",
          spec_version: "3.1.0",
          api_version: "2026-06-16",
          content: "### POST /widgets\nOperation ID: createWidget\nCreate widget",
        },
      ],
    });

    expect(countApiEndpoints(libraryId)).toBe(1);

    const byOperation = listApiEndpoints({ libraryId, operationId: "createWidget" });
    expect(byOperation).toHaveLength(1);
    expect(byOperation[0]?.method).toBe("POST");
    expect(byOperation[0]?.source_format).toBe("yaml");
    expect(byOperation[0]?.parameters[0]?.name).toBe("workspace_id");
    expect(byOperation[0]?.parameters[0]?.schema?.type).toBe("string");
    expect(byOperation[0]?.request_body?.schemas?.["application/json"]?.name).toBe("WidgetCreate");
    expect(byOperation[0]?.request_body?.schemas?.["application/json"]?.properties[0]?.required).toBe(true);

    const byPath = listApiEndpoints({ libraryId, method: "POST", path: "/widgets" });
    expect(byPath[0]?.operation_id).toBe("createWidget");

    const byText = listApiEndpoints({ libraryId, query: "createWidget" });
    expect(byText[0]?.path).toBe("/widgets");
  });

  it("deletes endpoint FTS rows with the document endpoint rows", () => {
    replaceDocumentApiEndpoints({
      library_id: libraryId,
      document_id: documentId,
      endpoints: [
        {
          url: "https://api.example.com/openapi.yaml",
          method: "GET",
          path: "/widgets",
          operation_id: "listWidgets",
          content: "### GET /widgets\nOperation ID: listWidgets",
        },
      ],
    });

    deleteApiEndpointsForDocument(documentId);

    expect(countApiEndpoints(libraryId)).toBe(0);
    expect(listApiEndpoints({ libraryId, query: "listWidgets" })).toHaveLength(0);
    const ftsCount = getDatabase().get("SELECT COUNT(*) AS count FROM api_endpoints_fts") as
      | { count: number }
      | null;
    expect(ftsCount?.count ?? 0).toBe(0);
  });

  it("syncs API endpoints into the knowledge graph", () => {
    const [endpoint] = replaceDocumentApiEndpoints({
      library_id: libraryId,
      document_id: documentId,
      endpoints: [
        {
          url: "https://api.example.com/openapi.yaml",
          method: "POST",
          path: "/widgets",
          operation_id: "createWidget",
          summary: "Create widget",
          tags: ["widgets"],
          content: "### POST /widgets\nOperation ID: createWidget",
        },
      ],
    });
    expect(endpoint).toBeDefined();

    syncApiEndpointsToKnowledgeGraph(getLibraryById(libraryId), [endpoint!]);

    const libraryNode = getNodeByLibraryId(libraryId);
    expect(libraryNode).not.toBeNull();
    const related = getRelatedNodes(libraryNode!.id, "part_of");
    const endpointRelation = related.relations.find((relation) => relation.node.type === "endpoint");
    expect(endpointRelation?.direction).toBe("incoming");
    expect(endpointRelation?.node.metadata["operation_id"]).toBe("createWidget");

    const endpointNodes = searchNodes("POST /widgets");
    expect(endpointNodes.some((node) => node.type === "endpoint")).toBe(true);
  });
});
