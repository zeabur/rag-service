# RAG Service

A self-hosted RAG service with hybrid search (semantic + BM25), admin dashboard, and Claude Code plugin for agent integration.

## Architecture

```
                          rag-service
 ┌─────────────────────────────────────────────────────────┐
 │                                                         │
 │  ┌─────────┐   ┌──────────┐   ┌───────────────────┐    │
 │  │ Adapter  │──>│ Chunking │──>│  Embed & Upload    │    │
 │  │ (json,md)│   │ (H2+para)│   │                    │    │
 │  └─────────┘   └──────────┘   │  text-embedding-   │    │
 │       ^                        │  3-small (1536d)   │    │
 │       │ --input                └────────┬───────────┘    │
 │       │ --dry-run                       │                │
 │                                         v                │
 │  ┌──────────────────────────────────────────────┐       │
 │  │           InsForge (pgvector)                 │       │
 │  │                                               │       │
 │  │  poc_kb_chunks                                │       │
 │  │  ┌─────┬──────┬───────────┬──────────┐       │       │
 │  │  │ id  │ text │ embedding │ vis/tags │       │       │
 │  │  └─────┴──────┴───────────┴──────────┘       │       │
 │  │                                               │       │
 │  │  AI Proxy: embeddings + chat completions      │       │
 │  └──────────────────────────────────────────────┘       │
 │                         │                                │
 │              ┌──────────┴──────────┐                     │
 │              v                     v                     │
 │  ┌─────────────────┐   ┌──────────────────┐             │
 │  │   BM25 search   │   │ Semantic search  │             │
 │  │ (Intl.Segmenter │   │ (pgvector cosine)│             │
 │  │  + Porter stem)  │   └────────┬─────────┘             │
 │  └────────┬────────┘            │                        │
 │           └──────────┬──────────┘                        │
 │                      v                                   │
 │             ┌─────────────────┐                          │
 │             │   RRF Fusion    │                          │
 │             │ (keyword 0.25 + │                          │
 │             │  semantic 0.75) │                          │
 │             └────────┬────────┘                          │
 │                      v                                   │
 │  ┌────────────────────────────────────────────┐         │
 │  │  /api/query  →  chunks + optional LLM RAG  │         │
 │  │  /api/learn  →  add chunk (unverified)      │         │
 │  │  /api/report →  flag content issue          │         │
 │  │  /dashboard  →  admin UI                    │         │
 │  └────────────────────────────────────────────┘         │
 └─────────────────────────────────────────────────────────┘

            Agent Curation Loop
 ┌───────────────────────────────────────┐
 │                                       │
 │  search ──> learn/report              │
 │               │                       │
 │               v                       │
 │  triage ──> inspect ──> edit/verify   │
 │               │                       │
 │               v                       │
 │  curate (walks queue item-by-item)    │
 │               │                       │
 │               v                       │
 │  improved KB ──> better search ──>    │
 └───────────────────────────────────────┘
```

## Getting Started

### 1. Create a Zeabur Project

