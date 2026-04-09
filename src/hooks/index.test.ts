import { describe, it, expect, beforeEach, vi } from "vitest";

// Test the exported functions from hooks module
import { getHookRegistry, createGraphUpdateHook } from "./index.js";

describe("getHookRegistry", () => {
  it("should return a hook registry instance", () => {
    const registry = getHookRegistry();
    expect(registry).toBeDefined();
    expect(typeof registry.register).toBe("function");
    expect(typeof registry.unregister).toBe("function");
    expect(typeof registry.listHooks).toBe("function");
    expect(typeof registry.trigger).toBe("function");
  });

  it("should return the same global registry instance", () => {
    const registry1 = getHookRegistry();
    const registry2 = getHookRegistry();
    expect(registry1).toBe(registry2);
  });
});

describe("HookRegistry via getHookRegistry", () => {
  let registry: ReturnType<typeof getHookRegistry>;

  beforeEach(() => {
    registry = getHookRegistry();
    // Clear all hooks between tests
    for (const hook of registry.listHooks()) {
      registry.unregister(hook.id);
    }
  });

  describe("register", () => {
    it("should register a hook", () => {
      const handler = vi.fn();
      const hook = {
        id: "hook-1",
        name: "Test Hook",
        events: ["file:created", "file:modified"] as const,
        handler,
        enabled: true,
      };

      registry.register(hook);

      expect(registry.getHook("hook-1")).toBe(hook);
    });

    it("should allow multiple hooks to be registered", () => {
      registry.register({
        id: "hook-1",
        name: "Hook 1",
        events: ["file:created"],
        handler: vi.fn(),
        enabled: true,
      });

      registry.register({
        id: "hook-2",
        name: "Hook 2",
        events: ["file:created"],
        handler: vi.fn(),
        enabled: true,
      });

      expect(registry.listHooks()).toHaveLength(2);
    });
  });

  describe("unregister", () => {
    it("should remove a hook", () => {
      const handler = vi.fn();
      registry.register({
        id: "hook-1",
        name: "Test Hook",
        events: ["file:created"],
        handler,
        enabled: true,
      });

      registry.unregister("hook-1");

      expect(registry.getHook("hook-1")).toBeUndefined();
    });

    it("should handle unregistering non-existent hook gracefully", () => {
      expect(() => registry.unregister("non-existent")).not.toThrow();
    });
  });

  describe("getHook", () => {
    it("should return hook by id", () => {
      const hook = {
        id: "hook-1",
        name: "Test",
        events: ["file:created"] as const,
        handler: vi.fn(),
        enabled: true,
      };

      registry.register(hook);
      expect(registry.getHook("hook-1")).toBe(hook);
    });

    it("should return undefined for unknown id", () => {
      expect(registry.getHook("unknown")).toBeUndefined();
    });
  });

  describe("listHooks", () => {
    it("should return all registered hooks", () => {
      registry.register({
        id: "hook-1",
        name: "Hook 1",
        events: ["file:created"],
        handler: vi.fn(),
        enabled: true,
      });

      registry.register({
        id: "hook-2",
        name: "Hook 2",
        events: ["file:modified"],
        handler: vi.fn(),
        enabled: true,
      });

      const hooks = registry.listHooks();
      expect(hooks).toHaveLength(2);
    });

    it("should return empty array when no hooks registered", () => {
      expect(registry.listHooks()).toEqual([]);
    });
  });

  describe("trigger", () => {
    it("should return triggered false when no listeners", async () => {
      const result = await registry.trigger("file:created", {
        contextId: "ctx-1",
        contextPath: "/test",
        filePath: "/test/file.ts",
        timestamp: new Date(),
      });

      expect(result.triggered).toBe(false);
      expect(result.context.filePath).toBe("/test/file.ts");
    });

    it("should trigger handlers and return triggered true when listeners exist", async () => {
      const handler = vi.fn();
      registry.register({
        id: "hook-1",
        name: "Test",
        events: ["file:created"],
        handler,
        enabled: true,
      });

      const result = await registry.trigger("file:created", {
        contextId: "ctx-1",
        contextPath: "/test",
        filePath: "/test/file.ts",
        timestamp: new Date(),
      });

      expect(result.triggered).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(result);
    });

    it("should include actions in result", async () => {
      const actions = [{ type: "index" as const, payload: { filePath: "/test.ts" } }];

      const result = await registry.trigger("file:created", {
        contextId: "ctx-1",
        contextPath: "/test",
        filePath: "/test/file.ts",
        timestamp: new Date(),
      }, actions);

      expect(result.actions).toEqual(actions);
    });

    it("should not trigger for different event types", async () => {
      const handler = vi.fn();
      registry.register({
        id: "hook-1",
        name: "Test",
        events: ["file:created"],
        handler,
        enabled: true,
      });

      await registry.trigger("file:modified", {
        contextId: "ctx-1",
        contextPath: "/test",
        filePath: "/test/file.ts",
        timestamp: new Date(),
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe("createGraphUpdateHook", () => {
  it("should create a hook with correct properties", () => {
    const hook = createGraphUpdateHook("/test/path");

    expect(hook.id).toMatch(/^graph-update-\d+$/);
    expect(hook.name).toBe("Knowledge Graph Auto-Update");
    expect(hook.events).toEqual(["file:created", "file:modified", "file:deleted"]);
    expect(hook.contextPath).toBe("/test/path");
    expect(hook.enabled).toBe(true);
    expect(typeof hook.handler).toBe("function");
  });

  it("should log file changes when handler is called", async () => {
    const hook = createGraphUpdateHook("/test/path");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hook.handler({
      triggered: true,
      context: {
        contextId: "ctx-1",
        contextPath: "/test/path",
        filePath: "/test/path/test.ts",
        timestamp: new Date(),
      },
      actions: [{ type: "index", payload: { filePath: "/test.ts" } }],
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[hooks] Processing /test/path/test.ts for context /test/path"
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "[hooks]   Action: index",
      { filePath: "/test.ts" }
    );

    consoleSpy.mockRestore();
  });

  it("should handle missing filePath gracefully", async () => {
    const hook = createGraphUpdateHook("/test/path");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hook.handler({
      triggered: true,
      context: {
        contextId: "ctx-1",
        contextPath: "/test/path",
        timestamp: new Date(),
      },
      actions: [],
    });

    // Should not log any file processing
    expect(consoleSpy).not.toHaveBeenCalledWith(
      "[hooks] Processing",
      expect.any(String)
    );

    consoleSpy.mockRestore();
  });
});

describe("HookResult structure", () => {
  let registry: ReturnType<typeof getHookRegistry>;

  beforeEach(() => {
    registry = getHookRegistry();
    for (const hook of registry.listHooks()) {
      registry.unregister(hook.id);
    }
  });

  it("should have correct structure from trigger", async () => {
    const handler = vi.fn();
    registry.register({
      id: "hook-1",
      name: "Test",
      events: ["file:created"],
      handler,
      enabled: true,
    });

    const result = await registry.trigger("file:created", {
      contextId: "ctx-1",
      contextPath: "/test",
      filePath: "/test/file.ts",
      timestamp: new Date(),
    }, [
      { type: "index", payload: { filePath: "/test.ts" } },
      { type: "relate", payload: { relationsCreated: 2 } },
    ]);

    expect(result.triggered).toBe(true);
    expect(result.context.contextId).toBe("ctx-1");
    expect(result.context.contextPath).toBe("/test");
    expect(result.context.filePath).toBe("/test/file.ts");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].type).toBe("index");
  });

  it("should handle actions with different types", async () => {
    registry.register({
      id: "hook-1",
      name: "Test",
      events: ["file:created"],
      handler: vi.fn(),
      enabled: true,
    });

    const result = await registry.trigger("file:created", {
      contextId: "ctx-1",
      contextPath: "/test",
      timestamp: new Date(),
    }, [
      { type: "index", payload: { filePath: "/test.ts" } },
      { type: "delete", payload: { itemId: "item-1" } },
      { type: "relate", payload: { relationsCreated: 5 } },
      { type: "notify", payload: { message: "Hello" } },
      { type: "suggest", payload: { relatedFiles: [] } },
    ]);

    expect(result.actions.map((a) => a.type)).toEqual([
      "index",
      "delete",
      "relate",
      "notify",
      "suggest",
    ]);
  });
});

describe("FileChangeHook interface", () => {
  let registry: ReturnType<typeof getHookRegistry>;

  beforeEach(() => {
    registry = getHookRegistry();
    for (const hook of registry.listHooks()) {
      registry.unregister(hook.id);
    }
  });

  it("should allow hooks with different event combinations", () => {
    registry.register({
      id: "hook-all",
      name: "All Events",
      events: ["file:created", "file:modified", "file:deleted", "entity:created", "ai:edit"],
      handler: vi.fn(),
      enabled: true,
    });

    expect(registry.getHook("hook-all")).toBeDefined();
  });

  it("should allow hooks with file patterns", () => {
    registry.register({
      id: "hook-pattern",
      name: "TypeScript Only",
      events: ["file:created"],
      filePattern: "*.ts",
      handler: vi.fn(),
      enabled: true,
    });

    expect(registry.getHook("hook-pattern")?.filePattern).toBe("*.ts");
  });

  it("should allow hooks with context path filter", () => {
    registry.register({
      id: "hook-context",
      name: "Specific Context",
      events: ["file:created"],
      contextPath: "/specific/path",
      handler: vi.fn(),
      enabled: true,
    });

    expect(registry.getHook("hook-context")?.contextPath).toBe("/specific/path");
  });
});

describe("HookContext interface", () => {
  let registry: ReturnType<typeof getHookRegistry>;

  beforeEach(() => {
    registry = getHookRegistry();
    for (const hook of registry.listHooks()) {
      registry.unregister(hook.id);
    }
  });

  it("should require contextId and contextPath", async () => {
    registry.register({
      id: "hook-1",
      name: "Test",
      events: ["file:created"],
      handler: vi.fn(),
      enabled: true,
    });

    const result = await registry.trigger("file:created", {
      contextId: "ctx-1",
      contextPath: "/test",
      timestamp: new Date(),
    });

    expect(result.context.contextId).toBe("ctx-1");
    expect(result.context.contextPath).toBe("/test");
  });

  it("should optionally include filePath, itemId, entityId", async () => {
    registry.register({
      id: "hook-1",
      name: "Test",
      events: ["file:created"],
      handler: vi.fn(),
      enabled: true,
    });

    const result = await registry.trigger("file:created", {
      contextId: "ctx-1",
      contextPath: "/test",
      filePath: "/test/file.ts",
      itemId: "item-1",
      entityId: "entity-1",
      timestamp: new Date(),
    });

    expect(result.context.filePath).toBe("/test/file.ts");
    expect(result.context.itemId).toBe("item-1");
    expect(result.context.entityId).toBe("entity-1");
  });
});

describe("HookEventType", () => {
  let registry: ReturnType<typeof getHookRegistry>;

  beforeEach(() => {
    registry = getHookRegistry();
    // Clear all hooks before each test
    for (const hook of registry.listHooks()) {
      registry.unregister(hook.id);
    }
  });

  it("should include file events", () => {
    const handler = vi.fn();

    // These should all be valid event types
    const events = ["file:created", "file:modified", "file:deleted"] as const;

    for (const event of events) {
      registry.register({
        id: `hook-${event}-${Date.now()}`,
        name: `Test ${event}`,
        events: [event],
        handler,
        enabled: true,
      });
    }

    expect(registry.listHooks()).toHaveLength(3);
  });

  it("should include entity events", () => {
    const events = ["entity:created", "entity:modified", "entity:deleted"] as const;

    for (const event of events) {
      registry.register({
        id: `hook-${event}-${Date.now()}`,
        name: `Test ${event}`,
        events: [event],
        handler: vi.fn(),
        enabled: true,
      });
    }

    expect(registry.listHooks()).toHaveLength(3);
  });

  it("should include relation and ai events", () => {
    const events = ["relation:created", "ai:edit"] as const;

    for (const event of events) {
      registry.register({
        id: `hook-${event}-${Date.now()}`,
        name: `Test ${event}`,
        events: [event],
        handler: vi.fn(),
        enabled: true,
      });
    }

    expect(registry.listHooks()).toHaveLength(2);
  });
});
