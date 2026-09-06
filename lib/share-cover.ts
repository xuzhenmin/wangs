import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Article } from "./articles";
import { isOssArticleImageSource } from "./article-image-urls";
import { firstShareImage } from "./share-metadata";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_COVER_BYTES = 100 * 1024;
type Cover = { bytes: Buffer; etag: string; fallback: boolean };
const cache = new Map<string, { cover: Cover; expiresAt: number }>();
const inFlight = new Map<string, Promise<Cover>>();

async function localBytes(source: string) {
  const root = await realpath(path.join(process.cwd(), "public"));
  const filename = await realpath(path.join(root, source));
  if (!filename.startsWith(root + path.sep)) throw new Error("Invalid cover path");
  if ((await stat(filename)).size > MAX_INPUT_BYTES) throw new Error("Cover source too large");
  return readFile(filename);
}

async function sourceBytes(source: string, articleId?: string) {
  if (source.startsWith("/")) return localBytes(source);
  if (!articleId || !isOssArticleImageSource(articleId, source)) throw new Error("Invalid cover source");
  // Only the configured current-article OSS URL is fetched; redirects are refused.
  const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/") || !response.body) throw new Error("Cover source unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INPUT_BYTES) throw new Error("Cover source too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

async function thumbnail(input?: Buffer) {
  const base = input
    ? sharp(input, { limitInputPixels: 20_000_000, animated: false }).rotate()
    : sharp({ create: { width: 480, height: 480, channels: 3, background: "#171717" } });
  const resized = base.resize(480, 480, { fit: "contain", background: "#171717" }).flatten({ background: "#171717" });
  for (const quality of [78, 60, 40, 25]) {
    const bytes = await resized.clone().jpeg({ quality, chromaSubsampling: "4:2:0" }).timeout({ seconds: 5 }).toBuffer();
    if (bytes.length <= MAX_COVER_BYTES) return bytes;
  }
  throw new Error("Cover exceeds size limit");
}

export async function getShareCover(article?: Article): Promise<Cover> {
  const source = article ? firstShareImage(article) : "/og.png";
  const key = `${article?.id || "site"}:${article?.updatedAt || 0}:${source}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.cover;
  if (inFlight.has(key)) return inFlight.get(key)!;
  if (inFlight.size >= 2) throw new Error("Cover renderer busy");
  const work = (async () => {
    let fallback = false;
    let bytes: Buffer;
    try { bytes = await thumbnail(await sourceBytes(source, article?.id)); } catch {
      fallback = true;
      try { bytes = await thumbnail(await localBytes("/og.png")); } catch { bytes = await thumbnail(); }
    }
    const cover = { bytes, fallback, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { cover, expiresAt: Date.now() + (fallback ? 60_000 : 600_000) });
    return cover;
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

export function coverResponse(request: Request, cover: Cover) {
  const headers = {
    "Content-Type": "image/jpeg",
    "Cache-Control": `public, max-age=${cover.fallback ? 60 : 300}`,
    "X-Content-Type-Options": "nosniff",
    ETag: cover.etag,
  };
  if (request.headers.get("if-none-match") === cover.etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(cover.bytes), { headers });
}
