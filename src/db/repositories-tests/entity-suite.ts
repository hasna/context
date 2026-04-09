import { describe, expect, it } from "bun:test";
import {
  deleteCodeEntitiesByItem,
  deleteCodeRelationsByItem,
  getCodeEntitiesByItem,
  getCodeEntitiesByName,
  getRelatedItems,
  getRelationsByEntity,
  getRelationsByItem,
  searchCodeEntities,
  upsertCodeEntity,
  upsertCodeRelation,
  upsertContext,
  upsertContextItem,
} from "../repositories.js";

export function registerEntityRepositoryTests(): void {
  describe("upsertCodeEntity", () => {
    it("creates a code entity", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const entity = upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "TestClass",
        type: "class",
        signature: "class TestClass { }",
        start_line: 1,
        end_line: 10,
      });
      expect(entity.name).toBe("TestClass");
      expect(entity.type).toBe("class");
      expect(entity.start_line).toBe(1);
      expect(entity.end_line).toBe(10);
    });

    it("updates existing entity", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "TestFunc",
        type: "function",
        start_line: 1,
        end_line: 5,
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "TestFunc",
        type: "function",
        start_line: 1,
        end_line: 10,
      });
      const entities = getCodeEntitiesByItem(item.id);
      expect(entities).toHaveLength(1);
      expect(entities[0]!.end_line).toBe(10);
    });
  });

  describe("getCodeEntitiesByItem", () => {
    it("returns entities for an item", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "Func1",
        type: "function",
        start_line: 1,
        end_line: 5,
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "Func2",
        type: "function",
        start_line: 7,
        end_line: 10,
      });
      const entities = getCodeEntitiesByItem(item.id);
      expect(entities).toHaveLength(2);
    });
  });

  describe("getCodeEntitiesByName", () => {
    it("finds entities by name", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "MyClass",
        type: "class",
        start_line: 1,
        end_line: 20,
      });
      const found = getCodeEntitiesByName("MyClass");
      expect(found).toHaveLength(1);
      expect(found[0]!.name).toBe("MyClass");
    });
  });

  describe("searchCodeEntities", () => {
    it("searches entities by name", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
        content: "export function handleRequest() {}",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "handleRequest",
        type: "function",
        signature: "function handleRequest()",
        start_line: 1,
        end_line: 1,
      });
      const results = searchCodeEntities("handleRequest");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("deleteCodeEntitiesByItem", () => {
    it("deletes all entities for an item", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "Func1",
        type: "function",
        start_line: 1,
        end_line: 5,
      });
      upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "Func2",
        type: "function",
        start_line: 7,
        end_line: 10,
      });
      deleteCodeEntitiesByItem(item.id);
      expect(getCodeEntitiesByItem(item.id)).toHaveLength(0);
    });
  });

  describe("upsertCodeRelation", () => {
    it("creates a relation between items", () => {
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
      const relation = upsertCodeRelation({
        context_id: ctx.id,
        source_item_id: itemA.id,
        target_item_id: itemB.id,
        relation_type: "imports",
      });
      expect(relation.relation_type).toBe("imports");
      expect(relation.source_item_id).toBe(itemA.id);
      expect(relation.target_item_id).toBe(itemB.id);
    });

    it("creates relation between entities", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const entityA = upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "ClassA",
        type: "class",
        start_line: 1,
        end_line: 10,
      });
      const entityB = upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "ClassB",
        type: "class",
        start_line: 12,
        end_line: 20,
      });
      const relation = upsertCodeRelation({
        context_id: ctx.id,
        source_item_id: item.id,
        target_item_id: item.id,
        source_entity_id: entityA.id,
        target_entity_id: entityB.id,
        relation_type: "extends",
      });
      expect(relation.relation_type).toBe("extends");
    });
  });

  describe("getRelationsByItem", () => {
    it("returns relations for an item", () => {
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
      const relations = getRelationsByItem(itemA.id);
      expect(relations).toHaveLength(1);
    });
  });

  describe("getRelationsByEntity", () => {
    it("returns relations for an entity", () => {
      const ctx = upsertContext({ name: "Test", path: "/test", type: "repository" });
      const item = upsertContextItem({
        context_id: ctx.id,
        path: "/test/file.ts",
        name: "file.ts",
        item_type: "file",
      });
      const entityA = upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "ClassA",
        type: "class",
        start_line: 1,
        end_line: 10,
      });
      const entityB = upsertCodeEntity({
        context_id: ctx.id,
        item_id: item.id,
        name: "InterfaceB",
        type: "interface",
        start_line: 12,
        end_line: 15,
      });
      upsertCodeRelation({
        context_id: ctx.id,
        source_item_id: item.id,
        target_item_id: item.id,
        source_entity_id: entityA.id,
        target_entity_id: entityB.id,
        relation_type: "implements",
      });
      const relations = getRelationsByEntity(entityA.id);
      expect(relations).toHaveLength(1);
    });
  });

  describe("getRelatedItems", () => {
    it("finds related items up to depth", () => {
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
      const itemC = upsertContextItem({
        context_id: ctx.id,
        path: "/test/c.ts",
        name: "c.ts",
        item_type: "file",
      });
      upsertCodeRelation({
        context_id: ctx.id,
        source_item_id: itemA.id,
        target_item_id: itemB.id,
        relation_type: "imports",
      });
      upsertCodeRelation({
        context_id: ctx.id,
        source_item_id: itemB.id,
        target_item_id: itemC.id,
        relation_type: "imports",
      });
      const related = getRelatedItems(itemA.id, 2);
      expect(related.length).toBeGreaterThan(0);
    });
  });

  describe("deleteCodeRelationsByItem", () => {
    it("deletes relations for an item", () => {
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
      deleteCodeRelationsByItem(itemA.id);
      expect(getRelationsByItem(itemA.id)).toHaveLength(0);
    });
  });
}
