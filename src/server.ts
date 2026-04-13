import { serve } from "bun";
import {
  DEFAULT_SEARCH_OPTIONS,
  generateRAGAnswer,
  generateRAGAnswerStream,
  retrieveChunks,
  insforge,
  type SearchMode,
} from "./query";
import { embedTexts, buildLearnedChunkRow, insertChunks } from "./knowledge";
import { clearBM25Cache } from "./bm25";
import { appendFile } from "node:fs/promises";
import {
  hashKey, generateRawKey, validateScopes, computeExpiry,
  VALID_SCOPES, type ApiKeyRow, getKeyStatus,
} from "./api-keys";
import { runMigrations } from "./migrate";

// Run idempotent schema migrations on startup
await runMigrations().catch(err => {
  console.error("[Migration] Failed:", err);
});

const PORT = process.env.PORT || 3000;
const FEEDBACK_PATH = "data/user-feedback.jsonl";
const RAG_API_KEY = process.env.RAG_API_KEY;
// Format: "username:password"
const RAG_BASIC_AUTH = process.env.RAG_BASIC_AUTH;

// Key cache: hash → { row, cachedAt }
const keyCache = new Map<string, { row: ApiKeyRow; cachedAt: number }>();
const KEY_CACHE_TTL = 5 * 60 * 1000; // 5 min

// Debounce last_used_at updates: at most once per 60s per key
const lastUsedUpdated = new Map<string, number>();
const LAST_USED_DEBOUNCE = 60 * 1000;

function clearKeyCache(keyHash?: string) {
  if (keyHash) keyCache.delete(keyHash);
  else keyCache.clear();
}

