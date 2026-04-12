import { createClient } from "@insforge/sdk";
import { parseArgs } from "util";
import { loadBM25Index, type BM25Index } from "./bm25";

// Existing database client
export const insforge = createClient({
  baseUrl: process.env.INSFORGE_URL!,
  anonKey: process.env.INSFORGE_KEY!,
});

export interface MatchedChunk {
  id: string;
  title: string;
  question: string;
  answer: string;
  tags: string[];
  similarity: number;
  created_at?: string;
  source?: string;
  verified?: boolean;
  status?: string;
  url?: string | null;
}

export type SearchMode = "semantic" | "hybrid" | "sql-hybrid";

export interface SearchOptions {
  mode: SearchMode;
  topK: number;
  threshold: number;
  keywordWeight: number;
  semanticWeight: number;
  decayHalfLife: number;
  rewrite?: boolean;
  visibility?: "public" | "internal" | "all";
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  mode: "semantic",
  topK: 5,
  threshold: 0.3,
  keywordWeight: 0.25,
  semanticWeight: 0.75,
  decayHalfLife: 180,
};

const REWRITE_PROMPT = `You are a search query expander.
Rewrite the user query to improve search retrieval:
- Add relevant technical terms and context
- For Chinese queries, append English translation in parentheses
- For English queries, add relevant synonyms
- Do NOT change the core intent
- Output ONLY the rewritten query, nothing else
- Keep it concise (1-2 sentences max)`;

export async function rewriteQuery(query: string): Promise<string> {
  try {
    const completion = await insforge.ai.chat.completions.create({
      model: "openai/gpt-4o-mini",
      temperature: 0,
      maxTokens: 150,
      messages: [
        { role: "system", content: REWRITE_PROMPT },
        { role: "user", content: query },
      ],
    });
    return completion.choices[0].message.content?.trim() || query;
  } catch {
    return query;
  }
}

