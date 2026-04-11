---
name: zeabur-rag-edit
description: Edit the content of an existing chunk in the RAG knowledge base. Use when a chunk has a typo, outdated info, wrong tags, wrong visibility, or needs its title/question/answer rewritten — and you want the fix to take effect immediately. Requires admin scope. Prefer zeabur-rag-report for surfacing issues without write access.
---

# RAG — Edit

Update the content of an existing chunk in place. Embedding is recomputed automatically when the searchable text changes, and the BM25 cache is cleared so the change is live on the next query.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY` — **admin scope required**

## When to use

| Situation | Use this skill |
|-----------|---------------|
| Fixing a typo or stale fact in an existing chunk | ✅ |
| Adjusting `tags` or toggling `visibility` (`public` ↔ `internal`) | ✅ |
| Rewriting the answer because the procedure changed | ✅ |
| You don't have admin scope | ❌ Use `zeabur-rag-report` instead |
| The knowledge doesn't exist yet | ❌ Use `zeabur-rag-learn` instead |

## API

`PATCH /api/admin/chunks/:id` — pass any subset of editable fields.

```bash
curl -s -X PATCH "$ZEABUR_RAG_URL/api/admin/chunks/<chunk_id>" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated title",
    "answer": "Corrected content",
    "text_content": "Updated title\nCorrected content"
  }'
```

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Display title |
| `question` | string | Question form (mainly for forum chunks) |
| `answer` | string | Main body |
| `tags` | string[] | Replaces the existing tag array |
| `url` | string | Source URL |
| `text_content` | string | The text that gets embedded and BM25-indexed |
| `visibility` | `"public"` \| `"internal"` | Hard-filters search results |
| `status` | `"unverified"` \| `"verified"` \| `"rejected"` | Lifecycle state |

### Critical rule — keep the embedding in sync

If you update **any** of `title` / `question` / `answer`, you **MUST** also pass a new `text_content`. The server enforces this and returns `400` otherwise. The reason: embedding and BM25 index are built from `text_content`, not from the display fields — letting them drift apart silently corrupts search quality.

How to construct `text_content`:

| Source | Convention |
|--------|-----------|
| `learned` | `${title}\n${answer}` |
| `forum` (`SUP-*`) | `Question: ${question}\n\nAnswer: ${answer}` |
| `docs` (`DOC-*`) | Use the exact body text that was originally indexed; if unsure, fetch the chunk first via `GET /api/admin/chunks/:id` and adapt |

When in doubt, **read the existing `text_content` first**, then rewrite it in the same shape.

### Edits that don't need `text_content`

Pure metadata changes — `tags`, `url`, `visibility`, `status` — don't touch the embedding, so `text_content` is not required:

```bash
curl -s -X PATCH "$ZEABUR_RAG_URL/api/admin/chunks/SUP-1234" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["billing", "stripe"], "visibility": "internal"}'
```

## Workflow

1. **Find the chunk** — search via `zeabur-rag-search` or `GET /api/admin/chunks?search=...` to get its ID and current contents.
2. **Read it** — `GET /api/admin/chunks/:id` returns the full record including `text_content`. Confirm you're editing what you think you're editing.
3. **PATCH** — send only the fields you want to change. Include `text_content` if any of `title`/`question`/`answer` are in the patch.
4. **Verify** — re-search to confirm the new content surfaces.

## Response

```json
{
  "success": true,
  "id": "SUP-1234",
  "updated_fields": ["title", "answer", "text_content"],
  "embedding_updated": true
}
```

`embedding_updated: true` means the chunk was re-embedded. Every edit is logged to `rag_audit_log` with action `edit` and a diff of old vs new values, and the BM25 cache is cleared so the next query sees the change.

## Errors

| Status | Cause |
|--------|-------|
| `400` | Updated `title`/`question`/`answer` without providing `text_content`, or invalid `visibility`/`status`/`tags` |
| `401` / `403` | Missing/invalid key, or key lacks `admin` scope |
| `404` | Chunk ID does not exist |
| `500` | DB or embedding service error — safe to retry |

## Guidelines

- **One coherent edit at a time.** Don't rewrite three unrelated chunks in one batch — each edit should be auditable.
- **Don't paraphrase for style.** Edit only when the content is wrong, stale, or unclear. Cosmetic rewrites churn the embedding for no quality gain.
- **Verified chunks should stay accurate.** If you're unsure whether your fix is correct, file a `zeabur-rag-report` instead of patching.
- **Visibility changes are powerful.** Flipping `public` → `internal` immediately hides the chunk from public search. Confirm before doing this.
