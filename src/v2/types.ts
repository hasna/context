import type {
  ApiEndpointParameter,
  ApiEndpointRequestBody,
  ApiEndpointResponse,
  LibrarySourceType,
} from "../types/index.js";

export type V2RetrievalChannel = "fts" | "vector" | "api" | "kg";
export type V2EvidenceKind = "documentation_chunk" | "api_endpoint" | "knowledge_graph";
export type V2FreshnessState = "fresh" | "due" | "empty" | "unknown";
export type V2PipelineStepStatus = "completed" | "skipped" | "failed";
export type V2SynthesisStatus = "not_run" | "complete" | "failed";

export interface V2ResolvedLibrary {
  id: string;
  slug: string;
  name: string;
  version: string | null;
  source_type: LibrarySourceType;
  source_url: string | null;
  docs_url: string | null;
  npm_package: string | null;
  github_repo: string | null;
  freshness_days: number;
  priority: number;
  document_count: number;
  chunk_count: number;
  last_crawled_at: string | null;
  last_checked_at: string | null;
  next_check_at: string | null;
}

export interface V2QueryIntent {
  original_query: string;
  normalized_query: string;
  requested_library: string | null;
  requested_version: string | null;
  wants_latest: boolean;
  needs_api: boolean;
  needs_examples: boolean;
  terms: string[];
  generated_at: string;
}

export interface V2FreshnessStatus {
  state: V2FreshnessState;
  checked_at: string;
  last_refreshed_at: string | null;
  next_check_at: string | null;
  freshness_days: number | null;
  warnings: string[];
}

export interface V2PipelineStep {
  id: string;
  label: string;
  status: V2PipelineStepStatus;
  detail: string;
}

export interface V2QueryPlan {
  deterministic: true;
  steps: V2PipelineStep[];
  retrieval: {
    fts: boolean;
    vector: boolean;
    api: boolean;
    kg: boolean;
  };
}

export interface V2CitationSpan {
  source_url: string | null;
  source_title: string | null;
  source_type: LibrarySourceType | string | null;
  source_revision_id: string | null;
  source_revision: string | null;
  source_hash: string | null;
  artifact_uri: string | null;
  artifact_path: string | null;
  library_id: string | null;
  library_slug: string | null;
  document_id: string | null;
  chunk_id: string | null;
  endpoint_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  quote: string | null;
}

export interface V2ContextCitation extends V2CitationSpan {
  id: string;
  evidence_id: string;
}

export interface V2ApiEndpointEvidence {
  endpoint_id: string;
  method: string;
  path: string;
  operation_id: string | null;
  summary: string | null;
  tags: string[];
  parameters: ApiEndpointParameter[];
  request_body: ApiEndpointRequestBody | null;
  responses: Record<string, ApiEndpointResponse>;
  source_format: string;
  spec_version: string | null;
  api_version: string | null;
}

export interface V2KnowledgeGraphEvidence {
  node_id: string;
  node_type: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
}

export interface V2RetrievalEvidence {
  evidence_id: string;
  channel: V2RetrievalChannel;
  kind: V2EvidenceKind;
  title: string | null;
  text: string;
  score: number;
  scores: Record<string, number>;
  library: V2ResolvedLibrary | null;
  citation: V2CitationSpan | null;
  api_endpoint: V2ApiEndpointEvidence | null;
  knowledge_graph: V2KnowledgeGraphEvidence | null;
  reasons: string[];
}

export interface V2SynthesisResult {
  status: V2SynthesisStatus;
  text: string | null;
  cited_evidence_ids: string[];
  warnings: string[];
  provider: string | null;
  model: string | null;
}

export interface V2CitationVerificationResult {
  verified: boolean;
  checked_at: string;
  missing_citations: string[];
  warnings: string[];
}

export interface V2ContextPack {
  schema_version: 2;
  query: string;
  intent: V2QueryIntent;
  resolved_library: V2ResolvedLibrary | null;
  freshness: V2FreshnessStatus;
  plan: V2QueryPlan;
  evidence: V2RetrievalEvidence[];
  citations: V2ContextCitation[];
  context_text: string;
  estimated_tokens: number;
  synthesis: V2SynthesisResult;
  citation_verification: V2CitationVerificationResult;
  warnings: string[];
  created_at: string;
}

export interface V2RetrievalRequest {
  query: string;
  library_id?: string;
  limit: number;
}

export interface V2ApiRetrievalRequest extends V2RetrievalRequest {
  fallback_to_library_endpoints?: boolean;
}

export interface ContextHubStorage {
  resolveLibrary(reference?: string, version?: string | null): Promise<V2ResolvedLibrary | null> | V2ResolvedLibrary | null;
  getFreshness(library: V2ResolvedLibrary | null): Promise<V2FreshnessStatus> | V2FreshnessStatus;
  searchText(request: V2RetrievalRequest): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
  searchVector?(request: V2RetrievalRequest): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
  searchApiEndpoints(request: V2ApiRetrievalRequest): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
  searchKnowledgeGraph(request: V2RetrievalRequest): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
}

export interface SourceRegistry {
  resolve(reference: string, version?: string | null): Promise<V2ResolvedLibrary | null> | V2ResolvedLibrary | null;
  search(query: string, limit?: number): Promise<V2ResolvedLibrary[]> | V2ResolvedLibrary[];
}

export interface V2IngestRequest {
  library: V2ResolvedLibrary;
  max_pages: number;
  refresh: boolean;
  write_artifacts: boolean;
}

export interface V2IngestResult {
  library_id: string;
  source_revision_ids: string[];
  document_ids: string[];
  chunk_ids: string[];
  endpoint_ids: string[];
  artifact_uris: string[];
  refreshed_at: string;
  warnings: string[];
}

export interface IngestAdapter {
  ingest(request: V2IngestRequest): Promise<V2IngestResult>;
}

export interface Retriever {
  retrieve(request: V2RetrievalRequest): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
}

export interface ApiEndpointRetriever {
  retrieveApiEndpoints(request: V2ApiRetrievalRequest): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
}

export interface FreshnessGate {
  evaluate(library: V2ResolvedLibrary | null, intent: V2QueryIntent): Promise<V2FreshnessStatus> | V2FreshnessStatus;
}

export interface ContextPackBuilder {
  build(options: BuildV2ContextPackOptions): Promise<V2ContextPack>;
}

export interface LegacyPresenter<Output = unknown> {
  present(pack: V2ContextPack): Output;
}

export interface ContextHubService {
  readonly registry: SourceRegistry;
  readonly ingest: IngestAdapter;
  readonly storage: ContextHubStorage;
  readonly freshness: FreshnessGate;
  readonly contextPacks: ContextPackBuilder;
}

export interface V2QueryHooks {
  planIntent?(intent: V2QueryIntent): Promise<Partial<V2QueryIntent>> | Partial<V2QueryIntent>;
  rerankEvidence?(input: {
    intent: V2QueryIntent;
    evidence: V2RetrievalEvidence[];
  }): Promise<V2RetrievalEvidence[]> | V2RetrievalEvidence[];
  synthesize?(pack: V2ContextPack): Promise<V2SynthesisResult> | V2SynthesisResult;
  verifyCitations?(pack: V2ContextPack): Promise<V2CitationVerificationResult> | V2CitationVerificationResult;
}

export interface BuildV2ContextPackOptions {
  prompt: string;
  library?: string;
  version?: string;
  limit?: number;
  endpointLimit?: number;
  kgLimit?: number;
  vectorLimit?: number;
  maxTokens?: number;
  storage?: ContextHubStorage;
  hooks?: V2QueryHooks;
}
