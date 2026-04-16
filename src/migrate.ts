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
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      text_content TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      embedding vector(1536),
      source TEXT NOT NULL,
      parent_id TEXT,
      created_at TIMESTAMPTZ,
      fts tsvector,
      verified BOOLEAN DEFAULT false,
      url TEXT,
      status TEXT DEFAULT 'unverified'
    )
  `, "CREATE TABLE kb_chunks");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops)`,
    "INDEX kb_chunks(embedding hnsw)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_kb_chunks_fts ON kb_chunks USING gin (fts)`,
    "INDEX kb_chunks(fts)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_kb_chunks_status ON kb_chunks(status)`,
    "INDEX kb_chunks(status)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(source)`,
    "INDEX kb_chunks(source)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_kb_chunks_tags_gin ON kb_chunks USING gin(tags)`,
    "GIN INDEX kb_chunks(tags)"
  );

  // 0b. Auto-migrate from legacy poc_kb_chunks (pre-v3 installs)
  // Copies all rows, drops the `visibility` column (retired), preserves embeddings.
  console.error("\n=== 0b. Legacy poc_kb_chunks Migration ===");
  await runSQL(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'poc_kb_chunks') THEN
        INSERT INTO kb_chunks (id, title, question, answer, text_content, tags, embedding, source, parent_id, created_at, fts, verified, url, status)
        SELECT id, title, question, answer, text_content, tags, embedding,
               COALESCE(NULLIF(source, ''), 'docs'),
               parent_id, created_at, fts, verified, url,
               COALESCE(status, 'unverified')
        FROM poc_kb_chunks
        ON CONFLICT (id) DO NOTHING;
        DROP TABLE poc_kb_chunks;
        RAISE NOTICE 'Migrated poc_kb_chunks → kb_chunks and dropped legacy table';
      END IF;
    END $$
  `, "MIGRATE poc_kb_chunks → kb_chunks");

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

  // 2. kb_hybrid_search — hybrid search on kb_chunks with source-based ACL
  console.error("\n=== 2. kb_hybrid_search Function ===");
  await runSQL(`
    CREATE OR REPLACE FUNCTION kb_hybrid_search(
      query_embedding vector(1536),
      query_text text,
      match_count int,
      keyword_weight float DEFAULT 0.25,
      semantic_weight float DEFAULT 0.75,
      decay_halflife float DEFAULT 180,
      p_sources text[] DEFAULT NULL
    )
    RETURNS TABLE(id text, title text, question text, answer text, tags text[], similarity float, url text)
    LANGUAGE sql STABLE
    AS $fn$
      WITH semantic AS (
        SELECT
          c.id,
          ROW_NUMBER() OVER (ORDER BY c.embedding <=> query_embedding) AS rank
        FROM kb_chunks c
        WHERE (p_sources IS NULL OR c.source = ANY(p_sources))
          AND (c.status IS NULL OR c.status != 'rejected')
        ORDER BY c.embedding <=> query_embedding
        LIMIT match_count * 2
      ),
      keyword AS (
        SELECT
          c.id,
          ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) DESC) AS rank
        FROM kb_chunks c
        WHERE c.fts @@ websearch_to_tsquery('english', query_text)
          AND (p_sources IS NULL OR c.source = ANY(p_sources))
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
      JOIN kb_chunks c ON c.id = cb.id
      ORDER BY similarity DESC
      LIMIT match_count;
    $fn$
  `, "CREATE FUNCTION kb_hybrid_search");

  // 3. kb_match_chunks — semantic search on kb_chunks with source-based ACL
  console.error("\n=== 3. kb_match_chunks Function ===");
  await runSQL(`
    CREATE OR REPLACE FUNCTION kb_match_chunks(
      query_embedding vector(1536),
      match_threshold float,
      match_count int,
      p_sources text[] DEFAULT NULL
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
      FROM kb_chunks c
      WHERE (1 - (c.embedding <=> query_embedding)) > match_threshold
        AND (p_sources IS NULL OR c.source = ANY(p_sources))
        AND (c.status IS NULL OR c.status != 'rejected')
      ORDER BY c.embedding <=> query_embedding
      LIMIT match_count;
    $fn$
  `, "CREATE FUNCTION kb_match_chunks");

  // 7. API Keys table (v2 schema — same columns as legacy rag_api_keys,
  // but named v2 to stay aligned with zeabur-rag for future diffs)
  console.error("\n=== 7. API Keys Table ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_api_keys_v2 (
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
  `, "CREATE TABLE rag_api_keys_v2");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON rag_api_keys_v2(key_hash)`,
    "INDEX api_keys(key_hash)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON rag_api_keys_v2(key_prefix)`,
    "INDEX api_keys(key_prefix)"
  );

  // 7b. Auto-migrate legacy rag_api_keys → rag_api_keys_v2
  // Copies rows, maps old scope names to new short form, then drops legacy table.
  console.error("\n=== 7b. Legacy rag_api_keys Migration ===");
  await runSQL(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rag_api_keys') THEN
        INSERT INTO rag_api_keys_v2 (id, name, key_hash, key_prefix, scopes, client, expires_at, revoked_at, last_used_at, created_at)
        SELECT id, name, key_hash, key_prefix,
               ARRAY(
                 SELECT CASE x
                   WHEN 'read:public'    THEN 'query'
                   WHEN 'read:internal'  THEN 'query'
                   WHEN 'write:learn'    THEN 'learn'
                   WHEN 'write:report'   THEN 'report'
                   WHEN 'write:feedback' THEN 'feedback'
                   ELSE x
                 END
                 FROM unnest(scopes) AS x
               ),
               client, expires_at, revoked_at, last_used_at, created_at
        FROM rag_api_keys
        ON CONFLICT (id) DO NOTHING;
        DROP TABLE rag_api_keys;
        RAISE NOTICE 'Migrated rag_api_keys → rag_api_keys_v2 and dropped legacy table';
      END IF;
    END $$
  `, "MIGRATE rag_api_keys → rag_api_keys_v2");

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

  // 11. Sources catalogue — lists which content domains exist.
  // API key permissions reference rows here. Seed with a minimal set so a
  // fresh install has working source-based ACL out of the box; operators
  // can add more via UI or direct SQL.
  console.error("\n=== 11. Sources Catalogue ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_sources (
      name         TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description  TEXT,
      created_at   TIMESTAMPTZ DEFAULT now()
    )
  `, "CREATE TABLE rag_sources");
  await runSQL(`
    INSERT INTO rag_sources (name, display_name, description) VALUES
      ('docs',    'Docs',    'General documentation'),
      ('learned', 'Learned', 'Agent-contributed knowledge via /api/learn')
    ON CONFLICT (name) DO NOTHING
  `, "SEED rag_sources");

  // 11b. Auto-seed rag_sources from existing chunk data (covers upgrades where
  // users had custom sources beyond docs/learned).
  console.error("\n=== 11b. Auto-seed Sources from Chunks ===");
  await runSQL(`
    INSERT INTO rag_sources (name, display_name)
    SELECT DISTINCT source, initcap(replace(source, '-', ' '))
    FROM kb_chunks
    WHERE source IS NOT NULL
      AND source != ''
      AND source NOT IN (SELECT name FROM rag_sources)
    ON CONFLICT (name) DO NOTHING
  `, "SEED rag_sources from kb_chunks");

  // 12. API key → source permissions (per-action ACL).
  // admin-scoped keys bypass this table; non-admin keys must have explicit
  // (source, action) rows to access a source.
  console.error("\n=== 12. API Key Source Permissions ===");
  await runSQL(`
    CREATE TABLE IF NOT EXISTS rag_api_key_source_permissions (
      key_id     UUID NOT NULL REFERENCES rag_api_keys_v2(id) ON DELETE CASCADE,
      source     TEXT NOT NULL REFERENCES rag_sources(name) ON DELETE CASCADE,
      action     TEXT NOT NULL CHECK (action IN ('read', 'write', 'delete')),
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (key_id, source, action)
    )
  `, "CREATE TABLE rag_api_key_source_permissions");
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_key_source_perms_key_id ON rag_api_key_source_permissions(key_id)`,
    "INDEX key_source_perms(key_id)"
  );
  await runSQL(
    `CREATE INDEX IF NOT EXISTS idx_key_source_perms_source ON rag_api_key_source_permissions(source)`,
    "INDEX key_source_perms(source)"
  );

  console.error("\n=== Migration Complete ===");
}

if (import.meta.main) {
  runMigrations().catch(console.error);
}
