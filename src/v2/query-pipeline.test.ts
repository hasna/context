import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { replaceDocumentApiEndpoints } from "../db/api-endpoints.js";
import { insertChunk } from "../db/chunks.js";
import { upsertDocument } from "../db/documents.js";
import { createLibrary, updateLibraryCounts } from "../db/libraries.js";
import { buildV2ContextPack } from "./query-pipeline.js";
import { createKnowledgeSubstrateAdapterBoundary, toKnowledgeSubstrateContextPack } from "./open-knowledge-adapter.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
});

describe("v2 context pack pipeline", () => {
  it("builds cited context from existing v1 chunks and API endpoint rows", async () => {
    const { library } = seedV1Docs();

    const pack = await buildV2ContextPack({
      prompt: "latest widget API create authentication",
      library: library.slug,
      limit: 3,
      endpointLimit: 3,
    });

    expect(pack.schema_version).toBe(2);
    expect(pack.intent.wants_latest).toBe(true);
    expect(pack.intent.needs_api).toBe(true);
    expect(pack.resolved_library?.slug).toBe(library.slug);
    expect(pack.freshness.state).toBe("fresh");
    expect(pack.evidence.some((item) => item.channel === "fts")).toBe(true);
    expect(pack.evidence.some((item) => item.channel === "api")).toBe(true);
    expect(pack.citations.length).toBeGreaterThanOrEqual(2);
    expect(pack.citations.some((citation) => citation.source_url === "https://docs.example.com/widgets")).toBe(true);
    expect(pack.context_text).toContain("# Open Context v2 Context Pack");
    expect(pack.context_text).toContain("POST /widgets");
    expect(pack.synthesis.status).toBe("not_run");
    expect(pack.citation_verification.verified).toBe(true);
  });

  it("warns when latest/current queries hit an empty library", async () => {
    const library = createLibrary({
      name: "Empty Latest Docs",
      slug: "empty-latest-docs",
      docs_url: "https://docs.example.com/empty",
    });

    const pack = await buildV2ContextPack({
      prompt: "what is the latest empty docs API",
      library: library.slug,
    });

    expect(pack.freshness.state).toBe("empty");
    expect(pack.warnings.join("\n")).toContain("latest/current");
    expect(pack.context_text).toContain("Freshness: empty");
  });

  it("accepts synthesis and citation verification hooks without letting them create evidence", async () => {
    const { library } = seedV1Docs();

    const pack = await buildV2ContextPack({
      prompt: "create widget",
      library: library.slug,
      hooks: {
        synthesize: (contextPack) => ({
          status: "complete",
          text: `Use cited evidence ${contextPack.citations[0]?.id}.`,
          cited_evidence_ids: contextPack.citations.slice(0, 1).map((citation) => citation.evidence_id),
          warnings: [],
          provider: "test",
          model: "deterministic",
        }),
        verifyCitations: (contextPack) => ({
          verified: contextPack.citations.length > 0,
          checked_at: "2026-01-01T00:00:00.000Z",
          missing_citations: [],
          warnings: [],
        }),
      },
    });

    expect(pack.synthesis.status).toBe("complete");
    expect(pack.synthesis.cited_evidence_ids).toHaveLength(1);
    expect(pack.evidence.length).toBeGreaterThan(0);
    expect(pack.citation_verification.checked_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("maps v2 packs to the open-knowledge-compatible adapter boundary", async () => {
    const { library } = seedV1Docs();
    const pack = await buildV2ContextPack({
      prompt: "widget authentication",
      library: library.slug,
    });
    const substratePack = toKnowledgeSubstrateContextPack(pack);
    const adapter = createKnowledgeSubstrateAdapterBoundary();
    const stored = await adapter.putContextPack(pack);

    expect(substratePack.query).toBe(pack.query);
    expect(substratePack.results.length).toBe(pack.evidence.length);
    expect(substratePack.citations[0]?.source_uri).toBe("https://docs.example.com/widgets");
    expect(substratePack.excerpts[0]?.text).toContain("authentication token");
    expect(stored.stored).toBe(false);
    expect(stored.context_pack.results.length).toBe(pack.evidence.length);
  });
});

function seedV1Docs() {
  const library = createLibrary({
    name: "Widget API",
    slug: "widget-api",
    version: "2026-06",
    docs_url: "https://docs.example.com/widgets",
    source_type: "openapi",
    freshness_days: 7,
  });
  const document = upsertDocument({
    library_id: library.id,
    url: "https://docs.example.com/widgets",
    title: "Widgets",
    source_type: "openapi",
    content_hash: "sha256:test",
    file_path: "docs/widget-api/widgets.md",
    metadata: {
      refreshed_at: new Date().toISOString(),
    },
  });
  insertChunk({
    library_id: library.id,
    document_id: document.id,
    position: 0,
    content: "Widget API requests require an authentication token and a widget name.",
  });
  replaceDocumentApiEndpoints({
    library_id: library.id,
    document_id: document.id,
    endpoints: [
      {
        url: "https://docs.example.com/widgets",
        method: "POST",
        path: "/widgets",
        operation_id: "createWidget",
        summary: "Create widget",
        tags: ["widgets"],
        responses: { "201": { description: "Widget created" } },
        source_format: "openapi",
        content: "POST /widgets creates a widget from a JSON body.",
      },
    ],
  });
  updateLibraryCounts(library.id);
  return { library, document };
}
