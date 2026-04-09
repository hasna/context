import {
  readdirSync,
  statSync,
  readFileSync,
  existsSync,
  watch,
  type FSWatcher,
} from "fs";
import { join, extname, basename, dirname } from "path";
import {
  upsertContext,
  getContextByPath,
  upsertContextItem,
  getContextItemByPath,
  upsertCodeEntity,
  upsertCodeRelation,
  upsertContextWatch,
  deleteCodeEntitiesByItem,
  updateContextCounts,
  type ContextItem,
  type CodeEntity,
  type RelationType,
  type ContextType,
} from "../db/repositories.js";
import { parseFile } from "./parser.js";

// Default file extensions to index
const DEFAULT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
]);

// Directories to ignore
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  "venv",
  "env",
  ".venv",
  ".env",
  ".idea",
  ".vscode",
  ".DS_Store",
  "coverage",
  ".nyc_output",
]);

// Files to ignore
const IGNORE_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  ".gitignore",
  ".gitattributes",
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
]);

export interface IndexerOptions {
  extensions?: Set<string>;
  ignoreDirs?: Set<string>;
  ignoreFiles?: Set<string>;
  watch?: boolean;
  onProgress?: (stats: IndexStats) => void;
}

export interface IndexStats {
  contextId: string;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  entitiesExtracted: number;
  relationsFound: number;
  errors: string[];
}

export interface IndexResult {
  context: Awaited<ReturnType<typeof upsertContext>>;
  stats: IndexStats;
}

// Scan a directory recursively and return all file paths
export function scanDirectory(
  rootPath: string,
  options: IndexerOptions = {}
): string[] {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const ignoreDirs = options.ignoreDirs ?? IGNORE_DIRS;
  const ignoreFiles = options.ignoreFiles ?? IGNORE_FILES;
  const files: string[] = [];

  function scanDir(dirPath: string): void {
    let entries;
    try {
      entries = readdirSync(dirPath);
    } catch (e) {
      console.error(`Cannot read directory ${dirPath}: ${e}`);
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;

      const fullPath = join(dirPath, entry);

      try {
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          if (!ignoreDirs.has(entry) && !entry.startsWith(".")) {
            scanDir(fullPath);
          }
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          if (extensions.has(ext) && !ignoreFiles.has(entry)) {
            files.push(fullPath);
          }
        }
      } catch (e) {
        // Skip files we can't stat
      }
    }
  }

  scanDir(rootPath);
  return files;
}

// Detect language from file extension
export function detectLanguageFromExtension(extension: string): string {
  const langMap: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".rb": "Ruby",
    ".php": "PHP",
    ".cs": "C#",
    ".cpp": "C++",
    ".cc": "C++",
    ".c": "C",
    ".h": "C/C++",
    ".hpp": "C++",
  };
  return langMap[extension.toLowerCase()] ?? "Unknown";
}

// Detect context type from path
export function detectContextType(path: string): ContextType {
  if (existsSync(join(path, ".git"))) return "repository";
  if (existsSync(join(path, "package.json"))) return "project";
  if (existsSync(join(path, "Cargo.toml"))) return "project";
  if (existsSync(join(path, "go.mod"))) return "project";
  return "folder";
}

// Index a single file
export async function indexFile(
  contextId: string,
  filePath: string,
  content: string
): Promise<{
  item: ContextItem;
  entities: CodeEntity[];
  relations: { source: CodeEntity; targetName: string; type: RelationType }[];
}> {
  const extension = extname(filePath);
  const name = basename(filePath);
  const parentPath = dirname(filePath);

  // Upsert the file
  const item = upsertContextItem({
    context_id: contextId,
    path: filePath,
    name,
    item_type: "file",
    parent_path: parentPath,
    extension,
    content,
    last_modified: new Date().toISOString(),
  });

  // Parse and extract entities
  const parsed = parseFile(filePath, extension, content);
  const entities: CodeEntity[] = [];
  const relations: {
    source: CodeEntity;
    targetName: string;
    type: RelationType;
  }[] = [];

  if (parsed) {
    // Delete old entities for this item
    deleteCodeEntitiesByItem(item.id);

    // Insert new entities
    for (const entity of parsed.entities) {
      const codeEntity = upsertCodeEntity({
        context_id: contextId,
        item_id: item.id,
        name: entity.name,
        type: entity.type,
        signature: entity.signature,
        start_line: entity.start_line,
        end_line: entity.end_line,
        visibility: entity.visibility,
        metadata: entity.metadata,
      });
      entities.push(codeEntity);

      // Extract relations from imports
      for (const imp of parsed.imports) {
        const importedNames = extractImportedNames(imp, parsed.imports);
        for (const imported of importedNames) {
          relations.push({
            source: codeEntity,
            targetName: imported,
            type: "imports",
          });
        }
      }
    }
  }

  return { item, entities, relations };
}

