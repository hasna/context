/**
 * Hooks SDK for context awareness
 *
 * Provides a hook system that triggers when:
 * - Files are created, modified, or deleted
 * - AI edits code (via the edit context)
 *
 * Hooks can:
 * - Update the knowledge graph automatically
 * - Track which files are related to a change
 * - Provide smart context suggestions
 */

import { EventEmitter } from "events";
import { getDatabase } from "../db/database.js";
import {
  getContextByPath,
  getContextItemByPath,
  getCodeEntitiesByItem,
  getRelatedItems,
  searchContextItems,
  upsertCodeRelation,
  deleteContextItem,
  deleteCodeEntitiesByItem,
  deleteCodeRelationsByItem,
  type ContextItem,
  type CodeEntity,
  type RelationType,
} from "../db/repositories.js";
import { indexFile } from "../indexer/index.js";
import { readFileSync, existsSync } from "fs";

// Hook event types
export type HookEventType =
  | "file:created"
  | "file:modified"
  | "file:deleted"
  | "entity:created"
  | "entity:modified"
  | "entity:deleted"
  | "relation:created"
  | "ai:edit";

export interface HookContext {
  contextId: string;
  contextPath: string;
  filePath?: string;
  itemId?: string;
  entityId?: string;
  timestamp: Date;
}

export interface HookResult {
  triggered: boolean;
  actions: HookAction[];
  context: HookContext;
}

export interface HookAction {
  type: "index" | "delete" | "relate" | "notify" | "suggest";
  payload: Record<string, unknown>;
}

export interface FileChangeHook {
  id: string;
  name: string;
  events: HookEventType[];
  contextPath?: string;
  filePattern?: string;
  handler: (result: HookResult) => void | Promise<void>;
  enabled: boolean;
}

// Hook registry
class HookRegistry extends EventEmitter {
  private hooks: Map<string, FileChangeHook> = new Map();

  constructor() {
    super();
  }

  register(hook: FileChangeHook): void {
    this.hooks.set(hook.id, hook);
    for (const event of hook.events) {
      this.on(event, hook.handler);
    }
  }

  unregister(hookId: string): void {
    const hook = this.hooks.get(hookId);
    if (hook) {
      for (const event of hook.events) {
        this.off(event, hook.handler);
      }
      this.hooks.delete(hookId);
    }
  }

  getHook(hookId: string): FileChangeHook | undefined {
    return this.hooks.get(hookId);
  }

  listHooks(): FileChangeHook[] {
    return Array.from(this.hooks.values());
  }

  async trigger(event: HookEventType, context: HookContext, actions: HookAction[] = []): Promise<HookResult> {
    const result: HookResult = {
      triggered: this.listenerCount(event) > 0,
      actions,
      context,
    };

    if (result.triggered) {
      this.emit(event, result);
    }

    return result;
  }
}

// Global hook registry
let globalRegistry: HookRegistry | null = null;

export function getHookRegistry(): HookRegistry {
  if (!globalRegistry) {
    globalRegistry = new HookRegistry();
  }
  return globalRegistry;
}

/**
 * Analyze a file change and determine related files/entities
 */
export function analyzeFileChange(
  contextPath: string,
  filePath: string,
  eventType: "created" | "modified" | "deleted"
): {
  relatedItems: ContextItem[];
  relatedEntities: CodeEntity[];
  suggestedRelations: Array<{ source: string; target: string; type: RelationType }>;
} {
  const ctx = getContextByPath(contextPath);
  if (!ctx) {
    return { relatedItems: [], relatedEntities: [], suggestedRelations: [] };
  }

  const relatedItems: ContextItem[] = [];
  const relatedEntities: CodeEntity[] = [];
  const suggestedRelations: Array<{ source: string; target: string; type: RelationType }> = [];

  if (eventType === "deleted") {
    // For deletions, find what referenced this file
    const existingItem = getContextItemByPath(ctx.id, filePath);
    if (existingItem) {
      const related = getRelatedItems(existingItem.id, 2);
      relatedItems.push(...related.map((r) => r.item));

      // Find entities in related files that might import this file
      for (const rel of related) {
        const entities = getCodeEntitiesByItem(rel.item.id);
        for (const entity of entities) {
          if ((entity.metadata?.imports as string[])?.includes(filePath)) {
            relatedEntities.push(entity);
          }
        }
      }
    }
  } else {
    // For creates/modifies, find files that import this one
    const fileName = filePath.split("/").pop() ?? "";

    // Search for files that might import this
    const importers = searchContextItems(fileName, ctx.id);
    relatedItems.push(...importers.filter((f) => f.path !== filePath));

    // Get entities from the changed file if it exists
    const existingItem = getContextItemByPath(ctx.id, filePath);
    if (existingItem) {
      const entities = getCodeEntitiesByItem(existingItem.id);
      relatedEntities.push(...entities);

      // Analyze imports to suggest relations
      for (const entity of entities) {
        if (entity.metadata?.imports) {
          for (const imp of entity.metadata.imports as string[]) {
            suggestedRelations.push({
              source: entity.id,
              target: imp,
              type: "imports",
            });
          }
        }
      }
    }
  }

  return { relatedItems, relatedEntities, suggestedRelations };
}

