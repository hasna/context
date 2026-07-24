import type { V2ContextCitation, V2ContextPack, V2RetrievalEvidence } from "./types.js";

export interface KnowledgeSubstrateSearchEntry {
  kind: "source_chunk" | "api_endpoint" | "knowledge_graph";
  id: string;
  title: string | null;
  text: string | null;
  score: number;
  scores: Record<string, number>;
  source: {
    uri: string | null;
    ref: string | null;
    kind: string | null;
    revision: string | null;
    hash: string | null;
  } | null;
  citation: {
    chunk_id: string | null;
    start_offset: number | null;
    end_offset: number | null;
  } | null;
  artifact: {
    uri: string | null;
    path: string | null;
    hash: string | null;
    shard_key: string | null;
  } | null;
  provenance: {
    source_owner: "open-context";
    source_ref: string | null;
    source_uri: string | null;
    source_kind: string | null;
    source_revision_id: string | null;
    revision: string | null;
    hash: string | null;
    chunk_id: string | null;
    start_offset: number | null;
    end_offset: number | null;
    read_only: true;
    citation_required: true;
    stale: boolean;
  } | null;
  reasons: string[];
}

export interface KnowledgeSubstrateContextPack {
  query: string;
  normalized_query: string;
  created_at: string;
  mode: {
    keyword: true;
    catalog: boolean;
    semantic: boolean;
  };
  warnings: string[];
  search_counts: {
    keyword_results: number;
    catalog_results: number;
    semantic_results: number;
    merged_results: number;
  };
  results: KnowledgeSubstrateSearchEntry[];
  citations: Array<{
    id: string;
    result_id: string;
    kind: KnowledgeSubstrateSearchEntry["kind"];
    source_uri: string | null;
    source_ref: string | null;
    artifact_uri: string | null;
    artifact_path: string | null;
    revision: string | null;
    hash: string | null;
    chunk_id: string | null;
    start_offset: number | null;
    end_offset: number | null;
    quote: string | null;
  }>;
  excerpts: Array<{
    id: string;
    result_id: string;
    citation_id: string | null;
    kind: KnowledgeSubstrateSearchEntry["kind"];
    text: string;
    score: number;
  }>;
  notes: {
    permissions: string[];
    freshness: string[];
    stability: string[];
  };
}

export interface KnowledgeSubstrateAdapterResult {
  ok: true;
  stored: false;
  context_pack: KnowledgeSubstrateContextPack;
  message: string;
}

export interface KnowledgeSubstrateAdapter {
  readonly name: "open-knowledge-compatible";
  readonly write_enabled: false;
  toContextPack(pack: V2ContextPack): KnowledgeSubstrateContextPack;
  putContextPack(pack: V2ContextPack): Promise<KnowledgeSubstrateAdapterResult>;
}

export function createKnowledgeSubstrateAdapterBoundary(): KnowledgeSubstrateAdapter {
  return {
    name: "open-knowledge-compatible",
    write_enabled: false,
    toContextPack: toKnowledgeSubstrateContextPack,
    async putContextPack(pack: V2ContextPack): Promise<KnowledgeSubstrateAdapterResult> {
      return {
        ok: true,
        stored: false,
        context_pack: toKnowledgeSubstrateContextPack(pack),
        message: "Open Context v2 produced an open-knowledge-compatible context pack; no open-knowledge write adapter is configured.",
      };
    },
  };
}

export function toKnowledgeSubstrateContextPack(pack: V2ContextPack): KnowledgeSubstrateContextPack {
  const results = pack.evidence.map(toSearchEntry);
  return {
    query: pack.query,
    normalized_query: pack.intent.normalized_query,
    created_at: pack.created_at,
    mode: {
      keyword: true,
      catalog: pack.evidence.some((item) => item.channel === "api" || item.channel === "kg"),
      semantic: pack.evidence.some((item) => item.channel === "vector"),
    },
    warnings: pack.warnings,
    search_counts: {
      keyword_results: pack.evidence.filter((item) => item.channel === "fts").length,
      catalog_results: pack.evidence.filter((item) => item.channel === "api" || item.channel === "kg").length,
      semantic_results: pack.evidence.filter((item) => item.channel === "vector").length,
      merged_results: pack.evidence.length,
    },
    results,
    citations: pack.citations.map(toSubstrateCitation),
    excerpts: pack.evidence.map((item) => {
      const citation = pack.citations.find((entry) => entry.evidence_id === item.evidence_id);
      return {
        id: `excerpt_${item.evidence_id}`,
        result_id: item.evidence_id,
        citation_id: citation?.id ?? null,
        kind: resultKind(item),
        text: item.text,
        score: item.score,
      };
    }),
    notes: {
      permissions: ["Public documentation evidence is treated as read-only."],
      freshness: pack.freshness.warnings.length > 0 ? pack.freshness.warnings : [`Freshness state: ${pack.freshness.state}`],
      stability: ["Evidence order is deterministic unless a caller supplies a rerank hook."],
    },
  };
}

function toSearchEntry(item: V2RetrievalEvidence): KnowledgeSubstrateSearchEntry {
  const citation = item.citation;
  return {
    kind: resultKind(item),
    id: item.evidence_id,
    title: item.title,
    text: item.text,
    score: item.score,
    scores: item.scores,
    source: citation ? {
      uri: citation.source_url,
      ref: citation.source_url,
      kind: citation.source_type,
      revision: citation.source_revision,
      hash: citation.source_hash,
    } : null,
    citation: citation ? {
      chunk_id: citation.chunk_id,
      start_offset: citation.start_offset,
      end_offset: citation.end_offset,
    } : null,
    artifact: citation ? {
      uri: citation.artifact_uri,
      path: citation.artifact_path,
      hash: citation.source_hash,
      shard_key: citation.artifact_path,
    } : null,
    provenance: citation ? {
      source_owner: "open-context",
      source_ref: citation.source_url,
      source_uri: citation.source_url,
      source_kind: citation.source_type,
      source_revision_id: citation.source_revision_id,
      revision: citation.source_revision,
      hash: citation.source_hash,
      chunk_id: citation.chunk_id,
      start_offset: citation.start_offset,
      end_offset: citation.end_offset,
      read_only: true,
      citation_required: true,
      stale: false,
    } : null,
    reasons: item.reasons,
  };
}

function toSubstrateCitation(citation: V2ContextCitation): KnowledgeSubstrateContextPack["citations"][number] {
  return {
    id: citation.id,
    result_id: citation.evidence_id,
    kind: citation.endpoint_id ? "api_endpoint" : "source_chunk",
    source_uri: citation.source_url,
    source_ref: citation.source_url,
    artifact_uri: citation.artifact_uri,
    artifact_path: citation.artifact_path,
    revision: citation.source_revision,
    hash: citation.source_hash,
    chunk_id: citation.chunk_id,
    start_offset: citation.start_offset,
    end_offset: citation.end_offset,
    quote: citation.quote,
  };
}

function resultKind(item: V2RetrievalEvidence): KnowledgeSubstrateSearchEntry["kind"] {
  if (item.kind === "api_endpoint") return "api_endpoint";
  if (item.kind === "knowledge_graph") return "knowledge_graph";
  return "source_chunk";
}
