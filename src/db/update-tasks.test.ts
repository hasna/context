import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetDatabase } from "./database.js";
import { insertChunk } from "./chunks.js";
import { upsertDocument } from "./documents.js";
import {
  createLibrary,
  updateLibraryCounts,
  updateLibrarySchedule,
} from "./libraries.js";
import {
  getRefreshPlan,
  listDocUpdateTasks,
} from "./update-tasks.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
});

describe("getRefreshPlan", () => {
  it("plans never-crawled libraries", () => {
    createLibrary({ name: "React" });

    const plan = getRefreshPlan();
    expect(plan).toHaveLength(1);
    expect(plan[0]!.reason).toBe("not crawled");
  });

  it("creates one pending task per due library", () => {
    const lib = createLibrary({ name: "React", priority: 10 });

    const plan = getRefreshPlan({ createTasks: true });
    const tasks = listDocUpdateTasks("pending");

    expect(plan).toHaveLength(1);
    expect(plan[0]!.task?.library_id).toBe(lib.id);
    expect(tasks).toHaveLength(1);

    getRefreshPlan({ createTasks: true });
    expect(listDocUpdateTasks("pending")).toHaveLength(1);
  });

  it("skips fresh crawled libraries and includes scheduled stale libraries", () => {
    const lib = createLibrary({ name: "React", freshness_days: 7 });
    const doc = upsertDocument({ library_id: lib.id, url: "https://react.dev" });
    insertChunk({
      library_id: lib.id,
      document_id: doc.id,
      content: "React documentation content for hooks and components.",
      position: 0,
    });
    updateLibraryCounts(lib.id);

    expect(getRefreshPlan()).toHaveLength(0);

    updateLibrarySchedule(lib.id, {
      next_check_at: "2000-01-01T00:00:00.000Z",
    });

    const plan = getRefreshPlan();
    expect(plan).toHaveLength(1);
    expect(plan[0]!.reason).toBe("scheduled freshness check due");
  });
});
