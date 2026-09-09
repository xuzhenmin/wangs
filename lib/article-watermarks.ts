import { createHash } from "node:crypto";
import { open, mkdir, readFile, realpath, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { load } from "cheerio";
import { MAX_IMAGES_PER_ARTICLE } from "./article-image-limits";
import { createColorTemplate, validateSettings, validateWatermarkTemplate } from "../scripts/watermark-engine.mjs";

export type WatermarkExtractionColor = "yellow" | "black";
export type WatermarkSettings = {
  template: string;
  extractionColor?: WatermarkExtractionColor;
  relativeWidth: number;
  mode: "inpaint" | "inverse";
  search: "bottom-right" | "all";
  threshold: number;
  opacity: number;
  padding: number;
};
export type WatermarkResult = {
  status: "processed" | "skipped" | "failed";
  source: string;
  localUrl?: string;
  confidence?: number;
  reason: string;
  region?: { x: number; y: number; width: number; height: number };
  repairedPixels?: number;
  platformWatermark?: {
    text: string;
    opacity: number;
    transparencyPercent: number;
    style: "plain";
    position: "bottom-right";
    region: { x: number; y: number; width: number; height: number };
  };
};
const root = () => /* turbopackIgnore: true */ process.cwd();
const templateDirectory = () => process.env.WATERMARK_TEMPLATE_DIR || path.join(root(), "data", "watermark-templates");
export const ARTICLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_NAME = /^[0-9a-f]{24}\.(png|jpe?g|webp)$/i;

export function checkedRawSource(articleId: string, source: string) {
  const prefix = `/uploads/articles/${articleId}/`;
  if (!ARTICLE_ID.test(articleId) || !source.startsWith(prefix) || !IMAGE_NAME.test(source.slice(prefix.length))) throw new Error("仅支持当前文章的本地静态原图。外链/Blob 请先导入；已处理图片、OSS 图片不会重复处理。");
  return path.join(root(), "public", "uploads", "articles", articleId, source.slice(prefix.length));
}

export async function readRawSource(articleId: string, source: string) {
  const filename = checkedRawSource(articleId, source);
  // Do not follow an imported file or article directory symlink outside its storage root.
  const actual = await realpath(filename);
  const base = path.join(await realpath(path.join(root(), "public", "uploads", "articles")), articleId) + path.sep;
  if (!actual.startsWith(base)) throw new Error("图片存储路径无效。");
  const handle = await open(actual, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > 8 * 1024 * 1024) throw new Error("原图为空或超过 8 MB。");
    return await handle.readFile();
  } finally { await handle.close(); }
}

export function validateArticleImages(content: string, source: string) {
  if (content.length > 200_000) throw new Error("正文过长。");
  const $ = load(content, null, false);
  const images = $("img").toArray();
  if (images.length > MAX_IMAGES_PER_ARTICLE) throw new Error(`当前正文有 ${images.length} 张图片，每篇文章最多处理 ${MAX_IMAGES_PER_ARTICLE} 张。`);
  if (!images.some(img => $(img).attr("src")?.trim() === source)) throw new Error("图片不在当前正文中。");
}

function templateBytes(settings: WatermarkSettings) {
  validateSettings(settings);
  if (typeof settings.template !== "string" || settings.template.length > 1_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(settings.template)) throw new Error("水印模板无效或超过 1 MB。");
  const bytes = Buffer.from(settings.template, "base64");
  if (bytes.length > 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("请提供不超过 1 MB 的透明 PNG 水印模板。");
  return bytes;
}

export async function getWatermarkTemplate(): Promise<WatermarkSettings | null> {
  try { return JSON.parse(await readFile(path.join(templateDirectory(), "default.json"), "utf8")); }
  catch { return null; }
}

export async function saveWatermarkTemplate(settings: WatermarkSettings) {
  await validateWatermarkTemplate(templateBytes(settings));
  await mkdir(templateDirectory(), { recursive: true });
  const temporary = path.join(templateDirectory(), `${crypto.randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
  await rename(temporary, path.join(templateDirectory(), "default.json"));
  return settings;
}

export async function calibrateColorTemplate(articleId: string, source: string, region: number[], color: WatermarkExtractionColor = "yellow") {
  if (processing) throw new WatermarkBusyError("已有图片正在处理，请稍后再试。");
  processing = true;
  try {
    const input = await readRawSource(articleId, source);
    const settings = await createColorTemplate(input, region, color) as WatermarkSettings;
    return await saveWatermarkTemplate(settings);
  } finally { processing = false; }
}

let processing = false;
export class WatermarkBusyError extends Error {}

export async function processArticleWatermark(articleId: string, source: string, settings: WatermarkSettings, signal: AbortSignal): Promise<WatermarkResult> {
  const template = templateBytes(settings);
  if (processing) throw new WatermarkBusyError("已有图片正在处理，请稍后再试。");
  processing = true;
  try {
    const input = await readRawSource(articleId, source);
    if (signal.aborted) throw new Error("处理已取消。");
    const result = await new Promise<WatermarkResult & { bytes?: Uint8Array }>((resolve, reject) => {
      // This is a deployed Node script, not a bundled worker entry. Keep the
      // absolute runtime path out of Turbopack's relative module lookup map.
      const worker = new Worker(/* turbopackIgnore: true */ path.join(root(), "scripts", "watermark-worker.mjs"), {
        workerData: { input, template, settings },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
      });
      let settled = false;
      const finish = (error?: Error, value?: WatermarkResult & { bytes?: Uint8Array }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        // Keep the concurrency slot until the worker has actually terminated.
        void worker.terminate().finally(() => error ? reject(error) : resolve(value!));
      };
      const abort = () => finish(new Error("处理已取消。"));
      const timer = setTimeout(() => finish(new Error("单张图片处理超过 45 秒，已停止；请缩小原图或搜索范围。")), 45_000);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", value => finish(undefined, value));
      worker.once("error", () => finish(new Error("图片处理进程失败，请检查内存和 scripts/watermark-worker.mjs 是否已部署。")));
      worker.once("exit", () => { if (!settled) finish(new Error("图片处理进程提前结束。")); });
      if (signal.aborted) abort();
    });
    if (result.status !== "processed" || !result.bytes) return { ...result, source };
    const bytes = Buffer.from(result.bytes);
    const outputHash = createHash("sha256").update(bytes).digest("hex");
    const filename = `${outputHash.slice(0, 24)}.png`;
    const directory = path.join(root(), "public", "article-images", articleId);
    const localUrl = `/article-images/${articleId}/${filename}`;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), bytes);
    const { bytes: _bytes, ...report } = result;
    void _bytes;
    const manifestDirectory = path.join(root(), "data", "watermark-manifests", articleId);
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(path.join(manifestDirectory, `${outputHash.slice(0, 24)}.json`), JSON.stringify({
      ...report, version: 2, algorithm: "template-chroma-ncc+inverse-alpha+harmonic-inpaint+shenxiang-brand-v1", articleId, source, localUrl,
      sourceHash: createHash("sha256").update(input).digest("hex"), outputHash,
      templateHash: createHash("sha256").update(template).digest("hex"), settings: { ...settings, template: undefined },
      createdAt: new Date().toISOString(),
    }, null, 2));
    return { ...report, source, localUrl };
  } finally { processing = false; }
}
