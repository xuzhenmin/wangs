import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ articleId: string; filename: string }> }) {
  const { articleId, filename } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(articleId) || !/^[0-9a-f]{24}\.(png|jpe?g|webp|gif)$/i.test(filename)) return new Response("Not found", { status: 404 });
  try {
    const base = path.join(/* turbopackIgnore: true */ process.cwd(), "public", "article-images");
    const actual = await realpath(path.join(base, articleId, filename));
    if (!actual.startsWith(path.join(await realpath(base), articleId) + path.sep)) throw new Error("invalid-path");
    if ((await stat(actual)).size > 8 * 1024 * 1024) throw new Error("too-large");
    const bytes = await readFile(actual);
    const ext = path.extname(filename).toLowerCase();
    return new Response(bytes, { headers: { "Content-Type": ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : `image/${ext.slice(1)}`, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("Not found", { status: 404 }); }
}
