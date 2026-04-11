import { readFileSync } from "fs";
import type { SourceAdapter, Chunk } from "../pipeline/types";

function normalizeToChunk(item: any, index: number): Chunk | null {
  // Already a Chunk (has content + metadata)
  if (item.content && item.metadata && item.id) {
    return item as Chunk;
  }
  // Minimal format: { id, title?, content or text_content or answer }
  const id = item.id || `json-${index}`;
  const content = item.content || item.text_content || item.answer || "";
  if (!content) return null;

  return {
    id,
    source: "json",
    title: item.title || id,
    content,
    metadata: {
      question: item.question || item.title || "",
      answer: item.answer || content,
      tags: item.tags || [],
      parent_id: item.parent_id || null,
      created_at: item.created_at || null,
      url: item.url || null,
    },
  };
}

export default {
  name: "json",
  description: "Import chunks from a JSON file (Chunk[] or array of objects with id + content)",

  async export(config) {
    const filePath = config.INPUT_PATH || "data/chunks.json";
    let raw: any[];
    try {
      raw = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
      throw new Error(`JSON adapter: failed to read "${filePath}": ${err}`);
    }

    if (!Array.isArray(raw)) {
      throw new Error(`JSON adapter: "${filePath}" must contain a JSON array`);
    }

    const chunks: Chunk[] = [];
    for (let i = 0; i < raw.length; i++) {
      const chunk = normalizeToChunk(raw[i], i);
      if (chunk) chunks.push(chunk);
    }

    return chunks;
  },
} satisfies SourceAdapter;
