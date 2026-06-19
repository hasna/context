import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { getLibraryById } from "../db/libraries.js";
import {
  embedText,
  embeddingCoverage,
  getEmbeddingConfig,
  saveEmbedding,
  type EmbeddingProvider,
} from "../db/embeddings.js";

export interface EmbedLibraryChunksOptions {
  all?: boolean;
  limit?: number;
  onProgress?: (progress: { done: number; total: number; failed: number }) => void;
}

export interface EmbedLibraryChunksReport {
  generated_at: string;
  library_id: string;
  library_slug: string;
  library_name: string;
  provider: EmbeddingProvider;
  model: string;
  total_chunks: number;
  previously_embedded: number;
  selected_chunks: number;
  embedded_count: number;
  failed_count: number;
  failures: Array<{ chunk_id: string; error: string }>;
}

export async function embedLibraryChunks(
  libraryId: string,
  options: EmbedLibraryChunksOptions = {},
  db?: Database
): Promise<EmbedLibraryChunksReport> {
  const database = db ?? getDatabase();
  const library = getLibraryById(libraryId, database);
  const config = getEmbeddingConfig();
  if (!config) {
    throw new Error("Set CONTEXT_EMBEDDING_PROVIDER=openai|voyage to enable embeddings");
  }

  const coverage = embeddingCoverage(library.id, database);
  let sql = "SELECT id, content FROM chunks WHERE library_id = ?";
  const params: Array<string | number> = [library.id];
  if (!options.all) {
    sql += " AND id NOT IN (SELECT chunk_id FROM chunk_embeddings)";
  }
  sql += " ORDER BY position ASC";
  if (options.limit !== undefined && options.limit > 0) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const chunks = database.all(sql, ...params) as Array<{ id: string; content: string }>;
  let embedded = 0;
  let failed = 0;
  const failures: Array<{ chunk_id: string; error: string }> = [];

  for (const chunk of chunks) {
    try {
      const vec = await embedText(chunk.content, config);
      saveEmbedding(chunk.id, config.model, vec, database);
      embedded++;
    } catch (error) {
      failed++;
      failures.push({
        chunk_id: chunk.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    options.onProgress?.({ done: embedded, total: chunks.length, failed });
  }

  return {
    generated_at: new Date().toISOString(),
    library_id: library.id,
    library_slug: library.slug,
    library_name: library.name,
    provider: config.provider,
    model: config.model,
    total_chunks: coverage.total,
    previously_embedded: coverage.embedded,
    selected_chunks: chunks.length,
    embedded_count: embedded,
    failed_count: failed,
    failures,
  };
}
