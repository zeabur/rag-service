---
name: zeabur-rag-curate
description: Interactive knowledge base curation loop — reviews pending items (reports, unverified chunks, failed queries, negative feedback) and walks through fixes one by one. Use when asked to "maintain the knowledge base", "review pending items", "run a curation round", "process reports", "clean up the KB", or any request to improve KB quality. This is the main entry point for the expand → organize → reflect cycle, and requires admin scope.
---

# RAG — Curate

Interactive curation loop for the knowledge base. This skill orchestrates other skills (`triage`, `inspect`, `edit`, `learn`, `search`) plus a few inline admin API calls to walk the user through fixing pending issues one by one.

**This is NOT an API wrapper.** It's a workflow guide. Follow the steps below as a conversation with the user.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY` — **admin scope required**

## Loop

1. **Call `zeabur-rag-triage`** to get the pending items list.
2. **Present results** as a numbered list grouped by category (🔴 Reports, 🟡 Unverified, 🟠 Low-similarity, 🔵 Negative feedback). Show counts.
3. **If all categories are empty:** tell the user "The knowledge base has no pending items — looks healthy ✅" and stop.
4. **Wait for user** to pick an item by number or description.
5. **Run the decision tree** for that item type (see below).
6. **After each action**, echo the result and ask "Next?" to return to the list.
7. **User says stop** → end the loop.

## Decision trees

### 🔴 Open report

1. If `chunk_id` is null (type=missing) → skip to step 3.
2. Call `zeabur-rag-inspect` on the referenced chunk. Show the chunk content + report detail side by side.
3. Classify:

| Classification | Action |
|---------------|--------|
| Fixable — content is wrong or outdated | Draft fix with user → `zeabur-rag-edit` → close report |
| Wholly wrong — chunk should not exist | Reject chunk (see Inline commands) → close report |
| Duplicate of another chunk | Reject this one → point user to the correct chunk → close report |
| Type=missing — knowledge gap | Draft new content with user → `zeabur-rag-learn` → close report |
| Report is invalid — chunk is fine | Close report directly (no chunk changes needed) |

4. Every action requires explicit user confirmation before execution.

### 🟡 Unverified learned chunk

1. Call `zeabur-rag-inspect` on the chunk. Show full content, tags, `text_content`.
2. Classify:

| Classification | Action |
|---------------|--------|
| Correct and well-formed | Verify (see Inline commands) |
| Correct but needs polish | `zeabur-rag-edit` to fix → then verify |
| Low quality or wrong | Reject (see Inline commands) |

### 🟠 Low-similarity signal

1. Call `zeabur-rag-search` with the original query to confirm the gap.
2. Classify:

| Classification | Action |
|---------------|--------|
| True gap — no relevant chunk exists | Draft new content with user → `zeabur-rag-learn` |
| Chunk exists but ranks poorly | `zeabur-rag-inspect` the chunk → `zeabur-rag-edit` to improve `text_content` |
| Irrelevant or spam query | Dismiss — no action, move to next item |

### 🔵 Negative feedback signal

1. Call `zeabur-rag-inspect` on each chunk in `top_chunk_ids`. If `top_chunk_ids` is null or empty, skip to step 3.
2. Identify which chunk(s) caused the bad result.
3. Classify:

| Classification | Action |
|---------------|--------|
| Chunk content is wrong | `zeabur-rag-edit` to fix |
| Chunk should not have been returned | Reject chunk (see Inline commands) |
| Answer was right but user query was ambiguous | Dismiss — no action |
| No chunks to inspect (null top_chunk_ids) | Treat as knowledge gap → `zeabur-rag-learn` |

## Inline commands

These actions don't have dedicated skills. Execute them as direct API calls:

### Verify a learned chunk

```bash
curl -s -X POST "$ZEABUR_RAG_URL/api/admin/learned/<id>/verify" \
  -H "Authorization: Bearer $RAG_API_KEY"
```

Returns `{"success": true}`. The chunk now ranks at full weight in search (unverified `learned` chunks are downranked to ×0.7 similarity).

### Reject a learned chunk (soft delete)

```bash
curl -s -X DELETE "$ZEABUR_RAG_URL/api/admin/learned/<id>" \
  -H "Authorization: Bearer $RAG_API_KEY"
```

Returns `{"success": true}`. Sets `status='rejected'`, excluded from all search.

### Reject any non-learned chunk (soft delete via PATCH)

```bash
curl -s -X PATCH "$ZEABUR_RAG_URL/api/admin/chunks/<id>" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"rejected"}'
```

Returns `{"success": true, ...}`. For docs/forum chunks, this rejection survives pipeline rebuilds.

### Close a report

```bash
curl -s -X POST "$ZEABUR_RAG_URL/api/admin/reports/<id>/close" \
  -H "Authorization: Bearer $RAG_API_KEY"
```

Returns `{"success": true}`. Closing an already-closed report is treated as success.

## Rules

- **Never auto-execute mutations.** Every edit, verify, reject, learn, or close requires the user to explicitly confirm (e.g. "ok", "verify", "reject", "close").
- **Always inspect before edit.** You need the existing `text_content` to construct a new one. The edit endpoint returns 400 if you change `title`/`question`/`answer` without providing `text_content`.
- **Echo results after every action.** Show the audit_id, new status, or error message so the user knows what happened.
- **Don't retry failed mutations.** Surface the error and let the user decide.
- **One item at a time.** Process triage items sequentially. Don't batch.
