import {
  parseGo,
  parseJava,
  parsePHP,
  parsePython,
  parseRuby,
  parseRust,
} from "./parser-languages.js";
import { parseJavaScript, parseTypeScript } from "./parser-typescript.js";
import type { ImportStatement, ParsedFile } from "./parser-types.js";

export type { ImportStatement, ParsedEntity, ParsedFile } from "./parser-types.js";

type Parser = (content: string) => ParsedFile;

const PARSERS: Record<string, Parser> = {
  ".ts": parseTypeScript,
  ".tsx": parseTypeScript,
  ".js": parseJavaScript,
  ".jsx": parseJavaScript,
  ".mjs": parseJavaScript,
  ".cjs": parseJavaScript,
  ".py": parsePython,
  ".rs": parseRust,
  ".go": parseGo,
  ".java": parseJava,
  ".rb": parseRuby,
  ".php": parsePHP,
};

export function parseFile(
  path: string,
  extension: string,
  content: string
): ParsedFile | null {
  const parser = PARSERS[extension];
  if (!parser) {
    return {
      path,
      name: path.split("/").pop() ?? path,
      extension,
      content,
      entities: [],
      imports: [],
      exports: [],
    };
  }

  try {
    return parser(content);
  } catch (e) {
    console.error(`Error parsing ${path}: ${e}`);
    return null;
  }
}

export function extractImports(content: string): ImportStatement[] {
  const results: ImportStatement[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const importMatch = line.match(
      /^(?:export\s+)?import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/
    );
    if (importMatch) {
      const isDefault = /^import\s+\w+/.test(importMatch[1]!);
      const isNamespace = /^import\s+\*\s+as/.test(importMatch[1]!);
      const namedMatch = importMatch[1]!.match(/\{([^}]+)\}/);
      const named = namedMatch
        ? namedMatch[1]!.split(",").map((s) => s.trim())
        : [];

      results.push({
        path: importMatch[2]!,
        imported: named,
        is_default: isDefault,
        is_namespace: isNamespace,
        line: i + 1,
      });
    }
  }

  return results;
}

export function detectLanguage(
  extension: string,
  _content: string
): string | null {
  if (extension === ".ts" || extension === ".tsx") return "TypeScript";
  if (extension === ".js" || extension === ".jsx") return "JavaScript";
  if (extension === ".py") return "Python";
  if (extension === ".rs") return "Rust";
  if (extension === ".go") return "Go";
  if (extension === ".java") return "Java";
  if (extension === ".rb") return "Ruby";
  if (extension === ".php") return "PHP";
  if (extension === ".cs") return "C#";
  if (extension === ".cpp" || extension === ".cc") return "C++";
  if (extension === ".c") return "C";
  return null;
}
