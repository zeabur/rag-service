import type { Chunk } from "./types";

/**
 * Generic quality filter. Removes low-quality chunks based on answer content.
 * Chunks without a metadata.answer bypass the filter (the rules are answer-specific).
 */
export function filterChunks(chunks: Chunk[]): Chunk[] {
  let filtered = 0;
  const result = chunks.filter(chunk => {
    const answer = chunk.metadata.answer || "";
    if (!answer) return true;
    if (answer.length < 15) { filtered++; return false; }
    if (/^(ok|okay|好的|收到|已處理)/i.test(answer)) { filtered++; return false; }
    if (/目前沒有|没有具体|暫無/.test(answer)) { filtered++; return false; }
    return true;
  });
  if (filtered > 0) {
    console.error(`[Pipeline] Filtered out ${filtered} low-quality chunk(s)`);
  }
  return result;
}

/**
 * Validate chunks have required fields. Returns valid chunks, logs warnings for invalid ones.
 */
export function validateChunks(chunks: Chunk[], adapterName: string): Chunk[] {
  return chunks.filter(chunk => {
    if (!chunk.id || !chunk.content) {
      console.error(`[Pipeline] Warning: adapter "${adapterName}" produced chunk without id or content, skipping`);
      return false;
    }
    return true;
  });
}
