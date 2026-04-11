# Pluggable Adapter Architecture — Design

**Date:** 2026-04-11
**Status:** Approved (brainstormed with user)
**Author:** Claude (with Can Yu)

## Problem

The RAG service currently has no pluggable data pipeline. Zeabur maintains 6 hardcoded export scripts (forum, docs, blogs, changelogs, skills, Linear) that each produce chunks in their own way with no shared interface. This makes the codebase un-publishable as a generic open-source project — community users can't add their own data sources without forking.

The goal is to introduce a `SourceAdapter` interface so that:
1. The core RAG engine (search, BM25, embedding, API) remains generic and open-source.
2. Anyone can write a data source adapter (Notion, Confluence, Slack, GitHub Issues) by implementing one function.
3. Zeabur's internal adapters (forum MongoDB, docs repo, etc.) live in a private repo and are loaded at runtime via an environment variable.

## Goals

1. A community user can import their own data into the RAG service by writing a single-file adapter or using built-in adapters (JSON, Markdown).
2. Zeabur can plug in private adapters without any code in the public repo.
3. The pipeline runner replaces the current `pipeline.ts` + `embed-and-upload.ts` with a single unified entry point.
4. The adapter interface is simple enough that a "hello world" adapter is < 20 lines.
5. Existing DB schema, API endpoints, skills, and UI are unchanged.

## Non-goals (YAGNI)

- Refactoring `query.ts` / `bm25.ts` (separate spec)
- Converting Zeabur's 6 export scripts to adapters (follow-up task, mechanical)
- Adapter-level caching or incremental export (adapter decides internally)
- Parallel adapter execution (sequential to avoid rate limits)
- Dry-run mode
- Adapter dependency ordering
- npm package distribution of adapters

## Decisions Made During Brainstorming

| Decision | Choice | Alternatives Considered |
|----------|--------|------------------------|
| Adapter granularity | Coarse: `export(): Chunk[]` | Fine (export + chunk separate), Coarse + optional filter hook |
| Private adapter isolation | `RAG_ADAPTERS_PATH` env var pointing to external directory | `.gitignore` directory, npm packages |
| Built-in adapters | JSON + Markdown | JSON only, JSON + Markdown + Git |
| Repo strategy | rag-service becomes the sole public repo; zeabur-rag becomes private adapters | zeabur-rag becomes public, both repos kept |
| Adapter style | Object literal (not class) | Class with `extends BaseAdapter` |

## Architecture

### Repo structure after implementation

```
rag-service/                        (public repo)
  src/
    server.ts                       (existing, unchanged)
    query.ts                        (existing, unchanged)
    bm25.ts                         (existing, unchanged)
    knowledge.ts                    (existing, unchanged)
    api-keys.ts                     (existing, unchanged)
    migrate.ts                      (existing, unchanged)
    pipeline/
      types.ts                      (NEW — Chunk + SourceAdapter interfaces)
      registry.ts                   (NEW — adapter registration + auto-loading)
      runner.ts                     (NEW — CLI pipeline executor)
      filter.ts                     (NEW — generic quality filter)
      markdown-utils.ts             (NEW — frontmatter, heading split, paragraph split)
    adapters/
      json.ts                       (NEW — built-in JSON file adapter)
      markdown.ts                   (NEW — built-in Markdown directory adapter)
  skills/                           (existing 8 skills, unchanged)
  ui/                               (existing, unchanged)

zeabur-rag/                         (private repo, downgraded)
  adapters/
    forum.ts                        (MongoDB forum — from export-forum-posts.ts)
    docs.ts                         (docs repo — from export-docs.ts)
    blogs.ts                        (blogs — from export-blogs.ts)
    changelogs.ts                   (changelogs — from export-changelogs.ts)
    skills.ts                       (skills repo — from export-skills.ts)
    linear.ts                       (Linear issues — from export-linear-posts.ts)
  eval/                             (eval framework, kept)
  data/                             (eval set, chunk snapshots, kept)
```

### Deployment

