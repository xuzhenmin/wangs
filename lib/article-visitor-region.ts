import { isIP } from "node:net";
import { after } from "next/server";
import { getDb } from "../db";

export type ArticleVisitorRegion = {
  province: string; city: string; source: "amap-ip"; resolvedAt: number;
};
type Region = Pick<ArticleVisitorRegion, "province" | "city">;
const MAX_CACHE_ENTRIES = 512;
const cache = new Map<string, { region: Region | null; expiresAt: number }>();
const pending = new Map<string, Promise<Region | null>>();

// Next's Request does not expose the TCP peer. Accept only the header selected
// by the deployment, where the trusted ingress must overwrite/append it and
// prevent clients from reaching Next directly. No inferred header fallback.
export function articleVisitorIp(headers: Headers): string | null {
  if (headers.get("dnt") === "1" || headers.get("sec-gpc") === "1") return null;
  const name = process.env.ARTICLE_VISITOR_IP_HEADER?.trim().toLowerCase();
  if (!name || !["x-real-ip", "cf-connecting-ip", "x-forwarded-for"].includes(name)) return null;
  const value = headers.get(name)?.trim();
  if (!value || value.length > 2048) return null;
  let ip = value;
  if (name === "x-forwarded-for") {
    const hops = Number(process.env.ARTICLE_VISITOR_PROXY_HOPS || "1");
    if (!Number.isSafeInteger(hops) || hops < 1 || hops > 10) return null;
    const chain = value.split(",").map(part => part.trim());
    if (chain.length < hops) return null;
    ip = chain[chain.length - hops];
  }
  // Amap's basic IP service supports IPv4 only. Never omit the ip parameter:
  // that would resolve the application server instead of the visitor.
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) !== 4) return null;
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)) return null;
  return ip;
}

async function lookup(ip: string, key: string): Promise<Region | null> {
  try {
    const params = new URLSearchParams({ key, ip, output: "json" });
    const response = await fetch(`https://restapi.amap.com/v3/ip?${params}`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { status?: unknown; province?: unknown; city?: unknown } | null;
    if (!body || body.status !== "1") return null;
    const name = (value: unknown) => typeof value === "string" && value.trim().length <= 100 ? value.trim() : "";
    const province = name(body.province), city = name(body.city);
    if (!province || province === "局域网" || province === "未知" || province === "[]") return null;
    return { province, city: city === "[]" ? "" : city };
  } catch {
    // Do not log request URLs: they contain both the API key and visitor IP.
    return null;
  }
}

async function cachedRegion(ip: string): Promise<Region | null> {
  const key = process.env.AMAP_WEB_SERVICE_KEY?.trim();
  if (!key) return null;
  const hit = cache.get(ip);
  if (hit && hit.expiresAt > Date.now()) return hit.region;
  cache.delete(ip);
  const running = pending.get(ip);
  if (running) return running;
  if (pending.size >= MAX_CACHE_ENTRIES) return null;
  const task = lookup(ip, key).then(region => {
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    // Short, bounded in-memory cache only; IPs are never persisted.
    cache.set(ip, { region, expiresAt: Date.now() + (region ? 10 * 60_000 : 60_000) });
    return region;
  }).finally(() => { pending.delete(ip); });
  pending.set(ip, task);
  return task;
}

export function scheduleArticleVisitorRegion(headers: Headers, eventId: string, visitorKey: string | null) {
  if (!visitorKey) return;
  const ip = articleVisitorIp(headers);
  if (!ip || !process.env.AMAP_WEB_SERVICE_KEY?.trim()) return;
  try {
    after(async () => {
      try {
        const region = await cachedRegion(ip);
        if (!region) return;
        getDb().prepare(`INSERT OR IGNORE INTO article_view_regions (event_id, province, city, source, resolved_at)
          SELECT id, ?, ?, 'amap-ip', ? FROM article_view_events WHERE id = ? AND visitor_key = ?`)
          .run(region.province, region.city, Date.now(), eventId, visitorKey);
      } catch { /* Optional enrichment must not affect article access or counting. */ }
    });
  } catch { /* An environment without after support still serves the article. */ }
}
