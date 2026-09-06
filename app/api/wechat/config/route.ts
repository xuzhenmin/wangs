import { getWechatConfig, wechatConfigured, WechatShareError } from "../../../../lib/wechat-share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!wechatConfigured()) return Response.json({ enabled: false }, { headers });
  try {
    return Response.json(await getWechatConfig(new URL(request.url).searchParams.get("url")), { headers });
  } catch (error) {
    if (error instanceof WechatShareError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return Response.json({ error: "configuration_error", message: "微信分享配置不可用，请检查服务端配置。" }, { status: 503, headers });
  }
}
