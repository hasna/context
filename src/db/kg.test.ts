import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { createLibrary } from "./libraries.js";
import {
  upsertNode,
  upsertEdge,
  getRelatedNodes,
  searchNodes,
  listNodes,
  getNodeByLibraryId,
} from "./kg.js";

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
});

describe("upsertNode", () => {
  it("creates a new node", () => {
    const node = upsertNode({ type: "library", name: "React" });
    expect(node.name).toBe("React");
    expect(node.type).toBe("library");
  });

  it("updates existing node on conflict", () => {
    upsertNode({ type: "library", name: "React" });
    const updated = upsertNode({
      type: "library",
      name: "React",
      description: "UI library",
    });
    expect(updated.description).toBe("UI library");

    // Should still be one node
    expect(listNodes()).toHaveLength(1);
  });

  it("stores metadata as JSON", () => {
    const node = upsertNode({
      type: "library",
      name: "Vue",
      metadata: { tags: ["frontend", "framework"] },
    });
    expect(node.metadata).toEqual({ tags: ["frontend", "framework"] });
  });
});

describe("upsertEdge", () => {
  it("creates an edge between nodes", () => {
    const react = upsertNode({ type: "library", name: "React" });
    const nextjs = upsertNode({ type: "framework", name: "Next.js" });

    const edge = upsertEdge({
      source_id: nextjs.id,
      target_id: react.id,
      relation: "depends_on",
    });

    expect(edge.relation).toBe("depends_on");
    expect(edge.weight).toBe(1.0);
  });

  it("updates edge weight on conflict", () => {
    const a = upsertNode({ type: "library", name: "A" });
    const b = upsertNode({ type: "library", name: "B" });

    upsertEdge({ source_id: a.id, target_id: b.id, relation: "used_with", weight: 0.5 });
    const updated = upsertEdge({
      source_id: a.id,
      target_id: b.id,
      relation: "used_with",
      weight: 0.9,
    });

    expect(updated.weight).toBe(0.9);
  });
});

describe("getRelatedNodes", () => {
  it("returns outgoing and incoming relations", () => {
    const react = upsertNode({ type: "library", name: "React" });
    const nextjs = upsertNode({ type: "framework", name: "Next.js" });
    const remix = upsertNode({ type: "framework", name: "Remix" });

    upsertEdge({ source_id: nextjs.id, target_id: react.id, relation: "depends_on" });
    upsertEdge({ source_id: remix.id, target_id: react.id, relation: "depends_on" });
    upsertEdge({ source_id: nextjs.id, target_id: remix.id, relation: "alternative_to" });

    const withRels = getRelatedNodes(react.id);
    // React has 2 incoming depends_on
    expect(withRels.relations.filter((r) => r.direction === "incoming")).toHaveLength(2);
  });

  it("filters by relation type", () => {
    const a = upsertNode({ type: "library", name: "A2" });
    const b = upsertNode({ type: "library", name: "B2" });
    const c = upsertNode({ type: "library", name: "C2" });

    upsertEdge({ source_id: a.id, target_id: b.id, relation: "depends_on" });
    upsertEdge({ source_id: a.id, target_id: c.id, relation: "used_with" });

    const withRels = getRelatedNodes(a.id, "depends_on");
    expect(withRels.relations).toHaveLength(1);
    expect(withRels.relations[0]!.relation).toBe("depends_on");
  });
});

describe("searchNodes", () => {
  it("finds nodes by name", () => {
    upsertNode({ type: "library", name: "React" });
    upsertNode({ type: "framework", name: "React Native" });
    upsertNode({ type: "library", name: "Vue" });

    const results = searchNodes("React");
    expect(results.length).toBe(2);
  });
});

describe("getNodeByLibraryId", () => {
  it("returns null if no node linked to library", () => {
    const lib = createLibrary({ name: "Test" });
    expect(getNodeByLibraryId(lib.id)).toBeNull();
  });

  it("returns node linked to library", () => {
    const lib = createLibrary({ name: "Linked" });
    upsertNode({ type: "library", name: "Linked", library_id: lib.id });
    const node = getNodeByLibraryId(lib.id);
    expect(node).not.toBeNull();
    expect(node!.name).toBe("Linked");
  });
});
