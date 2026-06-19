import type { Command } from "commander";
import chalk from "chalk";
import {
  addWebhookEndpoint,
  emitWebhookEvent,
  listWebhookDeliveries,
  listWebhookEndpoints,
  removeWebhookEndpoint,
} from "../db/webhooks.js";

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
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
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
      for (const delivery of deliveries.slice(0, 50)) {
        console.log(`  ${chalk.cyan(delivery.id)} ${chalk.gray(`[${delivery.status}]`)} ${delivery.event}`);
        if (delivery.response_status) console.log(`    response: ${delivery.response_status}`);
        if (delivery.error) console.log(`    error: ${delivery.error.slice(0, 160)}`);
      }
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
