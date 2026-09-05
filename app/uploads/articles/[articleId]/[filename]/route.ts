import { readFile } from "node:fs/promises";
import path from "node:path";

const contentTypes: Record<string, string> = {
  gif: "image/gif",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ articleId: string; filename: string }> },
) {
  const { articleId, filename } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(articleId) || !/^[0-9a-f]{24}\.(png|jpg|gif|webp)$/.test(filename)) {
    return new Response("Not found", { status: 404 });
  }
  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  const imagePath = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "public",
    "uploads",
    "articles",
    articleId,
    filename,
  );
  try {
    const bytes = await readFile(imagePath);
    return new Response(bytes, {
      headers: {
        "Content-Type": contentTypes[extension],
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