```bash
# Server (unchanged)
bun run src/server.ts

# Pipeline with built-in adapters
bun run src/pipeline/runner.ts --adapter json --input data/chunks.json
bun run src/pipeline/runner.ts --adapter markdown --input ./docs/

# Pipeline with private adapters
RAG_ADAPTERS_PATH=../zeabur-rag/adapters bun run src/pipeline/runner.ts
```

## Adapter Interface (`src/pipeline/types.ts`)

```ts
export interface Chunk {
  id: string;
  source: string;
  title: string;
  content: string;
  metadata: {
    question: string;
    answer: string;
    tags: string[];
    parent_id: string | null;
    created_at: string | null;
    url: string | null;
  };
}

export interface SourceAdapter {
  /** Unique name, used as the `source` field in DB rows */
  name: string;

  /** Human-readable description (optional, for CLI listing) */
  description?: string;

  /**
   * Export chunks from this source.
   * @param config - Key-value pairs from environment variables + CLI args.
   *                 Adapter picks the keys it needs (e.g. FORUM_MONGODB_URI).
   * @returns Array of chunks ready for embedding and upload.
   */
  export(config: Record<string, string>): Promise<Chunk[]>;
}
```

The `Chunk` interface matches the existing `ChunkV2` format used by `embed-and-upload.ts`, ensuring backward compatibility with the DB schema.

### Why object literal, not class

```ts
// Community writes this — no imports beyond types
export default {
  name: "notion",
  description: "Import pages from Notion",
  async export(config) {
    // fetch, chunk, return Chunk[]
  },
} satisfies SourceAdapter;
```

No `extends`, no `super()`, no constructor. One object = one adapter. Lowest possible barrier for community contributors.

## Registry (`src/pipeline/registry.ts`)

```ts
const adapters = new Map<string, SourceAdapter>();

/** Register an adapter. Throws if name conflicts. */
export function registerAdapter(adapter: SourceAdapter): void;

/** Get adapter by name. */
export function getAdapter(name: string): SourceAdapter | undefined;

/** List all registered adapters. */
export function listAdapters(): SourceAdapter[];

/**
 * Load adapters from:
 * 1. src/adapters/*.ts (built-in)
 * 2. RAG_ADAPTERS_PATH directory (if env var is set)
 */
export async function loadAdapters(): Promise<void>;
```

### Dynamic loading from `RAG_ADAPTERS_PATH`

```ts
async function loadAdaptersFrom(dir: string): Promise<void> {
  // Glob *.ts files in dir
  // For each file: dynamic import, check mod.default has name + export
  // registerAdapter(mod.default)
  // Log: "[Pipeline] Loaded adapter: <name> from <file>"
  // On error: log warning, skip file, don't crash
}
```

Private adapters are **completely outside** the public repo. The env var points to an external directory. No `.gitignore` risk.

## Pipeline Runner (`src/pipeline/runner.ts`)

### Data flow

```
loadAdapters()
  ↓
Parse CLI args (--adapter, --input, --replace)
  ↓
Build config from process.env + CLI args
  ↓
For each selected adapter (or all if none specified):
  adapter.export(config) → Chunk[]
  ↓
Merge all chunks (concat, dedupe by id — last write wins)
  ↓
filterChunks(allChunks) — generic quality filter
  ↓
Diff against DB:
  getExistingChunkHashes() → compare content hashes
  → categorize: new / changed / unchanged
  ↓
If --replace: deleteAllChunks() first, then treat all as new
  ↓
Snapshot rejected chunk IDs (for restoration)
  ↓
Batch embed (embedTexts from knowledge.ts, batch size 10)
  ↓
Batch upload to poc_kb_chunks
  ↓
Restore rejected status on snapshot IDs
  ↓
Log summary: N new, N changed, N unchanged, N filtered, N rejected restored
```

### CLI interface

```
Usage: bun run src/pipeline/runner.ts [options]

Options:
  --adapter <name>    Run specific adapter(s). Repeat for multiple. Omit for all.
  --input <path>      Set INPUT_PATH in adapter config (shorthand for env var).
  --replace           Delete all chunks before import (full rebuild).
  --list              List available adapters and exit.
  --help              Show this help.

Environment:
  RAG_ADAPTERS_PATH   Directory of external adapter files to load.
  INSFORGE_URL        InsForge backend URL (required).
  INSFORGE_KEY        InsForge anon key (required).
  (adapter-specific)  Each adapter may require its own env vars.
```

