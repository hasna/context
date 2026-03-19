import type { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";
import type { SearchResult } from "../types/index.js";

export type EmbeddingProvider = "openai" | "anthropic" | "none";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  apiKey: string;
}

export function getEmbeddingConfig(): EmbeddingConfig | null {
  const provider = (process.env["CONTEXT_EMBEDDING_PROVIDER"] ?? "none") as EmbeddingProvider;
  if (provider === "none") return null;

  if (provider === "openai") {
    const key = process.env["OPENAI_API_KEY"] ?? process.env["HASNAXYZ_OPENAI_LIVE_API_KEY"];
    if (!key) throw new Error("OPENAI_API_KEY required for OpenAI embeddings");
    return {
      provider: "openai",
      model: process.env["CONTEXT_EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      apiKey: key,
    };
  }

  if (provider === "anthropic") {
    // Anthropic uses voyage embeddings via their API
    const key =
      process.env["VOYAGE_API_KEY"] ??
      process.env["ANTHROPIC_API_KEY"] ??
      process.env["HASNAXYZ_ANTHROPIC_LIVE_API_KEY"];
    if (!key) throw new Error("VOYAGE_API_KEY or ANTHROPIC_API_KEY required for Anthropic embeddings");
    return {
      provider: "anthropic",
      model: process.env["CONTEXT_EMBEDDING_MODEL"] ?? "voyage-3-lite",
      apiKey: key,
    };
  }

  return null;
}

/**
 * Generate an embedding vector for a piece of text.
 */
export async function embedText(
  text: string,
  config: EmbeddingConfig
): Promise<Float32Array> {
  if (config.provider === "openai") {
    return embedOpenAI(text, config);
  }
  if (config.provider === "anthropic") {
    return embedVoyage(text, config);
  }
  throw new Error(`Unknown embedding provider: ${config.provider}`);
}

async function embedOpenAI(
  text: string,
  config: EmbeddingConfig
): Promise<Float32Array> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: text.slice(0, 8192),
      model: config.model,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embeddings error: ${err}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return new Float32Array(data.data[0]!.embedding);
}

async function embedVoyage(
  text: string,
  config: EmbeddingConfig
): Promise<Float32Array> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: [text.slice(0, 16000)],
      model: config.model,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage embeddings error: ${err}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return new Float32Array(data.data[0]!.embedding);
}

/**
 * Store an embedding for a chunk.
 */
export function saveEmbedding(
  chunkId: string,
  model: string,
  embedding: Float32Array,
  db?: Database
): void {
  const database = db ?? getDatabase();
  const blob = Buffer.from(embedding.buffer);
  const now = new Date().toISOString();

  database.run(
    `INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, embedding, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [chunkId, model, blob, embedding.length, now]
  );
}

/**
 * Retrieve an embedding for a chunk.
 */
export function getEmbedding(
  chunkId: string,
  db?: Database
): Float32Array | null {
  const database = db ?? getDatabase();
  const row = database
    .query<{ embedding: Buffer; dimensions: number }, [string]>(
      "SELECT embedding, dimensions FROM chunk_embeddings WHERE chunk_id = ?"
    )
    .get(chunkId);

  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic search: find top-k chunks most similar to query embedding.
 */
export function semanticSearch(
  queryEmbedding: Float32Array,
  libraryId: string | undefined,
  limit: number,
  db?: Database
): SearchResult[] {
  const database = db ?? getDatabase();

  let sql: string;
  let params: string[];

  if (libraryId) {
    sql = `
      SELECT ce.chunk_id, c.library_id, c.document_id, c.content,
             d.url, d.title, ce.embedding, ce.dimensions
      FROM chunk_embeddings ce
      JOIN chunks c ON c.id = ce.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE c.library_id = ?
    `;
    params = [libraryId];
  } else {
    sql = `
      SELECT ce.chunk_id, c.library_id, c.document_id, c.content,
             d.url, d.title, ce.embedding, ce.dimensions
      FROM chunk_embeddings ce
      JOIN chunks c ON c.id = ce.chunk_id
      JOIN documents d ON d.id = c.document_id
    `;
    params = [];
  }

  const rows = database
    .query<
      {
        chunk_id: string;
        library_id: string;
        document_id: string;
        content: string;
        url: string | null;
        title: string | null;
        embedding: Buffer;
        dimensions: number;
      },
      string[]
    >(sql)
    .all(...params);

  const scored = rows.map((row) => {
    const vec = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.dimensions
    );
    const score = cosineSimilarity(queryEmbedding, vec);
    return {
      chunk_id: row.chunk_id,
      library_id: row.library_id,
      document_id: row.document_id,
      content: row.content,
      url: row.url,
      title: row.title,
      score,
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Check how many chunks have embeddings for a library.
 */
export function embeddingCoverage(
  libraryId: string,
  db?: Database
): { total: number; embedded: number } {
  const database = db ?? getDatabase();
  const total =
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM chunks WHERE library_id = ?"
      )
      .get(libraryId)?.count ?? 0;
  const embedded =
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM chunk_embeddings ce
         JOIN chunks c ON c.id = ce.chunk_id WHERE c.library_id = ?`
      )
      .get(libraryId)?.count ?? 0;
  return { total, embedded };
}