/**
 * Auto-update relations when a file changes
 */
export async function updateRelationsForItem(
  contextId: string,
  itemId: string,
  content: string
): Promise<number> {
  const db = getDatabase();
  let relationsCreated = 0;

  // Parse imports from content
  const importRegex =
    /^(?:export\s+)?import\s+(?:(\*\s+as\s+\w+)|(\w+)|(?:type\s+)?\{([^}]+)\})\s*(?:from\s+)?['"]([^'"]+)['"]/gm;
  const imports: string[] = [];
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[4]!);
  }

  // Get item
  const item = getContextItemByPath(contextId, itemId);
  if (!item) return 0;

  const entities = getCodeEntitiesByItem(item.id);

  // For each entity, check if it has imports in metadata and create relations
  for (const entity of entities) {
    if (entity.metadata?.imports && Array.isArray(entity.metadata.imports)) {
      for (const imp of entity.metadata.imports as string[]) {
        // Try to find target entity or create a reference
        const targetEntities = db.get(
          "SELECT * FROM code_entities WHERE context_id = ? AND name = ? LIMIT 1",
          contextId,
          imp.split("/").pop() ?? imp
        ) as Record<string, unknown> | null;

        if (targetEntities) {
          upsertCodeRelation({
            context_id: contextId,
            source_item_id: item.id,
            source_entity_id: entity.id,
            target_entity_id: targetEntities["id"] as string,
            relation_type: "imports",
            relation_text: imp,
          });
          relationsCreated++;
        }
      }
    }
  }

  return relationsCreated;
}

/**
 * Process a file change event and trigger appropriate hooks
 */
export async function processFileChange(
  contextPath: string,
  filePath: string,
  eventType: "created" | "modified" | "deleted"
): Promise<HookResult> {
  const ctx = getContextByPath(contextPath);
  if (!ctx) {
    throw new Error(`Context not indexed at ${contextPath}`);
  }

  const context: HookContext = {
    contextId: ctx.id,
    contextPath,
    filePath,
    timestamp: new Date(),
  };

  const actions: HookAction[] = [];

  if (eventType === "deleted") {
    // Handle deletion
    const item = getContextItemByPath(ctx.id, filePath);
    if (item) {
      context.itemId = item.id;

      // Delete item and its entities/relations
      deleteCodeRelationsByItem(item.id);
      deleteCodeEntitiesByItem(item.id);
      deleteContextItem(item.id);

      actions.push({
        type: "delete",
        payload: { itemId: item.id, filePath },
      });
    }
  } else {
    // Handle create/modify - re-index the file
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const { entities } = await indexFile(ctx.id, filePath, content);

        context.itemId = entities[0]?.item_id;

        actions.push({
          type: "index",
          payload: { filePath, entitiesCount: entities.length },
        });

        // Update relations
        if (context.itemId) {
          const relsCreated = await updateRelationsForItem(ctx.id, context.itemId, content);
          if (relsCreated > 0) {
            actions.push({
              type: "relate",
              payload: { relationsCreated: relsCreated },
            });
          }
        }
      } catch (e) {
        console.error(`Error indexing file ${filePath}: ${e}`);
      }
    }
  }

  // Analyze related files
  const analysis = analyzeFileChange(contextPath, filePath, eventType);

  if (analysis.relatedItems.length > 0) {
    actions.push({
      type: "suggest",
      payload: {
        relatedFiles: analysis.relatedItems.map((f) => ({
          path: f.path,
          name: f.name,
        })),
        relatedEntities: analysis.relatedEntities.map((e) => ({
          name: e.name,
          type: e.type,
        })),
      },
    });
  }

  // Trigger hooks
  const registry = getHookRegistry();
  const hookEvent: HookEventType =
    eventType === "created"
      ? "file:created"
      : eventType === "modified"
        ? "file:modified"
        : "file:deleted";

  return registry.trigger(hookEvent, context, actions);
}

