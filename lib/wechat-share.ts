import { createHash, randomBytes } from "node:crypto";
import { siteOrigin } from "./share-metadata";

export class WechatShareError extends Error {
  constructor(public code: string, message: string, public status = 503) {
    super(message);
  }
}

export function wechatConfigured() {
  return Boolean(process.env.WECHAT_APP_ID?.trim() && process.env.WECHAT_APP_SECRET?.trim());
}

// Preserve the exact query/escaping: WeChat signs the URL before '#'.
export function validateWechatUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) throw new WechatShareError("invalid_url", "分享页面地址无效。", 400);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new WechatShareError("invalid_url", "分享页面地址无效。", 400); }
  if (parsed.origin !== siteOrigin() || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new WechatShareError("invalid_origin", "分享页面必须使用 NEXT_PUBLIC_SITE_URL 配置的 HTTPS 域名。", 400);
  }
  return value.split("#", 1)[0];
}

export function signWechatUrl(ticket: string, url: string, nonceStr: string, timestamp: number) {
  return createHash("sha1").update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`).digest("hex");
}

type Credential = { value: string; expiresAt: number };
let accountKey = "";
let token: Credential | undefined;
let ticket: Credential | undefined;
let pending: Promise<string> | undefined;
let lastFailure: { error: WechatShareError; until: number } | undefined;

async function wechatJson(url: string, init?: RequestInit) {
  let data: Record<string, unknown>;
  try {
    const response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("upstream-http-error");
    data = await response.json();
    if (!data || typeof data !== "object") throw new Error("invalid-response");
  } catch {
    // Never return/log a fetch error containing a token URL or request credentials.
    throw new WechatShareError("wechat_unavailable", "微信接口暂时不可用，请稍后重试。");
  }
  if (data.errcode) {
    const code = typeof data.errcode === "number" ? data.errcode : 0;
    const hint = code === 40164 ? "请检查公众号服务器 IP 白名单。"
      : code === 40013 || code === 40125 ? "请检查公众号 AppID 和 AppSecret。"
      : code === 48001 ? "请检查公众号的 JS-SDK 分享接口权限。" : "请检查公众号配置或稍后重试。";
    throw new WechatShareError(`wechat_${code}`, `微信接口错误 ${code}：${hint}`);
  }
  return data;
}

function credential(data: Record<string, unknown>, name: string): Credential {
  if (typeof data[name] !== "string" || !data[name] || typeof data.expires_in !== "number" || data.expires_in <= 0) {
    throw new WechatShareError("invalid_credentials_response", "微信未返回有效的签名凭据。");
  }
  return { value: data[name], expiresAt: Date.now() + Math.max(1, data.expires_in - 300) * 1000 };
}

async function getTicket(appId: string, secret: string) {
  const key = createHash("sha256").update(`${appId}:${secret}`).digest("hex");
  if (key !== accountKey) {
    accountKey = key;
    token = ticket = undefined;
    pending = undefined;
    lastFailure = undefined;
  }
  if (ticket && ticket.expiresAt > Date.now()) return ticket.value;
  if (lastFailure && lastFailure.until > Date.now()) throw lastFailure.error;
  if (pending) return pending;
  pending = (async () => {
    if (!token || token.expiresAt <= Date.now()) {
      token = credential(await wechatJson("https://api.weixin.qq.com/cgi-bin/stable_token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credential", appid: appId, secret, force_refresh: false }),
      }), "access_token");
    }
    try {
      ticket = credential(await wechatJson(`https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(token.value)}&type=jsapi`), "ticket");
    } catch (error) {
      if (error instanceof WechatShareError && ["wechat_40001", "wechat_40014", "wechat_42001"].includes(error.code)) token = undefined;
      throw error;
    }
    return ticket.value;
  })();
  try { return await pending; } catch (error) {
    if (error instanceof WechatShareError) lastFailure = { error, until: Date.now() + 30_000 };
    throw error;
  } finally { pending = undefined; }
}

export async function getWechatConfig(value: unknown) {
  const url = validateWechatUrl(value);
  const appId = process.env.WECHAT_APP_ID?.trim();
  const secret = process.env.WECHAT_APP_SECRET?.trim();
  if (!appId || !secret) return { enabled: false as const };
  const jsapiTicket = await getTicket(appId, secret);
  const nonceStr = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    enabled: true as const, appId, timestamp, nonceStr,
    signature: signWechatUrl(jsapiTicket, url, nonceStr, timestamp),
    jsApiList: ["updateAppMessageShareData", "updateTimelineShareData"],
  };
}