export async function embedQuery(text: string): Promise<number[]> {
  const response = await insforge.ai.embeddings.create({
    model: "openai/text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

export async function searchChunks(
  embedding: number[],
  matchThreshold: number,
  matchCount: number,
  visibility: string = "public"
): Promise<MatchedChunk[]> {
  const { data, error } = await insforge.database.rpc("match_chunks", {
    query_embedding: JSON.stringify(embedding),
    match_threshold: matchThreshold,
    match_count: matchCount,
    p_visibility: visibility,
  });

  if (error) {
    throw new Error(`Search failed: ${JSON.stringify(error)}`);
  }

  return data as MatchedChunk[];
}

export async function searchHybrid(
  embedding: number[],
  queryText: string,
  matchCount: number,
  keywordWeight: number = DEFAULT_SEARCH_OPTIONS.keywordWeight,
  semanticWeight: number = DEFAULT_SEARCH_OPTIONS.semanticWeight,
  decayHalfLife: number = DEFAULT_SEARCH_OPTIONS.decayHalfLife,
  visibility: string = "public"
): Promise<MatchedChunk[]> {
  const { data, error } = await insforge.database.rpc("hybrid_search", {
    query_embedding: JSON.stringify(embedding),
    query_text: queryText,
    match_count: matchCount,
    keyword_weight: keywordWeight,
    semantic_weight: semanticWeight,
    decay_halflife: decayHalfLife,
    p_visibility: visibility,
  });

  if (error) {
    throw new Error(`Hybrid search failed: ${JSON.stringify(error)}`);
  }

  return data as MatchedChunk[];
}

async function searchHybridBM25(
  queryText: string,
  embedding: number[],
  options: SearchOptions
): Promise<MatchedChunk[]> {
  const index = await loadBM25Index();
  const pool = options.topK * 4;

  const visibility = options.visibility || "public";

  // 1. BM25 keyword search (hard-filtered by visibility)
  const bm25Results = index.search(queryText, pool, visibility);

  // 2. Semantic search via pgvector (hard-filtered by visibility in SQL)
  const semanticResults = await searchChunks(embedding, 0.0, pool, visibility);

  const bm25Rank = new Map(bm25Results.map((r, i) => [r.id, i + 1]));
  const semanticRank = new Map(semanticResults.map((r, i) => [r.id, i + 1]));
  const bm25CreatedAt = new Map(bm25Results.map((r) => [r.id, r.createdAt]));
  const semanticCreatedAt = new Map(semanticResults.map((r) => [r.id, r.created_at]));

  const allIds = new Set([...bm25Rank.keys(), ...semanticRank.keys()]);

  const RRF_K = 20;
  const candidates: { id: string; score: number }[] = [];
  for (const id of allIds) {
    const kwRank = bm25Rank.get(id);
    const semRank = semanticRank.get(id);

    let score =
      (kwRank ? options.keywordWeight / (RRF_K + kwRank) : 0) +
      (semRank ? options.semanticWeight / (RRF_K + semRank) : 0);

    if (options.decayHalfLife > 0) {
      const dateStr = bm25CreatedAt.get(id) || semanticCreatedAt.get(id);
      if (dateStr) {
        const ageDays = (Date.now() - new Date(dateStr).getTime()) / 86400000;
        score *= Math.exp(-0.693147 / options.decayHalfLife * ageDays);
      }
    }

    candidates.push({ id, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const topIds = candidates.slice(0, options.topK);

  const semanticById = new Map(semanticResults.map((r) => [r.id, r]));
  const results: MatchedChunk[] = [];
  const missingIds: string[] = [];

  for (const { id, score } of topIds) {
    const chunk = semanticById.get(id);
    if (chunk) {
      results.push({ ...chunk, similarity: score });
    } else {
      missingIds.push(id);
    }
  }

  // Batch-fetch chunks only in BM25 results (not in semantic results)
  if (missingIds.length > 0) {
    const { data } = await insforge.database
      .from("poc_kb_chunks")
      .select("id, title, question, answer, tags, created_at, source, verified, status, url")
      .in("id", missingIds);

    if (data) {
      const fetchedById = new Map((data as MatchedChunk[]).map((r) => [r.id, r]));
      for (const { id, score } of topIds) {
        const fetched = fetchedById.get(id);
        if (fetched) {
          results.push({ ...fetched, similarity: score });
        }
      }
    }
  }

  // Downrank unverified "learned" chunks
  for (const result of results) {
    if (result.source === "learned" && result.status !== "verified") {
      result.similarity *= 0.7;
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);

  return results;
}

export async function retrieveChunks(
  queryText: string,
  options: SearchOptions
): Promise<MatchedChunk[]> {
  if (options.mode === "hybrid") {
    const embedding = await embedQuery(queryText);
    return searchHybridBM25(queryText, embedding, options);
  }
  if (options.mode === "sql-hybrid") {
    const embedding = await embedQuery(queryText);
    return searchHybrid(
      embedding, queryText, options.topK,
      options.keywordWeight, options.semanticWeight, options.decayHalfLife,
      options.visibility || "public"
    );
  }
  return searchChunks(await embedQuery(queryText), options.threshold, options.topK, options.visibility || "public");
}

export function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

export function printRetrievalResults(chunks: MatchedChunk[], query: string, top: number, threshold: number) {
  console.log(`\nQuery: ${query}`);
  console.log(
    `Found ${chunks.length} results (top: ${top}, threshold: ${threshold})`
  );

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const dateStr = c.created_at ? new Date(c.created_at).toLocaleDateString() : "unknown date";
    console.log(`\n${"─".repeat(50)}`);
    console.log(`[${i + 1}] ${c.id} (similarity: ${c.similarity.toFixed(4)}) [${dateStr}]`);
    console.log(`    Title: ${c.title}`);
    if (c.tags?.length) console.log(`    Tags: ${c.tags.join(", ")}`);
    console.log(`    Question: ${truncate(c.question, 120)}`);
    console.log(`    Answer: ${truncate(c.answer, 200)}`);
  }

  if (chunks.length === 0) {
    console.log("\nNo results found. Try lowering --threshold.");
  }
}

const RAG_LLM_URL = process.env.LLM_API_URL || process.env.ZEABUR_AI_HUB_URL || "https://api.openai.com/v1";
const RAG_LLM_KEY = process.env.LLM_API_KEY || process.env.ZEABUR_AI_HUB_API_KEY || process.env.INSFORGE_KEY!;
const RAG_DEFAULT_MODEL = process.env.RAG_MODEL || "gemini-2.5-flash-lite";

const RAG_SYSTEM_PROMPT_PREFIX = `你是技術支援助手。根據以下知識庫內容回答用戶問題。
- 僅根據提供的內容回答，不要編造
- 回答要具體、包含操作步驟
- 如果知識庫中沒有相關內容，請明確告知
- 引用來源時使用 [SUP-XXXX] 格式
- 注意資料日期，優先參考較新的內容，若內容衝突以較新日期為準

### 知識庫內容
`;

function buildRAGSystemPrompt(chunks: MatchedChunk[]): string {
  const context = chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.id} (${c.created_at || "unknown date"}): ${c.title}\nQuestion: ${c.question}\nAnswer: ${c.answer}`
    )
    .join("\n\n---\n\n");
  return RAG_SYSTEM_PROMPT_PREFIX + context;
}

function buildRAGRequestBody(chunks: MatchedChunk[], userQuery: string, model: string, stream: boolean) {
  return {
    model,
    messages: [
      { role: "system", content: buildRAGSystemPrompt(chunks) },
      { role: "user", content: userQuery },
    ],
    ...(stream && { stream: true }),
  };
}

async function fetchLLM(body: object): Promise<Response> {
  return fetch(`${RAG_LLM_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RAG_LLM_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function generateRAGAnswer(
  chunks: MatchedChunk[],
  userQuery: string,
  model: string = RAG_DEFAULT_MODEL
): Promise<string> {
  const resp = await fetchLLM(buildRAGRequestBody(chunks, userQuery, model, false));
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content || "(no response)";
}

export async function* generateRAGAnswerStream(
  chunks: MatchedChunk[],
  userQuery: string,
  model: string = "claude-opus-4-5"
) {
  const resp = await fetchLLM(buildRAGRequestBody(chunks, userQuery, model, true));

  if (!resp.ok || !resp.body) throw new Error(`Stream request failed: ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        const text = JSON.parse(payload).choices?.[0]?.delta?.content || "";
        if (text) yield text;
      } catch {}
    }
  }
}

async function main() {
  if (import.meta.main) {
    // Parse CLI arguments
    const { values, positionals } = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        rag: { type: "boolean", default: false },
        hybrid: { type: "boolean", default: false },
        mode: { type: "string" },
        top: { type: "string", default: "5" },
        threshold: { type: "string", default: "0.3" },
        "keyword-weight": { type: "string", default: "0.25" },
        "semantic-weight": { type: "string", default: "0.75" },
        model: { type: "string", default: "claude-opus-4-5" },
        decay: { type: "string", default: "180" },
        rewrite: { type: "boolean", default: false },
        visibility: { type: "string", default: "public" },
      },
      allowPositionals: true,
    });

    const query = positionals.join(" ").trim();
    if (!query) {
      console.error(`Usage: bun run src/query.ts [options] "your question"

Options:
  --rag              Enable RAG mode (retrieval + LLM answer)
  --hybrid           Use hybrid search (keyword + semantic + RRF)
  --mode MODE        Search mode: semantic | hybrid
  --top N            Number of results (default: 5)
  --threshold F      Similarity threshold (default: 0.3)
  --keyword-weight F Hybrid keyword weight (default: 0.25)
  --semantic-weight F Hybrid semantic weight (default: 0.75)
  --model MODEL      LLM model for RAG mode (default: claude-opus-4-5)
  --decay DAYS       Temporal decay half-life in days (default: 180, 0 to disable)
  --rewrite          Expand query with LLM before search
  --visibility SCOPE Search scope: public | internal | all (default: public)

Examples:
  bun run src/query.ts "如何部署 Docker 服務"
  bun run src/query.ts --hybrid --decay 90 "502 error"
  bun run src/query.ts --rag "deploy error 502"`);
      process.exit(1);
    }

    const top = parseInt(values.top!);
    const threshold = parseFloat(values.threshold!);
    const ragMode = values.rag!;
    const mode = (values.mode ||
      (values.hybrid ? "hybrid" : "semantic")) as SearchMode;
    if (mode !== "semantic" && mode !== "hybrid") {
      throw new Error(`Invalid --mode: ${values.mode}`);
    }
    const model = values.model!;
    const decay = parseInt(values.decay!);
    const keywordWeight = parseFloat(values["keyword-weight"]!);
    const semanticWeight = parseFloat(values["semantic-weight"]!);
    const rewrite = values.rewrite!;
    const visibility = (values.visibility as string) || "public";

    console.error(
      `Searching [${mode}] (top: ${top}, threshold: ${threshold}, kw: ${keywordWeight}, sem: ${semanticWeight}, decay: ${decay}d, rewrite: ${rewrite}, visibility: ${visibility})...`
    );
    const chunks = await retrieveChunks(query, {
      mode,
      topK: top,
      threshold,
      keywordWeight,
      semanticWeight,
      decayHalfLife: decay,
      rewrite,
      visibility: visibility as "public" | "internal" | "all",
    });

    // Always show retrieval results
    printRetrievalResults(chunks, query, top, threshold);

    // RAG mode: generate LLM answer
    if (ragMode) {
      if (chunks.length === 0) {
        console.log("\nRAG skipped: no chunks retrieved.");
        return;
      }

      console.error(`\nGenerating RAG answer (model: ${model})...`);
      const answer = await generateRAGAnswer(chunks, query, model);

      console.log(`\n${"═".repeat(50)}`);
      console.log(`RAG Answer (model: ${model}):`);
      console.log(`${"═".repeat(50)}`);
      console.log(answer);
    }
  }
}

main().catch(console.error);
