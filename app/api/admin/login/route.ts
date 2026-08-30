import { adminSessionCookie, createAdminSession, verifyAdminPassword } from "../../../../lib/admin-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { password?: string };
    if (!body.password || !(await verifyAdminPassword(body.password))) {
      return Response.json({ error: "invalid-credentials" }, { status: 401 });
    }
    const token = await createAdminSession();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": adminSessionCookie(token, request), "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "admin-login-unavailable" }, { status: 500 });
  }
}
