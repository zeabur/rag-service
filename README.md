# RAG Service

A self-hosted RAG service with hybrid search (semantic + BM25), admin dashboard, and Claude Code plugin for agent integration.

## Getting Started

### 1. Create a Zeabur Project

Go to [Zeabur Dashboard](https://dash.zeabur.com) and create a new project.

### 2. Enable InsForge

In your project, go to **Integration → InsForge → Enable InsForge**. Additional charges may apply based on usage ([pricing details](https://zeabur.com/docs/en-US/integrations/insforge/overview)).

### 3. Get InsForge Credentials

After enabling, open InsForge and go to **Project Settings → API** to find:

- Project URL (`INSFORGE_URL`): e.g. `https://xxx.us-east.insforge.app`
- API Key (`INSFORGE_API_KEY`): starts with `ik_...`
- Anon Key (`INSFORGE_KEY`): starts with `eyJ...`

### 4. Deploy RAG Service

In your project, click **Add Service → Marketplace**, search for **RAG Service**, and fill in:

- The three InsForge credentials from Step 3
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

| Skill | Description |
|-------|-------------|
| `zeabur-rag-search` | Search knowledge base with hybrid retrieval |
| `zeabur-rag-learn` | Contribute new verified knowledge |
| `zeabur-rag-report` | Report outdated, incorrect, or missing content |
| `zeabur-rag-setup` | Configure plugin environment variables |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INSFORGE_URL` | Yes | InsForge backend URL |
| `INSFORGE_KEY` | Yes | InsForge anon key |
| `INSFORGE_API_KEY` | Yes | InsForge API key for schema migration |
| `ZEABUR_AI_HUB_API_KEY` | Yes | [Zeabur AI Hub](https://zeabur.com/ai-hub) key for LLM inference |
| `RAG_API_KEY` | Auto | API key for service access (auto-generated on Zeabur) |
| `RAG_BASIC_AUTH` | Auto | Dashboard auth (format: `admin:password`) |
| `RAG_MODEL` | No | LLM model (default: `gemini-2.5-flash-lite`) |
| `CORS_ORIGIN` | No | CORS origin (default: `*`) |

See `.env.example` for a complete template.

## Local Development

```bash
cp .env.example .env
# Fill in your credentials
bun install
bun run start
```

## License

[MIT](LICENSE)
