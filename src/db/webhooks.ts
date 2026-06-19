import { randomUUID } from "crypto";
import type { Database } from "./database.js";
import { getDatabase } from "./database.js";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  response_status: number | null;
  error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export function addWebhookEndpoint(
  input: { url: string; events?: string[]; active?: boolean },
  db?: Database
): WebhookEndpoint {
  const database = db ?? getDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  database.run(
    `INSERT INTO webhook_endpoints (id, url, events, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       events = excluded.events,
       active = excluded.active,
       updated_at = excluded.updated_at`,
    [
      id,
      input.url,
      JSON.stringify(input.events ?? ["docs.refreshed", "docs.refresh_failed"]),
      input.active === false ? 0 : 1,
      now,
      now,
    ]
  );

  return getWebhookEndpointByUrl(input.url, database);
}

export function listWebhookEndpoints(db?: Database): WebhookEndpoint[] {
  const database = db ?? getDatabase();
  return (database.all("SELECT * FROM webhook_endpoints ORDER BY created_at ASC") as Record<string, unknown>[])
    .map(rowToEndpoint);
}

export function getWebhookEndpointByUrl(url: string, db?: Database): WebhookEndpoint {
  const database = db ?? getDatabase();
  const row = database.get(
    "SELECT * FROM webhook_endpoints WHERE url = ?",
    url
  ) as Record<string, unknown> | null;
  if (!row) throw new Error(`Webhook endpoint not found: ${url}`);
  return rowToEndpoint(row);
}

export function removeWebhookEndpoint(id: string, db?: Database): void {
  const database = db ?? getDatabase();
  database.run("DELETE FROM webhook_endpoints WHERE id = ?", [id]);
}

export async function emitWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
  db?: Database
): Promise<WebhookDelivery[]> {
  const database = db ?? getDatabase();
  const endpoints = listWebhookEndpoints(database)
    .filter((endpoint) => endpoint.active)
    .filter((endpoint) => endpoint.events.length === 0 || endpoint.events.includes(event));

  const deliveries: WebhookDelivery[] = [];
  for (const endpoint of endpoints) {
    const delivery = createWebhookDelivery(endpoint.id, event, payload, database);
    try {
      const response = await fetchWithTimeout(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          created_at: delivery.created_at,
          payload,
        }),
      });
      updateWebhookDelivery(delivery.id, {
        status: response.ok ? "delivered" : "failed",
        response_status: response.status,
        error: response.ok ? null : await response.text(),
      }, database);
    } catch (error) {
      updateWebhookDelivery(delivery.id, {
        status: "failed",
        response_status: null,
        error: error instanceof Error ? error.message : String(error),
      }, database);
    }
    deliveries.push(getWebhookDelivery(delivery.id, database));
  }
  return deliveries;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = getWebhookTimeoutMs();
  if (timeoutMs <= 0) return fetch(url, init);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Webhook delivery timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getWebhookTimeoutMs(): number {
  const value =
    process.env["CONTEXT_WEBHOOK_TIMEOUT_MS"] ??
    process.env["HASNA_CONTEXT_WEBHOOK_TIMEOUT_MS"];
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_WEBHOOK_TIMEOUT_MS;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

export function listWebhookDeliveries(db?: Database): WebhookDelivery[] {
  const database = db ?? getDatabase();
  return (database.all("SELECT * FROM webhook_deliveries ORDER BY created_at DESC") as Record<string, unknown>[])
    .map(rowToDelivery);
}

function createWebhookDelivery(
  endpointId: string,
  event: string,
  payload: Record<string, unknown>,
  db: Database
): WebhookDelivery {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [id, endpointId, event, JSON.stringify(payload), now]
  );
  return getWebhookDelivery(id, db);
}

function updateWebhookDelivery(
  id: string,
  input: { status: "delivered" | "failed"; response_status: number | null; error: string | null },
  db: Database
): void {
  db.run(
    `UPDATE webhook_deliveries SET
       status = ?,
       response_status = ?,
       error = ?,
       delivered_at = ?
     WHERE id = ?`,
    [
      input.status,
      input.response_status,
      input.error,
      new Date().toISOString(),
      id,
    ]
  );
}

function getWebhookDelivery(id: string, db: Database): WebhookDelivery {
  const row = db.get(
    "SELECT * FROM webhook_deliveries WHERE id = ?",
    id
  ) as Record<string, unknown> | null;
  if (!row) throw new Error(`Webhook delivery not found: ${id}`);
  return rowToDelivery(row);
}

function rowToEndpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row["id"] as string,
    url: row["url"] as string,
    events: parseStringArray(row["events"]),
    active: Boolean(row["active"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function rowToDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: row["id"] as string,
    endpoint_id: row["endpoint_id"] as string,
    event: row["event"] as string,
    payload: parseObject(row["payload"]),
    status: row["status"] as WebhookDelivery["status"],
    response_status: (row["response_status"] as number) ?? null,
    error: (row["error"] as string) ?? null,
    delivered_at: (row["delivered_at"] as string) ?? null,
    created_at: row["created_at"] as string,
  };
}

function parseStringArray(value: unknown): string[] {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
