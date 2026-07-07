import type { Command } from "commander";
import chalk from "chalk";
import {
  addWebhookEndpoint,
  emitWebhookEvent,
  listWebhookDeliveries,
  listWebhookEndpoints,
  removeWebhookEndpoint,
} from "../db/webhooks.js";
import { DEFAULT_LIST_LIMIT, parseLimit, takeWithMore, truncateText } from "./format.js";

function parseEvents(value?: string): string[] | undefined {
  return value?.split(",").map((event) => event.trim()).filter(Boolean);
}

export function registerWebhookCommands(program: Command): void {
  const webhooks = program
    .command("webhooks")
    .description("Manage docs update webhooks");

  webhooks
    .command("list")
    .description("List webhook endpoints")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const endpoints = listWebhookEndpoints();
      if (opts.json) {
        console.log(JSON.stringify(endpoints, null, 2));
        return;
      }
      if (endpoints.length === 0) {
        console.log(chalk.gray("No webhook endpoints configured."));
        return;
      }
      console.log(chalk.bold("\nWebhook Endpoints\n"));
      for (const endpoint of endpoints) {
        console.log(`  ${chalk.cyan(endpoint.id)} ${endpoint.active ? chalk.green("active") : chalk.gray("inactive")}`);
        console.log(`    url: ${endpoint.url}`);
        console.log(`    events: ${endpoint.events.join(", ") || "all"}`);
      }
      console.log(chalk.gray("\nUse --json for raw endpoint records."));
      console.log();
    });

  webhooks
    .command("add <url>")
    .description("Add or update a webhook endpoint")
    .option("-e, --events <events>", "Comma-separated event names", "docs.refreshed,docs.refresh_failed")
    .option("--inactive", "Register endpoint as inactive")
    .option("--json", "Output as JSON")
    .action((url: string, opts: { events?: string; inactive?: boolean; json?: boolean }) => {
      const endpoint = addWebhookEndpoint({
        url,
        events: parseEvents(opts.events),
        active: !opts.inactive,
      });
      if (opts.json) {
        console.log(JSON.stringify(endpoint, null, 2));
        return;
      }
      console.log(chalk.green(`✓ Webhook configured: ${endpoint.url}`));
    });

  webhooks
    .command("remove <id>")
    .description("Remove a webhook endpoint")
    .action((id: string) => {
      removeWebhookEndpoint(id);
      console.log(chalk.green(`✓ Removed webhook ${id}`));
    });

  webhooks
    .command("deliveries")
    .description("List webhook deliveries")
    .option("-n, --limit <n>", "Max deliveries to show", String(DEFAULT_LIST_LIMIT))
    .option("--json", "Output as JSON")
    .action((opts: { limit?: string; json?: boolean }) => {
      const deliveries = listWebhookDeliveries();
      if (opts.json) {
        console.log(JSON.stringify(deliveries, null, 2));
        return;
      }
      if (deliveries.length === 0) {
        console.log(chalk.gray("No webhook deliveries."));
        return;
      }
      console.log(chalk.bold("\nWebhook Deliveries\n"));
      const limit = parseLimit(opts.limit);
      const { visible, remaining } = takeWithMore(deliveries, limit);
      for (const delivery of visible) {
        console.log(`  ${chalk.cyan(delivery.id)} ${chalk.gray(`[${delivery.status}]`)} ${delivery.event}`);
        if (delivery.response_status) console.log(`    response: ${delivery.response_status}`);
        if (delivery.error) console.log(`    error: ${truncateText(delivery.error, 160)}`);
      }
      if (remaining > 0) console.log(chalk.gray(`\n  ...${remaining} more delivery record(s). Use --limit ${deliveries.length} to show all.`));
      console.log(chalk.gray("Use --json for raw delivery records."));
      console.log();
    });

  webhooks
    .command("test <event>")
    .description("Send a test webhook event to matching endpoints")
    .option("--json", "Output as JSON")
    .action(async (event: string, opts: { json?: boolean }) => {
      const deliveries = await emitWebhookEvent(event, {
        test: true,
        emitted_by: "context webhooks test",
      });
      if (opts.json) {
        console.log(JSON.stringify(deliveries, null, 2));
        return;
      }
      console.log(chalk.green(`✓ Created ${deliveries.length} webhook deliver${deliveries.length === 1 ? "y" : "ies"}`));
    });
}
