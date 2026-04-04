---
name: zeabur-rag-report
description: Report knowledge issues (outdated, incorrect, or missing content) in the RAG knowledge base. Use when search results seem outdated or wrong, when a topic should be covered but isn't found, or when a chunk contains incorrect information. This helps maintain knowledge base quality.
---

# RAG Report

Report issues with knowledge base content so they can be reviewed and fixed.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY`

## API

```bash
curl -s -X POST "$ZEABUR_RAG_URL/api/report" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "outdated",
    "chunk_id": "DOC-1234",
    "query": "the query you searched",
    "detail": "what is wrong or missing"
  }'
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | `"outdated"` / `"incorrect"` / `"missing"` |
| `chunk_id` | No | ID of the problematic chunk |
| `query` | No | The query that surfaced the issue |
| `detail` | No | Description of what is wrong or missing |

## When to report

| Situation | Type |
|-----------|------|
| Info was once correct but is now stale | `outdated` |
| Chunk contains factually wrong info | `incorrect` |
| Topic should exist but no chunks found | `missing` |
