import { clearAdminSessionCookie } from "../../../../lib/admin-auth";

export async function POST(request: Request) {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearAdminSessionCookie(request), "Cache-Control": "no-store" } });
}
