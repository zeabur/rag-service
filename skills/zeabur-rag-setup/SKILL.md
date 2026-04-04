---
name: zeabur-rag-setup
description: Use when setting up or configuring the RAG plugin for the first time. Use when ZEABUR_RAG_URL or RAG_API_KEY are missing or need to be updated. Use when the RAG skill fails with authentication or connection errors.
---

# RAG Setup

Configure the required environment variables for the RAG skills.

## Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ZEABUR_RAG_URL` | RAG service base URL | `https://your-rag-service.zeabur.app` |
| `RAG_API_KEY` | API key for authenticated writes (report/learn) | `rak_xxxxxxxxxxxxxxxx` |

> `RAG_API_KEY` is optional for search-only use. Required for `/api/report` and `/api/learn`.

## Setup Steps

1. **Ask the user** for `ZEABUR_RAG_URL` and `RAG_API_KEY` (or confirm existing values).

2. **Read** `~/.claude/settings.json`.

3. **Merge** the `env` section — preserve all existing keys:

```json
{
  "env": {
    "ZEABUR_RAG_URL": "<value>",
    "RAG_API_KEY": "<value>"
  }
}
```

4. **Write** the updated file back.

5. **Tell the user** to run `/reload-plugins` or restart Claude Code for the changes to take effect.

## Notes

- Store in `~/.claude/settings.json` (user scope) so they apply across all projects.
- Never commit these values to git.
- If the user only wants read access, `RAG_API_KEY` can be left empty or omitted.
