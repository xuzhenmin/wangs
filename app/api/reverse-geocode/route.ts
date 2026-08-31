const AMAP_TIMEOUT_MS = 8000;
const DEBUG_LOCATION_LOGS = process.env.LOCATION_DEBUG_LOGS === "true";

type AmapResponse = {
  status?: string;
  info?: string;
  infocode?: string;
};

type AmapCoordinateResponse = AmapResponse & {
  locations?: string;
};

type AmapReverseGeocodeResponse = AmapResponse & {
  regeocode?: {
    formatted_address?: string;
    addressComponent?: {
      province?: string;
      city?: string | string[];
      district?: string;
      township?: string;
    };
  };
};

function debugLocationLog(event: string, details: Record<string, unknown>) {
  if (!DEBUG_LOCATION_LOGS) return;
  console.info(`[location-server] ${event} ${JSON.stringify({ timestamp: new Date().toISOString(), ...details })}`);
}

function amapUrl(path: string, params: Record<string, string>, key: string) {
  const searchParams = new URLSearchParams({ ...params, key });
  return `https://restapi.amap.com${path}?${searchParams.toString()}`;
}

async function requestAmap<T extends AmapResponse>(
  path: string,
  params: Record<string, string>,
  key: string,
  stage: "coordinate-conversion" | "reverse-geocoding",
  requestId: string,
) {
  const startedAt = performance.now();
  const response = await fetch(amapUrl(path, params, key), {
    cache: "no-store",
    signal: AbortSignal.timeout(AMAP_TIMEOUT_MS),
  });
  const result = await response.json() as T;
  const durationMs = Math.round(performance.now() - startedAt);
  debugLocationLog("amap_response", {
    requestId,
    stage,
    httpStatus: response.status,
    status: result.status,
    info: result.info,
    infocode: result.infocode,
    durationMs,
  });
  if (!response.ok || result.status !== "1") {
    throw new Error(`amap-${stage}-failed:${result.infocode || response.status}:${result.info || "unknown"}`);
  }
  return result;
}

function cityName(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const requestStartedAt = performance.now();
  let requestId = crypto.randomUUID();
  try {
    const body = await request.json() as Record<string, unknown>;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (typeof body.requestId === "string") requestId = body.requestId.slice(0, 100);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return Response.json({ error: "invalid-coordinates" }, { status: 400 });
    }

    const key = process.env.AMAP_WEB_SERVICE_KEY?.trim();
    if (!key) {
      debugLocationLog("amap_configuration_missing", { requestId });
      return Response.json({ error: "amap-key-not-configured" }, { status: 503 });
    }

    debugLocationLog("amap_reverse_geocode_started", { requestId, latitude, longitude });
    const originalLocation = `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
    const converted = await requestAmap<AmapCoordinateResponse>(
      "/v3/assistant/coordinate/convert",
      { locations: originalLocation, coordsys: "gps", output: "json" },
      key,
      "coordinate-conversion",
      requestId,
    );
    if (!converted.locations) throw new Error("amap-coordinate-conversion-empty");

    const reverse = await requestAmap<AmapReverseGeocodeResponse>(
      "/v3/geocode/regeo",
      { location: converted.locations, extensions: "base", radius: "1000", output: "json" },
      key,
      "reverse-geocoding",
      requestId,
    );
    const regeocode = reverse.regeocode;
    const component = regeocode?.addressComponent;
    const address = regeocode?.formatted_address?.trim();
    if (!address || !component) throw new Error("amap-reverse-geocoding-empty");

    const city = cityName(component.city) || component.province || component.district || "";
    debugLocationLog("amap_reverse_geocode_succeeded", {
      requestId,
      city,
      address,
      durationMs: Math.round(performance.now() - requestStartedAt),
    });
    return Response.json({
      display_name: address,
      address: {
        city,
        municipality: component.province || "",
        town: component.township || "",
        county: component.district || "",
        state: component.province || "",
      },
      provider: "amap",
    });
  } catch (error) {
    const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    debugLocationLog("amap_reverse_geocode_failed", {
      requestId,
      error: description,
      durationMs: Math.round(performance.now() - requestStartedAt),
    });
    return Response.json({ error: "reverse-geocoding-failed", detail: description }, { status: 502 });
  }
}
