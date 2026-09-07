import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

test("anonymous visitor cookies, PV/UV, protected details and historical schema upgrade", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "wangs-visitor-test-"));
  const databasePath = path.join(directory, "test.sqlite");
  const first = crypto.randomUUID(), second = crypto.randomUUID(), draft = crypto.randomUUID(), historical = crypto.randomUUID();
  const seed = new DatabaseSync(databasePath);
  seed.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT, summary TEXT, content TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE article_view_events (id TEXT PRIMARY KEY, article_id TEXT, visited_at INTEGER);`);
  for (const [id, title, status] of [[first, "匿名访客统计测试", "published"], [second, "跨文章去重测试", "published"], [draft, "草稿测试", "draft"]]) {
    seed.prepare("INSERT INTO articles VALUES (?, ?, '', '<p>隔离测试文章</p>', ?, 1000, 2000)").run(id, title, status);
  }
  seed.prepare("INSERT INTO article_view_events VALUES (?, ?, 1000)").run(historical, first);
  seed.close();
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, LOCATION_DB_PATH: databasePath, ADMIN_PASSWORD: "visitor-fixture-password", ADMIN_SESSION_SECRET: "visitor-fixture-session-secret" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const report = (id = first, cookie = "", eventId = crypto.randomUUID(), extra = {}) => fetch(`${origin}/api/articles/${id}/view`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...extra }, body: JSON.stringify({ eventId }),
  });
  for (const id of [draft, crypto.randomUUID()]) {
    const response = await report(id); assert.equal(response.status, 404); assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal((await report(first, "", "bad-id")).status, 400);
  assert.equal((await report(first, "", crypto.randomUUID(), { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const event = crypto.randomUUID();
  const firstVisit = await report(first, "", event);
  assert.equal(firstVisit.status, 200);
  assert.equal(firstVisit.headers.get("cache-control"), "no-store");
  const cookieHeader = firstVisit.headers.get("set-cookie");
  assert.match(cookieHeader, /^shenxiang_article_visitor=[0-9a-f-]{36};/);
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Lax/); assert.match(cookieHeader, /Max-Age=2592000/);
  assert.doesNotMatch(cookieHeader, /Domain=|Secure/);
  const cookieA = cookieHeader.split(";")[0];
  const repeated = await report(first, cookieA, event);
  assert.equal(repeated.status, 200); assert.equal(repeated.headers.get("set-cookie"), null);
  assert.equal((await report(first, cookieA)).status, 200);
  const secondVisit = await report();
  assert.equal(secondVisit.status, 200);
  const cookieB = secondVisit.headers.get("set-cookie").split(";")[0];
  assert.notEqual(cookieA, cookieB);
  assert.equal((await report(second, cookieA)).status, 200);
  const privateVisit = await report(first, cookieA, crypto.randomUUID(), { DNT: "1" });
  assert.equal(privateVisit.status, 200); assert.match(privateVisit.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(`${origin}/api/admin/articles/${first}/visitors`)).status, 401);
  assert.equal((await fetch(`${origin}/api/admin/articles/${first}/visitors`, { headers: { Cookie: cookieA } })).status, 401, "Visitor cookie never authenticates an admin");
  const login = await fetch(`${origin}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "visitor-fixture-password" }) });
  const admin = login.headers.get("set-cookie").split(";")[0];
  const get = async url => {
    const response = await fetch(origin + url, { headers: { Cookie: admin } }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); return response.json();
  };
  const list = await get("/api/admin/articles/list?sort=visitors");
  const firstArticle = list.articles.find(a => a.id === first), secondArticle = list.articles.find(a => a.id === second);
  assert.equal(firstArticle.viewCount, 5); assert.equal(firstArticle.visitorCount, 2);
  assert.equal(secondArticle.viewCount, 1); assert.equal(secondArticle.visitorCount, 1);
  assert.equal(list.stats.views, 6); assert.equal(list.stats.visitors, 2, "Global UV deduplicates across articles");
  const details = await get(`/api/admin/articles/${first}/visitors`);
  assert.equal(details.viewCount, 5); assert.equal(details.total, 2); assert.equal(details.unidentifiedViews, 2);
  assert.deepEqual(details.visitors.map(v => v.viewCount).sort(), [1, 2]);
  const secondDetails = await get(`/api/admin/articles/${second}/visitors`);
  assert.equal(secondDetails.visitors[0].visitorKey, details.visitors.find(v => v.viewCount === 2).visitorKey);
  for (const visitor of details.visitors) {
    assert.match(visitor.visitorKey, /^[a-f0-9]{64}$/);
    assert.ok(visitor.firstViewedAt <= visitor.lastViewedAt);
    assert.deepEqual(Object.keys(visitor).sort(), ["firstViewedAt", "lastViewedAt", "viewCount", "visitorKey"]);
  }
  assert.equal(JSON.stringify(details).includes(cookieA.split("=")[1]), false);
  const audit = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(audit.prepare("SELECT visitor_key FROM article_view_events WHERE id = ?").get(historical).visitor_key, null);
  assert.equal(audit.prepare("SELECT COUNT(*) AS total FROM consented_locations").get().total, 0);
  audit.close();
  const unlimited = await fetch(`${origin}/api/admin/articles/${first}/access`, {
    method: "PUT", headers: { Cookie: admin, "Content-Type": "application/json" },
    body: JSON.stringify({ remainingUv: null, remainingPv: null, revision: 0 }),
  });
  assert.equal(unlimited.status, 200);
  for (let i = 0; i < 21; i++) assert.equal((await report()).status, 200);
  const page1 = await get(`/api/admin/articles/${first}/visitors?page=-1`);
  const page2 = await get(`/api/admin/articles/${first}/visitors?page=999`);
  assert.equal(page1.total, 23); assert.equal(page1.page, 1); assert.equal(page1.visitors.length, 20);
  assert.equal(page2.page, 2); assert.equal(page2.visitors.length, 3);
  assert.equal(new Set([...page1.visitors, ...page2.visitors].map(v => v.visitorKey)).size, 23);
  assert.equal((await fetch(`${origin}/api/admin/articles/${crypto.randomUUID()}/visitors`, { headers: { Cookie: admin } })).status, 404);
  const malformed = await report(first, "shenxiang_article_visitor=invalid", crypto.randomUUID(), { "x-forwarded-proto": "https" });
  assert.match(malformed.headers.get("set-cookie"), /; Secure/);
  const gpc = await report(first, cookieB, crypto.randomUUID(), { "Sec-GPC": "1" });
  assert.match(gpc.headers.get("set-cookie"), /Max-Age=0/);
  if (process.env.ARTICLE_VISITORS_UI_REVIEW === "1") {
    console.log(`Visitor UI fixture: http://localhost:${port}/ops-7q4m/articles`);
    console.log("Fixture-only password: visitor-fixture-password. Press Enter to clean up.");
    process.stdin.resume(); await new Promise(resolve => process.stdin.once("data", resolve)); process.stdin.pause();
  }
});