### Config passed to adapters

```ts
const config: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) config[k] = v;
}
if (cliInputPath) config.INPUT_PATH = cliInputPath;
```

Each adapter receives the full env + CLI overrides. It picks the keys it needs and ignores the rest.

## Quality Filter (`src/pipeline/filter.ts`)

Extracted from the current `pipeline.ts` `mergeAndFilter()` logic:

```ts
export function filterChunks(chunks: Chunk[]): Chunk[] {
  return chunks.filter(chunk => {
    const answer = chunk.metadata.answer || "";
    // Skip filter for chunks without an answer field (e.g. raw doc chunks)
    if (!answer) return true;
    if (answer.length < 15) return false;
    if (/^(ok|okay|好的|收到|已處理)/i.test(answer)) return false;
    if (/目前沒有|没有具体|暫無/.test(answer)) return false;
    return true;
  });
}
```

Applied by the runner after all adapters have exported. Chunks without a `metadata.answer` field bypass the filter (the rules are answer-specific). Adapters can pre-filter internally, but the runner's filter is a safety net.

## Built-in Adapters

### JSON Adapter (`src/adapters/json.ts`)

Reads a JSON file and returns its contents as chunks.

**Config:** `INPUT_PATH` (default: `data/chunks.json`)

**Supported formats:**
1. `Chunk[]` — used directly
2. Array of objects with at least `id` and `content` fields — normalized to `Chunk` format

```bash
bun run src/pipeline/runner.ts --adapter json --input data/my-chunks.json
```

### Markdown Adapter (`src/adapters/markdown.ts`)

Scans a directory for `.md`/`.mdx` files, parses frontmatter, splits by `##` headings, and further splits long sections by paragraph boundaries (target: 800 chars).

**Config:** `INPUT_PATH` (default: `./docs`)

**Chunk ID format:** `MD-{slug}-{section}-{part}`

**Frontmatter fields recognized:** `title`, `tags`, `date`, `url`

**Splitting logic** (extracted to `src/pipeline/markdown-utils.ts`):
- `parseFrontmatter(content)` — YAML frontmatter between `---` delimiters
- `splitByHeadings(content)` — split on `## ` (h2) boundaries
- `splitByParagraph(text, targetSize)` — split long text on blank lines, targeting `targetSize` chars per chunk

```bash
bun run src/pipeline/runner.ts --adapter markdown --input ./my-docs/
```

## Embed + Upload Logic

The runner reuses the proven logic from `embed-and-upload.ts`:

- `hashChunkPayload(chunk)` — SHA-256 of normalized chunk fields for diff detection
- `getExistingChunkHashes()` — paginated fetch of current DB state
- Batch embedding via `embedTexts()` from `knowledge.ts` (batch size 10, 1s delay)
- Batch upload via InsForge PostgREST `.insert()`
- `--replace` mode: `deleteAllChunks()` first
- Rejection preservation: `getRejectedChunkIds()` before delete, `restoreRejectedStatus()` after upload

This logic moves from `embed-and-upload.ts` into `runner.ts`. The original file becomes obsolete.

## Error Handling

| Situation | Behavior |
|-----------|----------|
| `RAG_ADAPTERS_PATH` directory doesn't exist | Log warning, continue with built-in adapters only |
| External adapter file fails to import | Log warning with filename + error, skip it, continue |
| External adapter file missing `name` or `export` | Log warning, skip it |
| Adapter name conflicts with built-in | Log error, refuse to register (built-in wins) |
| `adapter.export()` throws | Log error with adapter name + error, skip adapter, continue with others |
| `adapter.export()` returns invalid chunks (missing id/content) | Filter them out with warning, continue |
| `--adapter foo` but `foo` not found | Exit with error listing available adapters |
| No adapters selected and none loaded | Exit with error |
| Embed/upload batch fails | Retry up to 3 times (existing behavior), log failed IDs |
| DB connection failure | Exit with error (existing behavior) |

## Testing

### Pipeline runner manual tests

