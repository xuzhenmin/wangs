import {
  ImageLocalizationError,
  MAX_IMAGES_PER_ARTICLE,
  storeArticleImageBytes,
} from "../../../../lib/article-images";
import {
  authorizeImageImportTask,
  ImageImportAuthorizationError,
  ImageImportValidationError,
  recordImageImportFailure,
  recordImportedImage,
} from "../../../../lib/image-import";

const TASK_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    if (!TASK_ID_PATTERN.test(taskId)) return json({ error: "invalid-task-id" }, 400);
    const form = await request.formData();
    const token = String(form.get("token") || "");
    const sourceUrl = String(form.get("sourceUrl") || "").trim();
    const totalImages = Number(form.get("totalImages"));
    const imageOrder = Number(form.get("imageOrder"));
    const altText = String(form.get("altText") || "");
    const task = authorizeImageImportTask(taskId, token);
    const reportedError = String(form.get("error") || "").trim();

    if (reportedError) {
      recordImageImportFailure({ taskId, token, sourceUrl, totalImages, imageOrder, altText, errorMessage: reportedError });
      return json({ accepted: true });
    }

    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      throw new ImageImportValidationError("没有收到图片文件。");
    }
    if (!/^blob:https?:\/\//i.test(sourceUrl) || sourceUrl.length > 2_048
      || !Number.isInteger(totalImages) || totalImages < 1 || totalImages > MAX_IMAGES_PER_ARTICLE
      || !Number.isInteger(imageOrder) || imageOrder < 0 || imageOrder >= totalImages) {
      throw new ImageImportValidationError("图片导入参数无效。");
    }
    const localUrl = await storeArticleImageBytes(task.articleId, new Uint8Array(await file.arrayBuffer()));
    recordImportedImage({ taskId, token, sourceUrl, localUrl, totalImages, imageOrder, altText });
    return json({ sourceUrl, localUrl });
  } catch (error) {
    if (error instanceof ImageImportAuthorizationError) return json({ error: "unauthorized-import", detail: error.message }, 401);
    if (error instanceof ImageImportValidationError || error instanceof ImageLocalizationError) {
      return json({ error: "invalid-image", detail: error.message }, 422);
    }
    return json({ error: "image-import-failed" }, 500);
  }
}
