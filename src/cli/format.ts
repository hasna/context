export function formatDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export const DEFAULT_LIST_LIMIT = 20;
export const DEFAULT_SEARCH_PREVIEW_CHARS = 180;

export function parseLimit(value: string | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function truncateText(value: string | null | undefined, max = DEFAULT_SEARCH_PREVIEW_CHARS): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function takeWithMore<T>(items: T[], limit = DEFAULT_LIST_LIMIT): { visible: T[]; remaining: number } {
  const visible = items.slice(0, limit);
  return { visible, remaining: Math.max(0, items.length - visible.length) };
}
