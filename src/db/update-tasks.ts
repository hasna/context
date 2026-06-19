import { randomUUID } from "crypto";
import type { Database } from "./database.js";
import { getDatabase } from "./database.js";
import type { Library } from "../types/index.js";
import {
  getLibraryBySlug,
  listLibraries,
} from "./libraries.js";

export type DocUpdateTaskStatus = "pending" | "running" | "done" | "failed";

export interface DocUpdateTask {
  id: string;
  library_id: string;
  task_type: string;
  reason: string;
  status: DocUpdateTaskStatus;
  priority: number;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefreshPlanItem {
  library: Library;
  reason: string;
  due_at: string;
  priority: number;
  task: DocUpdateTask | null;
}

export function getRefreshPlan(
  options: {
    slug?: string;
    createTasks?: boolean;
    now?: Date;
  } = {},
  db?: Database
): RefreshPlanItem[] {
  const database = db ?? getDatabase();
  const now = options.now ?? new Date();
  const libraries = options.slug
    ? [getLibraryBySlug(options.slug, database)]
    : listLibraries(database);

  const plan: RefreshPlanItem[] = [];
  for (const library of libraries) {
    const reason = getRefreshReason(library, now);
    if (!reason) continue;

    const dueAt = library.next_check_at ?? now.toISOString();
    const task = options.createTasks
      ? upsertDocUpdateTask(
          {
            library_id: library.id,
            task_type: "refresh",
            reason,
            priority: library.priority,
            scheduled_at: dueAt,
          },
          database
        )
      : null;

    plan.push({
      library,
      reason,
      due_at: dueAt,
      priority: library.priority,
      task,
    });
  }

  return plan.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.due_at.localeCompare(b.due_at);
  });
}

export function upsertDocUpdateTask(
  input: {
    library_id: string;
    task_type: string;
    reason: string;
    priority?: number;
    scheduled_at?: string;
  },
  db?: Database
): DocUpdateTask {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();
  const existing = database.get(
    `SELECT * FROM doc_update_tasks
     WHERE library_id = ? AND task_type = ? AND status = 'pending'
     ORDER BY scheduled_at ASC
     LIMIT 1`,
    input.library_id,
    input.task_type
  ) as Record<string, unknown> | null;

  if (existing) {
    database.run(
      `UPDATE doc_update_tasks SET
         reason = ?,
         priority = ?,
         scheduled_at = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        input.reason,
        input.priority ?? (existing["priority"] as number) ?? 0,
        input.scheduled_at ?? (existing["scheduled_at"] as string) ?? now,
        now,
        existing["id"] as string,
      ]
    );
    return getDocUpdateTask(existing["id"] as string, database);
  }

  const id = randomUUID();
  database.run(
    `INSERT INTO doc_update_tasks (
       id, library_id, task_type, reason, status, priority,
       scheduled_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      id,
      input.library_id,
      input.task_type,
      input.reason,
      input.priority ?? 0,
      input.scheduled_at ?? now,
      now,
      now,
    ]
  );

  return getDocUpdateTask(id, database);
}

export function listDocUpdateTasks(
  status?: DocUpdateTaskStatus,
  db?: Database
): DocUpdateTask[] {
  const database = db ?? getDatabase();
  const rows = status
    ? database.all(
        "SELECT * FROM doc_update_tasks WHERE status = ? ORDER BY scheduled_at ASC, priority DESC",
        status
      )
    : database.all("SELECT * FROM doc_update_tasks ORDER BY scheduled_at ASC, priority DESC");
  return (rows as Record<string, unknown>[]).map(rowToTask);
}

export function markPendingDocUpdateTasksDone(
  libraryId: string,
  taskType = "refresh",
  db?: Database
): number {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();
  const result = database.run(
    `UPDATE doc_update_tasks SET
       status = 'done',
       finished_at = ?,
       updated_at = ?
     WHERE library_id = ? AND task_type = ? AND status IN ('pending', 'running')`,
    [now, now, libraryId, taskType]
  );
  return result.changes;
}

export function markDocUpdateTaskRunning(
  id: string,
  db?: Database
): DocUpdateTask {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();
  database.run(
    `UPDATE doc_update_tasks SET
       status = 'running',
       started_at = COALESCE(started_at, ?),
       error = NULL,
       updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [now, now, id]
  );
  return getDocUpdateTask(id, database);
}

export function markDocUpdateTaskFailed(
  id: string,
  error: string,
  db?: Database
): DocUpdateTask {
  const database = db ?? getDatabase();
  const now = new Date().toISOString();
  database.run(
    `UPDATE doc_update_tasks SET
       status = 'failed',
       started_at = COALESCE(started_at, ?),
       finished_at = ?,
       error = ?,
       updated_at = ?
     WHERE id = ? AND status IN ('pending', 'running')`,
    [now, now, error, now, id]
  );
  return getDocUpdateTask(id, database);
}

export function getDocUpdateTask(id: string, db?: Database): DocUpdateTask {
  const database = db ?? getDatabase();
  const row = database.get(
    "SELECT * FROM doc_update_tasks WHERE id = ?",
    id
  ) as Record<string, unknown> | null;
  if (!row) throw new Error(`Doc update task not found: ${id}`);
  return rowToTask(row);
}

function getRefreshReason(library: Library, now: Date): string | null {
  if (library.document_count === 0 || library.chunk_count === 0 || !library.last_crawled_at) {
    return "not crawled";
  }

  if (library.next_check_at) {
    const nextCheck = Date.parse(library.next_check_at);
    if (!Number.isNaN(nextCheck) && nextCheck <= now.getTime()) {
      return "scheduled freshness check due";
    }
  }

  const lastCrawled = Date.parse(library.last_crawled_at);
  if (Number.isNaN(lastCrawled)) return "missing crawl timestamp";

  const freshnessMs = Math.max(1, library.freshness_days) * 24 * 60 * 60 * 1000;
  if (now.getTime() - lastCrawled >= freshnessMs) {
    return `older than ${library.freshness_days} day freshness window`;
  }

  return null;
}

function rowToTask(row: Record<string, unknown>): DocUpdateTask {
  return {
    id: row["id"] as string,
    library_id: row["library_id"] as string,
    task_type: row["task_type"] as string,
    reason: row["reason"] as string,
    status: row["status"] as DocUpdateTaskStatus,
    priority: (row["priority"] as number) ?? 0,
    scheduled_at: row["scheduled_at"] as string,
    started_at: (row["started_at"] as string) ?? null,
    finished_at: (row["finished_at"] as string) ?? null,
    error: (row["error"] as string) ?? null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}
