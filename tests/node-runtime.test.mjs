import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

async function availablePort() {
  const server = createTcpServer();
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
  const ossUploads = [];
  const ossFailedUploads = [];
  let rejectOssUploads = false;
  let holdNextOssUpload = null;
  const heldOssUploads = [];
  const ossServer = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      if (rejectOssUploads) {
        ossFailedUploads.push({ method: request.method, url: request.url });
        response.writeHead(403, { "Content-Type": "application/xml" });
        response.end("<Error><Code>AccessDenied</Code><Message>Fixture upload denied</Message></Error>");
        return;
      }
      ossUploads.push({ method: request.method, url: request.url, body: Buffer.concat(chunks) });
      if (holdNextOssUpload) {
        const gate = holdNextOssUpload;
        holdNextOssUpload = null;
        gate.started();
        await gate.released;
      }
      response.writeHead(200, {
        ETag: '"test-etag"',
        "x-oss-request-id": "test-request-id",
      });
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    ossServer.once("error", reject);
    ossServer.listen(0, "127.0.0.1", resolve);
  });
  const ossAddress = ossServer.address();
  assert.ok(ossAddress && typeof ossAddress === "object");
  const ossEndpoint = `http://127.0.0.1:${ossAddress.port}`;
  const ossPublicBaseUrl = "https://test-bucket.oss-accelerate.aliyuncs.com";
  const articleSyncSecret = "test-article-sync-secret-with-enough-entropy";
  const remoteSyncRequests = [];
  let rejectRemoteSync = false;
  const remoteServer = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      remoteSyncRequests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(rejectRemoteSync ? 503 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(rejectRemoteSync ? { detail: "Fixture remote temporarily unavailable" } : { ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    remoteServer.once("error", reject);
    remoteServer.listen(0, "127.0.0.1", resolve);
  });
  const remoteAddress = remoteServer.address();
  assert.ok(remoteAddress && typeof remoteAddress === "object");
  const remoteOrigin = `http://127.0.0.1:${remoteAddress.port}`;
  const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ADMIN_PASSWORD: "test-admin-password",
      ADMIN_SESSION_SECRET: "test-session-secret-with-enough-entropy",
      ARTICLE_SYNC_SECRET: articleSyncSecret,
      ARTICLE_SYNC_ALLOW_PRIVATE: "true",
      OSS_ACCESS_KEY_ID: "test-access-key-id",
      OSS_ACCESS_KEY_SECRET: "test-access-key-secret",
      OSS_BUCKET: "test-bucket",
      OSS_REGION: "oss-cn-hangzhou",
      OSS_ENDPOINT: ossEndpoint,
      OSS_CNAME: "true",
      OSS_ALLOW_INSECURE_ENDPOINT: "true",
      OSS_PUBLIC_BASE_URL: ossPublicBaseUrl,
      LOCATION_DB_PATH: path.join(runtimeDirectory, "locations.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  t.after(async () => {
    for (const gate of heldOssUploads) gate.release();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve, reject) => ossServer.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => remoteServer.close((error) => error ? reject(error) : resolve()));
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

  const initialConsentedAt = payload.locations[0].consentedAt;
  const refreshLocationResponse = await fetch(`${origin}/api/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "integration-test-device",
      city: "杭州市",
      address: "杭州市刷新地址 2 号",
      latitude: 30.2741,
      longitude: 120.1551,
      accuracy: 18,
      consent: true,
      renewConsent: false,
    }),
  });
  assert.equal(refreshLocationResponse.status, 204);

  const refreshedLocationsResponse = await fetch(`${origin}/api/admin/locations`, {
    headers: { Cookie: cookie },
  });
  assert.equal(refreshedLocationsResponse.status, 200);
  const refreshedPayload = await refreshedLocationsResponse.json();
  assert.equal(refreshedPayload.locations[0].city, "杭州市");
  assert.equal(refreshedPayload.locations[0].address, "杭州市刷新地址 2 号");
  assert.equal(refreshedPayload.locations[0].consentedAt, initialConsentedAt);

  const locationId = refreshedPayload.locations[0].id;
  const unauthorizedRevokeResponse = await fetch(`${origin}/api/admin/locations/${locationId}`, { method: "DELETE" });
  assert.equal(unauthorizedRevokeResponse.status, 401);

  const revokeResponse = await fetch(`${origin}/api/admin/locations/${locationId}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(revokeResponse.status, 200);
  const revokePayload = await revokeResponse.json();
  assert.equal(revokePayload.revokedConsent.deviceId, "integration-test-device");

  const revokedStatusResponse = await fetch(`${origin}/api/location/consent-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "integration-test-device" }),
  });
  assert.equal(revokedStatusResponse.status, 200);
  assert.deepEqual(await revokedStatusResponse.json(), { revoked: true });

  const emptyLocationsResponse = await fetch(`${origin}/api/admin/locations`, { headers: { Cookie: cookie } });
  assert.equal(emptyLocationsResponse.status, 200);
  assert.equal((await emptyLocationsResponse.json()).locations.length, 0);

  const rejectedBackgroundRefresh = await fetch(`${origin}/api/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "integration-test-device",
      city: "杭州市",
      address: "不应重新写入的后台刷新地址",
      latitude: 30.2741,
      longitude: 120.1551,
      accuracy: 18,
      consent: true,
      renewConsent: false,
    }),
  });
  assert.equal(rejectedBackgroundRefresh.status, 409);
  assert.equal((await rejectedBackgroundRefresh.json()).error, "location-consent-revoked");

  const renewedConsentResponse = await fetch(`${origin}/api/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "integration-test-device",
      city: "北京市",
      address: "北京市重新授权地址 3 号",
      latitude: 39.9042,
      longitude: 116.4074,
      accuracy: 16,
      consent: true,
      renewConsent: true,
    }),
  });
  assert.equal(renewedConsentResponse.status, 204);

  const renewedStatusResponse = await fetch(`${origin}/api/location/consent-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "integration-test-device" }),
  });
  assert.deepEqual(await renewedStatusResponse.json(), { revoked: false });

  const renewedLocationsResponse = await fetch(`${origin}/api/admin/locations`, { headers: { Cookie: cookie } });
  const renewedLocationsPayload = await renewedLocationsResponse.json();
  assert.equal(renewedLocationsPayload.locations.length, 1);
  assert.equal(renewedLocationsPayload.locations[0].city, "北京市");
  assert.ok(renewedLocationsPayload.locations[0].consentedAt > initialConsentedAt);

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
  const processedFilename = "0123456789abcdef01234567.png";
  const sourceImagePath = path.join(sourceImageDirectory, processedFilename);
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await mkdir(sourceImageDirectory, { recursive: true });
  await writeFile(sourceImagePath, imageBytes);
  t.after(async () => {
    await rm(sourceImageDirectory, { recursive: true, force: true });
  });

  const sourceUrl = `/article-images/${articleId}/${processedFilename}`;
  const ossImageUrl = `${ossPublicBaseUrl}/article-images/${articleId}/${processedFilename}`;
  const rawSourceUrl = `/uploads/articles/${articleId}/${processedFilename}`;
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookie };
  const readArticle = async (id = articleId) => {
    const response = await fetch(`${origin}/api/admin/articles`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return (await response.json()).articles.find((article) => article.id === id);
  };
  const publishArticle = (content, extra = {}) => fetch(`${origin}/api/admin/articles/${articleId}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      title: "远端同步测试文章",
      summary: "本地发布与远端检查分离",
      content,
      status: "published",
      ...extra,
    }),
  });
  const syncArticle = (id = articleId, destination = remoteOrigin) => fetch(`${origin}/api/admin/articles/${id}/sync`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ remoteServer: destination }),
  });

  const unauthorizedManualSync = await fetch(`${origin}/api/admin/articles/${articleId}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remoteServer: remoteOrigin }),
  });
  assert.equal(unauthorizedManualSync.status, 401);
  const rejectedDraftSync = await syncArticle();
  assert.equal(rejectedDraftSync.status, 409);
  assert.equal((await rejectedDraftSync.json()).error, "article-not-published");

  // Local creation preserves every image source. Only remote synchronization
  // validates whether the images belong to this article and are ready for OSS.
  for (const imageSource of [
    "https://external.example/image.png",
    "blob:https://external.example/image",
    rawSourceUrl,
    sourceUrl,
    ossImageUrl,
  ]) {
    const content = `<p>本地允许发布</p><img src="${imageSource}">`;
    const createResponse = await fetch(`${origin}/api/admin/articles`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        title: "待同步的本地文章",
        summary: "图片校验延迟到上传远端",
        content,
        status: "published",
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.article.status, "published");
    assert.equal(created.article.content, content);
    assert.equal(created.uploadedImageCount, 0);
    assert.equal(created.remoteSync, undefined);
    assert.deepEqual(await readArticle(created.article.id), created.article);

    const rejectedSync = await syncArticle(created.article.id);
    assert.equal(rejectedSync.status, 502);
    const rejected = await rejectedSync.json();
    assert.equal(rejected.remoteSync.status, "failed");
    assert.match(rejected.remoteSync.detail, /图片|外链|Blob/);
    assert.deepEqual(rejected.article, created.article);
    assert.deepEqual(await readArticle(created.article.id), created.article);
  }
  assert.equal(ossUploads.length, 0);
  assert.equal(ossFailedUploads.length, 0);
  assert.equal(remoteSyncRequests.length, 0);

  const rawContent = `<p>原图也能在本地发布</p><img src="${rawSourceUrl}" alt="本地原始图片">`;
  const rawPublication = await publishArticle(rawContent);
  assert.equal(rawPublication.status, 200);
  const rawPublicationPayload = await rawPublication.json();
  assert.equal(rawPublicationPayload.article.content, rawContent);
  assert.equal(rawPublicationPayload.article.status, "published");
  assert.equal(rawPublicationPayload.uploadedImageCount, 0);
  const rawPage = await fetch(`${origin}/articles/${articleId}`);
  assert.equal(rawPage.status, 200);
  assert.ok((await rawPage.text()).includes(`<img src="${rawSourceUrl}" alt="本地原始图片"`));
  const rejectedRawSync = await syncArticle();
  assert.equal(rejectedRawSync.status, 502);
  const rejectedRawPayload = await rejectedRawSync.json();
  assert.match(rejectedRawPayload.remoteSync.detail, /原始导入图片/);
  assert.deepEqual(rejectedRawPayload.article, rawPublicationPayload.article);
  assert.deepEqual(await readArticle(), rawPublicationPayload.article);

  // Updating a published article also keeps unprocessed sources verbatim.
  for (const imageSource of ["https://external.example/new.png", "blob:https://external.example/new"]) {
    const content = `<p>更新本地正文</p><img src="${imageSource}">`;
    const updateResponse = await publishArticle(content);
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json();
    assert.equal(updated.article.content, content);
    assert.equal(updated.article.status, "published");
    assert.equal(updated.uploadedImageCount, 0);
    const rejectedSync = await syncArticle();
    assert.equal(rejectedSync.status, 502);
    assert.deepEqual((await rejectedSync.json()).article, updated.article);
  }

  // The image-count ceiling is a sync constraint, not a local publishing one.
  const tooManyImages = `<p>超过同步图片上限</p>${`<img src="${sourceUrl}">`.repeat(51)}`;
  const oversizedPublication = await publishArticle(tooManyImages);
  assert.equal(oversizedPublication.status, 200);
  const oversizedPayload = await oversizedPublication.json();
  assert.equal(oversizedPayload.article.content, tooManyImages);
  const oversizedSync = await syncArticle();
  assert.equal(oversizedSync.status, 502);
  const oversizedSyncPayload = await oversizedSync.json();
  assert.match(oversizedSyncPayload.remoteSync.detail, /50/);
  assert.deepEqual(oversizedSyncPayload.article, oversizedPayload.article);
  assert.equal(ossUploads.length, 0);
  assert.equal(ossFailedUploads.length, 0);
  assert.equal(remoteSyncRequests.length, 0);

  // Publishing remains available even while OSS is unavailable. A failed OSS
  // upload cannot change the local article or send an incomplete remote payload.
  rejectOssUploads = true;
  const processedContent = `<p>同步测试正文</p><img src="${sourceUrl}" alt="同步图片">`;
  const publishResponse = await publishArticle(processedContent);
  assert.equal(publishResponse.status, 200);
  const publishPayload = await publishResponse.json();
  assert.equal(publishPayload.remoteSync, undefined);
  assert.equal(publishPayload.uploadedImageCount, 0);
  assert.equal(publishPayload.article.status, "published");
  assert.equal(publishPayload.article.content, processedContent);
  assert.equal(ossUploads.length, 0);
  assert.equal(ossFailedUploads.length, 0);
  const failedOssSync = await syncArticle();
  assert.equal(failedOssSync.status, 502);
  const failedOssPayload = await failedOssSync.json();
  assert.equal(failedOssPayload.remoteSync.status, "failed");
  assert.match(failedOssPayload.remoteSync.detail, /上传 OSS 失败/);
  assert.deepEqual(failedOssPayload.article, publishPayload.article);
  assert.deepEqual(await readArticle(), publishPayload.article);
  assert.equal(ossFailedUploads.length, 3);
  assert.equal(remoteSyncRequests.length, 0);
  assert.equal((await fetch(`${origin}/articles/${articleId}`)).status, 200);
  rejectOssUploads = false;

  // Once OSS succeeds its URLs are saved locally even if the remote server
  // fails; retrying sends the same JSON and never reuploads the image bytes.
  rejectRemoteSync = true;
  const failedRemoteSync = await syncArticle();
  assert.equal(failedRemoteSync.status, 502);
  const failedRemotePayload = await failedRemoteSync.json();
  assert.equal(failedRemotePayload.remoteSync.status, "failed");
  assert.equal(failedRemotePayload.remoteSync.detail, "Fixture remote temporarily unavailable");
  assert.equal(failedRemotePayload.remoteSync.uploadedImageCount, 1);
  assert.equal(failedRemotePayload.article.status, "published");
  assert.ok(failedRemotePayload.article.content.includes(ossImageUrl));
  assert.ok(!failedRemotePayload.article.content.includes(`src="${sourceUrl}"`));
  assert.ok(failedRemotePayload.article.updatedAt > publishPayload.article.updatedAt);
  assert.deepEqual(await readArticle(), failedRemotePayload.article);
  assert.equal(ossUploads.length, 1);
  assert.equal(ossUploads[0].method, "PUT");
  assert.equal(ossUploads[0].url, `/article-images/${articleId}/${processedFilename}`);
  assert.deepEqual(ossUploads[0].body, imageBytes);
  assert.equal(remoteSyncRequests.length, 1);
  assert.equal(remoteSyncRequests[0].method, "POST");
  assert.equal(remoteSyncRequests[0].url, "/api/article-sync");
  assert.equal(remoteSyncRequests[0].headers.authorization, `Bearer ${articleSyncSecret}`);
  assert.equal(remoteSyncRequests[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(remoteSyncRequests[0].body), { article: failedRemotePayload.article });
  rejectRemoteSync = false;
  const retriedSync = await syncArticle();
  assert.equal(retriedSync.status, 200);
  const retriedPayload = await retriedSync.json();
  assert.equal(retriedPayload.remoteSync.status, "synced");
  assert.equal(retriedPayload.remoteSync.uploadedImageCount, 0);
  assert.equal(retriedPayload.remoteSync.articleUrl, `${remoteOrigin}/articles/${articleId}`);
  assert.deepEqual(retriedPayload.article, failedRemotePayload.article);
  assert.equal(remoteSyncRequests.length, 2);
  assert.deepEqual(JSON.parse(remoteSyncRequests[1].body), { article: failedRemotePayload.article });
  assert.equal(ossUploads.length, 1);

  // Compare-and-swap prevents a slow upload from replacing newer local edits.
  const beforeConcurrentSync = await publishArticle(processedContent);
  assert.equal(beforeConcurrentSync.status, 200);
  let started;
  let release;
  const uploadStarted = new Promise((resolve) => { started = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const gate = { started, released, release };
  heldOssUploads.push(gate);
  holdNextOssUpload = gate;
  const pendingSync = syncArticle();
  await Promise.race([
    uploadStarted,
    pendingSync.then((response) => { throw new Error(`Concurrent sync ended before upload: HTTP ${response.status}`); }),
  ]);
  const concurrentUpdate = await publishArticle("<p>上传过程中用户保存的新草稿</p>", { title: "不能被旧同步覆盖", status: "draft" });
  assert.equal(concurrentUpdate.status, 200);
  const concurrentUpdatePayload = await concurrentUpdate.json();
  release();
  const concurrentSyncResponse = await pendingSync;
  assert.equal(concurrentSyncResponse.status, 502);
  const concurrentSyncPayload = await concurrentSyncResponse.json();
  assert.equal(concurrentSyncPayload.remoteSync.status, "failed");
  assert.match(concurrentSyncPayload.remoteSync.detail, /已被修改/);
  assert.deepEqual(concurrentSyncPayload.article, concurrentUpdatePayload.article);
  assert.deepEqual(await readArticle(), concurrentUpdatePayload.article);
  assert.equal(ossUploads.length, 2);
  assert.equal(remoteSyncRequests.length, 2);

  const rejectedLocalSync = await fetch(`${origin}/api/article-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${articleSyncSecret}` },
    body: JSON.stringify({ article: { ...failedRemotePayload.article, content: `<img src="${sourceUrl}">` } }),
  });
  assert.equal(rejectedLocalSync.status, 422);
  assert.equal((await rejectedLocalSync.json()).error, "invalid-article-sync");

  // Simulate a fresh checkout: publishing and remote synchronization must use OSS
  // URLs without reopening local files or restoring image bytes on the receiver.
  await rm(sourceImageDirectory, { recursive: true });
  const republishOssOnlyResponse = await fetch(`${origin}/api/admin/articles/${articleId}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify(failedRemotePayload.article),
  });
  assert.equal(republishOssOnlyResponse.status, 200);
  const republishOssOnlyPayload = await republishOssOnlyResponse.json();
  assert.equal(republishOssOnlyPayload.uploadedImageCount, 0);
  assert.equal(republishOssOnlyPayload.article.content, failedRemotePayload.article.content);
  assert.equal(ossUploads.length, 2);

  const manualSyncResponse = await syncArticle(articleId, origin);
  assert.equal(manualSyncResponse.status, 200);
  const manualSyncPayload = await manualSyncResponse.json();
  assert.equal(manualSyncPayload.remoteSync.status, "synced");
  assert.equal(manualSyncPayload.remoteSync.articleUrl, `${origin}/articles/${articleId}`);
  assert.equal(manualSyncPayload.remoteSync.uploadedImageCount, 0);
  assert.deepEqual(manualSyncPayload.article, republishOssOnlyPayload.article);
  assert.equal(ossUploads.length, 2);
  await assert.rejects(access(sourceImageDirectory), { code: "ENOENT" });
  await assert.rejects(access(path.join(projectRoot, "public", "uploads", "articles", articleId)), { code: "ENOENT" });

  const publishedPage = await fetch(`${origin}/articles/${articleId}`);
  assert.equal(publishedPage.status, 200);
  assert.match(await publishedPage.text(), new RegExp(ossImageUrl.replaceAll(".", "\\.")));
});
