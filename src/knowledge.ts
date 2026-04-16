import { createHash } from "crypto";
import { insforge } from "./query";
import { chunkText } from "./pipeline/chunker";

const CHUNK_URL_BASE = process.env.CHUNK_URL_BASE || null;
const chunkUrl = (id: string): string | null =>
  CHUNK_URL_BASE ? `${CHUNK_URL_BASE.replace(/\/$/, "")}/${id}` : null;

export interface ChunkRow {
  id: string;
  title: string;
  question: string;
  answer: string;
  text_content: string;
  tags: string[];
  source: string;
  parent_id: string | null;
  created_at: string | null;
  verified: boolean;
  status?: string;       // 'unverified' | 'verified' | 'rejected'
  url: string | null;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await insforge.ai.embeddings.create({
    model: "openai/text-embedding-3-small",
    input: texts,
  });
  return response.data.map((item: { embedding: number[] }) => item.embedding);
}

export async function insertChunks(
  chunks: ChunkRow[],
  embeddings: number[][]
): Promise<void> {
  const rows = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: JSON.stringify(embeddings[i]),
  }));

  const { error } = await insforge.database.from("kb_chunks").insert(rows);
  if (error) {
    throw new Error(`Insert failed: ${JSON.stringify(error)}`);
  }
}

export function buildLearnedChunkRows(input: {
  title: string;
  content: string;
  tags?: string[];
  source_query?: string;
  source?: string;
}): ChunkRow[] {
  const source = input.source ?? "learned";
  const timestamp = Date.now();
  const hash = createHash("sha256").update(input.content).digest("hex").slice(0, 6);
  const sourcePrefix = source.toUpperCase().replace(/-/g, "_");
  const baseId = `${sourcePrefix}-${timestamp}-${hash}`;
  const createdAt = new Date().toISOString();
  const tags = input.tags || [];
  const question = input.source_query || "";

  const chunkResults = chunkText(input.content, { headings: [input.title] });

  if (chunkResults.length === 0) {
    return [{
      id: baseId,
      title: input.title,
      question,
      answer: input.content,
      text_content: `${input.title}\n${input.content}`,
      tags,
      source,
      parent_id: null,
      created_at: createdAt,
      verified: false,
      url: chunkUrl(baseId),
    }];
  }

  const firstId = `${baseId}-0`;
  return chunkResults.map((cr) => {
    const id = `${baseId}-${cr.index}`;
    return {
      id,
      title: input.title,
      question,
      answer: cr.text,
      text_content: cr.text,
      tags,
      source,
      parent_id: cr.isContinuation ? firstId : null,
      created_at: createdAt,
      verified: false,
      url: chunkUrl(id),
    };
  });
}
