import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { resetDatabase } from "./database.js";
import {
  addWebhookEndpoint,
  emitWebhookEvent,
  listWebhookDeliveries,
  listWebhookEndpoints,
  removeWebhookEndpoint,
} from "./webhooks.js";

let server: Server | null = null;
let oldWebhookTimeout: string | undefined;

beforeEach(() => {
  oldWebhookTimeout = process.env["CONTEXT_WEBHOOK_TIMEOUT_MS"];
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  resetDatabase();
  delete process.env["CONTEXT_DB_PATH"];
  if (oldWebhookTimeout === undefined) delete process.env["CONTEXT_WEBHOOK_TIMEOUT_MS"];
  else process.env["CONTEXT_WEBHOOK_TIMEOUT_MS"] = oldWebhookTimeout;
});

describe("webhook endpoints", () => {
  it("adds, updates, lists, and removes endpoints", () => {
    const endpoint = addWebhookEndpoint({
      url: "https://example.com/hooks/context",
      events: ["docs.refreshed"],
    });

    expect(endpoint.url).toBe("https://example.com/hooks/context");
    expect(endpoint.events).toEqual(["docs.refreshed"]);
    expect(endpoint.active).toBe(true);

    const updated = addWebhookEndpoint({
      url: "https://example.com/hooks/context",
      events: ["docs.refresh_failed"],
      active: false,
    });

    expect(updated.id).toBe(endpoint.id);
    expect(updated.events).toEqual(["docs.refresh_failed"]);
    expect(updated.active).toBe(false);

    expect(listWebhookEndpoints()).toHaveLength(1);
    removeWebhookEndpoint(endpoint.id);
    expect(listWebhookEndpoints()).toHaveLength(0);
    expect(listWebhookDeliveries()).toHaveLength(0);
  });

  it("times out a hanging endpoint and records a failed delivery", async () => {
    process.env["CONTEXT_WEBHOOK_TIMEOUT_MS"] = "25";
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => undefined);
      },
    });
    addWebhookEndpoint({
      url: `${server.url.origin}/hooks/context`,
      events: ["docs.refreshed"],
    });

    const startedAt = Date.now();
    const deliveries = await emitWebhookEvent("docs.refreshed", { ok: true });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.error).toContain("Webhook delivery timed out");
    expect(listWebhookDeliveries()[0]?.status).toBe("failed");
  });
});
