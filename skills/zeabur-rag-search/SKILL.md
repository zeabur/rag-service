---
name: zeabur-rag-search
description: Search the RAG knowledge base via hybrid search (semantic + BM25). Use whenever answering technical questions that may be covered in your knowledge base — even if the user doesn't explicitly ask you to search. Also use when you need to verify claims or find up-to-date information.
---

# RAG Search

Search your knowledge base using hybrid retrieval (semantic + BM25 keyword).

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY`

## API

```bash
curl -s -X POST "$ZEABUR_RAG_URL/api/query" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "your question", "mode": "hybrid", "rag": false, "top_k": 5, "client": "claude-code"}'
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `query` | required | Search query (supports multilingual) |
| `mode` | `"hybrid"` | `"hybrid"` (BM25 + semantic) or `"semantic"` |
| `top_k` | `5` | Number of chunks to return |
| `rag` | `false` | If `true`, also returns LLM-generated `answer` string |
| `keyword_weight` | `0.25` | BM25 weight in hybrid mode |
| `semantic_weight` | `0.75` | Semantic weight in hybrid mode |
| `decay` | `180` | Temporal decay half-life in days (0 = off) |
| `stream` | `false` | Stream the RAG answer (NDJSON) |
| `visibility` | `"public"` | `"public"`, `"internal"`, or `"all"` — filters chunks by visibility |
| `client` | `"api"` | Caller identifier for analytics (e.g. `"claude-code"`, `"web-ui"`, `"mcp"`) |

**Always pass `client: "claude-code"` when calling from Claude Code** so queries are trackable in the dashboard.

Response includes `chunks[]` (each with `id`, `title`, `answer`, `tags`, `similarity` (relevance score), `source`, `verified`) and `signal_id` for linking feedback. Note: `similarity` is an RRF score in hybrid mode (~0–0.02) or cosine similarity in semantic mode (0–1). The scale depends on the search mode — do not compare values across modes.

## Tips

- Use `rag: false` when you only need raw chunks to read yourself — it's faster and cheaper.
- Set `rag: true` only when you want the service to generate a summarized answer.
- The `signal_id` in the response can be passed to the feedback API to rate result quality.
