import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";

export type AiProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "mistral"
  | "cohere"
  | "groq"
  | "perplexity"
  | "togetherai";

export interface AiProviderConfig {
  id: AiProviderId;
  name: string;
  packageName: string;
  env: string[];
  defaultModel: string;
  docsUrl: string;
}

export interface AiProviderStatus extends AiProviderConfig {
  configured: boolean;
  activeEnv: string | null;
}

export const AI_PROVIDER_CONFIGS: readonly AiProviderConfig[] = [
  {
    id: "xai",
    name: "xAI",
    packageName: "@ai-sdk/xai",
    env: ["XAI_API_KEY"],
    defaultModel: "grok-4.3",
    docsUrl: "https://docs.x.ai/overview",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    packageName: "@ai-sdk/deepseek",
    env: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-chat",
    docsUrl: "https://api-docs.deepseek.com/",
  },
  {
    id: "openai",
    name: "OpenAI",
    packageName: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.2",
    docsUrl: "https://platform.openai.com/docs",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    packageName: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
    docsUrl: "https://docs.anthropic.com/",
  },
  {
    id: "google",
    name: "Google Gemini",
    packageName: "@ai-sdk/google",
    env: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-3-pro",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    packageName: "@ai-sdk/mistral",
    env: ["MISTRAL_API_KEY"],
    defaultModel: "mistral-large-latest",
    docsUrl: "https://docs.mistral.ai/",
  },
  {
    id: "cohere",
    name: "Cohere",
    packageName: "@ai-sdk/cohere",
    env: ["COHERE_API_KEY"],
    defaultModel: "command-a-03-2025",
    docsUrl: "https://docs.cohere.com/",
  },
  {
    id: "groq",
    name: "Groq",
    packageName: "@ai-sdk/groq",
    env: ["GROQ_API_KEY"],
    defaultModel: "openai/gpt-oss-120b",
    docsUrl: "https://console.groq.com/docs/overview",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    packageName: "@ai-sdk/perplexity",
    env: ["PERPLEXITY_API_KEY"],
    defaultModel: "sonar",
    docsUrl: "https://docs.perplexity.ai/docs/getting-started/overview",
  },
  {
    id: "togetherai",
    name: "Together AI",
    packageName: "@ai-sdk/togetherai",
    env: ["TOGETHER_API_KEY"],
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    docsUrl: "https://docs.together.ai/intro",
  },
];

export function getAiProviderStatuses(): AiProviderStatus[] {
  return AI_PROVIDER_CONFIGS.map((config) => {
    const activeEnv = getActiveEnv(config.env);
    return {
      ...config,
      configured: Boolean(activeEnv),
      activeEnv,
    };
  });
}

export function getAiProviderConfig(providerId: AiProviderId): AiProviderConfig {
  const config = AI_PROVIDER_CONFIGS.find((item) => item.id === providerId);
  if (!config) throw new Error(`Unknown AI provider: ${providerId}`);
  return config;
}

export function getDefaultAiProvider(): AiProviderId | null {
  const explicit = process.env["CONTEXT_AI_PROVIDER"]?.trim() as AiProviderId | undefined;
  if (explicit) return explicit;
  return getAiProviderStatuses().find((provider) => provider.configured)?.id ?? null;
}

export async function generateWithAiSdk(input: {
  prompt: string;
  provider?: AiProviderId;
  model?: string;
  system?: string;
}): Promise<{ provider: AiProviderId; model: string; text: string }> {
  const provider = input.provider ?? getDefaultAiProvider();
  if (!provider) {
    throw new Error(
      "No AI provider configured. Set CONTEXT_AI_PROVIDER and a provider API key such as XAI_API_KEY or DEEPSEEK_API_KEY."
    );
  }

  const config = getAiProviderConfig(provider);
  const model = input.model ?? process.env["CONTEXT_AI_MODEL"] ?? config.defaultModel;
  const { text } = await generateText({
    model: createLanguageModel(provider, model),
    system: input.system,
    prompt: input.prompt,
  });

  return { provider, model, text };
}

export function createLanguageModel(provider: AiProviderId, model: string): LanguageModel {
  const apiKey = getProviderApiKey(provider);

  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(model);
    case "xai":
      return createXai({ apiKey })(model);
    case "deepseek":
      return createDeepSeek({ apiKey })(model);
    case "mistral":
      return createMistral({ apiKey })(model);
    case "cohere":
      return createCohere({ apiKey })(model);
    case "groq":
      return createGroq({ apiKey })(model);
    case "perplexity":
      return createPerplexity({ apiKey })(model);
    case "togetherai":
      return createTogetherAI({ apiKey })(model);
  }
}

function getProviderApiKey(provider: AiProviderId): string {
  const config = getAiProviderConfig(provider);
  const activeEnv = getActiveEnv(config.env);
  if (!activeEnv) {
    throw new Error(`${config.name} requires one of: ${config.env.join(", ")}`);
  }
  return process.env[activeEnv]!;
}

function getActiveEnv(names: readonly string[]): string | null {
  for (const name of names) {
    if (process.env[name]?.trim()) return name;
  }
  return null;
}
