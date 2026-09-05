import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next.js exited early:\n${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next.js did not become ready:\n${output.join("")}`);
}

test("serves the site and persists consented locations with the Node runtime", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "wangs-node-test-"));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const output = [];
  const articleSyncSecret = "test-article-sync-secret-with-enough-entropy";
  const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ADMIN_PASSWORD: "test-admin-password",
      ADMIN_SESSION_SECRET: "test-session-secret-with-enough-entropy",
      ARTICLE_SYNC_SECRET: articleSyncSecret,
      ARTICLE_SYNC_ALLOW_PRIVATE: "true",
      LOCATION_DB_PATH: path.join(runtimeDirectory, "locations.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(runtimeDirectory, { recursive: true, force: true });
  });

  const home = await waitForServer(origin, child, output);
  assert.match(await home.text(), /<main class="home-page/);

  const locationResponse = await fetch(`${origin}/api/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "integration-test-device",
      city: "上海市",
      address: "上海市测试路 1 号",
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy: 25,
      consent: true,
    }),
  });
  assert.equal(locationResponse.status, 204);

  const loginResponse = await fetch(`${origin}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-admin-password" }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const locationsResponse = await fetch(`${origin}/api/admin/locations`, {
    headers: { Cookie: cookie },
  });
  assert.equal(locationsResponse.status, 200);
  const payload = await locationsResponse.json();
  assert.equal(payload.locations.length, 1);
  assert.equal(payload.locations[0].city, "上海市");
  assert.equal(payload.locations[0].deviceId, "integration-test-device");

  const unauthorizedSync = await fetch(`${origin}/api/article-sync`, { method: "POST" });
  assert.equal(unauthorizedSync.status, 401);

  const draftResponse = await fetch(`${origin}/api/admin/articles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: "远端同步测试文章",
      summary: "验证文章与图片同步",
      content: "<p>同步测试正文</p>",
      status: "draft",
    }),
  });
  assert.equal(draftResponse.status, 201);
  const draftPayload = await draftResponse.json();
  const articleId = draftPayload.article.id;
  const sourceImageDirectory = path.join(projectRoot, "public", "article-images", articleId);
  const uploadedImageDirectory = path.join(projectRoot, "public", "uploads", "articles", articleId);
  const sourceImagePath = path.join(sourceImageDirectory, "test.png");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await mkdir(sourceImageDirectory, { recursive: true });
  await writeFile(sourceImagePath, imageBytes);
  t.after(async () => {
    await rm(sourceImageDirectory, { recursive: true, force: true });
    await rm(uploadedImageDirectory, { recursive: true, force: true });
  });

  const sourceUrl = `/article-images/${articleId}/test.png`;
  const publishResponse = await fetch(`${origin}/api/admin/articles/${articleId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: "远端同步测试文章",
      summary: "验证文章与图片同步",
      content: `<p>同步测试正文</p><img src="${sourceUrl}" alt="同步图片">`,
      status: "published",
    }),
  });
  assert.equal(publishResponse.status, 200);
  const publishPayload = await publishResponse.json();
  assert.equal(publishPayload.remoteSync, undefined);

  const manualSyncResponse = await fetch(`${origin}/api/admin/articles/${articleId}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ remoteServer: origin }),
  });
  assert.equal(manualSyncResponse.status, 200);
  const manualSyncPayload = await manualSyncResponse.json();
  assert.equal(manualSyncPayload.remoteSync.status, "synced");
  assert.equal(manualSyncPayload.remoteSync.uploadedImageCount, 1);
  assert.equal(manualSyncPayload.remoteSync.articleUrl, `${origin}/articles/${articleId}`);

  const publishedPage = await fetch(`${origin}/articles/${articleId}`);
  assert.equal(publishedPage.status, 200);
  assert.match(await publishedPage.text(), new RegExp(`/uploads/articles/${articleId}/[a-f0-9]{24}\\.png`));
});
