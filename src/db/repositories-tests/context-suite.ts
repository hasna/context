import { describe, expect, it } from "bun:test";
import {
  deleteContext,
  deleteContextItem,
  deleteContextItemsByPath,
  getContext,
  getContextByPath,
  getContextItem,
  getContextItemByPath,
  getContextItemsByExtension,
  getContextItemsByParent,
  getDirectories,
  listContexts,
  listContextsByType,
  searchContextItems,
  updateContextCounts,
  upsertCodeEntity,
  upsertContext,
  upsertContextItem,
} from "../repositories.js";

export function registerContextRepositoryTests(): void {
  describe("upsertContext", () => {
    it("creates a new context", () => {
      const ctx = upsertContext({
        name: "TestRepo",
        path: "/tmp/test-repo",
        type: "repository",
      });
      expect(ctx.name).toBe("TestRepo");
      expect(ctx.path).toBe("/tmp/test-repo");
      expect(ctx.type).toBe("repository");
      expect(ctx.file_count).toBe(0);
      expect(ctx.entity_count).toBe(0);
    });

    it("creates context with all fields", () => {
      const ctx = upsertContext({
        name: "MyProject",
        path: "/projects/my-project",
        type: "project",
        description: "A test project",
        language: "typescript",
      });
      expect(ctx.description).toBe("A test project");
      expect(ctx.language).toBe("typescript");
    });

    it("updates existing context by path", () => {
      const first = upsertContext({
        name: "Original",
        path: "/tmp/repo",
        type: "repository",
      });
      const second = upsertContext({
        name: "Updated",
        path: "/tmp/repo",
        type: "folder",
        description: "Changed",
      });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe("Updated");
      expect(second.type).toBe("folder");
    });

    it("supports parent context", () => {
      const parent = upsertContext({
        name: "Parent",
        path: "/parent",
        type: "workspace",
      });
      const child = upsertContext({
        name: "Child",
        path: "/parent/child",
        type: "folder",
        parent_context_id: parent.id,
      });
      expect(child.parent_context_id).toBe(parent.id);
    });
  });

  describe("getContext", () => {
    it("retrieves existing context by id", () => {
      const created = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const found = getContext(created.id);
      expect(found?.name).toBe("Test");
    });

    it("returns null for non-existent id", () => {
      expect(getContext("non-existent")).toBeNull();
    });
  });

  describe("getContextByPath", () => {
    it("retrieves context by path", () => {
      upsertContext({ name: "Test", path: "/test", type: "repository" });
      const found = getContextByPath("/test");
      expect(found?.name).toBe("Test");
    });

    it("returns null for non-existent path", () => {
      expect(getContextByPath("/non-existent")).toBeNull();
    });
  });

  describe("listContexts", () => {
    it("returns empty list initially", () => {
      expect(listContexts()).toHaveLength(0);
    });

    it("returns all contexts sorted by name", () => {
      upsertContext({ name: "Zebra", path: "/zebra", type: "repository" });
      upsertContext({ name: "Apple", path: "/apple", type: "repository" });
      upsertContext({ name: "Mango", path: "/mango", type: "repository" });
      const contexts = listContexts();
      expect(contexts).toHaveLength(3);
      expect(contexts[0]!.name).toBe("Apple");
      expect(contexts[1]!.name).toBe("Mango");
      expect(contexts[2]!.name).toBe("Zebra");
    });
  });

  describe("listContextsByType", () => {
    it("filters by context type", () => {
      upsertContext({ name: "Repo1", path: "/repo1", type: "repository" });
      upsertContext({ name: "Folder1", path: "/folder1", type: "folder" });
      upsertContext({ name: "Repo2", path: "/repo2", type: "repository" });
      const repos = listContextsByType("repository");
      expect(repos).toHaveLength(2);
      expect(repos.every((c) => c.type === "repository")).toBe(true);
    });
  });

  describe("deleteContext", () => {
    it("deletes a context", () => {
      const ctx = upsertContext({ name: "ToDelete", path: "/delete", type: "repository" });
      deleteContext(ctx.id);
      expect(getContext(ctx.id)).toBeNull();
    });
  });

  describe("updateContextCounts", () => {
    it("updates file and entity counts", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
        content: "hello world",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "TestFunc",
        type: "function",
        start_line: 1,
        end_line: 10,
      });
      updateContextCounts(ctx.id);
      const updated = getContext(ctx.id);
      expect(updated?.file_count).toBe(1);
      expect(updated?.entity_count).toBe(1);
    });
  });

  describe("upsertContextItem", () => {
    it("creates a file item", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/index.ts",
        name: "index.ts",
        item_type: "file",
        extension: ".ts",
        content: "console.log('hello')",
      });
      expect(item.name).toBe("index.ts");
      expect(item.item_type).toBe("file");
      expect(item.extension).toBe(".ts");
      expect(item.line_count).toBe(1);
      expect(item.content_hash).not.toBeNull();
    });

    it("creates a directory item", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/src",
        name: "src",
        item_type: "directory",
      });
      expect(item.item_type).toBe("directory");
      expect(item.content_hash).toBeNull();
    });

    it("tracks content changes", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
        content: "original",
      });
      const originalHash = item.content_hash;

      upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
        content: "modified",
      });
      const updated = getContextItem(item.id);
      expect(updated?.content_hash).not.toBe(originalHash);
    });
  });

  describe("getContextItem", () => {
    it("retrieves item by id", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const created = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const found = getContextItem(created.id);
      expect(found?.name).toBe("file.ts");
    });
  });

  describe("getContextItemByPath", () => {
    it("retrieves item by context and path", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const found = getContextItemByPath(ctx.id, "/test/file.ts");
      expect(found?.name).toBe("file.ts");
    });
  });

  describe("getContextItemsByExtension", () => {
    it("filters by extension", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/a.ts",
        name: "a.ts",
        item_type: "file",
        extension: ".ts",
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/b.js",
        name: "b.js",
        item_type: "file",
        extension: ".js",
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/c.ts",
        name: "c.ts",
        item_type: "file",
        extension: ".ts",
      });
      const tsFiles = getContextItemsByExtension(ctx.id, ".ts");
      expect(tsFiles).toHaveLength(2);
      expect(tsFiles.every((f) => f.extension === ".ts")).toBe(true);
    });
  });

  describe("getContextItemsByParent", () => {
    it("returns root items when parentPath is null", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/file1.ts",
        name: "file1.ts",
        item_type: "file",
        parent_path: null as unknown as string,
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/file2.ts",
        name: "file2.ts",
        item_type: "file",
        parent_path: null as unknown as string,
      });
      const rootItems = getContextItemsByParent(ctx.id, null);
      expect(rootItems).toHaveLength(2);
    });

    it("returns children of a directory", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
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
        parent_path: "/test/src",
      });
      const children = getContextItemsByParent(ctx.id, "/test/src");
      expect(children).toHaveLength(1);
      expect(children[0]!.name).toBe("file.ts");
    });
  });

  describe("getDirectories", () => {
    it("returns only directories", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/src",
        name: "src",
        item_type: "directory",
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const dirs = getDirectories(ctx.id);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]!.item_type).toBe("directory");
    });
  });

  describe("searchContextItems", () => {
    it("finds items by content", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/a.ts",
        name: "a.ts",
        item_type: "file",
        content: "function hello() {}",
      });
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/b.ts",
        name: "b.ts",
        item_type: "file",
        content: "const x = 1;",
      });
      const results = searchContextItems("hello");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.name).toBe("a.ts");
    });
  });

  describe("deleteContextItem", () => {
    it("deletes an item", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      deleteContextItem(item.id);
      expect(getContextItem(item.id)).toBeNull();
    });
  });

  describe("deleteContextItemsByPath", () => {
    it("deletes item and all children", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
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
      upsertContextItem({
        context_id: ctx.id,
        path: "/test/src/nested/deep.ts",
        name: "deep.ts",
        item_type: "file",
      });
      deleteContextItemsByPath(ctx.id, "/test/src");
      const remaining = getContextItemsByParent(ctx.id, "/test/src");
      expect(remaining).toHaveLength(0);
    });
  });
}
