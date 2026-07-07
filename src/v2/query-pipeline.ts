import { createHash } from "crypto";
import type { Database } from "../db/database.js";
import { createV1ContextHubStorage } from "./storage.js";
import type {
  BuildV2ContextPackOptions,
  ContextHubStorage,
  V2CitationVerificationResult,
  V2ContextCitation,
  V2ContextPack,
  V2FreshnessStatus,
  V2PipelineStep,
  V2QueryIntent,
  V2QueryPlan,
  V2ResolvedLibrary,
  V2RetrievalEvidence,
  V2SynthesisResult,
} from "./types.js";

export async function buildV2ContextPack(
  options: BuildV2ContextPackOptions,
  db?: Database
): Promise<V2ContextPack> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("A prompt is required to build a v2 context pack.");

  const storage = options.storage ?? createV1ContextHubStorage(db);
  const createdAt = new Date().toISOString();
  const baseIntent = createQueryIntent(prompt, options, createdAt);
  const plannedIntent = options.hooks?.planIntent
    ? { ...baseIntent, ...(await options.hooks.planIntent(baseIntent)) }
    : baseIntent;
  const intent = normalizeIntent(plannedIntent, baseIntent);
  const resolvedLibrary = await storage.resolveLibrary(options.library, options.version ?? intent.requested_version);
  const freshness = await storage.getFreshness(resolvedLibrary);
  const plan = createPlan(storage, intent, options);
  const warnings = freshnessWarnings(intent, resolvedLibrary, freshness);

  const evidence = await retrieveEvidence({
    prompt,
    intent,
    storage,
    resolvedLibrary,
    options,
  });
  const reranked = options.hooks?.rerankEvidence
    ? await options.hooks.rerankEvidence({ intent, evidence })
    : rankEvidence(evidence);
  const selectedEvidence = dedupeEvidence(reranked);
  const citations = selectedEvidence.flatMap((item, index) => item.citation
    ? [{ ...item.citation, id: stableId("cite", `${item.evidence_id}:${index}`), evidence_id: item.evidence_id }]
    : []
  );

  const contextText = formatContextText({
    prompt,
    intent,
    resolvedLibrary,
    freshness,
    evidence: selectedEvidence,
    citations,
    warnings,
    maxTokens: normalizePositiveInt(options.maxTokens, 5000),
  });
  let pack: V2ContextPack = {
    schema_version: 2,
    query: prompt,
    intent,
    resolved_library: resolvedLibrary,
    freshness,
    plan,
    evidence: selectedEvidence,
    citations,
    context_text: contextText,
    estimated_tokens: estimateTokens(contextText),
    synthesis: notRunSynthesis(),
    citation_verification: defaultCitationVerification(citations),
    warnings,
    created_at: createdAt,
  };

  if (options.hooks?.synthesize) {
    pack = { ...pack, synthesis: await options.hooks.synthesize(pack) };
  }
  if (options.hooks?.verifyCitations) {
    pack = { ...pack, citation_verification: await options.hooks.verifyCitations(pack) };
  }

  return pack;
}

function createQueryIntent(
  prompt: string,
  options: BuildV2ContextPackOptions,
  generatedAt: string
): V2QueryIntent {
  const normalized = normalizeQuery(prompt);
  return {
    original_query: prompt,
    normalized_query: normalized,
    requested_library: options.library ?? libraryMention(prompt),
    requested_version: options.version ?? versionMention(prompt),
    wants_latest: /\b(latest|current|recent|new|newest|today)\b/i.test(prompt),
    needs_api: /\b(api|endpoint|openapi|sdk|stream|schema|request|response|integrat)/i.test(prompt),
    needs_examples: /\b(example|sample|how do i|how to|integrat|quickstart|snippet)\b/i.test(prompt),
    terms: queryTerms(normalized),
    generated_at: generatedAt,
  };
}

function normalizeIntent(intent: V2QueryIntent, fallback: V2QueryIntent): V2QueryIntent {
  return {
    ...fallback,
    ...intent,
    original_query: fallback.original_query,
    normalized_query: normalizeQuery(intent.normalized_query || fallback.original_query),
    terms: intent.terms.length > 0 ? intent.terms : fallback.terms,
  };
}

