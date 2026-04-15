import { createHash } from "crypto";
import { insforge } from "./query";

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
  visibility?: string;   // 'public' | 'internal'
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

  const { error } = await insforge.database.from("poc_kb_chunks").insert(rows);
  if (error) {
    throw new Error(`Insert failed: ${JSON.stringify(error)}`);
  }
}

export function buildLearnedChunkRow(input: {
  title: string;
  content: string;
  tags?: string[];
  source_query?: string;
  source?: string;
}): ChunkRow {
  const source = input.source ?? "learned";
  const timestamp = Date.now();
  const hash = createHash("sha256").update(input.content).digest("hex").slice(0, 6);
  const sourcePrefix = source.toUpperCase().replace(/-/g, "_");
  const id = `${sourcePrefix}-${timestamp}-${hash}`;

  return {
    id,
    title: input.title,
    question: input.source_query || "",
    answer: input.content,
    text_content: `${input.title}\n${input.content}`,
    tags: input.tags || [],
    source,
    parent_id: null,
    created_at: new Date().toISOString(),
    verified: false,
    url: null,
  };
}
