/**
 * Parse and clean raw text content from Exa into indexable chunks.
 * Exa already returns text-only content, so we mainly need to:
 * 1. Clean up whitespace and artifacts
 * 2. Split into semantic chunks
 */

const CHUNK_SIZE = 1500; // target chars per chunk (~300 tokens)
const CHUNK_OVERLAP = 200; // overlap between chunks

/**
 * Clean raw text returned from Exa.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, "\n\n")
    // Remove common nav artifacts
    .replace(/^(Skip to|Jump to|Back to|Table of Contents|On this page)\b.*/gim, "")
    // Remove URLs on their own line (navigation links)
    .replace(/^https?:\/\/\S+$/gm, "")
    // Clean up leading/trailing whitespace per line
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Split cleaned text into overlapping chunks.
 * Tries to split at paragraph or sentence boundaries.
 */
export function splitIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_SIZE) {
    return text.trim() ? [text.trim()] : [];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 <= CHUNK_SIZE) {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
    } else {
      if (current) {
        chunks.push(current);
        // Overlap: carry last portion into next chunk
        const overlap = getOverlap(current);
        current = overlap ? `${overlap}\n\n${trimmed}` : trimmed;
      } else {
        // Single paragraph too long — split by sentences
        const sentences = splitBySentences(trimmed);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= CHUNK_SIZE) {
            current = current ? `${current} ${sentence}` : sentence;
          } else {
            if (current) {
              chunks.push(current);
              const overlap = getOverlap(current);
              current = overlap ? `${overlap} ${sentence}` : sentence;
            } else {
              // Single sentence too long — hard split
              chunks.push(sentence.slice(0, CHUNK_SIZE));
              current = sentence.slice(CHUNK_SIZE - CHUNK_OVERLAP);
            }
          }
        }
      }
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.trim().length > 50);
}

function getOverlap(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text;
  const start = text.length - CHUNK_OVERLAP;
  const spaceIdx = text.indexOf(" ", start);
  return spaceIdx > 0 ? text.slice(spaceIdx + 1) : text.slice(start);
}

function splitBySentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 chars).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