function createPlan(
  storage: ContextHubStorage,
  intent: V2QueryIntent,
  options: BuildV2ContextPackOptions
): V2QueryPlan {
  const vectorLimit = normalizePositiveInt(options.vectorLimit, 0);
  const endpointLimit = normalizePositiveInt(options.endpointLimit, 5);
  const kgLimit = normalizePositiveInt(options.kgLimit, 5);
  const vectorEnabled = Boolean(storage.searchVector && vectorLimit > 0);
  const steps: V2PipelineStep[] = [
    {
      id: "query_intent",
      label: "Query intent",
      status: "completed",
      detail: intent.needs_api ? "API-oriented query intent detected." : "General documentation query intent detected.",
    },
    {
      id: "library_resolution",
      label: "Library and version resolution",
      status: options.library ? "completed" : "skipped",
      detail: options.library ? `Requested library: ${options.library}` : "No library filter requested.",
    },
    {
      id: "freshness_gate",
      label: "Freshness gate",
      status: "completed",
      detail: "Freshness is evaluated before synthesis.",
    },
    {
      id: "fts_retrieval",
      label: "FTS retrieval",
      status: "completed",
      detail: "Search existing v1 documentation chunks.",
    },
    {
      id: "vector_retrieval",
      label: "Vector retrieval",
      status: vectorEnabled ? "completed" : "skipped",
      detail: vectorEnabled ? "Use configured vector search adapter." : "No vector adapter was configured for this context pack.",
    },
    {
      id: "api_retrieval",
      label: "API endpoint retrieval",
      status: endpointLimit > 0 ? "completed" : "skipped",
      detail: endpointLimit > 0 ? "Search indexed API endpoint/schema rows." : "Endpoint retrieval disabled by limit.",
    },
    {
      id: "kg_retrieval",
      label: "Knowledge graph retrieval",
      status: kgLimit > 0 ? "completed" : "skipped",
      detail: kgLimit > 0 ? "Search local KG nodes as navigational evidence." : "KG retrieval disabled by limit.",
    },
    {
      id: "citation_pack",
      label: "Citation context pack",
      status: "completed",
      detail: "Assemble exact excerpts and citation metadata before synthesis.",
    },
  ];

  return {
    deterministic: true,
    steps,
    retrieval: {
      fts: true,
      vector: vectorEnabled,
      api: endpointLimit > 0,
      kg: kgLimit > 0,
    },
  };
}

async function retrieveEvidence(input: {
  prompt: string;
  intent: V2QueryIntent;
  storage: ContextHubStorage;
  resolvedLibrary: V2ResolvedLibrary | null;
  options: BuildV2ContextPackOptions;
}): Promise<V2RetrievalEvidence[]> {
  const libraryId = input.resolvedLibrary?.id;
  const textLimit = normalizePositiveInt(input.options.limit, 5);
  const endpointLimit = normalizePositiveInt(input.options.endpointLimit, 5);
  const kgLimit = normalizePositiveInt(input.options.kgLimit, 5);
  const vectorLimit = normalizePositiveInt(input.options.vectorLimit, 0);
  const evidence: V2RetrievalEvidence[] = [];

  evidence.push(...await input.storage.searchText({
    query: input.prompt,
    library_id: libraryId,
    limit: textLimit,
  }));

  if (input.storage.searchVector && vectorLimit > 0) {
    evidence.push(...await input.storage.searchVector({
      query: input.prompt,
      library_id: libraryId,
      limit: vectorLimit,
    }));
  }

  if (endpointLimit > 0) {
    evidence.push(...await input.storage.searchApiEndpoints({
      query: input.prompt,
      library_id: libraryId,
      limit: endpointLimit,
      fallback_to_library_endpoints: input.intent.needs_api,
    }));
  }

  if (kgLimit > 0) {
    evidence.push(...await input.storage.searchKnowledgeGraph({
      query: input.prompt,
      library_id: libraryId,
      limit: kgLimit,
    }));
  }

  return evidence;
}

function rankEvidence(evidence: V2RetrievalEvidence[]): V2RetrievalEvidence[] {
  return [...evidence].sort((a, b) =>
    b.score - a.score ||
    channelPriority(a.channel) - channelPriority(b.channel) ||
    a.evidence_id.localeCompare(b.evidence_id)
  );
}

function channelPriority(channel: V2RetrievalEvidence["channel"]): number {
  switch (channel) {
    case "api":
      return 0;
    case "fts":
      return 1;
    case "vector":
      return 2;
    case "kg":
      return 3;
  }
}

