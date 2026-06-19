import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { createLibrary } from "../db/libraries.js";
import { upsertDocument } from "../db/documents.js";
import { insertChunk } from "../db/chunks.js";
import { replaceDocumentApiEndpoints } from "../db/api-endpoints.js";
import { askDocs, buildDocsContext } from "./docs-context.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
});

describe("docs context builder", () => {
  it("builds a context pack from indexed chunks and API endpoints", () => {
    const { library } = seedDocsContext();

    const context = buildDocsContext({
      prompt: "create widget authentication",
      library: library.slug,
      limit: 3,
      endpointLimit: 3,
    });

    expect(context.library?.slug).toBe("docs-context-api");
    expect(context.chunks).toHaveLength(1);
    expect(context.chunks[0]?.content).toContain("authentication token");
    expect(context.endpoints).toHaveLength(1);
    expect(context.endpoints[0]?.operation_id).toBe("createWidget");
    expect(context.context_text).toContain("Documentation Context");
    expect(context.context_text).toContain("POST /widgets");
  });

  it("selects versioned docs when a version is required", () => {
    const v18 = seedDocsContext({
      name: "React",
      slug: "react-18",
      version: "18.2.0",
      content: "React 18 legacy root documentation covers createRoot migration details.",
    });
    seedDocsContext({
      name: "React",
      slug: "react-19",
      version: "19.0.0",
      content: "React 19 documentation covers actions and modern form APIs.",
    });

    const context = buildDocsContext({
      prompt: "legacy root",
      library: "react",
      version: "18",
      limit: 3,
      endpointLimit: 0,
    });

    expect(context.library?.slug).toBe(v18.library.slug);
    expect(context.library?.version).toBe("18.2.0");
    expect(context.context_text).toContain("Version: 18.2.0");
    expect(context.chunks[0]?.content).toContain("React 18 legacy root");
  });

  it("can answer with an injected AI SDK generator", async () => {
    const { library } = seedDocsContext();

    const result = await askDocs({
      prompt: "How do I create a widget?",
      library: library.slug,
      generate: async ({ prompt }) => ({
        provider: "xai",
        model: "test-model",
        text: prompt.includes("createWidget") ? "Use POST /widgets." : "missing",
      }),
    });

    expect(result.provider).toBe("xai");
    expect(result.model).toBe("test-model");
    expect(result.text).toBe("Use POST /widgets.");
    expect(result.context.endpoints[0]?.path).toBe("/widgets");
  });
});

function seedDocsContext(input: {
  name?: string;
  slug?: string;
  version?: string;
  content?: string;
} = {}) {
  const library = createLibrary({
    name: input.name ?? "Docs Context API",
    slug: input.slug,
    version: input.version,
    docs_url: "https://docs.example.com/api",
    source_type: "api",
  });
  const document = upsertDocument({
    library_id: library.id,
    url: "https://docs.example.com/api/widgets",
    title: "Widgets",
    source_type: "api",
  });
  insertChunk({
    library_id: library.id,
    document_id: document.id,
    position: 0,
    content: input.content ?? "Create widget requests require an authentication token and a widget name.",
  });
  replaceDocumentApiEndpoints({
    library_id: library.id,
    document_id: document.id,
    endpoints: [
      {
        url: "https://docs.example.com/api/widgets",
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

  return { library, document };
}