Go to [Zeabur Dashboard](https://zeabur.com/projects) and create a new project.

### 2. Enable InsForge

In your project, go to **Integration → InsForge → Enable InsForge**. Additional charges may apply based on usage ([pricing details](https://zeabur.com/docs/en-US/integrations/insforge/overview)).

### 3. Get InsForge Credentials

After enabling, open InsForge and go to **Project Settings → API** to find:

- Project URL (`INSFORGE_URL`): e.g. `https://xxx.us-east.insforge.app`
- API Key (`INSFORGE_API_KEY`): starts with `ik_...`

### 4. Deploy RAG Service

In your project, click **Add Service → Marketplace**, search for **RAG Service**, and fill in:

- The InsForge credentials from Step 3
- Zeabur AI Hub API Key: can be generated during deployment, or created in advance at [Zeabur AI Hub](https://zeabur.com/ai-hub)

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/H126IM)

Schema migrations run automatically on first startup — no manual setup needed.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/query` | POST | API key | Search knowledge base + optional RAG answer |
| `/api/learn` | POST | API key | Add new knowledge chunks |
| `/api/report` | POST | API key | Report content issues |
| `/api/feedback` | POST | API key | Submit result feedback |
| `/api/admin/*` | GET/POST | API key (admin) | API key management, signals, reports, chunks |
| `/dashboard` | GET | Basic Auth | Admin dashboard |

### Search Example

```bash
curl -X POST "https://your-rag-service/api/query" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "how to deploy", "mode": "hybrid", "top_k": 5}'
```

### Learn Example

```bash
curl -X POST "https://your-rag-service/api/learn" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Deploy with Docker", "content": "Steps to deploy..."}'
```

## Agent Integration (Claude Code Plugin)

Add the marketplace and install the plugin:

```bash
claude plugins marketplace add zeabur/rag-service
claude plugins install rag-service@rag-service
```

Then configure the connection:

```bash
claude
# Inside Claude Code, run:
/zeabur-rag-setup
```

This sets `ZEABUR_RAG_URL` and `RAG_API_KEY` in your Claude Code settings. The agent will automatically use the search skill when answering questions.

### Available Skills

The plugin ships 8 skills split into two tiers: everyday use, and maintenance of the knowledge base itself.

**Using the knowledge base** — any agent with an API key can invoke these:

| Skill | When it triggers |
|-------|------------------|
| `zeabur-rag-setup` | First-time setup — asks for `ZEABUR_RAG_URL` and `RAG_API_KEY`, writes them to Claude Code settings |
| `zeabur-rag-search` | Any technical question that might be answered by the KB (fires automatically, even without an explicit "search" instruction) |
| `zeabur-rag-learn` | After solving a problem or discovering something the KB didn't cover — contributes a new chunk marked `unverified` until an admin reviews it |
| `zeabur-rag-report` | A search result looks wrong, outdated, or a topic is missing — files an issue against a chunk without needing write access |

**Curating the knowledge base** — admin-scope skills that form a self-improving loop:

| Skill | Role in the loop |
|-------|------------------|
| `zeabur-rag-triage` | Lists everything pending: open reports, unverified `learn` chunks, low-similarity queries, negative feedback |
| `zeabur-rag-inspect` | Pulls one chunk's full content + related reports + search signals + edit history — the "look before you touch" step |
| `zeabur-rag-edit` | Patches an existing chunk in place (title, content, tags, visibility). Requires admin scope |
| `zeabur-rag-curate` | Orchestrator — walks through every triage item one by one with the user, deciding fix / reject / learn-new for each |

### The Curation Loop

Every agent interaction feeds a signal back into the KB, and the curation skills close the loop:

1. **Agents run `search`** → every query is logged with its top similarity score. Low-similarity queries (< 0.4) become signals that the KB may have a gap.
2. **Agents run `learn` / `report`** → new unverified chunks and open reports pile up in a queue.
3. **An admin runs `curate`** (or `triage` for a quick read-only view) → the skill walks the queue item-by-item:
   - For a **report**: `inspect` the chunk → `edit` to fix, or `learn` new content if it's a gap → close the report.
   - For an **unverified `learn` chunk**: `inspect` → verify, reject, or edit before verifying.
   - For a **low-similarity query**: `search` to reproduce → `learn` new content if it's a true gap, or `edit` an existing chunk to rank better.
   - For **negative feedback**: `inspect` the returned chunks → fix whichever one misled the agent.
4. **Verified chunks rank at full weight**; rejected ones are removed. The next round of searches sees an improved KB.

Agents and admins operate on the same data — the skills just expose different capabilities depending on scope. Point the plugin at any RAG service deployment and the loop works out of the box.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INSFORGE_URL` | Yes | InsForge backend URL |
| `INSFORGE_API_KEY` | Yes | InsForge API key (`ik_...`) |
| `ZEABUR_AI_HUB_API_KEY` | Yes | [Zeabur AI Hub](https://zeabur.com/ai-hub) key for LLM inference |
| `RAG_API_KEY` | Auto | API key for service access (auto-generated on Zeabur) |
| `RAG_BASIC_AUTH` | Auto | Dashboard auth (format: `admin:password`) |
| `RAG_MODEL` | No | LLM model (default: `gemini-2.5-flash-lite`) |
| `CORS_ORIGIN` | No | CORS origin (default: `*`) |

See `.env.example` for a complete template.

## Embedding Model

All vector embeddings use **`openai/text-embedding-3-small`** (1536 dimensions) via the InsForge AI proxy. No separate OpenAI API key is needed — the InsForge credentials (`INSFORGE_URL` / `INSFORGE_API_KEY`) handle both database and embedding requests.

This model is used for:
- **Query-time embedding** — vectorizing search queries (`src/query.ts`)
- **Batch embedding** — vectorizing chunks during pipeline upload (`src/knowledge.ts`)

## Local Development

```bash
cp .env.example .env
# Fill in your credentials
bun install
bun run start
```

## Pipeline

Import data into the knowledge base using adapters.

### Quick start

```bash
# Import from a JSON file
bun run pipeline --adapter json --input data/my-chunks.json

# Import from a directory of Markdown files
bun run pipeline --adapter markdown --input ./docs/

# List available adapters
bun run pipeline --list
```

### CLI options

| Option | Description |
|--------|-------------|
| `--adapter <name>` | Run specific adapter(s). Repeat for multiple. Omit for all. |
| `--input <path>` | Set INPUT_PATH in adapter config. |
| `--replace` | Delete all chunks before import (full rebuild). |
| `--dry-run` | Export chunks as JSON to stdout; skip embed/upload. |
| `--list` | List available adapters and exit. |
| `--help` | Show help. |

### Writing a custom adapter

Create a `.ts` file that exports a `SourceAdapter`:

```ts
import type { SourceAdapter, Chunk } from "rag-service/pipeline/types";

export default {
  name: "my-source",
  description: "Import from my custom source",

  async export(config) {
    // config contains all env vars + CLI --input as INPUT_PATH
    const chunks: Chunk[] = [];
    // ... fetch data, chunk it, push to chunks[] ...
    // Set metadata.visibility to "internal" or "public" per chunk (default: "public")
    return chunks;
  },

  // Optional: called after successful upload with the uploaded chunks
  async afterUpload(chunks, config) {
    // e.g. write back chunk IDs to source files
  },
} satisfies SourceAdapter;
```

#### Chunk visibility

Each chunk can set `metadata.visibility` to `"internal"` or `"public"`. Chunks without visibility default to `"public"`. Use `--visibility internal|public|all` with `src/query.ts` CLI to filter by visibility scope.

Load external adapters by setting `RAG_ADAPTERS_PATH`:

```bash
RAG_ADAPTERS_PATH=./my-adapters bun run pipeline
```

### Built-in adapters

**json** — Import from a JSON file. Accepts `Chunk[]` or arrays of objects with `id` + `content` fields.

**markdown** — Scan a directory for `.md`/`.mdx` files, parse frontmatter, split by `##` headings (~800 chars per chunk).

## License

[MIT](LICENSE)