function dedupeEvidence(evidence: V2RetrievalEvidence[]): V2RetrievalEvidence[] {
  const seen = new Set<string>();
  const selected: V2RetrievalEvidence[] = [];
  for (const item of evidence) {
    const key = [
      item.kind,
      item.citation?.source_url,
      item.citation?.chunk_id,
      item.citation?.endpoint_id,
      item.text.slice(0, 160),
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
  }
  return selected;
}

function freshnessWarnings(
  intent: V2QueryIntent,
  library: V2ResolvedLibrary | null,
  freshness: V2FreshnessStatus
): string[] {
  const warnings = [...freshness.warnings];
  if (intent.wants_latest && freshness.state !== "fresh") {
    warnings.push(
      library
        ? `The query asks for latest/current information, but ${library.name} freshness is ${freshness.state}. Refresh before relying on this context for recency-sensitive claims.`
        : "The query asks for latest/current information, but no library was selected for freshness evaluation."
    );
  }
  return warnings;
}

function formatContextText(input: {
  prompt: string;
  intent: V2QueryIntent;
  resolvedLibrary: V2ResolvedLibrary | null;
  freshness: V2FreshnessStatus;
  evidence: V2RetrievalEvidence[];
  citations: V2ContextCitation[];
  warnings: string[];
  maxTokens: number;
}): string {
  const lines = [
    "# Open Context v2 Context Pack",
    "",
    `Query: ${input.prompt}`,
    `Intent: ${input.intent.needs_api ? "api" : "docs"}${input.intent.wants_latest ? ", latest" : ""}`,
  ];

  if (input.resolvedLibrary) {
    lines.push(`Library: ${input.resolvedLibrary.name} (/context/${input.resolvedLibrary.slug})`);
    if (input.resolvedLibrary.version) lines.push(`Version: ${input.resolvedLibrary.version}`);
    lines.push(`Source type: ${input.resolvedLibrary.source_type}`);
  }

  lines.push(`Freshness: ${input.freshness.state}`);
  if (input.freshness.last_refreshed_at) lines.push(`Last refreshed: ${input.freshness.last_refreshed_at}`);
  if (input.freshness.next_check_at) lines.push(`Next check: ${input.freshness.next_check_at}`);
  if (input.warnings.length > 0) {
    lines.push("", "## Warnings");
    for (const warning of input.warnings) lines.push(`- ${warning}`);
  }

  lines.push("", "## Evidence");
  if (input.evidence.length === 0) {
    lines.push("No matching cited evidence was found.");
  }

  let usedTokens = estimateTokens(lines.join("\n"));
  for (const item of input.evidence) {
    const citation = input.citations.find((entry) => entry.evidence_id === item.evidence_id);
    const block = evidenceBlock(item, citation);
    const blockTokens = estimateTokens(block);
    if (usedTokens + blockTokens > input.maxTokens) {
      lines.push("", `[context truncated at ${input.maxTokens} tokens]`);
      break;
    }
    lines.push("", block);
    usedTokens += blockTokens;
  }

  lines.push("", "## Synthesis Policy");
  lines.push("Use only the cited evidence above. If evidence is missing, stale, or navigational-only, say what is missing.");
  return lines.join("\n").trim();
}

function evidenceBlock(item: V2RetrievalEvidence, citation: V2ContextCitation | undefined): string {
  const lines = [
    `### [${item.evidence_id}] ${item.title ?? item.kind}`,
    `Channel: ${item.channel}`,
    `Score: ${item.score}`,
  ];
  if (item.library) lines.push(`Library: ${item.library.name} (/context/${item.library.slug})`);
  if (citation?.source_url) lines.push(`Source: ${citation.source_url}`);
  if (citation) {
    lines.push(`Citation: ${citation.id}`);
    if (citation.source_hash) lines.push(`Source hash: ${citation.source_hash}`);
    if (citation.chunk_id) lines.push(`Chunk: ${citation.chunk_id}`);
    if (citation.endpoint_id) lines.push(`Endpoint: ${citation.endpoint_id}`);
  } else {
    lines.push("Citation: none (navigational evidence only)");
  }
  if (item.api_endpoint) {
    lines.push(`API: ${item.api_endpoint.method} ${item.api_endpoint.path}`);
    if (item.api_endpoint.operation_id) lines.push(`Operation: ${item.api_endpoint.operation_id}`);
  }
  lines.push("", item.text.trim());
  return lines.join("\n").trim();
}

function defaultCitationVerification(citations: V2ContextCitation[]): V2CitationVerificationResult {
  return {
    verified: citations.length > 0,
    checked_at: new Date().toISOString(),
    missing_citations: [],
    warnings: citations.length > 0 ? [] : ["No citations were available for this context pack."],
  };
}

function notRunSynthesis(): V2SynthesisResult {
  return {
    status: "not_run",
    text: null,
    cited_evidence_ids: [],
    warnings: ["Synthesis hook was not configured; returning cited context only."],
    provider: null,
    model: null,
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function queryTerms(query: string): string[] {
  return Array.from(new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])).slice(0, 16);
}

function libraryMention(prompt: string): string | null {
  const match = prompt.match(/\/context\/([a-z0-9._-]+)/i);
  return match?.[1] ?? null;
}

function versionMention(prompt: string): string | null {
  const match = prompt.match(/(?:version|v|@)\s*([0-9]+(?:\.[0-9]+){0,3})/i);
  return match?.[1] ?? null;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}
