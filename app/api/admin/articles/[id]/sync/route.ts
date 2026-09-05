import { verifyAdminRequest } from "../../../../../../lib/admin-auth";
import { syncArticleToRemote } from "../../../../../../lib/article-sync";
import { getArticle } from "../../../../../../lib/articles";

const noStoreHeaders = { "Cache-Control": "no-store" };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStoreHeaders });
  }
  try {
    const { id } = await context.params;
    const article = getArticle(id);
    if (!article) return Response.json({ error: "article-not-found" }, { status: 404, headers: noStoreHeaders });
    if (article.status !== "published") {
      return Response.json({ error: "article-not-published", detail: "只有已发布文章才能上传到远端。" }, { status: 409, headers: noStoreHeaders });
    }
    const body = await request.json() as { remoteServer?: unknown };
    const remoteServer = typeof body.remoteServer === "string" ? body.remoteServer : "";
    const remoteSync = await syncArticleToRemote(article, remoteServer);
    return Response.json(
      { remoteSync },
      { status: remoteSync.status === "synced" ? 200 : 502, headers: noStoreHeaders },
    );
  } catch {
    return Response.json({ error: "article-sync-failed", detail: "远端同步请求处理失败。" }, { status: 500, headers: noStoreHeaders });
  }
}
