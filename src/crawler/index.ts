import type { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import { getLibraryById, updateLibraryCounts } from "../db/libraries.js";
import { upsertDocument } from "../db/documents.js";
import {
  insertChunk,
  deleteChunksForDocument,
  deleteChunksForLibrary,
} from "../db/chunks.js";
import { discoverDocs } from "./exa.js";
import { cleanText, splitIntoChunks, estimateTokens } from "./parser.js";
import type { CrawlResult } from "../types/index.js";

export interface CrawlOptions {
  maxPages?: number;
  refresh?: boolean;
}

/**
 * Crawl and index documentation for a library.
 * Discovers pages via Exa, parses content, stores chunks in SQLite.
 */
export async function crawlLibrary(
  libraryId: string,
  options: CrawlOptions = {},
  db?: Database
): Promise<CrawlResult> {
  const database = db ?? getDatabase();
  const library = getLibraryById(libraryId, database);

  const result: CrawlResult = {
    library_id: libraryId,
    pages_crawled: 0,
    chunks_indexed: 0,
    errors: [],
  };

  if (options.refresh) {
    deleteChunksForLibrary(libraryId, database);
  }

  let pages;
  try {
    pages = await discoverDocs({
      name: library.name,
      npm_package: library.npm_package,
      docs_url: library.docs_url,
      github_repo: library.github_repo,
      maxPages: options.maxPages ?? 30,
    });
  } catch (err) {
    result.errors.push(
      `Failed to discover docs: ${err instanceof Error ? err.message : String(err)}`
    );
    return result;
  }

  for (const page of pages) {
    try {
      const cleaned = cleanText(page.text);
      if (!cleaned || cleaned.length < 100) continue;

      const doc = upsertDocument(
        {
          library_id: libraryId,
          url: page.url,
          title: page.title ?? undefined,
          content: cleaned,
        },
        database
      );

      // Re-index chunks for this document
      deleteChunksForDocument(doc.id, database);

      const chunks = splitIntoChunks(cleaned);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        insertChunk(
          {
            library_id: libraryId,
            document_id: doc.id,
            content: chunk,
            position: i,
            token_count: estimateTokens(chunk),
          },
          database
        );
        result.chunks_indexed++;
      }

      result.pages_crawled++;
    } catch (err) {
      result.errors.push(
        `Error processing ${page.url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  updateLibraryCounts(libraryId, database);

  return result;
}
