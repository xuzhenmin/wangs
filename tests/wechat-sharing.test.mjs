import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const id = "11111111-1111-4111-8111-111111111111";
const hash = "0123456789abcdef01234567";
const article = { id, title: "测试文章", summary: "摘要", content: "<p>内容</p>", status: "published", createdAt: 1, updatedAt: 2 };

function loader(overrides = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const output = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const loadedModule = { exports: {} };
    cache.set(filename, loadedModule.exports);
    const require = createRequire(filename);
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename })((name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (!name.startsWith(".")) return require(name);
      return load(path.resolve(path.dirname(filename), `${name}.ts`));
    }, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  return relative => load(path.join(root, relative));
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test("sign only the configured HTTPS origin; preserve query encoding and remove fragment", t => {
  environment(t, { NEXT_PUBLIC_SITE_URL: "https://news.example.com" });
  const { validateWechatUrl, signWechatUrl } = loader()("lib/wechat-share.ts");
  const url = "https://news.example.com/articles/test?a=%2f&b=1+2#section";
  assert.equal(validateWechatUrl(url), url.split("#")[0]);
  for (const invalid of [null, "broken", "http://news.example.com/", "https://news.example.com.evil.test/", "https://user@news.example.com/", "https://evil.test/"]) {
    assert.throws(() => validateWechatUrl(invalid));
  }
  assert.match(signWechatUrl("ticket", validateWechatUrl(url), "nonce", 123), /^[a-f0-9]{40}$/);
  assert.notEqual(signWechatUrl("ticket", validateWechatUrl(url), "nonce", 123), signWechatUrl("ticket", validateWechatUrl(url) + "&x=1", "nonce", 123));
});

test("concurrent signing shares token/ticket fetches and never returns credentials", async t => {
  environment(t, { NEXT_PUBLIC_SITE_URL: "https://news.example.com", WECHAT_APP_ID: "wx-fixture", WECHAT_APP_SECRET: "private-fixture" });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("stable_token")) return Response.json({ access_token: "private-token", expires_in: 7200 });
    return Response.json({ errcode: 0, ticket: "private-ticket", expires_in: 7200 });
  });
  const { getWechatConfig } = loader()("lib/wechat-share.ts");
  const configurations = await Promise.all(Array.from({ length: 8 }, () => getWechatConfig("https://news.example.com/?x=1#test")));
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).force_refresh, false);
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(configurations[0].enabled, true);
  assert.equal(new Set(configurations.map(c => c.nonceStr)).size, 8);
  assert.doesNotMatch(JSON.stringify(configurations), /private-fixture|private-token|private-ticket/);
  await getWechatConfig("https://news.example.com/other");
  assert.equal(calls.length, 2);
});

