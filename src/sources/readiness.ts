import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { getRefreshPlan } from "../db/update-tasks.js";
import { getLibraryBySlug, listLibraries } from "../db/libraries.js";
import { listDocumentArtifacts } from "../docs/artifacts.js";
import type { Library } from "../types/index.js";
import { canRefreshSourceNatively, getDocumentationSource } from "./index.js";

export type SourceReadinessSeverity = "info" | "warning" | "error";

export interface SourceReadinessIssue {
  code: string;
  severity: SourceReadinessSeverity;
  message: string;
}

export interface LibrarySourceReadiness {
  library_id: string;
  library_slug: string;
  library_name: string;
  source_type: string;
  source_name: string;
  source_url: string | null;
  native_ingest: string;
  can_refresh_natively: boolean;
  can_refresh_without_external_retriever: boolean;
  /** @deprecated Use can_refresh_without_external_retriever. */
  can_refresh_without_external_crawler: boolean;
  requires_external_retriever: boolean;
  /** @deprecated Use requires_external_retriever. */
  requires_external_crawler: boolean;
  external_retriever_keys_configured: {
    exa: boolean;
    firecrawl: boolean;
  };
  /** @deprecated Use external_retriever_keys_configured. */
  crawler_keys_configured: {
    exa: boolean;
    firecrawl: boolean;
  };
  documents: number;
  chunks: number;
  artifacts: number;
  due_reason: string | null;
  next_check_at: string | null;
  issues: SourceReadinessIssue[];
}

export interface SourceReadinessReport {
  generated_at: string;
  totals: {
    libraries: number;
    ready_for_native_refresh: number;
    requiring_external_retriever: number;
    /** @deprecated Use requiring_external_retriever. */
    requiring_external_crawler: number;
    indexed: number;
    with_artifacts: number;
    with_errors: number;
    due: number;
  };
  libraries: LibrarySourceReadiness[];
}

export function getSourceReadinessReport(
  options: { slug?: string } = {},
  db?: Database
): SourceReadinessReport {
  const database = db ?? getDatabase();
  const libraries = options.slug
    ? [getLibraryBySlug(options.slug, database)]
    : listLibraries(database);
  const dueByLibrary = new Map(
    getRefreshPlan({ slug: options.slug }, database).map((item) => [item.library.id, item.reason])
  );
  const rows = libraries.map((library) =>
    getLibrarySourceReadiness(library, dueByLibrary.get(library.id) ?? null)
  );

  return {
    generated_at: new Date().toISOString(),
    totals: {
      libraries: rows.length,
      ready_for_native_refresh: rows.filter((row) => row.can_refresh_natively).length,
      requiring_external_retriever: rows.filter((row) => row.requires_external_retriever).length,
      requiring_external_crawler: rows.filter((row) => row.requires_external_crawler).length,
      indexed: rows.filter((row) => row.documents > 0 && row.chunks > 0).length,
      with_artifacts: rows.filter((row) => row.artifacts > 0).length,
      with_errors: rows.filter((row) => row.issues.some((issue) => issue.severity === "error")).length,
      due: rows.filter((row) => row.due_reason !== null).length,
    },
    libraries: rows,
  };
}

function getLibrarySourceReadiness(
  library: Library,
  dueReason: string | null
): LibrarySourceReadiness {
  const source = getDocumentationSource(library.source_type);
  const sourceUrl = library.source_url ?? library.docs_url;
  const artifacts = listDocumentArtifacts(library.slug).length;
  const retrieverKeys = {
    exa: Boolean(process.env["EXA_API_KEY"]),
    firecrawl: Boolean(process.env["FIRECRAWL_API_KEY"]),
  };
  const canNative = canRefreshSourceNatively(library);
  const requiresExternalRetriever = !canNative && source.supportsWebCrawl;
  const issues = getReadinessIssues({
    library,
    sourceUrl,
    artifacts,
    canNative,
    requiresExternalRetriever,
    retrieverKeys,
    dueReason,
  });

  return {
    library_id: library.id,
    library_slug: library.slug,
    library_name: library.name,
    source_type: library.source_type,
    source_name: source.name,
    source_url: sourceUrl ?? null,
    native_ingest: source.nativeIngest,
    can_refresh_natively: canNative,
    can_refresh_without_external_retriever: canNative,
    can_refresh_without_external_crawler: canNative,
    requires_external_retriever: requiresExternalRetriever,
    requires_external_crawler: requiresExternalRetriever,
    external_retriever_keys_configured: retrieverKeys,
    crawler_keys_configured: retrieverKeys,
    documents: library.document_count,
    chunks: library.chunk_count,
    artifacts,
    due_reason: dueReason,
    next_check_at: library.next_check_at,
    issues,
  };
}

function getReadinessIssues(input: {
  library: Library;
  sourceUrl: string | null;
  artifacts: number;
  canNative: boolean;
  requiresExternalRetriever: boolean;
  retrieverKeys: { exa: boolean; firecrawl: boolean };
  dueReason: string | null;
}): SourceReadinessIssue[] {
  const issues: SourceReadinessIssue[] = [];
  const { library, sourceUrl, artifacts, canNative, requiresExternalRetriever, retrieverKeys, dueReason } = input;

  if (!sourceUrl && !library.npm_package && !library.github_repo) {
    if (canDiscoverMissingSource(library, retrieverKeys)) {
      issues.push({
        code: "source_discovery_needed",
        severity: "warning",
        message: "No source URL is configured; Exa source discovery will be attempted during refresh.",
      });
    } else {
      issues.push({
        code: "missing_source",
        severity: "error",
        message: "No source URL, npm package, or GitHub repo is configured.",
      });
    }
  }

  if (!canNative && requiresExternalRetriever && !retrieverKeys.exa && !retrieverKeys.firecrawl) {
    issues.push({
      code: "external_retriever_key_missing",
      severity: "error",
      message: "This source needs an Exa or Firecrawl retrieval fallback, but no key is configured.",
    });
  }

  if (library.document_count === 0 || library.chunk_count === 0) {
    issues.push({
      code: "not_indexed",
      severity: "warning",
      message: "No indexed docs/chunks are stored yet.",
    });
  }

  if (library.document_count > 0 && artifacts === 0) {
    issues.push({
      code: "missing_artifacts",
      severity: "warning",
      message: "SQLite documents exist, but structured Markdown artifacts are missing.",
    });
  }

  if (dueReason) {
    issues.push({
      code: "refresh_due",
      severity: "info",
      message: `Refresh is due: ${dueReason}.`,
    });
  }

  return issues;
}

function canDiscoverMissingSource(
  library: Library,
  retrieverKeys: { exa: boolean; firecrawl: boolean }
): boolean {
  return retrieverKeys.exa && (
    library.source_type === "docs" ||
    library.source_type === "website" ||
    library.source_type === "api"
  );
}
