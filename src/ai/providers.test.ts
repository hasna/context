import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getAiProviderStatuses,
  getDefaultAiProvider,
} from "./providers.js";

const ENV_NAMES = [
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "GROQ_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "CONTEXT_AI_PROVIDER",
] as const;

const oldEnv = new Map<string, string | undefined>();

beforeEach(() => {
  oldEnv.clear();
  for (const name of ENV_NAMES) {
    oldEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("AI SDK provider status", () => {
  it("reports providers without requiring API keys", () => {
    const statuses = getAiProviderStatuses();

    expect(statuses.length).toBeGreaterThan(5);
    expect(statuses.some((provider) => provider.id === "xai")).toBe(true);
    expect(statuses.some((provider) => provider.id === "deepseek")).toBe(true);
    expect(statuses.every((provider) => provider.configured === false)).toBe(true);
  });

  it("selects the first configured provider by env", () => {
    process.env["DEEPSEEK_API_KEY"] = "test-key";

    expect(getDefaultAiProvider()).toBe("deepseek");
    expect(getAiProviderStatuses().find((provider) => provider.id === "deepseek")?.activeEnv)
      .toBe("DEEPSEEK_API_KEY");
  });
});