test("misconfiguration yields actionable errors, caches failure and does not leak upstream text", async t => {
  environment(t, { NEXT_PUBLIC_SITE_URL: "https://news.example.com", WECHAT_APP_ID: "wx-fixture", WECHAT_APP_SECRET: "private-fixture" });
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ errcode: 40164, errmsg: "secret upstream details" }));
  const { getWechatConfig } = loader()("lib/wechat-share.ts");
  for (let i = 0; i < 2; i++) await assert.rejects(getWechatConfig("https://news.example.com/"), error => {
    assert.equal(error.code, "wechat_40164");
    assert.match(error.message, /IP 白名单/);
    assert.doesNotMatch(error.message, /secret upstream/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("missing WeChat credentials disables SDK without requesting WeChat", async t => {
  environment(t, { WECHAT_APP_ID: undefined, WECHAT_APP_SECRET: undefined });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const { GET } = loader()("app/api/wechat/config/route.ts");
  const response = await GET(new Request("http://localhost/api/wechat/config"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { enabled: false });
});

test("metadata selects current-article images and changes cover URL when updated", t => {
  environment(t, { NEXT_PUBLIC_SITE_URL: "https://news.example.com", OSS_PUBLIC_BASE_URL: "https://images.example.com", OSS_ARTICLE_IMAGE_PREFIX: "article-images" });
  const { articleShareData, firstShareImage } = loader()("lib/share-metadata.ts");
  const source = `https://images.example.com/article-images/${id}/${hash}.png`;
  assert.equal(firstShareImage({ ...article, content: `<img src="https://evil.test/a.png"><img src='${source}'>` }), source);
  assert.equal(firstShareImage({ ...article, content: `<img src="/article-images/${id}/../../.env">` }), "/og.png");
  assert.equal(articleShareData(article).title, "测试文章｜深巷");
  assert.match(articleShareData(article).imgUrl, /^https:\/\/news.example.com\/api\/share\/cover\//);
  assert.notEqual(articleShareData(article).imgUrl, articleShareData({ ...article, updatedAt: 3 }).imgUrl);
});

test("cover renders opaque 480px JPEG below 100KB, caches, falls back and supports 304", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "wangs-share-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public");
  await mkdir(path.join(publicDir, "article-images", id), { recursive: true });
  const input = await sharp({ create: { width: 1200, height: 1800, channels: 4, background: { r: 240, g: 120, b: 0, alpha: 0.5 } } }).png().toBuffer();
  await writeFile(path.join(publicDir, "og.png"), input);
  await writeFile(path.join(publicDir, "article-images", id, `${hash}.png`), input);
  t.mock.method(process, "cwd", () => directory);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const { getShareCover, coverResponse } = loader()("lib/share-cover.ts");
  const withImage = { ...article, content: `<img src="/article-images/${id}/${hash}.png">` };
  const [cover, same] = await Promise.all([getShareCover(withImage), getShareCover(withImage)]);
  assert.equal(cover, same);
  const info = await sharp(cover.bytes).metadata();
  assert.equal(info.width, 480);
  assert.equal(info.height, 480);
  assert.equal(info.format, "jpeg");
  assert.equal(info.hasAlpha, false);
  assert.ok(cover.bytes.length < 100 * 1024);
  assert.equal(cover.fallback, false);
  const response = coverResponse(new Request("https://news.example.com/", { headers: { "If-None-Match": cover.etag } }), cover);
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  const missing = await getShareCover({ ...article, content: `<img src="/article-images/${id}/${"f".repeat(24)}.png">` });
  assert.equal(missing.fallback, true);
  assert.ok(missing.bytes.length < 100 * 1024);
});

test("cover endpoint refuses draft or missing articles", async () => {
  const { GET } = loader({ "../../../../../lib/articles": { getPublishedArticle: async () => undefined } })("app/api/share/cover/[id]/route.ts");
  const response = await GET(new Request(`https://news.example.com/api/share/cover/${id}`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

async function exerciseClient({ userAgent, enabled = true, entry = "https://news.example.com/?entry=1#top" }) {
  const calls = [];
  let effect;
  let ready;
  const sdk = {
    config(config) { calls.push(["config", config]); },
    ready(callback) { ready = callback; callback(); },
    error() {},
    updateAppMessageShareData(data) { calls.push(["friends", data]); },
    updateTimelineShareData(data) { calls.push(["timeline", data]); },
  };
  const window = {
    location: { href: "https://news.example.com/articles/current?from=chat#body", origin: "https://news.example.com" },
    setTimeout, clearTimeout,
  };
  const context = vm.createContext({
    window, location: window.location, navigator: { userAgent },
    performance: { getEntriesByType: () => [{ name: entry }] }, URL, AbortController,
    console: { warn(...args) { calls.push(["warning", args]); } },
    document: {
      createElement() { return { remove() {} }; },
      head: { appendChild(script) { calls.push(["script", script.src]); window.wx = sdk; queueMicrotask(() => script.onload()); } },
    },
    async fetch(url) {
      calls.push(["fetch", url]);
      return Response.json({ enabled, appId: "wx-test", timestamp: 123, nonceStr: "nonce", signature: "signature", jsApiList: ["updateAppMessageShareData", "updateTimelineShareData"] });
    },
  });
  const compiled = ts.transpileModule(readFileSync(path.join(root, "app/WechatShare.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context)(() => ({ useEffect(callback) { effect = callback; } }), loadedModule, loadedModule.exports);
  loadedModule.exports.default({ title: "本篇标题", desc: "本篇摘要", link: "/articles/current", imgUrl: "/api/share/cover/current?v=1" });
  const cleanup = effect();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  cleanup?.();
  const before = calls.length;
  ready?.();
  assert.equal(calls.length, before, "unmounted callback must not overwrite another page's share data");
  return calls;
}

test("WeChat client initializes both share menus with article-specific absolute URLs", async () => {
  const calls = await exerciseClient({ userAgent: "Android MicroMessenger/8.0" });
  const signedUrl = new URL(calls.find(([type]) => type === "fetch")[1], "https://news.example.com").searchParams.get("url");
  assert.equal(signedUrl, "https://news.example.com/articles/current?from=chat");
  assert.equal(calls.filter(([type]) => type === "script").length, 1);
  assert.equal(calls.filter(([type]) => type === "config").length, 1);
  for (const name of ["friends", "timeline"]) {
    const data = calls.find(([type]) => type === name)[1];
    assert.equal(data.title, "本篇标题");
    assert.equal(data.link, "https://news.example.com/articles/current");
    assert.equal(data.imgUrl, "https://news.example.com/api/share/cover/current?v=1");
  }
});

test("iOS signs the entry URL while sharing the current article; disabled/non-WeChat skips SDK", async () => {
  const calls = await exerciseClient({ userAgent: "iPhone MicroMessenger/8.0" });
  const signedUrl = new URL(calls.find(([type]) => type === "fetch")[1], "https://news.example.com").searchParams.get("url");
  assert.equal(signedUrl, "https://news.example.com/?entry=1");
  const disabled = await exerciseClient({ userAgent: "iPhone MicroMessenger/8.0", enabled: false });
  assert.deepEqual(disabled.map(([type]) => type), ["fetch"]);
  assert.deepEqual(await exerciseClient({ userAgent: "Chrome" }), []);
});
