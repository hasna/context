/**
 * Parse and clean raw text/markdown content into indexable chunks.
 * Handles content from both Exa (text) and Firecrawl (markdown).
 */

const CHUNK_SIZE = 1500; // target chars per chunk (~300 tokens)
const CHUNK_OVERLAP = 200; // overlap between adjacent chunks
const MIN_CHUNK_LENGTH = 80; // discard chunks shorter than this

// Common boilerplate patterns to strip
const BOILERPLATE_PATTERNS = [
  /^(Skip to|Jump to|Back to|On this page|Table of contents|In this (article|section|page|guide))\b.*/gim,
  /^(Edit (this page|on GitHub)|View source|Last (updated|modified):.*)/gim,
  /^(Cookie|Privacy|Terms|Accept all cookies|We use cookies).*/gim,
  /^(Share|Tweet|Like|Follow us|Subscribe|Newsletter).*/gim,
  /^(Previous|Next|Prev|←|→|‹|›)\s*(page|article|section)?.*/gim,
  /^\[.*\]\s*$\n?/gm, // Lone markdown links on a line
  /^https?:\/\/\S+\s*$/gm, // Bare URLs on their own line
  /^#{1,6}\s*(Overview|Introduction|Getting Started|Table of Contents)\s*$/gim, // Very generic headings
];

// Duplicate line detection
const MAX_DUPLICATE_LINE_RATIO = 0.4;

/**
 * Clean raw text/markdown returned from a crawler.
 */
export function cleanText(raw: string): string {
  let text = raw;

  // Normalize line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove HTML tags before decoding entities (order matters)
  text = text.replace(/<[^>]{1,200}>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");

  // Remove zero-width and invisible characters
  text = text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "");

  // Strip boilerplate patterns
  for (const pattern of BOILERPLATE_PATTERNS) {
    text = text.replace(pattern, "");
  }

  // Remove lines that are just separators
  text = text.replace(/^[-=*_]{3,}\s*$/gm, "");

  // Remove excessive whitespace within lines
  text = text
    .split("\n")
    .map((line) => line.replace(/\s{2,}/g, " ").trimEnd())
    .join("\n");

  // Collapse 3+ blank lines to 2
  text = text.replace(/\n{3,}/g, "\n\n");

  // Deduplicate repeated lines (navigation menus repeat)
  text = deduplicateLines(text);

  // Final trim
  text = text.trim();

  return text;
}

/**
 * Remove duplicate lines that appear more than twice in the document.
 * This catches repeated navigation elements, footers, etc.
 */
function deduplicateLines(text: string): string {
  const lines = text.split("\n");
  const lineCounts = new Map<string, number>();

  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (key.length < 10) continue; // Skip short lines
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
  }

  const totalLines = lines.length;
  const result: string[] = [];
  const seenDuplicates = new Map<string, number>();

  for (const line of lines) {
    const key = line.trim().toLowerCase();
    const count = lineCounts.get(key) ?? 1;

    // If line appears in >40% of all lines (and at least 3 times), it's likely boilerplate
    if (count >= 3 && count / totalLines > MAX_DUPLICATE_LINE_RATIO && key.length > 15) {
      continue;
    }

    // Allow a line to appear up to 2 times (e.g. appears in intro + section)
    const seen = seenDuplicates.get(key) ?? 0;
    if (count > 2 && seen >= 2) {
      continue;
    }

    result.push(line);
    if (count > 2) {
      seenDuplicates.set(key, seen + 1);
    }
  }

  return result.join("\n");
}

/**
 * Split cleaned text into overlapping chunks at paragraph/sentence boundaries.
 */
export function splitIntoChunks(text: string): string[] {
  if (!text.trim()) return [];
  if (text.length <= CHUNK_SIZE) {
    const trimmed = text.trim();
    return trimmed.length >= MIN_CHUNK_LENGTH ? [trimmed] : [];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= CHUNK_SIZE) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current.length >= MIN_CHUNK_LENGTH) {
        chunks.push(current);
        // Carry overlap from end of current chunk
        current = `${getOverlap(current)}\n\n${para}`.trim();
      } else if (para.length > CHUNK_SIZE) {
        // Long paragraph — split by sentences
        const sentences = splitBySentences(para);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= CHUNK_SIZE) {
            current = current ? `${current} ${sentence}` : sentence;
          } else {
            if (current.length >= MIN_CHUNK_LENGTH) {
              chunks.push(current);
              current = `${getOverlap(current)} ${sentence}`.trim();
            } else {
              current = sentence;
            }
          }
        }
      } else {
        current = para;
      }
    }
  }

  if (current.trim().length >= MIN_CHUNK_LENGTH) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Compute Jaccard similarity between two text strings (word overlap).
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  return intersection / (wordsA.size + wordsB.size - intersection);
}

/**
 * Deduplicate an array of chunks, removing those with >threshold similarity
 * to a previously seen chunk.
 */
export function deduplicateChunks(
  chunks: string[],
  threshold = 0.8
): string[] {
  const result: string[] = [];
  for (const chunk of chunks) {
    const isDuplicate = result.some(
      (existing) => jaccardSimilarity(existing, chunk) > threshold
    );
    if (!isDuplicate) result.push(chunk);
  }
  return result;
}

/**
 * Estimate token count (rough: 1 token ≈ 4 chars).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getOverlap(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text;
  const start = text.length - CHUNK_OVERLAP;
  const spaceIdx = text.indexOf(" ", start);
  return spaceIdx > 0 ? text.slice(spaceIdx + 1) : text.slice(start);
}

function splitBySentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}
