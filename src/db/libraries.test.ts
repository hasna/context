import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import {
  createLibrary,
  getLibraryById,
  getLibraryBySlug,
  resolveLibraryReference,
  listLibraries,
  searchLibraries,
  deleteLibrary,
  updateLibraryCounts,
  updateLibraryMetadata,
} from "./libraries.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
});

describe("createLibrary", () => {
  it("creates a library with auto slug", () => {
    const lib = createLibrary({ name: "React" });
    expect(lib.name).toBe("React");
    expect(lib.slug).toBe("react");
    expect(lib.source_type).toBe("docs");
    expect(lib.source_url).toBeNull();
    expect(lib.chunk_count).toBe(0);
    expect(lib.document_count).toBe(0);
  });

  it("creates a library with explicit slug", () => {
    const lib = createLibrary({ name: "Next.js", slug: "nextjs" });
    expect(lib.slug).toBe("nextjs");
  });

  it("creates a library with all fields", () => {
    const lib = createLibrary({
      name: "Express",
      npm_package: "express",
      github_repo: "expressjs/express",
      docs_url: "https://expressjs.com",
      description: "Fast web framework",
    });
    expect(lib.npm_package).toBe("express");
    expect(lib.github_repo).toBe("expressjs/express");
    expect(lib.docs_url).toBe("https://expressjs.com");
    expect(lib.description).toBe("Fast web framework");
    expect(lib.source_type).toBe("docs");
    expect(lib.source_url).toBe("https://expressjs.com");
  });

  it("normalizes explicit source metadata", () => {
    const lib = createLibrary({
      name: "Example API",
      docs_url: "https://example.com/swagger.yaml",
      source_type: "open-api",
      freshness_days: 3,
      priority: 20,
    });
    expect(lib.source_type).toBe("openapi");
    expect(lib.source_url).toBe("https://example.com/swagger.yaml");
    expect(lib.freshness_days).toBe(3);
    expect(lib.priority).toBe(20);
  });

  it("throws on unknown source types", () => {
    expect(() =>
      createLibrary({
        name: "Bad Source",
        docs_url: "https://example.com/docs",
        source_type: "whatever",
      })
    ).toThrow("Unknown documentation source type");
  });

  it("throws on invalid documentation URLs before storing source metadata", () => {
    expect(() =>
      createLibrary({
        name: "Bad URL",
        docs_url: "not-a-url",
      })
    ).toThrow('Invalid docs_url "not-a-url"');
  });

  it("throws on duplicate slug", () => {
    createLibrary({ name: "React" });
    expect(() => createLibrary({ name: "React" })).toThrow();
  });
});

describe("getLibraryBySlug", () => {
  it("retrieves by slug", () => {
    createLibrary({ name: "Vue" });
    const lib = getLibraryBySlug("vue");
    expect(lib.name).toBe("Vue");
  });

  it("throws on not found", () => {
    expect(() => getLibraryBySlug("nonexistent")).toThrow();
  });
});

describe("getLibraryById", () => {
  it("retrieves by id", () => {
    const created = createLibrary({ name: "Svelte" });
    const found = getLibraryById(created.id);
    expect(found.name).toBe("Svelte");
  });
});

describe("listLibraries", () => {
  it("returns empty list initially", () => {
    expect(listLibraries()).toHaveLength(0);
  });

  it("returns all libraries sorted by name", () => {
    createLibrary({ name: "Zustand" });
    createLibrary({ name: "Axios" });
    createLibrary({ name: "React" });
    const libs = listLibraries();
    expect(libs).toHaveLength(3);
    expect(libs[0]!.name).toBe("Axios");
    expect(libs[1]!.name).toBe("React");
    expect(libs[2]!.name).toBe("Zustand");
  });
});

describe("searchLibraries", () => {
  it("finds by name", () => {
    createLibrary({ name: "React" });
    createLibrary({ name: "Vue" });
    const results = searchLibraries("react");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe("React");
  });

  it("finds by npm_package", () => {
    createLibrary({ name: "Next.js", slug: "nextjs", npm_package: "next" });
    const results = searchLibraries("next");
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds and resolves versioned documentation libraries", () => {
    createLibrary({
      name: "React",
      slug: "react-18",
      version: "18.2.0",
      docs_url: "https://react.dev/v18",
    });
    createLibrary({
      name: "React",
      slug: "react-19",
      version: "19.0.0",
      docs_url: "https://react.dev/v19",
    });

    expect(searchLibraries("react 18")[0]?.slug).toBe("react-18");
    expect(resolveLibraryReference("react", { version: "18" }).slug).toBe("react-18");
    expect(resolveLibraryReference("/context/react-19@19").slug).toBe("react-19");
    expect(() => resolveLibraryReference("react-19", { version: "18" })).toThrow("not found");
  });
});

describe("deleteLibrary", () => {
  it("deletes a library", () => {
    const lib = createLibrary({ name: "ToDelete" });
    deleteLibrary(lib.id);
    expect(listLibraries()).toHaveLength(0);
  });
});

describe("updateLibraryCounts", () => {
  it("updates counts after docs/chunks added", () => {
    const lib = createLibrary({ name: "Test" });
    const db = getDatabase();

    // Manually insert a document
    const docId = "test-doc-id";
    db.run(
      "INSERT INTO documents (id, library_id, url, created_at) VALUES (?, ?, ?, ?)",
      [docId, lib.id, "https://example.com", new Date().toISOString()]
    );

    updateLibraryCounts(lib.id);
    const updated = getLibraryById(lib.id);
    expect(updated.document_count).toBe(1);
  });
});

describe("updateLibraryMetadata", () => {
  it("reconciles source metadata for an existing library", () => {
    const lib = createLibrary({
      name: "Seeded API",
      docs_url: "https://old.example.com/docs",
      source_type: "docs",
      freshness_days: 7,
      priority: 0,
    });

    const updated = updateLibraryMetadata(lib.id, {
      name: "Seeded API",
      description: "Updated API docs",
      docs_url: "https://new.example.com/openapi.json",
      source_type: "openapi",
      freshness_days: 1,
      priority: 25,
    });

    expect(updated.description).toBe("Updated API docs");
    expect(updated.docs_url).toBe("https://new.example.com/openapi.json");
    expect(updated.source_url).toBe("https://new.example.com/openapi.json");
    expect(updated.source_type).toBe("openapi");
    expect(updated.freshness_days).toBe(1);
    expect(updated.priority).toBe(25);
  });
});
