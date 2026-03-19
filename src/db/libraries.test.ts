import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import {
  createLibrary,
  getLibraryById,
  getLibraryBySlug,
  listLibraries,
  searchLibraries,
  deleteLibrary,
  updateLibraryCounts,
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
