# @hasna/context

Self-hosted documentation context server for AI coding agents — refresh, index, and query library docs via MCP + CLI + HTTP

[![npm](https://img.shields.io/npm/v/@hasna/context)](https://www.npmjs.com/package/@hasna/context)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/context
```

## CLI Usage

```bash
context --help
context seed
context seed --groups llm,saas --limit 0
context seed --groups llm,saas --limit 0 --json
context seed --groups llm --limit 3 --crawl --pages 1
context seed --groups llm --crawl --pages 3 --embed
context seed --open-connectors ../open-connectors --open-connectors-enabled-only --open-connectors-only
context add react --url https://react.dev/reference/react
context build "How does useEffect cleanup work?" --library react
context build "How does createRoot work?" --library react --doc-version 18
context ask "How do I create a Stripe checkout session?" --library stripe
context search "useEffect cleanup" --library react
context endpoints stripe-api --operation createPaymentIntent
context docs react
context updates --create-tasks
context sources
context sources --readiness
context verify --registry
context publish-check
context ai status
```

Docs are stored in SQLite for catalog/search and as structured Markdown artifacts
under `~/.hasna/apps/knowledge/docs/<library>/`. Each library folder also gets a
`manifest.json` that maps saved Markdown files back to SQLite document metadata,
source refresh metadata, and any indexed API endpoints.
Use `--doc-version <version>` with `context build` / `context ask`, or a library
reference such as `/context/react@18` in MCP `query-docs`, when a versioned
source must be selected explicitly.

Libraries also carry normalized source metadata. Supported source
types are `docs`, `website`, `llms_txt`, `openapi`, `github`, `npm`, `api`,
and `manual`; each source type also reports an origin such as `web`, `manifest`,
`api_spec`, `repository`, `package`, or `manual`:

```bash
context add "Stripe API" \
  --url https://docs.stripe.com/api \
  --source-type api \
  --freshness-days 3
```

Native source ingestion works without retriever API keys for documentation
websites, API docs pages, `llms.txt`, OpenAPI specs, npm package READMEs, and
common GitHub README/docs files. Website/API sources follow same-origin docs
links, `sitemap.xml` entries, sitemap URLs declared in `robots.txt`, and
auto-discovered `llms.txt` / `llms-full.txt` manifests. The same refresh path
writes SQLite metadata, chunks, version records, structured Markdown artifacts,
and a per-library `manifest.json`. OpenAPI sources also write first-class
endpoint rows with method, path, operation ID, request/response schema summaries,
and same-origin external `$ref` schema resolution. Endpoint rows are linked into
the local knowledge graph as `part_of` relations for the source library.

## Source Catalog Bootstrap

The seed catalog is idempotent. Re-running it updates existing source metadata,
links, freshness policy, priority, and knowledge-graph records instead of
skipping stale rows. Use groups or explicit slugs to bootstrap the docs you
want, then add `--crawl` to refresh the selected sources. Firecrawl remains the
external fallback, while native `llms.txt`, OpenAPI, npm, GitHub, and website
ingestion run without retriever keys when possible.

```bash
context seed --groups llm,saas --limit 0
context seed --groups llm,saas --limit 0 --json
context seed --slugs vercel-ai-sdk,anthropic,slack --crawl --pages 2
context seed --groups llm --crawl --pages 3 --embed
context seed --groups all --crawl --pages 3 --retriever firecrawl
context seed --groups llm --crawl --new-only
context seed --open-connectors ../open-connectors --open-connectors-enabled-only --open-connectors-only
context seed --open-connectors ../open-connectors --open-connectors-only --slugs figma,stripe --crawl --pages 3
```

`--open-connectors <path>` imports an `@hasna/connectors` checkout into the same
source bootstrap pipeline. Imported connector packages become normal `api`
sources with npm/GitHub/doc links and refresh policy; they are not stored in a
separate connector/provider model. `--open-connectors-enabled-only` respects
`.connectors/manifest.json`, and `--open-connectors-only` processes only the
imported connector-backed sources. If an imported source does not declare a real
docs URL, refresh uses Exa for docs URL discovery and Firecrawl as the default
crawler fallback.

## MCP Server

```bash
context-mcp
```

The MCP server exposes library resolution, docs querying, docs file listing,
source discovery, refresh planning, storage sync, AI generation,
repository indexing, and code context tools.

## HTTP mode

Long-lived Streamable HTTP transport (stateless, bind `127.0.0.1` only):

```bash
context-mcp --http              # default port 8810
context-mcp --http --port 8810
MCP_HTTP=1 context-mcp
```

- Health: `GET http://127.0.0.1:8810/health`
- MCP: `http://127.0.0.1:8810/mcp`

The REST server (`context-serve`) also exposes `/health` and `/mcp` when running.

## REST API

```bash
context-serve
```

The HTTP server binds to `127.0.0.1` by default. Set `CONTEXT_HOST` to bind
elsewhere; non-local binds require `CONTEXT_HTTP_TOKEN`. When a token is set,
all API routes except `/api/health` require `Authorization: Bearer <token>` or
`X-Context-Token: <token>`.

Useful endpoints include:

```text
GET  /api/health
GET  /api/libraries
POST /api/libraries/:slug/refresh
POST /api/libraries/:slug/crawl     (compatibility alias)
GET  /api/libraries/:slug/docs
GET  /api/libraries/:slug/embeddings
POST /api/libraries/:slug/embed
GET  /api/search?q=...&library=...
GET  /api/search?q=...&library=...&semantic=true
GET  /api/endpoints?library=...&operation_id=...
GET  /api/updates/plan
GET  /api/live/cycle
POST /api/live/cycle
GET  /api/sources
GET  /api/sources/readiness
GET  /api/seeds?groups=llm,saas&limit=10
POST /api/seeds
GET  /api/webhooks
POST /api/webhooks
DELETE /api/webhooks/:id
GET  /api/webhooks/deliveries
POST /api/webhooks/test
GET  /api/publish/readiness
GET  /api/ai/status
POST /api/ai/generate
POST /api/context/build
POST /api/ai/ask
```

`POST /api/seeds` accepts the same source bootstrap controls as the CLI:
`groups`, `slugs`, `limit`, `crawl`, `new_only`, `max_pages`, `retriever`,
`retriever_only`, `write_files`, `open_connectors_path`,
`open_connectors_enabled_only`, and `open_connectors_only`.
`GET /api/live/cycle` is read-only and returns a plan-only cycle; use
`POST /api/live/cycle` to run a refresh cycle. Webhook endpoints mirror the CLI
webhook commands and record delivery attempts in SQLite.
Semantic search requires embeddings first. Use `context refresh <slug> --embed`,
`context seed --crawl --embed`, `context live --embed`,
`POST /api/libraries/:slug/embed`, or the MCP `embed-library` tool after setting
`CONTEXT_EMBEDDING_PROVIDER` (`openai` or `voyage`) and the provider API key.
Use `context build`, `POST /api/context/build`, or MCP `build-docs-context` to
assemble a read-only docs context pack without AI keys. Pass `version` when a
specific indexed source version is required. Use `context ask`, `POST
/api/ai/ask`, or MCP `ask-docs` to answer from that context with the configured
AI SDK backend.

## Retrieval Backends

Firecrawl is the default external retriever when native source ingestion is not
enough. When a source is registered without a docs URL, Exa can resolve likely
canonical documentation URLs first; Firecrawl then crawls the discovered source.
`--crawler firecrawl` and `CONTEXT_CRAWLER` remain supported compatibility
aliases.

```bash
export EXA_API_KEY="..."
export FIRECRAWL_API_KEY="..."
context add "Slack API"
context refresh react
context refresh react --retriever firecrawl --retriever-only
CONTEXT_RETRIEVER=exa context refresh react
```

An empty retrieval is treated as a failure instead of a successful zero-result run.
Refresh results include coverage metadata in CLI, MCP, HTTP, webhook, and JSON
verifier output: `max_pages`, `pages_retrieved`, `page_limit_reached`, and
`full_docs_detected`. Use `page_limit_reached` to detect when a run saturated its
page budget, and `full_docs_detected` to confirm an `llms-full.txt` source was
included when available.

## AI SDK Generation

The package includes AI SDK v6 plus adapter packages for OpenAI, Anthropic,
Google Gemini, xAI, DeepSeek, Mistral, Cohere, Groq, Perplexity, and Together AI.

```bash
export CONTEXT_AI_PROVIDER=xai
export XAI_API_KEY="..."
context ai status
context ai generate "Summarize the React docs indexed locally"
context build "Summarize the React effect lifecycle" --library react
context ask "Summarize the React effect lifecycle" --library react --backend xai
curl -s http://localhost:19431/api/ai/generate \
  -H 'content-type: application/json' \
  -d '{"provider":"xai","prompt":"Summarize the indexed React docs"}'
```

Supported AI key envs include `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`,
`MISTRAL_API_KEY`, `COHERE_API_KEY`, `GROQ_API_KEY`, `PERPLEXITY_API_KEY`,
and `TOGETHER_API_KEY`.

## Live Updates and Webhooks

```bash
context live --once --plan-only
context live --once --native-only
context live --interval 86400 --retriever firecrawl --embed
context webhooks add https://example.com/hooks/context
context webhooks deliveries
```

Webhook events include `docs.refreshed` and `docs.refresh_failed`.

## Publish Readiness

```bash
context verify --registry
context verify --smoke
context verify --no-publish --smoke --pages 2 --require-full-docs
context verify --no-publish --required-smoke --pages 1 --concurrency 6 --case-timeout-ms 45000
CONTEXT_SOURCE_FETCH_TIMEOUT_MS=8000 context verify --no-publish --required-live-smoke llm --pages 1
context verify --seed-smoke llm,saas --seed-limit 8 --pages 1
context verify --external-smoke --retrievers firecrawl,exa
context publish-check
context publish-check --registry
```

`context verify` combines publish readiness, AI SDK status, retriever key
availability, source readiness, seed corpus coverage, optional isolated
source/retriever smokes, and seed-backed LLM/SaaS source matrix checks.
Use `--required-smoke` to fetch and search every required LLM provider and
SaaS/API seed in one read-only verifier run. Use `--required-live-smoke` to
bootstrap the required seeds, run the live update cycle, complete update tasks,
write local docs artifacts, index SQLite chunks, and verify search results.
Add `--require-full-docs` to smoke commands when the run must fail on saturated
page budgets or missing `llms-full.txt` coverage for `llms_txt` sources.
Use `--concurrency` to bound parallel smoke refreshes during required corpus
checks; results stay ordered by source. Use `--case-timeout-ms` to cap each
individual smoke source when a live docs site stalls; `0` disables the per-case
cap.
`CONTEXT_SOURCE_FETCH_TIMEOUT_MS` bounds native source fetches for long-running
corpus or live-update verifier runs. Optional probes are shorter by default and
can be tuned with `CONTEXT_LLMS_FULL_FETCH_TIMEOUT_MS` and
`CONTEXT_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS`.
The publish check validates package metadata, built `dist` entrypoints,
executables, exports, npm publish config, and optionally the latest registry
version.

## Storage Sync

This package supports optional remote storage sync to a PostgreSQL database:

```bash
export HASNA_CONTEXT_DATABASE_URL="postgres://..."
context storage status
context storage push
context storage pull
```

The remote storage URL can also be provided as `CONTEXT_DATABASE_URL`.
Programmatic storage helpers are available from `@hasna/context/storage`.

## Data Directory

Data is stored in `~/.hasna/apps/knowledge/`. Existing `~/.hasna/context/` or
`~/.context/` data is copied forward on first database open. Override with
`CONTEXT_DATA_DIR` or `HASNA_CONTEXT_DATA_DIR`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
