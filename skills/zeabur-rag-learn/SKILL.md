---
name: zeabur-rag-learn
description: Contribute new verified knowledge to the RAG knowledge base. Use when you've learned something concrete and useful from solving a problem, debugging an issue, or discovering undocumented behavior — and the information isn't already in the knowledge base. Only contribute verified facts, not guesses or workarounds.
---

# RAG Learn

Add new knowledge to the knowledge base. The chunk is immediately searchable but marked as unverified until manually reviewed in the admin dashboard.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY`

## API

```bash
curl -s -X POST "$ZEABUR_RAG_URL/api/learn" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Short descriptive title",
    "content": "The knowledge content in Markdown",
    "tags": ["relevant", "tags"],
    "source_query": "original user query"
  }'
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Short descriptive title |
| `content` | Yes | Knowledge content (Markdown supported) |
| `tags` | No | Array of tag strings for categorization |
| `source_query` | No | Original user query that prompted this knowledge |

Returns `{ "id": "LEARNED-...", "status": "indexed", "verified": false }`.

## Guidelines

Only contribute knowledge that is:
- **Verified correct** — not a guess or workaround
- **General enough** — useful to future users, not just this one case
- **Not already covered** — search first to avoid duplicates
