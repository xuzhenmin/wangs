const VIDEO_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/video\.mp4$/;

export function ossArticleVideoObjectPrefix() {
  const value = process.env.OSS_ARTICLE_VIDEO_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "article-videos";
  return value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/.test(value) ? value : null;
}

function publicHostname(host: string) {
  if (!host || host.includes(":") || host.startsWith("[") || host === "localhost" || /\.(?:localhost|local|internal)$/.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 2)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  return host.includes(".") && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes("..");
}

export function ossArticleVideoBaseUrl() {
  const prefix = ossArticleVideoObjectPrefix();
  if (!prefix) return null;
  const configured = process.env.OSS_PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      if (/[\\%\s]/.test(configured) || /\/(?:\.|\.\.)(?:\/|$)/.test(configured)) return null;
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || !publicHostname(url.hostname)) return null;
      if (url.pathname.includes("//")) return null;
      return `${url.toString().replace(/\/+$/, "")}/${prefix}`;
    } catch { return null; }
  }
  const bucket = process.env.OSS_BUCKET?.trim();
  return bucket && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    ? `https://${bucket}.oss-accelerate.aliyuncs.com/${prefix}` : null;
}

// Videos are reusable between articles, but only this deployment's permanent OSS MP4 namespace is accepted.
export function isOssArticleVideoSource(source: string) {
  const base = ossArticleVideoBaseUrl();
  return !!base && source.startsWith(`${base}/`) && VIDEO_ID.test(source.slice(base.length + 1));
}
