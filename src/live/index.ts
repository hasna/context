import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import {
  getRefreshPlan,
  markDocUpdateTaskFailed,
  markDocUpdateTaskRunning,
  type RefreshPlanItem,
} from "../db/update-tasks.js";
import {
  refreshDocumentationSource,
  getDefaultExternalRetriever,
  type ExternalRetrieverType,
  type SourceRefreshRetrievers,
} from "../sources/refresh.js";
import type { CrawlResult } from "../types/index.js";
import {
  getSourceReadinessReport,
  type LibrarySourceReadiness,
  type SourceReadinessIssue,
} from "../sources/readiness.js";

export type LiveUpdateActionStatus = "planned" | "skipped" | "refreshed" | "failed";

export interface LiveUpdateAction {
  library_id: string;
  library_slug: string;
  library_name: string;
  source_type: string;
  reason: string;
  due_at: string;
  readiness: LibrarySourceReadiness | null;
  status: LiveUpdateActionStatus;
  skip_reason: string | null;
  result: CrawlResult | null;
  error: string | null;
}

export interface LiveUpdateCycle {
  generated_at: string;
  plan_count: number;
  planned_count: number;
  skipped_count: number;
  refreshed_count: number;
  failed_count: number;
  actions: LiveUpdateAction[];
}

export interface LiveUpdateCycleOptions {
  maxPages?: number;
  retriever?: ExternalRetrieverType;
  /** @deprecated Use retriever. */
  crawler?: ExternalRetrieverType;
  planOnly?: boolean;
  nativeOnly?: boolean;
  createTasks?: boolean;
  embed?: boolean;
  embedAll?: boolean;
  embedLimit?: number;
  refreshTimeoutMs?: number;
  retrievers?: Partial<SourceRefreshRetrievers>;
}

export async function runLiveUpdateCycle(
  options: LiveUpdateCycleOptions = {},
  db?: Database
): Promise<LiveUpdateCycle> {
  const database = db ?? getDatabase();
  const plan = getRefreshPlan(
    {
      createTasks: options.createTasks ?? (!options.planOnly && !options.nativeOnly),
    },
    database
  );
  const readinessByLibrary = new Map(
    getSourceReadinessReport({}, database).libraries.map((row) => [row.library_id, row])
  );
  const actions: LiveUpdateAction[] = [];
  const retriever = options.retriever ?? options.crawler ?? getDefaultExternalRetriever();
  const maxPages = options.maxPages ?? 30;

  for (const item of plan) {
    const readiness = readinessByLibrary.get(item.library.id) ?? null;
    const skipReason = getSkipReason(readiness, options.nativeOnly ?? false);
    const action = createAction(item, readiness, skipReason);

    if (skipReason) {
      if (item.task) markDocUpdateTaskFailed(item.task.id, skipReason, database);
      actions.push(action);
      continue;
    }

    if (options.planOnly) {
      action.status = "planned";
      actions.push(action);
      continue;
    }

    try {
      if (item.task) markDocUpdateTaskRunning(item.task.id, database);
      action.result = await refreshWithTimeout(
        item.library.id,
        {
          maxPages,
          refresh: true,
          retriever,
          embed: options.embed,
          embedAll: options.embedAll,
          embedLimit: options.embedLimit,
          retrievers: options.retrievers,
        },
        options.refreshTimeoutMs,
        database
      );
      action.status = "refreshed";
    } catch (error) {
      action.status = "failed";
      action.error = error instanceof Error ? error.message : String(error);
      if (item.task) markDocUpdateTaskFailed(item.task.id, action.error, database);
    }
    actions.push(action);
  }

  return summarizeCycle(plan.length, actions);
}

async function refreshWithTimeout(
  libraryId: string,
  options: Parameters<typeof refreshDocumentationSource>[1],
  timeoutMs: number | undefined,
  database: Database
): ReturnType<typeof refreshDocumentationSource> {
  const normalizedTimeout = normalizeRefreshTimeoutMs(timeoutMs);
  if (normalizedTimeout === 0) {
    return refreshDocumentationSource(libraryId, options, database);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, normalizedTimeout);

  try {
    return await refreshDocumentationSource(
      libraryId,
      {
        ...options,
        signal: controller.signal,
        retrieverTimeoutMs: normalizedTimeout,
      },
      database
    );
  } catch (error) {
    if (timedOut) throw new Error(`Live refresh timed out after ${normalizedTimeout}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRefreshTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 45_000;
  return Math.max(0, Math.floor(value));
}

function createAction(
  item: RefreshPlanItem,
  readiness: LibrarySourceReadiness | null,
  skipReason: string | null
): LiveUpdateAction {
  return {
    library_id: item.library.id,
    library_slug: item.library.slug,
    library_name: item.library.name,
    source_type: item.library.source_type,
    reason: item.reason,
    due_at: item.due_at,
    readiness,
    status: skipReason ? "skipped" : "planned",
    skip_reason: skipReason,
    result: null,
    error: null,
  };
}

function getSkipReason(
  readiness: LibrarySourceReadiness | null,
  nativeOnly: boolean
): string | null {
  if (!readiness) return "source readiness could not be determined";

  const blocking = readiness.issues.find(isBlockingIssue);
  if (blocking) return blocking.message;

  if (nativeOnly && !readiness.can_refresh_without_external_retriever) {
    return "native-only mode is enabled and this source requires an external retriever";
  }

  return null;
}

function isBlockingIssue(issue: SourceReadinessIssue): boolean {
  return issue.severity === "error" && (
    issue.code === "missing_source" ||
    issue.code === "external_retriever_key_missing" ||
    issue.code === "external_crawler_key_missing"
  );
}

function summarizeCycle(planCount: number, actions: LiveUpdateAction[]): LiveUpdateCycle {
  return {
    generated_at: new Date().toISOString(),
    plan_count: planCount,
    planned_count: actions.filter((action) => action.status === "planned").length,
    skipped_count: actions.filter((action) => action.status === "skipped").length,
    refreshed_count: actions.filter((action) => action.status === "refreshed").length,
    failed_count: actions.filter((action) => action.status === "failed").length,
    actions,
  };
}