// Extract imported names from import statements
function extractImportedNames(
  importPath: string,
  _allImports: string[]
): string[] {
  // For now, just return the last part of the import path as the name
  const parts = importPath.split("/");
  const lastPart = parts[parts.length - 1]!;
  return [lastPart.replace(/['"]/g, "")];
}

// Index a directory/folder as a context
export async function indexRepository(
  repoPath: string,
  options: IndexerOptions = {}
): Promise<IndexResult> {
  const errors: string[] = [];
  const stats: IndexStats = {
    contextId: "",
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    entitiesExtracted: 0,
    relationsFound: 0,
    errors: [],
  };

  // Validate path exists
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  // Detect language from first file
  const files = scanDirectory(repoPath, options);
  let language = "Unknown";
  if (files.length > 0) {
    const firstExt = extname(files[0]!);
    language = detectLanguageFromExtension(firstExt);
  }

  // Detect context type
  const contextType = detectContextType(repoPath);

  // Upsert context
  const ctx = upsertContext({
    name: basename(repoPath),
    path: repoPath,
    type: contextType,
    description: `Local ${contextType}: ${basename(repoPath)}`,
    language,
  });

  stats.contextId = ctx.id;

  // Index all files
  for (const filePath of files) {
    stats.filesScanned++;

    try {
      const content = readFileSync(filePath, "utf-8");
      const { entities, relations } = await indexFile(
        ctx.id,
        filePath,
        content
      );

      // Store relations
      for (const rel of relations) {
        // Find target entity by name
        const targetEntities = upsertCodeEntity({
          context_id: ctx.id,
          item_id: entities[0]?.item_id ?? "",
          name: rel.targetName,
          type: "import",
          start_line: 0,
          end_line: 0,
        });

        upsertCodeRelation({
          context_id: ctx.id,
          source_item_id: entities[0]?.item_id ?? "",
          source_entity_id: rel.source.id,
          target_entity_id: targetEntities.id,
          relation_type: rel.type,
          relation_text: rel.targetName,
        });
        stats.relationsFound++;
      }

      stats.entitiesExtracted += entities.length;
      stats.filesIndexed++;

      if (options.onProgress) {
        options.onProgress(stats);
      }
    } catch (e) {
      errors.push(`Error indexing ${filePath}: ${e}`);
      stats.filesSkipped++;
    }
  }

  // Update context counts
  updateContextCounts(ctx.id);
  stats.errors = errors;

  return { context: ctx, stats };
}

// Alias for backward compatibility
export { indexRepository as indexContext };

// Watch a context for changes
export function watchRepository(
  repoPath: string,
  _options: IndexerOptions = {}
): FSWatcher {
  const ctx = getContextByPath(repoPath);
  if (!ctx) {
    throw new Error(`Context not found at path: ${repoPath}`);
  }

  // Set up watch
  const watcher = watch(repoPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    const fullPath = join(repoPath, filename);
    const ext = extname(filename);

    if (eventType === "change" || eventType === "rename") {
      // Check if it's a file we index
      if (DEFAULT_EXTENSIONS.has(ext)) {
        if (existsSync(fullPath)) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            indexFile(ctx.id, fullPath, content);
          } catch (e) {
            console.error(`Error updating file ${fullPath}: ${e}`);
          }
        }
      }
    } else if (eventType === "delete") {
      // File was deleted, could handle this if needed
    }
  });

  // Register the watch
  upsertContextWatch({
    context_id: ctx.id,
    path: repoPath,
    pattern: "**/*",
  });

  return watcher;
}

// Alias for backward compatibility
export { watchRepository as watchContext };

// Get diff between current files and indexed files
export function getUntrackedFiles(
  repoPath: string,
  contextId: string
): string[] {
  const files = scanDirectory(repoPath);
  const untracked: string[] = [];

  for (const filePath of files) {
    const existing = getContextItemByPath(contextId, filePath);
    if (!existing) {
      untracked.push(filePath);
    }
  }

  return untracked;
}

// Re-index only changed files
export async function refreshRepository(
  repoPath: string,
  options: IndexerOptions = {}
): Promise<IndexResult> {
  const ctx = getContextByPath(repoPath);
  if (!ctx) {
    // If not indexed, do full index
    return indexRepository(repoPath, options);
  }

  const files = scanDirectory(repoPath, options);
  const errors: string[] = [];

  let filesIndexed = 0;
  let entitiesExtracted = 0;
  let filesSkipped = 0;

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const { entities } = await indexFile(ctx.id, filePath, content);
      filesIndexed++;
      entitiesExtracted += entities.length;
    } catch (e) {
      errors.push(`Error refreshing ${filePath}: ${e}`);
      filesSkipped++;
    }
  }

  updateContextCounts(ctx.id);

  return {
    context: ctx,
    stats: {
      contextId: ctx.id,
      filesScanned: files.length,
      filesIndexed,
      filesSkipped,
      entitiesExtracted,
      relationsFound: 0,
      errors,
    },
  };
}

// Alias for backward compatibility
export { refreshRepository as refreshContext };
