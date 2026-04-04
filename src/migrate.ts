// Schema migration: all tables needed by the RAG server
// Usage: bun run src/migrate.ts (standalone) or imported by server.ts

const INSFORGE_URL = process.env.INSFORGE_URL!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

async function runSQL(sql: string, label?: string): Promise<boolean> {
  const tag = label || sql.slice(0, 60);
  try {
    const res = await fetch(`${INSFORGE_URL}/api/database/advance/rawsql`, {
      method: "POST",
      headers: {
        "x-api-key": INSFORGE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql, params: [] }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`  FAIL: ${tag} — ${body}`);
      return false;
    }
    console.error(`  OK: ${tag}`);
    return true;
  } catch (err) {
    console.error(`  FAIL: ${tag} — ${err}`);
    return false;
  }
}

export async function runMigrations() {
  console.error("Running schema migrations...\n");

  // 0. pgvector extension + main chunks table
  console.error("=== 0. Core Table ===");
  await runSQL(
    `CREATE EXTENSION IF NOT EXISTS vector`,
    "CREATE EXTENSION vector"
  );
  await runSQL(`
    CREATE TABLE IF NOT EXISTS poc_kb_chunks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      text_content TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      embedding vector(1536),
      source TEXT DEFAULT 'forum',
      parent_id TEXT,
      created_at TIMESTAMPTZ,
      fts tsvector,
      verified BOOLEAN DEFAULT true,
      url TEXT,
      visibility TEXT DEFAULT 'public',
      status TEXT DEFAULT 'unverified'
    )
  `, "CREATE TABLE poc_kb_chunks");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON poc_kb_chunks USING hnsw (embedding vector_cosine_ops)`,
    "INDEX chunks(embedding hnsw)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_chunks_fts ON poc_kb_chunks USING gin (fts)`,
    "INDEX chunks(fts)"
  );

  // 1. Audit log table
  console.error("=== 1. Audit Log Table ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_audit_log (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      chunk_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      old_value JSONB,
      new_value JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `, "CREATE TABLE rag_audit_log");

  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_chunk_id ON rag_audit_log(chunk_id)`,
    "INDEX audit_log(chunk_id)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON rag_audit_log(created_at DESC)`,
    "INDEX audit_log(created_at)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON rag_audit_log(action)`,
    "INDEX audit_log(action)"
  );

  // 2. Visibility column
  console.error("\n=== 2. Visibility Column ===");
  await runSQL(
    `ALTER TABLE poc_kb_chunks ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public'`,
    "ADD COLUMN visibility"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_chunks_visibility ON poc_kb_chunks(visibility)`,
    "INDEX chunks(visibility)"
  );

  // 3. Status column
  console.error("\n=== 3. Status Column ===");
  await runSQL(
    `ALTER TABLE poc_kb_chunks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unverified'`,
    "ADD COLUMN status"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_chunks_status ON poc_kb_chunks(status)`,
    "INDEX chunks(status)"
  );

  // 4. Backfill status from verified boolean
  console.error("\n=== 4. Backfill Status ===");
  await runSQL(
    `UPDATE poc_kb_chunks SET status = CASE WHEN verified = true THEN 'verified' ELSE 'unverified' END WHERE status IS NULL OR status = 'unverified' AND verified = true`,
    "Backfill status from verified"
  );

  // 5. Update hybrid_search to support visibility filtering
  console.error("\n=== 5. Update hybrid_search Function ===");
  await runSQL(`
    CREATE OR REPLACE FUNCTION hybrid_search(
      query_embedding vector(1536),
      query_text text,
      match_count int,
      keyword_weight float DEFAULT 0.25,
      semantic_weight float DEFAULT 0.75,
      decay_halflife float DEFAULT 180,
      p_visibility text DEFAULT 'public'
    )
    RETURNS TABLE(id text, title text, question text, answer text, tags text[], similarity float, url text)
    LANGUAGE sql STABLE
    AS $fn$
      WITH semantic AS (
        SELECT
          c.id,
          ROW_NUMBER() OVER (ORDER BY c.embedding <=> query_embedding) AS rank
        FROM poc_kb_chunks c
        WHERE (p_visibility = 'all' OR c.visibility = p_visibility)
          AND (c.status IS NULL OR c.status != 'rejected')
        ORDER BY c.embedding <=> query_embedding
        LIMIT match_count * 2
      ),
      keyword AS (
        SELECT
          c.id,
          ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) DESC) AS rank
        FROM poc_kb_chunks c
        WHERE c.fts @@ websearch_to_tsquery('english', query_text)
          AND (p_visibility = 'all' OR c.visibility = p_visibility)
          AND (c.status IS NULL OR c.status != 'rejected')
        LIMIT match_count * 2
      ),
      combined AS (
        SELECT
          COALESCE(s.id, k.id) AS id,
          COALESCE(semantic_weight / (60.0 + s.rank), 0) +
          COALESCE(keyword_weight / (60.0 + k.rank), 0) AS rrf_score
        FROM semantic s
        FULL OUTER JOIN keyword k ON s.id = k.id
      )
      SELECT
        c.id,
        c.title,
        c.question,
        c.answer,
        c.tags,
        (cb.rrf_score *
          CASE WHEN decay_halflife > 0 AND c.created_at IS NOT NULL
            THEN EXP(-0.693147 / decay_halflife * EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 86400.0)
            ELSE 1.0
          END
        )::float AS similarity,
        c.url
      FROM combined cb
      JOIN poc_kb_chunks c ON c.id = cb.id
      ORDER BY similarity DESC
      LIMIT match_count;
    $fn$
  `, "UPDATE FUNCTION hybrid_search (with visibility + rejected filter)");

  // 6. Update match_chunks to support visibility filtering
  console.error("\n=== 6. Update match_chunks Function ===");
  await runSQL(`
    CREATE OR REPLACE FUNCTION match_chunks(
      query_embedding vector(1536),
      match_threshold float,
      match_count int,
      p_visibility text DEFAULT 'public'
    )
    RETURNS TABLE(id text, title text, question text, answer text, tags text[], similarity float, created_at timestamptz, source text, verified boolean, url text)
    LANGUAGE sql STABLE
    AS $fn$
      SELECT
        c.id,
        c.title,
        c.question,
        c.answer,
        c.tags,
        (1 - (c.embedding <=> query_embedding))::float AS similarity,
        c.created_at,
        c.source,
        c.verified,
        c.url
      FROM poc_kb_chunks c
      WHERE (1 - (c.embedding <=> query_embedding)) > match_threshold
        AND (p_visibility = 'all' OR c.visibility = p_visibility)
        AND (c.status IS NULL OR c.status != 'rejected')
      ORDER BY c.embedding <=> query_embedding
      LIMIT match_count;
    $fn$
  `, "UPDATE FUNCTION match_chunks (with visibility + rejected filter)");

  // 7. API Keys table
  console.error("\n=== 7. API Keys Table ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_api_keys (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      client TEXT,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `, "CREATE TABLE rag_api_keys");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON rag_api_keys(key_hash)`,
    "INDEX api_keys(key_hash)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON rag_api_keys(key_prefix)`,
    "INDEX api_keys(key_prefix)"
  );

  // 8. Query signals table
  console.error("\n=== 8. Query Signals Table ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_query_signals (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      query TEXT NOT NULL,
      mode TEXT,
      top_k INT,
      top_similarity FLOAT,
      top_chunk_ids TEXT[],
      answer_model TEXT,
      client TEXT,
      key_prefix TEXT,
      feedback_score INT,
      feedback_comment TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `, "CREATE TABLE rag_query_signals");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_signals_created_at ON rag_query_signals(created_at DESC)`,
    "INDEX signals(created_at)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_signals_client ON rag_query_signals(client)`,
    "INDEX signals(client)"
  );

  // 9. Reports table
  console.error("\n=== 9. Reports Table ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_reports (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      chunk_id TEXT,
      type TEXT NOT NULL,
      query TEXT,
      detail TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `, "CREATE TABLE rag_reports");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_reports_status ON rag_reports(status)`,
    "INDEX reports(status)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_reports_created_at ON rag_reports(created_at DESC)`,
    "INDEX reports(created_at)"
  );

  // 10. Key prefix on signals (for existing deployments without it)
  console.error("\n=== 10. Key Prefix on Signals ===");
  await runSQL(
    `ALTER TABLE rag_query_signals ADD COLUMN IF NOT EXISTS key_prefix TEXT`,
    "ADD COLUMN key_prefix on signals"
  );

  console.error("\n=== Migration Complete ===");
}

if (import.meta.main) {
  runMigrations().catch(console.error);
}
