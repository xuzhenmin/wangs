import { verifyAdminRequest } from "../../../../lib/admin-auth";
import { listActiveLocations } from "../../../../lib/locations";

export async function GET(request: Request) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const locations = await listActiveLocations();
    return Response.json({ locations }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "location-read-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
