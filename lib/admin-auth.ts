import { env } from "cloudflare:workers";

const encoder = new TextEncoder();
const SESSION_COOKIE = "shenxiang_admin_session";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

function getRuntimeSecret(name: "ADMIN_PASSWORD" | "ADMIN_SESSION_SECRET") {
  const workerEnv = env as unknown as Record<string, unknown>;
  const workerValue = workerEnv[name];
  if (typeof workerValue === "string" && workerValue) return workerValue;
  const processValue = process.env[name];
  if (processValue) return processValue;
  throw new Error(`${name} is not configured`);
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function sign(payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getRuntimeSecret("ADMIN_SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function verifyAdminPassword(candidate: string) {
  const [candidateDigest, expectedDigest] = await Promise.all([
    digest(candidate),
    digest(getRuntimeSecret("ADMIN_PASSWORD")),
  ]);
  return constantTimeEqual(candidateDigest, expectedDigest);
}

export async function createAdminSession() {
  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  const payload = String(expiresAt);
  return `${payload}.${await sign(payload)}`;
}

export async function verifyAdminRequest(request: Request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const token = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return false;
  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature || Number(expiresAt) <= Date.now()) return false;
  const expected = await sign(expiresAt);
  return constantTimeEqual(encoder.encode(signature), encoder.encode(expected));
}

export function adminSessionCookie(token: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`;
}

export function clearAdminSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}