- [ ] `--adapter json --input test.json` → chunks appear in DB
- [ ] `--adapter markdown --input ./test-docs/` → markdown split into chunks, appear in DB
- [ ] `--adapter json --adapter markdown` → both adapters' chunks merged in DB
- [ ] `--replace` → delete then rebuild, rejections preserved
- [ ] Incremental (no `--replace`) → only new/changed chunks updated
- [ ] `RAG_ADAPTERS_PATH=./test-adapters/` → external adapter loaded and executed
- [ ] Malformed external adapter file → warning logged, skipped, runner continues
- [ ] `--list` → prints all available adapters with descriptions
- [ ] `--adapter nonexistent` → error with list of available adapters

### Adapter tests

- [ ] JSON: empty file `[]` → 0 chunks, no error
- [ ] JSON: valid file → correct chunk count and format
- [ ] JSON: file not found → clear error message
- [ ] Markdown: empty directory → 0 chunks, no error
- [ ] Markdown: files with frontmatter → title/tags parsed correctly
- [ ] Markdown: long section (> 800 chars) → split into multiple chunks with correct `parent_id`
- [ ] Markdown: nested directories → all files discovered
- [ ] Markdown: `.md` and `.mdx` both processed

### Quality filter tests

- [ ] Answer < 15 chars → filtered out
- [ ] Answer starts with "ok" / "好的" / "收到" → filtered out
- [ ] Answer contains "目前沒有" → filtered out
- [ ] Normal answer → passes filter

### Eval set

**Not run.** This change does not touch search/BM25/embedding logic in `query.ts` or `bm25.ts`.

## Files

### New (in rag-service)

| File | Purpose |
|------|---------|
| `src/pipeline/types.ts` | `Chunk` and `SourceAdapter` interfaces |
| `src/pipeline/registry.ts` | Adapter registration + auto-loading from built-in and `RAG_ADAPTERS_PATH` |
| `src/pipeline/runner.ts` | CLI pipeline executor (merge → filter → diff → embed → upload) |
| `src/pipeline/filter.ts` | Generic quality filter |
| `src/pipeline/markdown-utils.ts` | Frontmatter parser, heading splitter, paragraph splitter |
| `src/adapters/json.ts` | Built-in JSON file adapter |
| `src/adapters/markdown.ts` | Built-in Markdown directory adapter |

### Modified (in rag-service)

| File | Change |
|------|--------|
| `README.md` | Add adapter documentation (interface, how to write, CLI usage, `RAG_ADAPTERS_PATH`) |
| `CHANGELOG.md` | v2.0.0 entry |
| `.claude-plugin/plugin.json` | Bump to 2.0.0 |
| `package.json` | Add `"pipeline": "bun run src/pipeline/runner.ts"` script |

### Unchanged

- `src/server.ts`, `src/query.ts`, `src/bm25.ts`, `src/knowledge.ts`, `src/api-keys.ts`, `src/migrate.ts`
- `skills/` (all 8 skills)
- `ui/` (dashboard + search)
- `Dockerfile`, `zbpack.json`, deploy config

### Obsoleted (in zeabur-rag, not deleted — becomes reference for adapter conversion)

- `scripts/pipeline.ts` — replaced by `src/pipeline/runner.ts`
- `scripts/embed-and-upload.ts` — logic absorbed into runner
- `scripts/export-*.ts` — to be converted to adapters in follow-up task
- `scripts/chunk-posts.ts`, `scripts/chunk-issues.ts` — to be absorbed into forum/linear adapters

## Future Work (out of scope)

- **Convert Zeabur export scripts to adapters** — mechanical follow-up task, not a design problem
- **Refactor query.ts / bm25.ts** — separate spec for DRY helpers and TF pre-computation
- **Community adapter repository** — curated list of community-contributed adapters
- **Adapter marketplace / registry** — discovery mechanism for adapters (npm, GitHub)
- **Parallel adapter execution** — add `--parallel` flag for independent adapters
- **Dry-run mode** — `--dry-run` to preview what would be imported without writing to DB
- **Adapter-level incremental export** — let adapters declare "last sync timestamp" for incremental fetches