function updateLastUsed(row: ApiKeyRow) {
  const now = Date.now();
  const last = lastUsedUpdated.get(row.id);
  if (last && now - last < LAST_USED_DEBOUNCE) return;
  lastUsedUpdated.set(row.id, now);
  insforge.database.from("rag_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => {})
    .catch((err: any) => console.error("[Auth] last_used_at update failed:", err));
}

interface AuthResult {
  authenticated: boolean;
  scopes: string[];
  keyPrefix: string | null;
  client: string | null;
  error?: string;
  status?: number; // 401 or 403
}

async function authenticateRequest(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");
  const apiKeyHeader = req.headers.get("X-API-Key");
  const providedKey = apiKeyHeader || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  if (!providedKey) {
    return { authenticated: false, scopes: [], keyPrefix: null, client: null, error: "Unauthorized", status: 401 };
  }

  // Fast path: check legacy RAG_API_KEY first (cheap string compare, no hash/DB)
  if (RAG_API_KEY && providedKey === RAG_API_KEY) {
    return { authenticated: true, scopes: [...VALID_SCOPES], keyPrefix: null, client: null };
  }

  const hash = hashKey(providedKey);

  // Resolve key row from cache or DB
  let row: ApiKeyRow | null = null;
  const cached = keyCache.get(hash);
  if (cached && Date.now() - cached.cachedAt < KEY_CACHE_TTL) {
    row = cached.row;
  } else {
    const { data } = await insforge.database
      .from("rag_api_keys")
      .select("id, name, key_hash, key_prefix, scopes, client, expires_at, revoked_at, last_used_at")
      .eq("key_hash", hash)
      .single();
    if (data) row = data as ApiKeyRow;
  }

  if (!row) {
    return { authenticated: false, scopes: [], keyPrefix: null, client: null, error: "Unauthorized", status: 401 };
  }

  // Validate key status
  const status = getKeyStatus(row);
  if (status === "revoked") {
    keyCache.delete(hash); // Don't cache revoked keys
    return { authenticated: false, scopes: [], keyPrefix: row.key_prefix, client: row.client, error: "Key has been revoked", status: 401 };
  }
  if (status === "expired") {
    keyCache.delete(hash); // Don't cache expired keys
    return { authenticated: false, scopes: [], keyPrefix: row.key_prefix, client: row.client, error: "Key has expired", status: 401 };
  }

  // Cache valid key and update last_used (debounced)
  keyCache.set(hash, { row, cachedAt: Date.now() });
  updateLastUsed(row);
  return { authenticated: true, scopes: row.scopes, keyPrefix: row.key_prefix, client: row.client };
}

function hasScope(auth: AuthResult, scope: string): boolean {
  return auth.scopes.includes(scope);
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function checkBasicAuth(req: Request): boolean {
  if (!RAG_BASIC_AUTH) return true;
  const authHeader = req.headers.get("Authorization");
  const provided = authHeader?.startsWith("Basic ")
    ? atob(authHeader.slice(6))
    : null;
  return provided === RAG_BASIC_AUTH;
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function writeAudit(entry: {
  chunk_id: string;
  action: string;
  actor?: string;
  old_value?: any;
  new_value?: any;
}): Promise<void> {
  try {
    await insforge.database.from("rag_audit_log").insert([{
      chunk_id: entry.chunk_id,
      action: entry.action,
      actor: entry.actor || null,
      old_value: entry.old_value || null,
      new_value: entry.new_value || null,
    }]);
  } catch (err) {
    console.error("[Audit] Write error:", err);
  }
}

async function writeSignal(signal: {
  query: string;
  mode: string;
  top_k: number;
  top_similarity: number | null;
  top_chunk_ids: string[];
  answer_model: string | null;
  client: string;
  key_prefix?: string | null;
}): Promise<string | null> {
  try {
    const { data, error } = await insforge.database
      .from("rag_query_signals")
      .insert([signal])
      .select("id")
      .single();
    if (error) {
      console.error("[Signal] Write failed:", error);
      return null;
    }
    return (data as any)?.id ?? null;
  } catch (err) {
    console.error("[Signal] Write error:", err);
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function chunkPageHtml(chunk: { notFound?: boolean; id: string; title?: string; question?: string; answer?: string; tags?: string[]; source?: string; created_at?: string; url?: string | null; verified?: boolean }): string {
  if (chunk.notFound) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found — Knowledge Base</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{text-align:center}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#888}</style>
</head><body><div class="c"><h1>Chunk Not Found</h1><p>${escapeHtml(chunk.id)}</p></div></body></html>`;
  }

  const title = escapeHtml(chunk.title || chunk.id);
  const source = chunk.source || "unknown";
  const date = chunk.created_at ? new Date(chunk.created_at).toLocaleDateString("zh-TW") : "";
  const tags = (chunk.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const question = escapeHtml(chunk.question || "");
  const answer = escapeHtml(chunk.answer || "").replace(/\n/g, "<br>");
  const verified = chunk.verified === false ? `<span class="badge unverified">Unverified</span>` : "";
  const sourceUrl = chunk.url ? `<a href="${escapeHtml(chunk.url)}" class="source-link">${escapeHtml(chunk.url)}</a>` : "";

  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Knowledge Base</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${escapeHtml((chunk.question || "").slice(0, 200))}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;line-height:1.6}
.wrap{max-width:720px;margin:0 auto;padding:2rem 1.5rem}
.header{margin-bottom:2rem;border-bottom:1px solid #222;padding-bottom:1.5rem}
h1{font-size:1.4rem;font-weight:600;margin-bottom:.75rem}
.meta{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;font-size:.85rem;color:#888}
.meta .source{background:#1a1a2e;color:#7c7cff;padding:.15rem .5rem;border-radius:4px;font-weight:500}
.tag{background:#1a2e1a;color:#7cff7c;padding:.15rem .5rem;border-radius:4px;font-size:.8rem}
.badge.unverified{background:#2e1a1a;color:#ff7c7c;padding:.15rem .5rem;border-radius:4px}
.section{margin-bottom:1.5rem}
.section-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#666;margin-bottom:.5rem}
.question{font-size:1.05rem;color:#ccc;padding:1rem;background:#111;border-radius:8px;border-left:3px solid #444}
.answer{padding:1rem;background:#111;border-radius:8px;color:#bbb;font-size:.95rem}
.source-link{color:#7c7cff;text-decoration:none;font-size:.9rem;word-break:break-all}
.source-link:hover{text-decoration:underline}
.footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #222;font-size:.8rem;color:#555}
</style></head><body><div class="wrap">
<div class="header">
  <h1>${title}</h1>
  <div class="meta">
    <span class="source">${escapeHtml(source)}</span>
    ${tags}
    ${verified}
    ${date ? `<span>${date}</span>` : ""}
    <span style="color:#555">${escapeHtml(chunk.id)}</span>
  </div>
</div>
${question ? `<div class="section"><div class="section-label">Question</div><div class="question">${question}</div></div>` : ""}
<div class="section"><div class="section-label">Answer</div><div class="answer">${answer}</div></div>
${sourceUrl ? `<div class="section"><div class="section-label">Source</div>${sourceUrl}</div>` : ""}
<div class="footer">Knowledge Base</div>
</div></body></html>`;
}

const server = serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Auth check for /api/* routes
    let auth: AuthResult = { authenticated: false, scopes: [], keyPrefix: null, client: null };
    if (url.pathname.startsWith("/api/")) {
      auth = await authenticateRequest(req);
      if (!auth.authenticated) {
        return jsonResponse({ error: auth.error || "Unauthorized" }, auth.status || 401);
      }
      // Admin routes require admin scope
      if (url.pathname.startsWith("/api/admin/") && !hasScope(auth, "admin")) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
    }

    // API: Feedback (requires write:feedback)
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      if (!hasScope(auth, "write:feedback")) return jsonResponse({ error: "Insufficient permissions" }, 403);
      try {
        const feedback = await req.json();
        const entry = {
          timestamp: new Date().toISOString(),
          ...feedback
        };

        await appendFile(FEEDBACK_PATH, JSON.stringify(entry) + "\n");
        console.log(`[API] Feedback received for query: "${feedback.query}" (Score: ${feedback.score})`);

        if (feedback.signal_id) {
          insforge.database
            .from("rag_query_signals")
            .update({ feedback_score: feedback.score, feedback_comment: feedback.comment || null })
            .eq("id", feedback.signal_id)
            .then(({ error }) => {
              if (error) console.error("[Feedback] Signal update failed:", error);
            });
        }

        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // API: Report (requires write:report)
    if (url.pathname === "/api/report" && req.method === "POST") {
      if (!hasScope(auth, "write:report")) return jsonResponse({ error: "Insufficient permissions" }, 403);
      try {
        const body = await req.json();
        const { chunk_id, type, query, detail } = body;

        if (!type) {
          return jsonResponse({ error: "type is required (outdated | incorrect | missing)" }, 400);
        }

        const { data, error } = await insforge.database
          .from("rag_reports")
          .insert([{ chunk_id: chunk_id || null, type, query: query || null, detail: detail || null }])
          .select("id")
          .single();

        if (error) {
          return jsonResponse({ error: error.message }, 500);
        }

        const reportId = (data as any)?.id;
        console.log(`[API] Report received: type=${type} chunk=${chunk_id} id=${reportId}`);
        return jsonResponse({ success: true, id: reportId });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // API: Learn (requires write:learn)
    if (url.pathname === "/api/learn" && req.method === "POST") {
      if (!hasScope(auth, "write:learn")) return jsonResponse({ error: "Insufficient permissions" }, 403);
      try {
        const body = await req.json();
        const { title, content, tags, source_query } = body;

        if (!title || !content) {
          return jsonResponse({ error: "title and content are required" }, 400);
        }

        const chunkRow = buildLearnedChunkRow({ title, content, tags, source_query });
        const [embedding] = await embedTexts([chunkRow.text_content]);
        await insertChunks([chunkRow], [embedding]);

        console.log(`[API] Learned chunk indexed: ${chunkRow.id}`);
        writeAudit({ chunk_id: chunkRow.id, action: "create", new_value: { title, content, tags } });
        clearBM25Cache();
        return jsonResponse({ id: chunkRow.id, status: "indexed", verified: false });
      } catch (err: any) {
        console.error("[API] Learn error:", err);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // API: Query (requires read:public or read:internal)
    if (url.pathname === "/api/query" && req.method === "POST") {
      if (!hasScope(auth, "read:public") && !hasScope(auth, "read:internal")) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
      try {
        const body = await req.json();
        const {
          query,
          rag = true,
          hybrid = true,
          mode,
          top = DEFAULT_SEARCH_OPTIONS.topK,
          top_k,
          threshold = DEFAULT_SEARCH_OPTIONS.threshold,
          keyword_weight = DEFAULT_SEARCH_OPTIONS.keywordWeight,
          semantic_weight = DEFAULT_SEARCH_OPTIONS.semanticWeight,
          model = process.env.RAG_MODEL || "gemini-2.5-flash-lite",
          stream = false,
          decay = DEFAULT_SEARCH_OPTIONS.decayHalfLife,
          rewrite = false,
          visibility = "public",
        } = body;

        if (!query) {
          return jsonResponse({ error: "Query is required" }, 400);
        }

        // Use explicit client from body, fall back to key's default client, then "api"
        const resolvedClient = body.client || auth.client || "api";

        const resolvedMode = (mode || (hybrid ? "hybrid" : "semantic")) as SearchMode;
        if (resolvedMode !== "semantic" && resolvedMode !== "hybrid") {
          return jsonResponse({ error: "mode must be semantic or hybrid" }, 400);
        }

        const resolvedTopK = Number(top_k ?? top);
        console.log(
          `[API] Query: "${query}" (rag: ${rag}, mode: ${resolvedMode}, top_k: ${resolvedTopK}, threshold: ${threshold}, kw: ${keyword_weight}, sem: ${semantic_weight}, stream: ${stream}, decay: ${decay}d)`
        );

        const resolvedVisibility = (visibility === "all" || visibility === "internal") ? visibility : "public";
        if (resolvedVisibility !== "public" && !hasScope(auth, "read:internal")) {
          return jsonResponse({ error: "Insufficient permissions for internal visibility" }, 403);
        }
        const chunks = await retrieveChunks(query, {
          mode: resolvedMode,
          topK: resolvedTopK,
          threshold: Number(threshold),
          keywordWeight: Number(keyword_weight),
          semanticWeight: Number(semantic_weight),
          decayHalfLife: Number(decay),
          rewrite: Boolean(rewrite),
          visibility: resolvedVisibility,
        });

        // Write signal asynchronously (don't block response)
        const topSimilarity = chunks.length > 0 ? chunks[0].similarity : null;
        const topChunkIds = chunks.slice(0, 5).map((c) => c.id);
        const signalPromise = writeSignal({
          query,
          mode: resolvedMode,
          top_k: resolvedTopK,
          top_similarity: topSimilarity,
          top_chunk_ids: topChunkIds,
          answer_model: rag ? model : null,
          client: String(resolvedClient),
          key_prefix: auth.keyPrefix || null,
        });

        // Non-streaming response
        if (!stream) {
          let answer = null;
          if (rag && chunks.length > 0) {
            answer = await generateRAGAnswer(chunks, query, model);
          }

          const signalId = await signalPromise;

          return jsonResponse({
            query,
            chunks,
            answer,
            model,
            signal_id: signalId,
            search: {
              mode: resolvedMode,
              top_k: resolvedTopK,
              threshold: Number(threshold),
              keyword_weight: Number(keyword_weight),
              semantic_weight: Number(semantic_weight),
              decay: Number(decay),
            },
          });
        }

        // Streaming response
        const encoder = new TextEncoder();
        const responseStream = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunks", chunks }) + "\n"));

            if (rag && chunks.length > 0) {
              try {
                const answerStream = generateRAGAnswerStream(chunks, query, model);
                for await (const text of answerStream) {
                  controller.enqueue(encoder.encode(JSON.stringify({ type: "text", text }) + "\n"));
                }
              } catch (err: any) {
                console.error("[API] Stream error:", err);
                controller.enqueue(encoder.encode(JSON.stringify({ type: "error", error: err.message }) + "\n"));
              }
            } else if (rag) {
              controller.enqueue(encoder.encode(JSON.stringify({ type: "text", text: "抱歉，我找不到相關資訊。" }) + "\n"));
            }

            controller.close();
          },
        });

        return new Response(responseStream, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Transfer-Encoding": "chunked",
            ...CORS_HEADERS,
          },
        });

      } catch (err: any) {
        console.error(err);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Signals — moved to paginated endpoint below

    // Admin: Reports list
    if (url.pathname === "/api/admin/reports" && req.method === "GET") {
      try {
        const status = url.searchParams.get("status") || "open";
        let q = insforge.database
          .from("rag_reports")
          .select("*")
          .order("created_at", { ascending: false });
        if (status !== "all") q = (q as any).eq("status", status);
        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse(data);
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Close report
    const reportCloseMatch = url.pathname.match(/^\/api\/admin\/reports\/([^/]+)\/close$/);
    if (reportCloseMatch && req.method === "POST") {
      try {
        const id = reportCloseMatch[1];
        const { error } = await insforge.database
          .from("rag_reports")
          .update({ status: "closed" })
          .eq("id", id);
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Source stats (dynamic — queries distinct sources from DB)
    if (url.pathname === "/api/admin/source-stats" && req.method === "GET") {
      try {
        // Paginate to avoid PostgREST default 1000-row limit
        const PAGE_SIZE = 1000;
        const breakdown: Record<string, number> = {};
        let offset = 0;
        while (true) {
          const { data: rows, error: srcErr } = await insforge.database
            .from("poc_kb_chunks")
            .select("source")
            .range(offset, offset + PAGE_SIZE - 1);
          if (srcErr) throw srcErr;
          if (!rows || rows.length === 0) break;
          for (const row of rows as { source: string | null }[]) {
            const src = row.source || "unknown";
            breakdown[src] = (breakdown[src] || 0) + 1;
          }
          if (rows.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
        return jsonResponse({ total, breakdown });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Learned chunks
    if (url.pathname === "/api/admin/learned" && req.method === "GET") {
      try {
        const statusFilter = url.searchParams.get("status") || "unverified";
        const limit = Number(url.searchParams.get("limit") || 200);
        const offset = Number(url.searchParams.get("offset") || 0);
        let q = insforge.database
          .from("poc_kb_chunks")
          .select("id, title, question, answer, tags, source, verified, status, visibility, created_at", { count: "exact" })
          .eq("source", "learned")
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (statusFilter !== "all") q = (q as any).eq("status", statusFilter);
        const { data, error, count } = await q;
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ data, total: count });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Verify learned chunk
    const verifyMatch = url.pathname.match(/^\/api\/admin\/learned\/([^/]+)\/verify$/);
    if (verifyMatch && req.method === "POST") {
      try {
        const id = verifyMatch[1];
        const { error } = await insforge.database
          .from("poc_kb_chunks")
          .update({ verified: true, status: "verified" })
          .eq("id", id);
        if (error) return jsonResponse({ error: error.message }, 500);
        writeAudit({ chunk_id: id, action: "verify", old_value: { status: "unverified" }, new_value: { status: "verified" } });
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Reject learned chunk (soft delete — keeps record)
    const rejectMatch = url.pathname.match(/^\/api\/admin\/learned\/([^/]+)\/reject$/);
    if (rejectMatch && req.method === "POST") {
      try {
        const id = rejectMatch[1];
        const { error } = await insforge.database
          .from("poc_kb_chunks")
          .update({ status: "rejected" })
          .eq("id", id);
        if (error) return jsonResponse({ error: error.message }, 500);
        writeAudit({ chunk_id: id, action: "reject", old_value: { status: "unverified" }, new_value: { status: "rejected" } });
        clearBM25Cache();
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Delete learned chunk (soft reject — keeps record for audit trail)
    const deleteLearnedMatch = url.pathname.match(/^\/api\/admin\/learned\/([^/]+)$/);
    if (deleteLearnedMatch && req.method === "DELETE") {
      try {
        const id = deleteLearnedMatch[1];
        // Fetch old data for audit
        const { data: oldData } = await insforge.database
          .from("poc_kb_chunks")
          .select("title, status, source")
          .eq("id", id)
          .single();
        const { error } = await insforge.database
          .from("poc_kb_chunks")
          .update({ status: "rejected" })
          .eq("id", id)
          .eq("source", "learned");
        if (error) return jsonResponse({ error: error.message }, 500);
        writeAudit({ chunk_id: id, action: "reject", old_value: oldData, new_value: { status: "rejected" } });
        clearBM25Cache();
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Triage — aggregated "what needs attention"
    if (url.pathname === "/api/admin/triage" && req.method === "GET") {
      try {
        const days = Number(url.searchParams.get("days") || 14);
        const similarityThreshold = Number(url.searchParams.get("similarity_threshold") || 0.4);
        const limit = Number(url.searchParams.get("limit") || 20);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const [reportsResult, learnedResult, lowSimResult, negFeedbackResult] = await Promise.all([
          // 1. Open reports (no time window)
          (async () => {
            const { data, error, count } = await insforge.database
              .from("rag_reports")
              .select("id, type, chunk_id, query, detail, created_at", { count: "exact" })
              .eq("status", "open")
              .order("created_at", { ascending: false })
              .limit(limit);
            return { data: data || [], error, count: count || 0 };
          })(),

          // 2. Unverified learned (no time window)
          (async () => {
            const { data, error, count } = await insforge.database
              .from("poc_kb_chunks")
              .select("id, title, tags, created_at", { count: "exact" })
              .eq("source", "learned")
              .eq("status", "unverified")
              .order("created_at", { ascending: false })
              .limit(limit);
            const now = Date.now();
            const withAge = (data || []).map((row: any) => ({
              ...row,
              age_days: row.created_at
                ? Math.floor((now - new Date(row.created_at).getTime()) / (24 * 60 * 60 * 1000))
                : null,
            }));
            return { data: withAge, error, count: count || 0 };
          })(),

          // 3. Low-similarity signals (time-windowed, dedup by query in app)
          (async () => {
            const { data, error, count } = await insforge.database
              .from("rag_query_signals")
              .select("id, query, top_similarity, top_chunk_ids, client, created_at", { count: "exact" })
              .gte("created_at", since)
              .lt("top_similarity", similarityThreshold)
              .not("top_similarity", "is", null)
              .order("created_at", { ascending: false });
            // Dedup by query: keep most recent (already sorted by created_at desc)
            const seen = new Set<string>();
            const deduped: any[] = [];
            for (const row of (data || []) as any[]) {
              const q = (row.query || "").toLowerCase().trim();
              if (seen.has(q)) continue;
              seen.add(q);
              deduped.push(row);
            }
            return { data: deduped.slice(0, limit), error, count: deduped.length };
          })(),

          // 4. Negative feedback signals (time-windowed)
          (async () => {
            const { data, error, count } = await insforge.database
              .from("rag_query_signals")
              .select("id, query, feedback_score, feedback_comment, top_chunk_ids, created_at", { count: "exact" })
              .gte("created_at", since)
              .lt("feedback_score", 0)
              .order("created_at", { ascending: false })
              .limit(limit);
            return { data: data || [], error, count: count || 0 };
          })(),
        ]);

        // Build response with partial error support
        const response: Record<string, any> = {
          generated_at: new Date().toISOString(),
          window_days: days,
          similarity_threshold: similarityThreshold,
          counts: {
            open_reports: 0,
            unverified_learned: 0,
            low_similarity_signals: 0,
            negative_feedback_signals: 0,
          },
          has_more: {
            open_reports: false,
            unverified_learned: false,
            low_similarity_signals: false,
            negative_feedback_signals: false,
          },
        };

        if (reportsResult.error) {
          response.open_reports_error = reportsResult.error.message;
          response.open_reports = [];
        } else {
          response.open_reports = reportsResult.data;
          response.counts.open_reports = reportsResult.count;
          response.has_more.open_reports = reportsResult.count > limit;
        }

        if (learnedResult.error) {
          response.unverified_learned_error = learnedResult.error.message;
          response.unverified_learned = [];
        } else {
          response.unverified_learned = learnedResult.data;
          response.counts.unverified_learned = learnedResult.count;
          response.has_more.unverified_learned = learnedResult.count > limit;
        }

        if (lowSimResult.error) {
          response.low_similarity_signals_error = lowSimResult.error.message;
          response.low_similarity_signals = [];
        } else {
          response.low_similarity_signals = lowSimResult.data;
          response.counts.low_similarity_signals = lowSimResult.count;
          response.has_more.low_similarity_signals = lowSimResult.count > limit;
        }

        if (negFeedbackResult.error) {
          response.negative_feedback_signals_error = negFeedbackResult.error.message;
          response.negative_feedback_signals = [];
        } else {
          response.negative_feedback_signals = negFeedbackResult.data;
          response.counts.negative_feedback_signals = negFeedbackResult.count;
          response.has_more.negative_feedback_signals = negFeedbackResult.count > limit;
        }

        return jsonResponse(response);
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Signals with pagination
    if (url.pathname === "/api/admin/signals" && req.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const search = url.searchParams.get("search") || "";
        let q = insforge.database
          .from("rag_query_signals")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (search) q = (q as any).ilike("query", `%${search}%`);
        const { data, error, count } = await q;
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ data, total: count });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Signal detail (with full chunk content)
    const signalDetailMatch = url.pathname.match(/^\/api\/admin\/signals\/([^/]+)$/);
    if (signalDetailMatch && req.method === "GET") {
      try {
        const id = signalDetailMatch[1];
        const { data: signal, error } = await insforge.database
          .from("rag_query_signals")
          .select("*")
          .eq("id", id)
          .single();
        if (error || !signal) return jsonResponse({ error: "Signal not found" }, 404);

        // Fetch full chunk content for top_chunk_ids
        const chunkIds = (signal as any).top_chunk_ids || [];
        let chunks: any[] = [];
        if (chunkIds.length > 0) {
          const { data: chunkData } = await insforge.database
            .from("poc_kb_chunks")
            .select("id, title, question, answer, tags, source, verified, status, visibility, created_at, url")
            .in("id", chunkIds);
          chunks = chunkData || [];
        }

        return jsonResponse({ signal, chunks });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Browse all chunks
    if (url.pathname === "/api/admin/chunks" && req.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const source = url.searchParams.get("source");
        const status = url.searchParams.get("status");
        const visibility = url.searchParams.get("visibility");
        const search = url.searchParams.get("search") || "";
        const sortBy = url.searchParams.get("sort_by") || "created_at";
        const sortDir = url.searchParams.get("sort_dir") === "asc";

        let q = insforge.database
          .from("poc_kb_chunks")
          .select("id, title, question, answer, tags, source, verified, status, visibility, created_at, url", { count: "exact" })
          .order(sortBy, { ascending: sortDir })
          .range(offset, offset + limit - 1);

        if (source) q = (q as any).eq("source", source);
        if (status) q = (q as any).eq("status", status);
        if (visibility) q = (q as any).eq("visibility", visibility);
        if (search) q = (q as any).or(`id.ilike.%${search}%,title.ilike.%${search}%,question.ilike.%${search}%,answer.ilike.%${search}%`);

        const { data, error, count } = await q;
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ data, total: count });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Chunk detail (with related reports, signals, audit)
    const chunkDetailMatch = url.pathname.match(/^\/api\/admin\/chunks\/([^/]+)$/);
    if (chunkDetailMatch && req.method === "GET") {
      try {
        const id = decodeURIComponent(chunkDetailMatch[1]);
        const { data: chunk, error } = await insforge.database
          .from("poc_kb_chunks")
          .select("id, title, question, answer, text_content, tags, source, verified, status, visibility, parent_id, created_at, url")
          .eq("id", id)
          .single();
        if (error || !chunk) return jsonResponse({ error: "Chunk not found" }, 404);

        // Related reports
        const { data: reports } = await insforge.database
          .from("rag_reports")
          .select("*")
          .eq("chunk_id", id)
          .order("created_at", { ascending: false });

        // Related signals (chunks that appeared in search results)
        const { data: signals } = await insforge.database
          .from("rag_query_signals")
          .select("id, query, mode, top_similarity, feedback_score, created_at")
          .contains("top_chunk_ids", [id])
          .order("created_at", { ascending: false })
          .limit(20);

        // Audit log
        const { data: auditLog } = await insforge.database
          .from("rag_audit_log")
          .select("*")
          .eq("chunk_id", id)
          .order("created_at", { ascending: false });

        return jsonResponse({ chunk, reports: reports || [], signals: signals || [], audit_log: auditLog || [] });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Update chunk content (any subset of editable fields)
    // PATCH body: { title?, question?, answer?, tags?, url?, text_content?, visibility?, status? }
    // If text_content is provided, the embedding is recomputed.
    const patchChunkMatch = url.pathname.match(/^\/api\/admin\/chunks\/([^/]+)$/);
    if (patchChunkMatch && req.method === "PATCH") {
      try {
        const id = decodeURIComponent(patchChunkMatch[1]);
        const body = await req.json();

        const editable = ["title", "question", "answer", "tags", "url", "text_content", "visibility", "status"] as const;
        const updates: Record<string, any> = {};
        for (const key of editable) {
          if (key in body) updates[key] = body[key];
        }
        if (Object.keys(updates).length === 0) {
          return jsonResponse({ error: "No editable fields provided" }, 400);
        }
        if (updates.visibility && updates.visibility !== "public" && updates.visibility !== "internal") {
          return jsonResponse({ error: "visibility must be 'public' or 'internal'" }, 400);
        }
        if (updates.status && !["unverified", "verified", "rejected"].includes(updates.status)) {
          return jsonResponse({ error: "status must be 'unverified' | 'verified' | 'rejected'" }, 400);
        }
        if (updates.tags && !Array.isArray(updates.tags)) {
          return jsonResponse({ error: "tags must be an array" }, 400);
        }
        // If any content field changes, text_content must also be provided so the embedding stays in sync.
        const contentFields = ["title", "question", "answer"] as const;
        const contentChanged = contentFields.some(f => f in updates);
        if (contentChanged && !("text_content" in updates)) {
          return jsonResponse({
            error: "text_content is required when updating title/question/answer (embedding must stay in sync)",
          }, 400);
        }

        // Fetch old row for audit + existence check
        const { data: oldRow, error: fetchErr } = await insforge.database
          .from("poc_kb_chunks")
          .select("id, title, question, answer, tags, url, text_content, visibility, status")
          .eq("id", id)
          .single();
        if (fetchErr || !oldRow) return jsonResponse({ error: "Chunk not found" }, 404);

        // Re-embed if text_content changed
        let embeddingUpdated = false;
        if ("text_content" in updates && updates.text_content !== (oldRow as any).text_content) {
          const [embedding] = await embedTexts([updates.text_content]);
          (updates as any).embedding = JSON.stringify(embedding);
          embeddingUpdated = true;
        }

        const { error: updateErr } = await insforge.database
          .from("poc_kb_chunks")
          .update(updates)
          .eq("id", id);
        if (updateErr) return jsonResponse({ error: updateErr.message }, 500);

        // Audit: log only the fields that actually changed (omit embedding blob)
        const oldDiff: Record<string, any> = {};
        const newDiff: Record<string, any> = {};
        for (const key of editable) {
          if (key in updates && JSON.stringify((oldRow as any)[key]) !== JSON.stringify(updates[key])) {
            oldDiff[key] = (oldRow as any)[key];
            newDiff[key] = updates[key];
          }
        }
        if (embeddingUpdated) newDiff.embedding = "<re-embedded>";
        writeAudit({ chunk_id: id, action: "edit", old_value: oldDiff, new_value: newDiff });

        clearBM25Cache();
        return jsonResponse({ success: true, id, updated_fields: Object.keys(newDiff), embedding_updated: embeddingUpdated });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Update chunk visibility
    const visibilityMatch = url.pathname.match(/^\/api\/admin\/chunks\/([^/]+)\/visibility$/);
    if (visibilityMatch && req.method === "POST") {
      try {
        const id = decodeURIComponent(visibilityMatch[1]);
        const { visibility } = await req.json();
        if (visibility !== "public" && visibility !== "internal") {
          return jsonResponse({ error: "visibility must be 'public' or 'internal'" }, 400);
        }
        const { data: old } = await insforge.database
          .from("poc_kb_chunks")
          .select("visibility")
          .eq("id", id)
          .single();
        const { error } = await insforge.database
          .from("poc_kb_chunks")
          .update({ visibility })
          .eq("id", id);
        if (error) return jsonResponse({ error: error.message }, 500);
        writeAudit({ chunk_id: id, action: "visibility_change", old_value: old, new_value: { visibility } });
        clearBM25Cache();
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Bulk visibility update
    if (url.pathname === "/api/admin/chunks/bulk-visibility" && req.method === "POST") {
      try {
        const { ids, visibility } = await req.json();
        if (!Array.isArray(ids) || (visibility !== "public" && visibility !== "internal")) {
          return jsonResponse({ error: "ids (array) and visibility ('public'|'internal') required" }, 400);
        }
        const { error } = await insforge.database
          .from("poc_kb_chunks")
          .update({ visibility })
          .in("id", ids);
        if (error) return jsonResponse({ error: error.message }, 500);
        for (const id of ids) {
          writeAudit({ chunk_id: id, action: "visibility_change", new_value: { visibility } });
        }
        clearBM25Cache();
        return jsonResponse({ success: true, count: ids.length });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Audit log
    if (url.pathname === "/api/admin/audit-log" && req.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const action = url.searchParams.get("action");
        const chunkId = url.searchParams.get("chunk_id");

        let q = insforge.database
          .from("rag_audit_log")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (action) q = (q as any).eq("action", action);
        if (chunkId) q = (q as any).eq("chunk_id", chunkId);

        const { data, error, count } = await q;
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ data, total: count });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Overview stats (server-side aggregation)
    if (url.pathname === "/api/admin/overview" && req.method === "GET") {
      try {
        const [signalStats, reportStats, learnedStats, keyStats] = await Promise.all([
          // Signal stats: total, avg sim, feedback counts, client breakdown
          (async () => {
            const { count: totalQueries } = await insforge.database
              .from("rag_query_signals").select("*", { count: "exact", head: true });
            // Paginate feedback + similarity + client data to avoid 1000-row cap
            const PAGE_SIZE = 1000;
            let pos = 0, neg = 0, simSum = 0, simCount = 0;
            const clientCounts: Record<string, number> = {};
            let offset = 0;
            while (true) {
              const { data, error } = await insforge.database
                .from("rag_query_signals")
                .select("feedback_score, top_similarity, client")
                .range(offset, offset + PAGE_SIZE - 1);
              if (error || !data || data.length === 0) break;
              for (const r of data as { feedback_score: number | null; top_similarity: number | null; client: string | null }[]) {
                if (r.feedback_score === 1) pos++;
                else if (r.feedback_score === -1) neg++;
                if (r.top_similarity != null) { simSum += r.top_similarity; simCount++; }
                const c = r.client || "api";
                clientCounts[c] = (clientCounts[c] || 0) + 1;
              }
              if (data.length < PAGE_SIZE) break;
              offset += PAGE_SIZE;
            }
            const avgSim = simCount ? simSum / simCount : 0;
            const clientBreakdown = Object.entries(clientCounts)
              .map(([name, count]) => ({ name, count }))
              .sort((a, b) => b.count - a.count);
            return { totalQueries: totalQueries || 0, avgSim, posFeedback: pos, negFeedback: neg, clientBreakdown };
          })(),
          // Report stats
          (async () => {
            const { count: open } = await insforge.database
              .from("rag_reports").select("*", { count: "exact", head: true }).eq("status", "open");
            return { openReports: open || 0 };
          })(),
          // Learned stats
          (async () => {
            const { count: unverified } = await insforge.database
              .from("poc_kb_chunks").select("*", { count: "exact", head: true }).eq("source", "learned").eq("status", "unverified");
            const { count: verified } = await insforge.database
              .from("poc_kb_chunks").select("*", { count: "exact", head: true }).eq("source", "learned").eq("status", "verified");
            const { count: rejected } = await insforge.database
              .from("poc_kb_chunks").select("*", { count: "exact", head: true }).eq("source", "learned").eq("status", "rejected");
            return { learnedUnverified: unverified || 0, learnedVerified: verified || 0, learnedRejected: rejected || 0 };
          })(),
          // Key stats
          (async () => {
            const { data: keys } = await insforge.database
              .from("rag_api_keys").select("expires_at, revoked_at");
            const now = new Date();
            let active = 0, expired = 0, revoked = 0;
            for (const k of (keys || []) as any[]) {
              if (k.revoked_at) revoked++;
              else if (k.expires_at && new Date(k.expires_at) <= now) expired++;
              else active++;
            }
            return { keysActive: active, keysExpired: expired, keysRevoked: revoked };
          })(),
        ]);

        return jsonResponse({ ...signalStats, ...reportStats, ...learnedStats, ...keyStats });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: List API keys
    if (url.pathname === "/api/admin/keys" && req.method === "GET") {
      try {
        const { data, error, count } = await insforge.database
          .from("rag_api_keys")
          .select("id, name, key_prefix, scopes, client, expires_at, revoked_at, last_used_at, created_at", { count: "exact" })
          .order("created_at", { ascending: false });
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ data, total: count });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Create API key
    if (url.pathname === "/api/admin/keys" && req.method === "POST") {
      try {
        const body = await req.json();
        const { name, scopes, client: keyClient, expires_in_days } = body;
        if (!name || !Array.isArray(scopes) || scopes.length === 0) {
          return jsonResponse({ error: "name (string) and scopes (non-empty array) are required" }, 400);
        }
        const scopeErr = validateScopes(scopes);
        if (scopeErr) return jsonResponse({ error: scopeErr }, 400);

        const { rawKey, keyHash, keyPrefix } = generateRawKey();
        const expiresAt = computeExpiry(expires_in_days);

        const { data, error } = await insforge.database
          .from("rag_api_keys")
          .insert([{ name, key_hash: keyHash, key_prefix: keyPrefix, scopes, client: keyClient || null, expires_at: expiresAt }])
          .select("id, name, key_prefix, scopes, client, expires_at, created_at")
          .single();

        if (error) return jsonResponse({ error: error.message }, 500);
        console.log(`[Admin] API key created: ${keyPrefix} (${name})`);
        return jsonResponse({ ...(data as any), key: rawKey });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Admin: Revoke API key
    const revokeKeyMatch = url.pathname.match(/^\/api\/admin\/keys\/([^/]+)\/revoke$/);
    if (revokeKeyMatch && req.method === "POST") {
      try {
        const id = revokeKeyMatch[1];
        // Get key_hash for targeted cache eviction
        const { data: keyRow } = await insforge.database
          .from("rag_api_keys")
          .select("key_hash")
          .eq("id", id)
          .single();
        const { error } = await insforge.database
          .from("rag_api_keys")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", id);
        if (error) return jsonResponse({ error: error.message }, 500);
        if (keyRow) clearKeyCache((keyRow as any).key_hash);
        console.log(`[Admin] API key revoked: ${id}`);
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    const unauthorizedResponse = () =>
      new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="RAG Service"' },
      });

    // Serve UI pages (Basic Auth protected)
    const uiRoutes: Record<string, string> = {
      "/": "ui/index.html",
      "/index.html": "ui/index.html",
      "/dashboard": "ui/dashboard.html",
    };
    // Redirect old standalone pages to tabbed UI
    if (url.pathname === "/report" || url.pathname === "/learn") {
      const tab = url.pathname.slice(1);
      const qs = url.search ? "&" + url.searchParams.toString() : "";
      return Response.redirect(new URL("/?tab=" + tab + qs, url.origin), 302);
    }
    if (url.pathname in uiRoutes) {
      if (!checkBasicAuth(req)) return unauthorizedResponse();
      return new Response(Bun.file(uiRoutes[url.pathname]), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Auto-provision API key for dashboard (Basic Auth protected)
    if (url.pathname === "/api/auth/token" && req.method === "GET") {
      if (!checkBasicAuth(req)) return unauthorizedResponse();
      if (RAG_API_KEY) {
        return jsonResponse({ token: RAG_API_KEY });
      }
      return jsonResponse({ error: "No API key configured" }, 500);
    }

    // Chunk detail page (/chunk/:id)
    const chunkMatch = url.pathname.match(/^\/chunk\/([^/]+)$/);
    if (chunkMatch && req.method === "GET") {
      if (!checkBasicAuth(req)) return unauthorizedResponse();
      const id = decodeURIComponent(chunkMatch[1]);
      const { data, error } = await insforge.database
        .from("poc_kb_chunks")
        .select("id, title, question, answer, tags, source, created_at, url, verified")
        .eq("id", id)
        .single();

      if (error || !data) {
        return new Response(chunkPageHtml({ notFound: true, id }), {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(chunkPageHtml(data as any), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Serve shared nav script (no auth required — already behind Basic Auth page)
    if (url.pathname === "/nav.js") {
      return new Response(Bun.file("ui/nav.js"), {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
});

console.log(`Server running at http://localhost:${PORT}`);
