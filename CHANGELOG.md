# Changelog

## 2.0.0 — Pluggable Adapter Architecture

### Pipeline system
- New pluggable `SourceAdapter` interface — implement one function to add a data source
- Pipeline runner (`src/pipeline/runner.ts`) replaces hardcoded export scripts
- Built-in adapters: JSON file import, Markdown directory import
- External adapter loading via `RAG_ADAPTERS_PATH` environment variable
- Quality filter for low-quality chunks (short answers, greetings, placeholder text)
- Incremental sync with content hash diffing (only re-embeds changed chunks)
- `--replace` mode for full rebuild with rejection preservation
- CLI: `--adapter`, `--input`, `--replace`, `--list`, `--help`

## 1.5.0 — Knowledge Curation Loop

### Triage endpoint
- `GET /api/admin/triage` aggregated endpoint for pending maintenance items
- `PATCH /api/admin/chunks/:id` for editing chunk content with auto re-embed

### New skills
- `zeabur-rag-triage`, `zeabur-rag-inspect`, `zeabur-rag-curate`, `zeabur-rag-edit`

### Bug fixes
- Paginated stats queries to avoid PostgREST 1000-row limit
- CORS methods updated to include PATCH and DELETE