/**
 * Get context suggestions for AI editing a file
 */
export function getEditContext(
  contextPath: string,
  filePath: string,
  options: { maxRelated?: number; includeImports?: boolean } = {}
): {
  item: ContextItem | null;
  entities: CodeEntity[];
  relatedItems: Array<{ item: ContextItem; distance: number; via: string }>;
  suggestions: string[];
} {
  const maxRelated = options.maxRelated ?? 10;
  const ctx = getContextByPath(contextPath);
  if (!ctx) {
    return { item: null, entities: [], relatedItems: [], suggestions: [] };
  }

  const item = getContextItemByPath(ctx.id, filePath);
  if (!item) {
    return { item: null, entities: [], relatedItems: [], suggestions: [] };
  }

  const entities = getCodeEntitiesByItem(item.id);
  const relatedItems = getRelatedItems(item.id, 3).slice(0, maxRelated);

  const suggestions: string[] = [];

  // Generate suggestions based on relations
  for (const { item: relatedItem, distance, relation } of relatedItems) {
    suggestions.push(
      `${relatedItem.name} is ${distance} hop(s) away via ${relation.relation_type}`
    );
  }

  // If file has imports, suggest what it depends on
  if (options.includeImports !== false) {
    const imports: string[] = [];
    for (const entity of entities) {
      if (entity.metadata?.imports) {
        imports.push(...(entity.metadata.imports as string[]));
      }
    }
    if (imports.length > 0) {
      suggestions.push(`Imports: ${imports.join(", ")}`);
    }
  }

  return {
    item,
    entities,
    relatedItems: relatedItems.map(({ item: ri, distance, relation }) => ({
      item: ri,
      distance,
      via: relation.relation_type,
    })),
    suggestions,
  };
}

/**
 * Create a default hook that auto-updates the knowledge graph
 */
export function createGraphUpdateHook(contextPath: string): FileChangeHook {
  return {
    id: `graph-update-${Date.now()}`,
    name: "Knowledge Graph Auto-Update",
    events: ["file:created", "file:modified", "file:deleted"],
    contextPath,
    handler: async (result: HookResult) => {
      if (result.context.filePath) {
        console.log(
          `[hooks] Processing ${result.context.filePath} for context ${result.context.contextPath}`
        );
        for (const action of result.actions) {
          console.log(`[hooks]   Action: ${action.type}`, action.payload);
        }
      }
    },
    enabled: true,
  };
}

/**
 * Watch a context and trigger hooks on changes
 */
import { watch, type FSWatcher } from "fs";
import { join, extname } from "path";

const DEFAULT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".rb", ".php", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp"
]);

export function watchContextWithHooks(
  contextPath: string,
  hooks: FileChangeHook[] = []
): FSWatcher {
  const registry = getHookRegistry();

  // Register all hooks
  for (const hook of hooks) {
    registry.register(hook);
  }

  // Watch for changes
  const watcher = watch(contextPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    const fullPath = join(contextPath, filename);
    const ext = extname(filename);

    // Only process indexed extensions
    if (!DEFAULT_EXTENSIONS.has(ext)) return;

    if (eventType === "rename") {
      // Could be create or delete - check if file exists
      if (existsSync(fullPath)) {
        processFileChange(contextPath, fullPath, "created").catch(console.error);
      } else {
        processFileChange(contextPath, fullPath, "deleted").catch(console.error);
      }
    } else if (eventType === "change") {
      processFileChange(contextPath, fullPath, "modified").catch(console.error);
    }
  });

  return watcher;
}
