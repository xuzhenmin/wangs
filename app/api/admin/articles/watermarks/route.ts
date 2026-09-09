import { verifyAdminRequest } from "../../../../../lib/admin-auth";
import { articleExists } from "../../../../../lib/articles";
import { ARTICLE_ID, calibrateColorTemplate, getWatermarkTemplate, processArticleWatermark, saveWatermarkTemplate, validateArticleImages, WatermarkBusyError, type WatermarkSettings } from "../../../../../lib/article-watermarks";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!await verifyAdminRequest(request)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  return Response.json({ settings: await getWatermarkTemplate() }, { headers });
}

async function limitedJson(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("请求必须为 JSON。");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("请求内容为空。");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_800_000) { await reader.cancel(); throw new Error("请求过大，请缩小模板或正文。"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  if (!await verifyAdminRequest(request)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const origin = request.headers.get("origin");
    if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).host !== request.headers.get("host"))) return Response.json({ detail: "不允许跨站请求。" }, { status: 403, headers });
    const body = await limitedJson(request);
    if (body.authorized !== true) throw new Error("请确认有权处理这些图片的水印。");
    if (body.action === "save-template") return Response.json({ settings: await saveWatermarkTemplate(body.settings as WatermarkSettings) }, { headers });
    const articleId = typeof body.articleId === "string" ? body.articleId : "";
    const source = typeof body.source === "string" ? body.source : "";
    if (!ARTICLE_ID.test(articleId)) throw new Error("请先保存文档草稿。");
    if (!articleExists(articleId)) return Response.json({ detail: "文章不存在。" }, { status: 404, headers });
    if (typeof body.content !== "string") throw new Error("缺少当前正文。");
    validateArticleImages(body.content, source);
    if (body.action === "calibrate") {
      if (!Array.isArray(body.region)) throw new Error("缺少模板区域。");
      const color = body.color === undefined ? "yellow" : body.color;
      if (color !== "yellow" && color !== "black") throw new Error("提取颜色无效，请选择黄色或黑色。");
      return Response.json({ settings: await calibrateColorTemplate(articleId, source, body.region, color) }, { headers });
    }
    if (body.action !== "process") throw new Error("未知处理操作。");
    return Response.json(await processArticleWatermark(articleId, source, body.settings as WatermarkSettings, request.signal), { headers });
  } catch (error) {
    const busy = error instanceof WatermarkBusyError;
    const detail = error instanceof Error ? error.message : "图片处理失败。";
    return Response.json({ detail: /ENOENT/.test(detail) ? "找不到原图，请先导入图片。" : detail }, { status: busy ? 429 : 422, headers });
  }
}
