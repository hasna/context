import {
  extractLine,
  findGoBlockEnd,
  findJavaBlockEnd,
  findPHPBlockEnd,
  findPythonBlockEnd,
  findRubyBlockEnd,
  findRustBlockEnd,
} from "./parser-helpers.js";
import type { ParsedEntity, ParsedFile } from "./parser-types.js";

export function parsePython(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  const importRegex = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[0]);
  }

  const classRegex = /^class\s+(\w+)(?:\([^)]*\))?:\s*$/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPythonBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "class",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const funcRegex = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPythonBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "function",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const methodRegex = /^\s+(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((match = methodRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPythonBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "method",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const typeRegex = /^(\w+)\s*:\s*type\s*=\s*/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    entities.push({
      name: match[1]!,
      type: "type",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: startLine,
      visibility: "public",
      metadata: {},
    });
  }

  const constRegex = /^[A-Z][A-Z0-9_]*\s*=\s*/gm;
  while ((match = constRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    entities.push({
      name: match[0].replace("=", "").trim(),
      type: "constant",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: startLine,
      visibility: "public",
      metadata: {},
    });
  }

  return { path: "", name: "", extension: ".py", content, entities, imports, exports };
}

export function parseRust(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  const useRegex = /^use\s+(.+);/gm;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(content)) !== null) {
    imports.push(match[1]!);
  }

  const structRegex = /^(?:pub\s+)?struct\s+(\w+)/gm;
  while ((match = structRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRustBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "class",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: match[0].includes("pub") ? "public" : "private",
      metadata: {},
    });
  }

  const enumRegex = /^(?:pub\s+)?enum\s+(\w+)/gm;
  while ((match = enumRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRustBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "enum",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: match[0].includes("pub") ? "public" : "private",
      metadata: {},
    });
  }

  const funcRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRustBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "function",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility: match[0].includes("pub") ? "public" : "private",
      metadata: {},
    });
  }

  const implRegex = /^impl(?:\s+[\w<>]+)?\s*/gm;
  while ((match = implRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRustBlockEnd(content, match.index);
    entities.push({
      name: `impl_${startLine}`,
      type: "class",
      signature: `impl block at line ${startLine}`,
      start_line: startLine,
      end_line: endLine,
      visibility: "private",
      metadata: {},
    });
  }

  const traitRegex = /^(?:pub\s+)?trait\s+(\w+)/gm;
  while ((match = traitRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRustBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "interface",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: match[0].includes("pub") ? "public" : "private",
      metadata: {},
    });
  }

  return { path: "", name: "", extension: ".rs", content, entities, imports, exports };
}

export function parseGo(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const lines = content.split("\n");

  const importRegex = /^\s*import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    if (match[1]) {
      const innerImports = match[1].match(/"([^"]+)"/g);
      if (innerImports) imports.push(...innerImports.map((i: string) => i.replace(/"/g, "")));
    } else if (match[2]) {
      imports.push(match[2]);
    }
  }

  for (const line of lines) {
    if (line.startsWith("// Export")) {
      const exportName = line.replace("// Export", "").trim();
      if (exportName) exports.push(exportName);
    }
  }

  const structRegex = /^type\s+(\w+)\s+struct\s*\{/gm;
  while ((match = structRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findGoBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "class",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const ifaceRegex = /^type\s+(\w+)\s+interface\s*\{/gm;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findGoBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "interface",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const funcRegex = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findGoBlockEnd(content, match.index);
    const isMethod = match[0].includes("(");
    entities.push({
      name: match[1]!,
      type: isMethod ? "method" : "function",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  return { path: "", name: "", extension: ".go", content, entities, imports, exports };
}

export function parseJava(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  const importRegex = /^import\s+([\w.]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]!);
  }

  const classRegex =
    /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findJavaBlockEnd(content, match.index);
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

  const ifaceRegex = /^(?:public\s+)?interface\s+(\w+)/gm;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findJavaBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "interface",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const methodRegex =
    /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+)?(?:void|int|String|boolean|double|float|long|char|byte|short|\w+)\s+(\w+)\s*\(/gm;
  while ((match = methodRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findJavaBlockEnd(content, match.index);
    const visibility = match[0].includes("private")
      ? "private"
      : match[0].includes("protected")
        ? "protected"
        : "public";
    entities.push({
      name: match[1]!,
      type: "method",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility,
      metadata: {},
    });
  }

  const enumRegex = /^(?:public\s+)?enum\s+(\w+)/gm;
  while ((match = enumRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findJavaBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "enum",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  return { path: "", name: "", extension: ".java", content, entities, imports, exports };
}

export function parseRuby(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  const requireRegex = /^(?:require|load)\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]!);
  }

  const classRegex = /^class\s+(\w+)(?:\s*<\s*[\w:]+)?\s*$/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRubyBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "class",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const moduleRegex = /^module\s+(\w+)\s*$/gm;
  while ((match = moduleRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRubyBlockEnd(content, match.index);
    entities.push({
      name: match[1]!,
      type: "module",
      signature: match[0].trim(),
      start_line: startLine,
      end_line: endLine,
      visibility: "public",
      metadata: {},
    });
  }

  const methodRegex = /^(?:def\s+|(?:private|public|protected)\s+def\s+)(\w+)/gm;
  while ((match = methodRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findRubyBlockEnd(content, match.index);
    const visibility = match[0].includes("private")
      ? "private"
      : match[0].includes("protected")
        ? "protected"
        : "public";
    entities.push({
      name: match[1]!,
      type: "function",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility,
      metadata: {},
    });
  }

  return { path: "", name: "", extension: ".rb", content, entities, imports, exports };
}

export function parsePHP(content: string): ParsedFile {
  const entities: ParsedEntity[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  const useRegex = /^use\s+([\w\\]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(content)) !== null) {
    imports.push(match[1]!);
  }

  const namespaceRegex = /^namespace\s+([\w\\]+);/gm;
  while ((match = namespaceRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split("\n").length;
    entities.push({
      name: match[1]!,
      type: "module",
      signature: `namespace ${match[1]}`,
      start_line: line,
      end_line: line,
      visibility: "public",
      metadata: {},
    });
  }

  const classRegex =
    /^(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+[\w\\]+)?(?:\s+implements\s+[\w,\s\\]+)?\s*\{/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPHPBlockEnd(content, match.index);
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

  const ifaceRegex = /^interface\s+(\w+)(?:\s+extends\s+[\w,\s\\]+)?\s*\{/gm;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPHPBlockEnd(content, match.index);
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

  const traitRegex = /^trait\s+(\w+)\s*\{/gm;
  while ((match = traitRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPHPBlockEnd(content, match.index);
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

  const funcRegex = /^(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)\s*\(/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPHPBlockEnd(content, match.index);
    const visibility = match[0].includes("private")
      ? "private"
      : match[0].includes("protected")
        ? "protected"
        : "public";
    entities.push({
      name: match[1]!,
      type: "function",
      signature: extractLine(content, match.index),
      start_line: startLine,
      end_line: endLine,
      visibility,
      metadata: {},
    });
  }

  return { path: "", name: "", extension: ".php", content, entities, imports, exports };
}
