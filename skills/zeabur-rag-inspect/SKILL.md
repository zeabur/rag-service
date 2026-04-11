---
name: zeabur-rag-inspect
description: View a single chunk's full content plus related reports, search signals, and edit history. Use when you need to understand a chunk's context before editing, when investigating why a search result appeared, or when reviewing a reported issue. Triggers on "看一下 SUP-1234", "inspect chunk", "chunk 的歷史", "為什麼這個結果出現".
---

# Zeabur RAG — Inspect

Get the full picture of a single knowledge base chunk: its content, related reports, search signals that surfaced it, and audit history.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY` — **admin scope required**

## API

```bash
curl -s "$ZEABUR_RAG_URL/api/admin/chunks/<chunk_id>" \
  -H "Authorization: Bearer $RAG_API_KEY"
```

**Input:** Chunk ID (e.g. `SUP-1234`, `DOC-deploy-variables-0`, `LEARNED-1712345678-abc123`).

## Response

```json
{
  "chunk": {
    "id": "SUP-1234",
    "title": "...",
    "question": "...",
    "answer": "...",
    "text_content": "...",
    "tags": ["..."],
    "source": "forum",
    "verified": true,
    "status": "verified",
    "visibility": "public",
    "parent_id": null,
    "created_at": "...",
    "url": "..."
  },
  "reports": [
    { "id": "...", "type": "outdated", "query": "...", "detail": "...", "status": "open", "created_at": "..." }
  ],
  "signals": [
    { "id": "...", "query": "...", "mode": "hybrid", "top_similarity": 0.45, "feedback_score": null, "created_at": "..." }
  ],
  "audit_log": [
    { "id": "...", "chunk_id": "SUP-1234", "action": "edit", "old_value": {}, "new_value": {}, "created_at": "..." }
  ]
}
```

## Key fields

- **`text_content`** — the text used for embedding and BM25 index. You MUST read this before editing a chunk, because `zeabur-rag-edit` requires you to provide updated `text_content` whenever you change `title`/`question`/`answer`.
- **`reports`** — any open or closed reports pointing to this chunk. If there's an open report, it may need action.
- **`signals`** — recent queries that surfaced this chunk in search results. Shows how the chunk is being found and whether users found it helpful (via `feedback_score`).
- **`audit_log`** — edit history. Check this to see who changed what and when.

## Common workflows

1. **Before editing:** inspect → read `text_content` → construct updated `text_content` in the same format → call `zeabur-rag-edit`.
2. **Investigating a report:** inspect the reported chunk → check if the report is valid → decide to edit, reject, or close the report.
3. **Understanding search behavior:** inspect a chunk that keeps appearing in irrelevant queries → check `signals` to see which queries surface it → consider editing `text_content` to improve relevance.

## Error

Returns `404` with `{"error": "Chunk not found"}` if the ID doesn't exist.
