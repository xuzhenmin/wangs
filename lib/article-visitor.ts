import { createHash, randomUUID } from "node:crypto";

const COOKIE_NAME = "shenxiang_article_visitor";
const MAX_AGE = 30 * 24 * 60 * 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Analytics-only identity. Never use this cookie to grant location consent,
// authenticate an account, or identify a physical device/person.
export function articleVisitor(request: Request) {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
  const attributes = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") {
    return { visitorKey: null, cookie: `${COOKIE_NAME}=; ${attributes}; Max-Age=0` };
  }
  const value = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  const existing = value && uuid.test(value) ? value.toLowerCase() : null;
  const token = existing || randomUUID();
  return {
    // Store only a one-way derivative; admin records never expose the cookie.
    visitorKey: createHash("sha256").update(`article-visitor-v1:${token}`).digest("hex"),
    cookie: existing ? null : `${COOKIE_NAME}=${token}; ${attributes}; Max-Age=${MAX_AGE}`,
  };
}
