import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { createLibrary } from "./libraries.js";
import { upsertDocument } from "./documents.js";
import { insertChunk } from "./chunks.js";
import {
  saveEmbedding,
  getEmbedding,
  cosineSimilarity,
  semanticSearch,
  embeddingCoverage,
} from "./embeddings.js";

let libraryId: string;
let chunkId: string;

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
  const lib = createLibrary({ name: "EmbedTest" });
  libraryId = lib.id;
  const doc = upsertDocument({ library_id: libraryId, url: "https://test.com" });
  const chunk = insertChunk({
    library_id: libraryId,
    document_id: doc.id,
    content: "React useState hook for state management.",
    position: 0,
  });
  chunkId = chunk.id;
});

afterEach(() => {
  resetDatabase();
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 0, 0, 1]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns close to 1 for similar vectors", () => {
    const a = new Float32Array([0.9, 0.1]);
    const b = new Float32Array([0.8, 0.2]);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.95);
  });

  it("handles zero vector", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles mismatched lengths", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe("saveEmbedding / getEmbedding", () => {
  it("saves and retrieves embedding", () => {
    const vec = new Float32Array([0.1, 0.5, -0.3, 0.8]);
    saveEmbedding(chunkId, "test-model", vec);
    const retrieved = getEmbedding(chunkId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(4);
    for (let i = 0; i < vec.length; i++) {
      expect(retrieved![i]!).toBeCloseTo(vec[i]!);
    }
  });

  it("returns null for missing embedding", () => {
    expect(getEmbedding("nonexistent")).toBeNull();
  });

  it("replaces embedding on upsert", () => {
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0, 1]);
    saveEmbedding(chunkId, "model", v1);
    saveEmbedding(chunkId, "model", v2);
    const retrieved = getEmbedding(chunkId);
    expect(retrieved![0]!).toBeCloseTo(0);
    expect(retrieved![1]!).toBeCloseTo(1);
  });
});

describe("semanticSearch", () => {
  it("finds top matching chunks by cosine similarity", () => {
    // Insert more chunks with distinct embeddings
    const lib = createLibrary({ name: "SemanticTest" });
    const doc = upsertDocument({ library_id: lib.id, url: "https://semantic.com" });

    const chunk1 = insertChunk({
      library_id: lib.id,
      document_id: doc.id,
      content: "useState hook in React",
      position: 0,
    });
    const chunk2 = insertChunk({
      library_id: lib.id,
      document_id: doc.id,
      content: "Express routing middleware",
      position: 1,
    });

    // "React" direction: [1, 0], "Express" direction: [0, 1]
    saveEmbedding(chunk1.id, "test", new Float32Array([1, 0, 0]));
    saveEmbedding(chunk2.id, "test", new Float32Array([0, 1, 0]));

    // Query close to "React"
    const query = new Float32Array([0.9, 0.1, 0]);
    const results = semanticSearch(query, lib.id, 2);

    expect(results).toHaveLength(2);
    expect(results[0]!.chunk_id).toBe(chunk1.id);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });
});

describe("embeddingCoverage", () => {
  it("reports correct coverage", () => {
    const { total, embedded } = embeddingCoverage(libraryId);
    expect(total).toBe(1);
    expect(embedded).toBe(0);

    saveEmbedding(chunkId, "model", new Float32Array([1, 0]));
    const after = embeddingCoverage(libraryId);
    expect(after.embedded).toBe(1);
  });
});
