import {
  extractLine,
  extractSignature,
  parseVisibility,
} from "./parser-helpers.js";
import type { ParsedEntity, ParsedFile } from "./parser-types.js";

export function parseTypeScript(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  const importRegex =
    /^(?:export\s+)?import\s+(?:(\*\s+as\s+\w+)|(\w+)|(?:type\s+)?\{([^}]+)\})\s*(?:from\s+)?['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[4]!);
  }

  const exportRegex =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]!);
  }

  const classRegex =
    /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[^{]+)?\s*\{/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const braceCount = { count: 0, found: false };
    let endLine = startLine;
    for (let i = match.index; i < content.length; i++) {
      if (content[i] === "{") {
        braceCount.count++;
        braceCount.found = true;
      } else if (content[i] === "}") {
        braceCount.count--;
        if (braceCount.found && braceCount.count === 0) {
          endLine = content.substring(0, i).split("\n").length;
          break;
        }
      }
    }
    entities.push({
      name: match[1]!,
      type: "class",
      signature: match[0].replace(/\{$/, "").trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const funcRegex =
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)(?:\s*<[^>]+>)?\s*\(/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const braceCount = { count: 0, found: false };
    let endLine = startLine;
    for (let i = match.index; i < content.length; i++) {
      if (content[i] === "{") {
        braceCount.count++;
        braceCount.found = true;
      } else if (content[i] === "}") {
        braceCount.count--;
        if (braceCount.found && braceCount.count === 0) {
          endLine = content.substring(0, i).split("\n").length;
          break;
        }
      }
    }
    const isExport = match[0].startsWith("export");
    entities.push({
      name: match[1]!,
      type: "function",
      signature: extractSignature(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility: isExport ? "public" : "private",
      metadata: {},
    });
  }

  const constRegex =
    /^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)(?:\s*:\s*(?:(?:[^{}]|\{[^}]*\})*))?\s*(?:=\s*(?:async\s+)?(?:(?:\([^)]*\))|(?:\w+))\s*=>|=\s*function)/gm;
  while ((match = constRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const bracePos = content.indexOf("{", match.index);
    if (bracePos === -1) continue;
    const braceCount = { count: 0 };
    let endLine = startLine;
    for (let i = bracePos; i < content.length; i++) {
      if (content[i] === "{") braceCount.count++;
      else if (content[i] === "}") {
        braceCount.count--;
        if (braceCount.count === 0) {
          endLine = content.substring(0, i).split("\n").length;
          break;
        }
      }
    }
    entities.push({
      name: match[1]!,
      type: "function",
      signature: extractSignature(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility: match[0].startsWith("export") ? "public" : "private",
      metadata: { isArrow: true },
    });
  }

  const ifaceRegex = /^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{/gm;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const braceCount = { count: 0, found: false };
    let endLine = startLine;
    for (let i = match.index; i < content.length; i++) {
      if (content[i] === "{") {
        braceCount.count++;
        braceCount.found = true;
      } else if (content[i] === "}") {
        braceCount.count--;
        if (braceCount.found && braceCount.count === 0) {
          endLine = content.substring(0, i).split("\n").length;
          break;
        }
      }
    }
    entities.push({
      name: match[1]!,
      type: "interface",
      signature: match[0].replace(/\{$/, "").trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const typeRegex = /^(?:export\s+)?type\s+(\w+)\s*=/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    entities.push({
      name: match[1]!,
      type: "type",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: startLine,
      visibility: match[0].startsWith("export") ? "public" : "private",
      metadata: {},
    });
  }

  const enumRegex = /^(?:export\s+)?enum\s+(\w+)\s*\{/gm;
  while ((match = enumRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    entities.push({
      name: match[1]!,
      type: "enum",
      signature: match[0].replace(/\{$/, "").trim(),
      start_line: startLine,
      end_line: startLine,
      visibility: match[0].startsWith("export") ? "public" : "private",
      metadata: {},
    });
  }

  const methodRegex =
    /^(?:\s*)((?:public|private|protected|readonly)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/gm;
  while ((match = methodRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const visibility = parseVisibility(match[1]);
    const braceCount = { count: 0, found: false };
    let endLine = startLine;
    for (let i = match.index; i < content.length; i++) {
      if (content[i] === "{") {
        braceCount.count++;
        braceCount.found = true;
      } else if (content[i] === "}") {
        braceCount.count--;
        if (braceCount.found && braceCount.count === 0) {
          endLine = content.substring(0, i).split("\n").length;
          break;
        }
      }
    }
    entities.push({
      name: match[2]!,
      type: "method",
      signature: extractSignature(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility,
      metadata: {},
    });
  }

  return {
    path: "",
    name: "",
    extension: ".ts",
    content,
    entities,
    imports,
    exports,
  };
}

export function parseJavaScript(content: string): ParsedFile {
  return parseTypeScript(content);
}
