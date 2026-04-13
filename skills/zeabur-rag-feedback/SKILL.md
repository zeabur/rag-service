---
name: zeabur-rag-feedback
description: Send feedback on RAG search results — thumbs-up (+1) or thumbs-down (-1) to indicate whether the answer was helpful. Use after calling zeabur-rag-search when you can evaluate the quality of the results. Positive feedback reinforces good results; negative feedback flags poor matches for review. Requires write:feedback scope.
---

# RAG Feedback

Send feedback on search results to improve knowledge base quality over time.

Base URL: `$ZEABUR_RAG_URL`
Auth: `Authorization: Bearer $RAG_API_KEY`

## API

```bash
curl -s -X POST "$ZEABUR_RAG_URL/api/feedback" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "how to deploy to zeabur",
    "answer": "the generated answer text",
    "chunks": ["DOC-1234", "SUP-5678"],
    "score": 1,
    "signal_id": "optional-signal-id",
    "comment": "optional explanation"
  }'
```

| Field | Required | Description |
|-------|----------|-------------|
| `query` | Yes | The original search query |
| `answer` | No | The generated RAG answer |
| `chunks` | No | Array of chunk IDs that were returned |
| `score` | Yes | `1` (helpful) or `-1` (not helpful) |
| `signal_id` | No | Signal ID from the search response — links feedback to the specific query signal |
| `comment` | No | Free-text explanation of why the result was good or bad |

## When to send feedback

| Situation | Score |
|-----------|-------|
| Answer correctly addressed the question | `1` |
| Retrieved chunks were relevant and accurate | `1` |
| Answer was wrong, incomplete, or misleading | `-1` |
| Retrieved chunks were irrelevant to the query | `-1` |
| No useful results were returned | `-1` |

## Notes

- If `signal_id` is provided, the feedback score is written back to the `rag_query_signals` table, linking it to the original query for analytics.
- Negative feedback surfaces in the Triage review queue for admin follow-up.
- Feedback is also appended to `data/user-feedback.jsonl` as a backup log.
