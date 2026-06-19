import type { Command } from "commander";
import chalk from "chalk";
import {
  generateWithAiSdk,
  getAiProviderStatuses,
  type AiProviderId,
} from "../ai/providers.js";
import { askDocs, buildDocsContext } from "../ai/docs-context.js";

export function registerAiCommands(program: Command): void {
  program.command("build <prompt>")
    .description("Build a read-only documentation context pack for a prompt")
    .option("-l, --library <slug>", "Limit context to one library")
    .option("--doc-version <version>", "Require a specific indexed library version")
    .option("-n, --limit <n>", "Maximum documentation chunks", "5")
    .option("--endpoint-limit <n>", "Maximum API endpoints", "5")
    .option("--tokens <n>", "Approximate context token budget", "5000")
    .option("--json", "Output as JSON")
    .action((prompt: string, opts: {
      library?: string;
      docVersion?: string;
      limit?: string;
      endpointLimit?: string;
      tokens?: string;
      json?: boolean;
    }) => {
      try {
        const context = buildDocsContext({
          prompt,
          library: opts.library,
          version: opts.docVersion,
          limit: parsePositiveInt(opts.limit) ?? 5,
          endpointLimit: parsePositiveInt(opts.endpointLimit) ?? 5,
          maxTokens: parsePositiveInt(opts.tokens) ?? 5000,
        });
        if (opts.json) {
          console.log(JSON.stringify(context, null, 2));
          return;
        }
        console.log(context.context_text);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  program.command("ask <prompt>")
    .description("Answer a prompt using indexed documentation context and AI SDK generation")
    .option("-l, --library <slug>", "Limit context to one library")
    .option("--doc-version <version>", "Require a specific indexed library version")
    .option("-n, --limit <n>", "Maximum documentation chunks", "5")
    .option("--endpoint-limit <n>", "Maximum API endpoints", "5")
    .option("--tokens <n>", "Approximate context token budget", "5000")
    .option("-b, --backend <id>", "AI SDK backend id")
    .option("-m, --model <model>", "Model id")
    .option("--system <prompt>", "System prompt")
    .option("--json", "Output as JSON")
    .action(async (prompt: string, opts: {
      library?: string;
      docVersion?: string;
      limit?: string;
      endpointLimit?: string;
      tokens?: string;
      backend?: string;
      model?: string;
      system?: string;
      json?: boolean;
    }) => {
      try {
        const result = await askDocs({
          prompt,
          library: opts.library,
          version: opts.docVersion,
          limit: parsePositiveInt(opts.limit) ?? 5,
          endpointLimit: parsePositiveInt(opts.endpointLimit) ?? 5,
          maxTokens: parsePositiveInt(opts.tokens) ?? 5000,
          provider: opts.backend as AiProviderId | undefined,
          model: opts.model,
          system: opts.system,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.gray(`${result.provider}/${result.model}`));
        console.log(chalk.gray(`context: ${result.context.chunks.length} chunk(s), ${result.context.endpoints.length} endpoint(s), ~${result.context.estimated_tokens} tokens\n`));
        console.log(result.text);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  const ai = program
    .command("ai")
    .description("Inspect and use configured AI SDK generation backends");

  ai.command("status")
    .description("Show AI SDK setup and API key availability")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const statuses = getAiProviderStatuses();
      if (opts.json) {
        console.log(JSON.stringify(statuses, null, 2));
        return;
      }

      console.log(chalk.bold("\nAI SDK Generation\n"));
      for (const provider of statuses) {
        const status = provider.configured ? chalk.green("configured") : chalk.gray("missing key");
        console.log(`  ${chalk.bold(provider.name)} ${chalk.gray(`(${provider.packageName})`)} - ${status}`);
        console.log(`    id: ${provider.id}`);
        console.log(`    default model: ${provider.defaultModel}`);
        console.log(`    env: ${provider.env.join(", ")}`);
      }
      console.log();
    });

  ai.command("generate <prompt>")
    .description("Generate text with the configured AI SDK backend")
    .option("-b, --backend <id>", "AI SDK backend id")
    .option("-m, --model <model>", "Model id")
    .option("--system <prompt>", "System prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        prompt: string,
        opts: { backend?: string; model?: string; system?: string; json?: boolean }
      ) => {
        try {
          const result = await generateWithAiSdk({
            prompt,
            provider: opts.backend as AiProviderId | undefined,
            model: opts.model,
            system: opts.system,
          });

          if (opts.json) {
            console.log(JSON.stringify({ backend: result.provider, model: result.model, text: result.text }, null, 2));
            return;
          }

          console.log(chalk.gray(`${result.provider}/${result.model}\n`));
          console.log(result.text);
        } catch (error) {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }
    );
}

function parsePositiveInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
