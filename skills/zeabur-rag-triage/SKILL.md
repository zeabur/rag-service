---
name: zeabur-rag-triage
description: List pending knowledge base maintenance items — open reports, unverified learned chunks, low-similarity queries, and negative feedback. Use when checking KB health, reviewing the maintenance queue, or starting a curation session. Triggers on "review queue", "what needs attention in the KB", "pending reports", "unverified chunks", "failed queries", "KB health check". Requires admin scope.
---

# RAG — Triage

Show what needs attention in the knowledge base. Returns 4 categories of pending items in a single call.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY` — **admin scope required**

## API

```bash
curl -s "$ZEABUR_RAG_URL/api/admin/triage?days=14&similarity_threshold=0.4&limit=20" \
  -H "Authorization: Bearer $RAG_API_KEY"
```

| Param | Default | Description |
|-------|---------|-------------|
| `days` | `14` | Time window for signals (reports and learned have no time window) |
| `similarity_threshold` | `0.4` | Queries with `top_similarity` below this are flagged |
| `limit` | `20` | Max items per category |

## Response

Returns JSON with 4 arrays + `counts` (true totals, not truncated) + `has_more` (boolean per category):

- **`open_reports`** — reports with `status='open'`, no time window. Fields: `id`, `type`, `chunk_id`, `query`, `detail`, `created_at`.
- **`unverified_learned`** — learned chunks with `status='unverified'`, no time window. Fields: `id`, `title`, `tags`, `created_at`, `age_days`.
- **`low_similarity_signals`** — queries where the best result scored below the threshold, within the time window, deduped by query text. Fields: `id`, `query`, `top_similarity`, `top_chunk_ids`, `client`, `created_at`.
- **`negative_feedback_signals`** — queries that got negative user feedback, within the time window. Fields: `id`, `query`, `feedback_score`, `feedback_comment`, `top_chunk_ids`, `created_at`.

If a category query fails, its array is empty and a `<category>_error` field appears with the error message.

## After triage

- To drill into a specific chunk: use `zeabur-rag-inspect` with the chunk ID.
- To start the full curation loop: use `zeabur-rag-curate`.
- **Do not mutate anything directly from triage results.** Always inspect first, then decide on action.

## When all categories are empty

If every count is 0, the knowledge base has no pending maintenance. Report:
"The knowledge base has no pending items — looks healthy ✅"
