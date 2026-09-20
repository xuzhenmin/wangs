/** Client-safe fragment handling. A share code is a bearer secret, not article metadata. */
export const ARTICLE_VIDEO_SHARE_PARAMETER = "video-access";
export const PRIVATE_VIDEO_ACCESS_EVENT = "private-video-access-changed";
const ARTICLE_PATH = /^\/articles\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/?$/;

export function articleIdFromPath(pathname: unknown): string | null {
  return typeof pathname === "string" && ARTICLE_PATH.test(pathname) ? pathname.replace(/\/$/, "").slice("/articles/".length) : null;
}

export function parseArticleVideoShareFragment(hash: unknown): { present: boolean; code: string | null } {
  if (typeof hash !== "string") return { present: false, code: null };
  const match = /^#video-access=([A-Za-z0-9_-]{32})$/.exec(hash);
  if (match) return { present: true, code: match[1] };
  return { present: /(?:^#|&)video-access(?:=|&|$)/.test(hash), code: null };
}

/** Preserve only a same-origin, same-article named fragment. Never send a code to a different canonical host. */
export function articleVideoShareLink(canonicalLink: string, currentHref: string): string {
  const current = new URL(currentHref), canonical = new URL(canonicalLink, current.origin);
  canonical.hash = "";
  const fragment = parseArticleVideoShareFragment(current.hash);
  if (fragment.code && ["http:", "https:"].includes(canonical.protocol) &&
      canonical.origin === current.origin && ARTICLE_PATH.test(current.pathname) &&
      canonical.pathname.replace(/\/$/, "") === current.pathname.replace(/\/$/, "")) {
    canonical.hash = `${ARTICLE_VIDEO_SHARE_PARAMETER}=${fragment.code}`;
  }
  return canonical.href;
}
