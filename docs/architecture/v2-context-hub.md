# Open Context v2 Context Hub Contract

Open Context v2 replatforms the package into a self-hosted context hub for AI
agents. It keeps the useful v1 acquisition and serving surface, while adding a
stable contract for source revisions, cited retrieval, freshness, and optional
knowledge-substrate integration.

## Product Boundary

Open Context owns public documentation acquisition and agent-facing context
serving:

- Source catalog records for libraries, packages, APIs, SDKs, examples, docs
  sites, llms.txt manifests, OpenAPI specs, GitHub docs, npm packages,
  changelogs, and releases.
- Refresh policy, crawl budgets, conditional fetch metadata, rate limits,
  backoff, and durable refresh run history.
- Native acquisition for docs sites, llms.txt and llms-full.txt, OpenAPI,
  GitHub, npm, and package docs.
- External retriever adapters such as Exa and Firecrawl.
- API endpoint and schema extraction from OpenAPI or API documentation.
- Context7-compatible library resolution and docs query tools.
- CLI, MCP, and HTTP compatibility wrappers.

Open Knowledge owns reusable durable knowledge substrate contracts when it is
used:

- Artifact storage contracts.
- Source revisions and chunks with offsets.
- Citations, provenance, run logs, context packs, and safe source boundaries.
- Hybrid retrieval and context-pack result shapes that can evolve under a
stable interface.

The OSS core must not hardcode hosted or proprietary corpus features. Hosted
workers, tenant permissions, connector secrets, billing, observability, and
large managed indexes can wrap these contracts later.

## v1 Surfaces To Preserve

The first v2 slice must not break:

- `context add`, `context refresh`, `context seed`, `context search`,
  `context endpoints`, `context docs`, `context updates`, `context live`,
  `context verify`, `context publish-check`, `context build`, and
  `context ask`.
- MCP tools `resolve-library-id`, `query-docs`, `build-docs-context`,
  `ask-docs`, `query-api-endpoints`, refresh, seed, readiness, storage, and
  repository tools.
- HTTP routes `/api/libraries`, `/api/libraries/:slug/refresh`,
  `/api/libraries/:slug/crawl`, `/api/search`, `/api/endpoints`,
  `/api/context/build`, and `/api/ai/ask`.
- SQLite v1 tables for `libraries`, `documents`, `chunks`, `chunk_embeddings`,
  `api_endpoints`, `kg_nodes`, `kg_edges`, `doc_update_tasks`, webhooks, and
  repository context indexing.
- Markdown docs artifacts under `.hasna/apps/knowledge/docs/<library>/`.

Compatibility wrappers may call v2 internals later, but their response shapes
and failure modes should remain stable unless a major-version CLI/API flag opts
into a new shape.

## Phase 1 Contract

Phase 1 adds an additive v2 layer under `src/v2`:

- `ContextHubStorage`: storage and retrieval interface used by query planning.
- `createV1ContextHubStorage`: adapter from existing v1 SQLite tables into the
  v2 contract.
- `buildV2ContextPack`: deterministic query pipeline skeleton.
- Knowledge-substrate adapter types that can map a v2 context pack into an
  open-knowledge-style context pack without adding a hard dependency.
- Remote storage sync includes `api_endpoints` so API evidence does not become
  local-only when users enable remote or hybrid storage.

The v2 query pipeline is:

1. Query intent extraction.
2. Library and version resolution.
3. Freshness gate.
4. FTS retrieval.
5. Optional vector retrieval.
6. API endpoint and schema retrieval.
7. Knowledge-graph retrieval.
8. Citation context-pack assembly.
9. Optional model rerank, synthesis, and citation verification hooks.

Retrieval is cited first. Model hooks may help planning, reranking, synthesis,
or verification, but they cannot create evidence. When a query asks for latest
or current information and the selected library is stale or empty, the context
pack must carry a freshness warning instead of confident prose.

## Evidence Contract

Every context-pack evidence item should include:

- Retrieval channel: `fts`, `vector`, `api`, or `kg`.
- Stable evidence id.
- Library identity and version when known.
- Exact excerpt text.
- Source URL when known.
- Document id, chunk id, endpoint id, source hash, artifact path, and revision
  metadata when available.
- Offset spans when the backend knows them.
- Score and reason codes.

API endpoint evidence additionally includes method, path, operation id, tags,
request body, responses, source format, spec version, and API version.

KG evidence is navigational unless it has a source URL and citation span. It
must not be treated as sufficient proof for factual synthesis by itself.

## Freshness Contract

Freshness starts with the existing `libraries` schedule fields:

- `last_crawled_at`
- `last_checked_at`
- `next_check_at`
- `freshness_days`
- `document_count`
- `chunk_count`

The v2 status is:

- `fresh`: indexed and not yet due.
- `due`: indexed but refresh is due.
- `empty`: selected source has no indexed docs or chunks.
- `unknown`: no selected library or no usable schedule metadata.

Future migrations can add source revision, ETag, Last-Modified, run history,
diff, and conditional fetch tables without changing the query pipeline
interface.

## Service Interfaces

The stable v2 boundary is intentionally broader than the first implementation:

- Source registry: resolve libraries, versions, aliases, package metadata, and
  canonical source URLs.
- Ingest adapter: turn discovered pages/specs/package docs into source
  revisions, documents, chunks, endpoint rows, KG updates, and artifacts.
- Storage repository: read/write source revisions, chunks, endpoints, KG rows,
  artifacts, refresh runs, and citations.
- Retriever: deterministic FTS/vector/API/KG retrieval with score components.
- Freshness gate: evaluate whether evidence is fresh enough for the requested
  intent and produce warnings before synthesis.
- Context-pack builder: assemble cited evidence before any model call.
- Legacy presenter: render existing CLI/MCP/HTTP-compatible text and JSON
  response shapes from v2 packs.

## Open Knowledge Boundary

Phase 1 mirrors the open-knowledge context-pack shape at the adapter boundary
only. Open Context should not require `@hasna/knowledge` to run v1 commands.

Safe to mirror now:

- Context pack: query, normalized query, results, citations, excerpts,
  warnings, and notes.
- Source revision/hash/citation span fields.
- Freshness and permission notes.
- Artifact URI/path metadata.

Keep optional for later:

- Direct writes to open-knowledge `knowledge.db`.
- Open-files source ownership semantics.
- Hosted/S3 storage policy.
- Wiki compile and durable answer filing.
- Permission enforcement beyond public-doc read-only assumptions.

## Migration Path

1. Add v2 contracts and v1-backed adapters.
2. Add additive CLI/MCP/HTTP v2 routes once the contract is stable.
3. Introduce source revision and refresh run tables behind the storage
   interface.
4. Move context building wrappers to v2 internals while keeping v1 response
   shapes.
5. Add optional open-knowledge package integration for projects that want the
   shared substrate.
6. Add worker scheduling and conditional fetch run history.

## Required Tests

Phase 1 tests must prove:

- V2 context packs can be built from existing v1 SQLite rows.
- Existing v1 context building still works.
- Library version resolution and freshness warnings are deterministic.
- API endpoints appear as cited evidence with schema summaries.
- The open-knowledge adapter boundary preserves citations and excerpts.
- Typecheck/build do not require a hosted account or external retriever keys.
