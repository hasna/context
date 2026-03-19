import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { createLibrary } from "./libraries.js";
import { upsertDocument } from "./documents.js";
import {
  insertChunk,
  deleteChunksForDocument,
  deleteChunksForLibrary,
  searchChunks,
  countChunks,
} from "./chunks.js";

let libraryId: string;
let documentId: string;

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
  const lib = createLibrary({ name: "TestLib" });
  libraryId = lib.id;
  const doc = upsertDocument({ library_id: libraryId, url: "https://test.com", title: "Test" });
  documentId = doc.id;
});

afterEach(() => {
  resetDatabase();
});

describe("insertChunk", () => {
  it("inserts a chunk and indexes it in FTS", () => {
    const chunk = insertChunk({
      library_id: libraryId,
      document_id: documentId,
      content: "React hooks allow you to use state in functional components.",
      position: 0,
    });
    expect(chunk.content).toContain("React hooks");
    expect(chunk.position).toBe(0);
  });

  it("inserts multiple chunks with positions", () => {
    for (let i = 0; i < 5; i++) {
      insertChunk({
        library_id: libraryId,
        document_id: documentId,
        content: `Content chunk number ${i} with some text to search.`,
        position: i,
        token_count: 20,
      });
    }
    expect(countChunks(libraryId)).toBe(5);
  });
});

describe("searchChunks", () => {
  beforeEach(() => {
    insertChunk({
      library_id: libraryId,
      document_id: documentId,
      content: "useState is a React hook for managing component state.",
      position: 0,
    });
    insertChunk({
      library_id: libraryId,
      document_id: documentId,
      content: "useEffect runs side effects in React functional components.",
      position: 1,
    });
    insertChunk({
      library_id: libraryId,
      document_id: documentId,
      content: "Express routing middleware handles HTTP requests.",
      position: 2,
    });
  });

  it("finds relevant chunks by keyword", () => {
    const results = searchChunks("useState");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("useState");
  });

  it("filters by library_id", () => {
    const lib2 = createLibrary({ name: "AnotherLib" });
    const doc2 = upsertDocument({ library_id: lib2.id, url: "https://other.com" });
    insertChunk({
      library_id: lib2.id,
      document_id: doc2.id,
      content: "useState in another library context.",
      position: 0,
    });

    const results = searchChunks("useState", libraryId);
    expect(results.every((r) => r.library_id === libraryId)).toBe(true);
  });

  it("returns empty for no matches", () => {
    const results = searchChunks("nonexistentterm12345");
    expect(results).toHaveLength(0);
  });
});

describe("deleteChunksForDocument", () => {
  it("deletes chunks and FTS entries", () => {
    insertChunk({
      library_id: libraryId,
      document_id: documentId,
      content: "Some content to delete.",
      position: 0,
    });
    expect(countChunks(libraryId)).toBe(1);
    deleteChunksForDocument(documentId);
    expect(countChunks(libraryId)).toBe(0);

    // FTS should also be empty
    const db = getDatabase();
    const ftsCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks_fts")
      .get()?.count ?? 0;
    expect(ftsCount).toBe(0);
  });
});

describe("deleteChunksForLibrary", () => {
  it("deletes all chunks for a library", () => {
    const doc2 = upsertDocument({ library_id: libraryId, url: "https://test2.com" });
    for (let i = 0; i < 3; i++) {
      insertChunk({
        library_id: libraryId,
        document_id: i === 0 ? documentId : doc2.id,
        content: `Chunk ${i} content.`,
        position: i,
      });
    }
    expect(countChunks(libraryId)).toBe(3);
    deleteChunksForLibrary(libraryId);
    expect(countChunks(libraryId)).toBe(0);
  });
});
