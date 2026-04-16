import { insforge } from "./query";

// --- Tokenizer ---

const EN_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "up", "it",
  "its", "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "they", "them", "their",
  "what", "which", "who", "whom",
]);

const ZH_STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一個", "上", "也", "很", "到", "說", "要", "去", "你", "會", "著",
  "沒有", "看", "好", "自己", "這", "他", "她", "它", "們", "那",
  "嗎", "吧", "啊", "呢", "哦", "喔", "嘛", "呀",
  "您好", "謝謝", "感謝", "好的", "收到",
]);

const zhSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

// --- Chinese Synonym Normalization (Traditional ↔ Simplified, pre-tokenization) ---
// Applied as string replacements BEFORE segmentation so compound words are handled

const ZH_SYNONYM_PAIRS: [string, string][] = [
  // Normalize to Traditional Chinese (matches docs content, better segmentation)
  // longer patterns first to avoid partial matches
  ["环境变量", "環境變數"],
  ["数据库", "資料庫"],
  ["服务器", "伺服器"],
  ["内存", "記憶體"],
  ["域名", "網域"],
  ["网站", "網站"],
  ["环境", "環境"],
  ["变量", "變數"],
  ["憑證", "憑證"],
  ["凭证", "憑證"],
  ["连接", "連線"],
  ["设置", "設定"], ["设定", "設定"],
  ["计费", "計費"],
  ["项目", "專案"],
  ["服务", "服務"],
  ["数据", "資料"],
  // English ↔ Chinese technical terms (expand English to include Chinese equivalent)
  ["database", "database 資料庫"],
  ["backup", "backup 備份"],
  ["deploy", "deploy 部署"],
  ["server", "server 伺服器"],
  ["template", "template 模板"],
  ["billing", "billing 計費"],
  ["refund", "refund 退款"],
  // Product name normalization
  ["git ", "git github "],
];

function normalizeSynonyms(text: string): string {
  let result = text;
  for (const [from, to] of ZH_SYNONYM_PAIRS) {
    if (from !== to) result = result.replaceAll(from, to);
  }
  return result;
}

// --- Porter Stemmer (simplified) ---
// Handles common English suffixes: -ing, -ed, -s, -tion, -ment, -ness, -ly, -er, -est, -able, -ible

const LATIN_RE = /^[a-z]+$/;

function porterStem(word: string): string {
  if (word.length <= 3) return word;

  let w = word;

  // Step 1: plurals and past participles
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) { /* keep */ }
  else if (w.endsWith("s")) w = w.slice(0, -1);

  if (w.endsWith("eed")) {
    // keep
  } else if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
  } else if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
  }

  // Step 2: common suffixes
  if (w.endsWith("ational")) w = w.slice(0, -5) + "e";
  else if (w.endsWith("tion")) w = w.slice(0, -4) + "t";
  else if (w.endsWith("ment") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ness") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("able") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ible") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ally") && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("er") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("est") && w.length > 5) w = w.slice(0, -3);

  return w;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = normalizeSynonyms(text.toLowerCase());
  const segments = zhSegmenter.segment(normalized);

  for (const { segment, isWordLike } of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    // Keep wordLike segments and numeric tokens (e.g. "502", "8080")
    if (!isWordLike && !/^\d+$/.test(trimmed)) continue;
    if (EN_STOPWORDS.has(trimmed) || ZH_STOPWORDS.has(trimmed)) continue;
    // Apply stemming to Latin words only (Chinese already normalized pre-segmentation)
    const token = LATIN_RE.test(trimmed) ? porterStem(trimmed) : trimmed;
    tokens.push(token);
  }

  return tokens;
}

// --- BM25 Index ---

interface DocEntry {
  tokens: string[];
  tf: Map<string, number>;
  length: number;
  createdAt: string | null;
  source: string;
}

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

export class BM25Index {
  private docs = new Map<string, DocEntry>();
  private df = new Map<string, number>(); // document frequency
  private avgDl = 0;
  private N = 0;

  addDocument(id: string, text: string, createdAt: string | null, source: string): void {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    this.docs.set(id, { tokens, tf, length: tokens.length, createdAt, source });

    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }
  }

  build(): void {
    this.N = this.docs.size;
    let totalLength = 0;
    for (const doc of this.docs.values()) {
      totalLength += doc.length;
    }
    this.avgDl = this.N > 0 ? totalLength / this.N : 0;
    console.error(`[bm25] Index built: ${this.N} docs, avgDl=${this.avgDl.toFixed(1)}, ${this.df.size} unique terms`);
  }

  search(query: string, topK: number, allowedSources: string[] | null = null): { id: string; score: number; createdAt: string | null }[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores: { id: string; score: number; createdAt: string | null }[] = [];

    for (const [id, doc] of this.docs) {
      if (allowedSources !== null && !allowedSources.includes(doc.source)) continue;
      let score = 0;

      for (const term of queryTokens) {
        const termDf = this.df.get(term) || 0;
        if (termDf === 0) continue;

        const termTf = doc.tf.get(term) || 0;
        if (termTf === 0) continue;

        // IDF: ln((N - df + 0.5) / (df + 0.5) + 1)
        const idf = Math.log((this.N - termDf + 0.5) / (termDf + 0.5) + 1);

        // BM25 term score
        const tfNorm = (termTf * (K1 + 1)) /
          (termTf + K1 * (1 - B + B * doc.length / this.avgDl));

        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ id, score, createdAt: doc.createdAt });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }

  get size(): number {
    return this.N;
  }
}

// --- Load from DB ---

let cachedIndex: BM25Index | null = null;

export async function loadBM25Index(): Promise<BM25Index> {
  if (cachedIndex) return cachedIndex;

  console.error("[bm25] Loading chunks from DB...");

  // Fetch all chunks — paginate since default limit is 1000
  const allRows: { id: string; title: string; text_content: string; created_at: string | null; source: string; status: string | null }[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await insforge.database
      .from("kb_chunks")
      .select("id, title, text_content, created_at, source, status")
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to load chunks: ${JSON.stringify(error)}`);
    if (!data || data.length === 0) break;

    allRows.push(...(data as typeof allRows));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Filter out rejected chunks — they should never appear in search
  const activeRows = allRows.filter(r => r.status !== "rejected");
  console.error(`[bm25] Loaded ${allRows.length} chunks (${allRows.length - activeRows.length} rejected excluded), building index...`);

  const index = new BM25Index();
  for (const row of activeRows) {
    // Title boosting: inject title tokens twice
    const text = `${row.title} ${row.title} ${row.text_content || ""}`;
    index.addDocument(row.id, text, row.created_at, row.source);
  }
  index.build();

  cachedIndex = index;
  return index;
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;
const CLEAR_DEBOUNCE_MS = 5000;

export function clearBM25Cache(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    cachedIndex = null;
    clearTimer = null;
    console.error("[bm25] Cache cleared (debounced)");
  }, CLEAR_DEBOUNCE_MS);
}
