import { describe, expect, it } from "bun:test";
import {
  deactivateWatch,
  getActiveWatches,
  getChildrenContexts,
  getContextHierarchy,
  getItemHierarchy,
  getRelevantContext,
  hashContent,
  upsertCodeEntity,
  upsertCodeRelation,
  upsertContext,
  upsertContextItem,
  upsertContextWatch,
} from "../repositories.js";

export function registerRepositorySupportTests(): void {
  describe("upsertContextWatch", () => {
    it("creates a watch", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const watch = upsertContextWatch({
        context_id: ctx.id,
        path: "/test/src",
        pattern: "**/*.ts",
      });
      expect(watch.pattern).toBe("**/*.ts");
      expect(watch.active).toBe(true);
    });

    it("updates existing watch", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextWatch({
        context_id: ctx.id,
        path: "/test/src",
        pattern: "*.ts",
      });
      upsertContextWatch({
        context_id: ctx.id,
        path: "/test/src",
        pattern: "**/*.ts",
      });
      const watches = getActiveWatches(ctx.id);
      expect(watches).toHaveLength(1);
      expect(watches[0]!.pattern).toBe("**/*.ts");
    });
  });

  describe("getActiveWatches", () => {
    it("returns only active watches", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextWatch({
        context_id: ctx.id,
        path: "/test/src",
        pattern: "*.ts",
      });
      const watches = getActiveWatches(ctx.id);
      expect(watches).toHaveLength(1);
      expect(watches[0]!.active).toBe(true);
    });
  });

  describe("deactivateWatch", () => {
    it("deactivates a watch", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const watch = upsertContextWatch({
        context_id: ctx.id,
        path: "/test/src",
        pattern: "*.ts",
      });
      deactivateWatch(watch.id);
      const watches = getActiveWatches(ctx.id);
      expect(watches).toHaveLength(0);
    });
  });

  describe("getContextHierarchy", () => {
    it("returns hierarchy from root to context", () => {
      const root = upsertContext({ name: "Root", path: "/root", type: "workspace" });
      const project = upsertContext({
        name: "Project",
        path: "/root/project",
        type: "project",
        parent_context_id: root.id,
      });
      const folder = upsertContext({
        name: "Folder",
        path: "/root/project/folder",
        type: "folder",
        parent_context_id: project.id,
      });
      const hierarchy = getContextHierarchy(folder.id);
      expect(hierarchy).toHaveLength(3);
      expect(hierarchy[0]!.name).toBe("Root");
      expect(hierarchy[1]!.name).toBe("Project");
      expect(hierarchy[2]!.name).toBe("Folder");
    });
  });

  describe("getChildrenContexts", () => {
    it("returns child contexts", () => {
      const parent = upsertContext({ name: "Parent", path: "/parent", type: "workspace" });
      upsertContext({
        name: "Child1",
        path: "/parent/child1",
        type: "project",
        parent_context_id: parent.id,
      });
      upsertContext({
        name: "Child2",
        path: "/parent/child2",
        type: "project",
        parent_context_id: parent.id,
      });
      const children = getChildrenContexts(parent.id);
      expect(children).toHaveLength(2);
    });
  });

  describe("getItemHierarchy", () => {
    it("returns path hierarchy", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test",
        name: "test",
        item_type: "directory",
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/src",
        name: "src",
        item_type: "directory",
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/src/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const hierarchy = getItemHierarchy(ctx.id, "/test/src/file.ts");
      expect(hierarchy).toHaveLength(3);
      expect(hierarchy[0]!.name).toBe("test");
      expect(hierarchy[1]!.name).toBe("src");
      expect(hierarchy[2]!.name).toBe("file.ts");
    });
  });

  describe("getRelevantContext", () => {
    it("finds relevant items by query", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
        content: "function calculateTotal() {}",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "calculateTotal",
        type: "function",
        signature: "function calculateTotal()",
        start_line: 1,
        end_line: 1,
      });
      const results = getRelevantContext({ query: "calculateTotal" });
      expect(results.length).toBeGreaterThan(0);
    });

    it("finds related items via relations", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const itemA = upsertContextItem({
        context_id: ctx.id,
        path: "/test/a.ts",
        name: "a.ts",
        item_type: "file",
      });
      const itemB = upsertContextItem({
        context_id: ctx.id,
        path: "/test/b.ts",
        name: "b.ts",
        item_type: "file",
      });
      upsertCodeRelation({
        context_id: ctx.id,
        source_item_id: itemA.id,
        target_item_id: itemB.id,
        relation_type: "imports",
      });
      const results = getRelevantContext({ itemId: itemA.id });
      expect(results.some((r) => r.item?.id === itemB.id)).toBe(true);
    });
  });

  describe("hashContent", () => {
    it("generates consistent hashes", () => {
      const hash1 = hashContent("hello world");
      const hash2 = hashContent("hello world");
      expect(hash1).toBe(hash2);
    });

    it("generates different hashes for different content", () => {
      const hash1 = hashContent("hello");
      const hash2 = hashContent("world");
      expect(hash1).not.toBe(hash2);
    });

    it("returns 32 character hash", () => {
      const hash = hashContent("test");
      expect(hash.length).toBe(32);
    });
  });
}
