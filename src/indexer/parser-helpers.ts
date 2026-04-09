import type { Visibility } from "../db/repositories.js";

export function findPythonBlockEnd(content: string, startIndex: number): number {
  const lines = content.substring(startIndex).split("\n");
  let baseIndent = -1;
  let lineNum = content.substring(0, startIndex).split("\n").length;

  for (const line of lines.slice(1)) {
    lineNum++;
    if (line.trim() === "") continue;

    const indent = line.search(/\S/);
    if (indent === -1) continue;

    if (baseIndent === -1) {
      baseIndent = indent;
    } else if (indent <= baseIndent) {
      return lineNum - 1;
    }
  }

  return lineNum;
}

export function findRustBlockEnd(content: string, startIndex: number): number {
  let braceCount = 0;
  let found = false;
  let lineNum = content.substring(0, startIndex).split("\n").length;

  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
      found = true;
    } else if (content[i] === "}") {
      braceCount--;
      if (found && braceCount === 0) {
        return content.substring(0, i).split("\n").length;
      }
    }
    if (content[i] === "\n") lineNum++;
  }

  return lineNum;
}

export function findGoBlockEnd(content: string, startIndex: number): number {
  let braceCount = 0;
  let found = false;
  let lineNum = content.substring(0, startIndex).split("\n").length;

  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
      found = true;
    } else if (content[i] === "}") {
      braceCount--;
      if (found && braceCount === 0) {
        return content.substring(0, i).split("\n").length;
      }
    }
    if (content[i] === "\n") lineNum++;
  }

  return lineNum;
}

export function findJavaBlockEnd(content: string, startIndex: number): number {
  let braceCount = 0;
  let found = false;
  let lineNum = content.substring(0, startIndex).split("\n").length;

  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
      found = true;
    } else if (content[i] === "}") {
      braceCount--;
      if (found && braceCount === 0) {
        return content.substring(0, i).split("\n").length;
      }
    }
    if (content[i] === "\n") lineNum++;
  }

  return lineNum;
}

export function findRubyBlockEnd(content: string, startIndex: number): number {
  const lines = content.substring(startIndex).split("\n");
  let baseIndent = -1;
  let lineNum = content.substring(0, startIndex).split("\n").length;

  for (const line of lines.slice(1)) {
    lineNum++;
    if (line.trim() === "") continue;

    const indent = line.search(/\S/);
    if (indent === -1) continue;

    if (baseIndent === -1) {
      baseIndent = indent;
    } else if (indent <= baseIndent && (line.trim() === "end" || line.match(/^end\b/))) {
      return lineNum - 1;
    }
  }

  return lineNum;
}

export function findPHPBlockEnd(content: string, startIndex: number): number {
  let braceCount = 0;
  let found = false;
  let lineNum = content.substring(0, startIndex).split("\n").length;

  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
      found = true;
    } else if (content[i] === "}") {
      braceCount--;
      if (found && braceCount === 0) {
        return content.substring(0, i).split("\n").length;
      }
    }
    if (content[i] === "\n") lineNum++;
  }

  return lineNum;
}

export function extractSignature(content: string, startIndex: number): string {
  const lineStart = content.lastIndexOf("\n", startIndex) + 1;
  const lineEnd = content.indexOf("\n", startIndex);
  const line =
    lineEnd === -1 ? content.substring(lineStart) : content.substring(lineStart, lineEnd);
  return line.trim();
}

export function extractLine(content: string, startIndex: number): string {
  return extractSignature(content, startIndex);
}

export function parseVisibility(modifier: string | undefined): Visibility {
  switch (modifier?.trim()) {
    case "public":
      return "public";
    case "private":
      return "private";
    case "protected":
      return "protected";
    default:
      return "public";
  }
}
