import { verifyAdminRequest } from "../../../../../../lib/admin-auth";
import { getImageImportTask } from "../../../../../../lib/image-import";

const TASK_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const { taskId } = await context.params;
  if (!TASK_ID_PATTERN.test(taskId)) {
    return Response.json({ error: "invalid-task-id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const task = getImageImportTask(taskId);
    if (!task) return Response.json({ error: "image-import-task-not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return Response.json({ task }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "image-import-task-read-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
