import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const id = "11111111-1111-4111-8111-111111111111";
const reference = { isPrivateVideoId: value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), PRIVATE_VIDEO_ATTRIBUTE: "data-private-video-id" };
const flush = () => new Promise(resolve => setImmediate(resolve));
function compile(path, imports, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${outputText}\n})`, globals)(name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

test("sanitizer preserves a valid private identity, removes competing public sources and rejects invalid markers", () => {
  const { safeArticleContent } = compile("lib/article-content.ts", {
    "sanitize-html": { default: require("sanitize-html") }, "./article-image-urls": { isDisplayableArticleImageSource: () => false },
    "./article-video-urls": { isOssArticleVideoSource: () => false }, "./private-video-reference": reference,
  });
  const output = safeArticleContent(id, `<video data-private-video-id="${id}" src="https://evil.example/x.mp4" onerror="alert(1)" title="Test"><source src="https://evil.example/y.mp4"></video>`);
  assert.match(output, new RegExp(`data-private-video-id="${id}"`));
  assert.doesNotMatch(output, /src=|onerror|evil\.example/);
  assert.equal(safeArticleContent(id, '<video data-private-video-id="../key" src="https://evil.example/x"></video>'), "");
});

test("publication requires registered private resources and rejects src mixed with a private marker", () => {
  const { assertArticleUsesOssVideos, privateVideoIdsFromContent } = compile("lib/article-videos.ts", {
    cheerio: require("cheerio"), "./article-video-urls": { isOssArticleVideoSource: value => value === "https://legacy.example/video.mp4" },
    "./private-video-reference": reference, "./private-videos": { getPrivateVideoAsset: value => value === id ? { id } : null },
  });
  assert.doesNotThrow(() => assertArticleUsesOssVideos(`<video data-private-video-id="${id}"></video>`));
  assert.doesNotThrow(() => assertArticleUsesOssVideos('<video src="https://legacy.example/video.mp4"></video>'));
  assert.throws(() => assertArticleUsesOssVideos(`<video data-private-video-id="${id}" src="https://legacy.example/video.mp4"></video>`), /不得同时/);
  assert.throws(() => assertArticleUsesOssVideos(`<video data-private-video-id="${id.replace("1111", "2222")}"></video>`), /尚未完成/);
  assert.throws(() => assertArticleUsesOssVideos(`<video data-private-video-id="../../key"></video>`), /尚未完成/);
  assert.deepEqual([...privateVideoIdsFromContent(`<video data-private-video-id="${id}"></video><video data-private-video-id="${id}"></video>`)], [id]);
});

async function playerHarness({ admin = false, authorized: initial = false, native = true, mediaSource = false, managedMediaSource = false, hlsSupported = true, cleanupBeforeInitialImport = false, firstStatus } = {}) {
  let authorized = initial, cursor = 0, tree;
  const values = [], effects = [], requests = [], listeners = new Map(), mediaEvents = new Map(), hlsInstances = [], sourceAssignments = [];
  let supportChecks = 0;
  const nativeVideo = {
    _src: "", currentTime: 0, duration: 120, pauses: 0, loads: 0,
    get src() { return this._src; },
    set src(value) { this._src = value; sourceAssignments.push(value); },
    canPlayType: () => typeof native === "string" ? native : native ? "probably" : "",
    addEventListener: (event, callback) => mediaEvents.set(event, callback), removeEventListener: event => mediaEvents.delete(event),
    pause() { this.pauses++; }, load() { this.loads++; }, removeAttribute(name) { if (name === "src") this._src = ""; },
  };
  class FakeHls {
    static isSupported() { supportChecks++; return hlsSupported; }
    static Events = { ERROR: "error" };
    constructor() { this.events = new Map(); this.sourceLoads = 0; this.attaches = 0; this.destroys = 0; hlsInstances.push(this); }
    on(event, callback) { this.events.set(event, callback); }
    loadSource(source) { this.source = source; this.sourceLoads++; }
    attachMedia() { this.attaches++; }
    destroy() { this.destroyed = true; this.destroys++; }
  }
  const jsx = (type, props) => ({ type, props: props || {} });
  const hooks = {
    useState(initialValue) { const i = cursor++; if (!(i in values)) values[i] = initialValue; return [values[i], value => { values[i] = typeof value === "function" ? value(values[i]) : value; }]; },
    useRef(initialValue) { const i = cursor++; return values[i] ||= { current: initialValue }; },
    useId() { return `player-${cursor++}`; },
    useCallback(callback, deps) { const i = cursor++; if (!values[i] || deps.some((dep, index) => dep !== values[i].deps[index])) values[i] = { callback, deps }; return values[i].callback; },
    useEffect(callback, deps) { const i = cursor++; if (!values[i] || deps.some((dep, index) => dep !== values[i].deps[index])) { const previous = values[i]; values[i] = { deps, cleanup: null }; effects.push(() => { previous?.cleanup?.(); values[i].cleanup = callback(); }); } },
  };
  const playerModule = compile("app/PrivateVideoPlayer.tsx", {
    react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx }, "../lib/private-video-reference": reference,
    "../lib/article-video-share-link": { PRIVATE_VIDEO_ACCESS_EVENT: "private-video-access-changed", articleIdFromPath: pathname => pathname === `/articles/${id}` ? id : null },
    "./PrivateVideoPlayer.module.css": { default: new Proxy({}, { get: (_target, key) => key }) },
    "hls.js": { default: FakeHls },
  }, {
    AbortController, Event,
    window: { ...(mediaSource ? { MediaSource: class {} } : {}), ...(managedMediaSource ? { ManagedMediaSource: class {} } : {}), location: { pathname: `/articles/${id}` }, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name), dispatchEvent: event => listeners.get(event.type)?.() },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (!options.method && requests.length === 1 && firstStatus) return firstStatus;
      if (options.method === "POST") {
        const input = JSON.parse(options.body);
        if (input.code !== "valid-code") return { ok: false, json: async () => ({ error: "访问码无效或已撤销。" }) };
        authorized = true;
      }
      if (options.method === "DELETE") authorized = false;
      return { ok: true, json: async () => ({ authorized }) };
    },
  });
  const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const cleanup = () => { for (const value of values) if (value?.cleanup) { value.cleanup(); value.cleanup = null; } };
  const render = async (cleanupBeforeFlush = false) => {
    cursor = 0; tree = playerModule.default({ assetId: id, title: "Fixture", admin });
    for (const node of nodes(tree)) if (node.type === "video") node.props.ref.current = nativeVideo;
    for (const effect of effects.splice(0)) effect();
    if (cleanupBeforeFlush) cleanup();
    await flush();
  };
  const find = type => nodes(tree).find(node => node.type === type);
  const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : String(node ?? "");
  await render(cleanupBeforeInitialImport); await render();
  return { requests, find, nativeVideo, render, hlsInstances, mediaEvents, sourceAssignments, supportChecks: () => supportChecks, text: () => text(tree), setAuthorized: value => { authorized = value; },
    async accessChanged() { listeners.get("private-video-access-changed")?.(); await flush(); await render(); },
    async failHls(status) { hlsInstances.at(-1).events.get("error")("error", { response: { code: status }, fatal: true }); await flush(); await render(); },
    async retry() { nodes(tree).find(node => node.type === "button" && text(node) === "重试").props.onClick(); await flush(); await render(); },
    async submit(code) { find("input").props.onChange({ target: { value: code } }); await render(); await find("form").props.onSubmit({ preventDefault() {} }); await render(); }, cleanup };
}

test("ordinary viewers must verify a code via POST, then receive only a protected manifest source", async () => {
  const h = await playerHarness();
  assert.equal(h.find("video"), undefined);
  assert.ok(h.find("form"));
  await h.submit("invalid");
  assert.equal(h.find("video"), undefined);
  await h.submit("valid-code");
  assert.ok(h.find("video"));
  assert.equal(h.nativeVideo.src, `/api/private-videos/${id}/manifest`);
  const post = h.requests.find(request => request.method === "POST" && JSON.parse(request.body).code === "valid-code");
  assert.equal(post.url, "/api/private-videos/access");
  assert.equal(post.credentials, "same-origin");
  assert.equal(JSON.parse(post.body).articleId, id);
  assert.ok(h.requests.filter(request => !request.method).every(request => request.url === `/api/private-videos/access?assetId=${id}`));
  assert.ok(h.requests.every(request => !request.url.includes("valid-code") && !request.url.includes("/admin/")));
  h.cleanup();
});

test("admin preview uses its explicit protected namespace without opening a viewer session", async () => {
  const h = await playerHarness({ admin: true });
  assert.equal(h.requests.length, 0);
  assert.equal(h.nativeVideo.src, `/api/admin/private-videos/${id}/manifest`);
  assert.equal(h.find("form"), undefined);
  h.cleanup();
});

test("Chrome-style native maybe plus MediaSource chooses hls.js, never a native manifest assignment", async () => {
  const h = await playerHarness({ authorized: true, native: "maybe", mediaSource: true, managedMediaSource: false });
  assert.equal(h.hlsInstances.length, 1);
  assert.equal(h.hlsInstances[0].source, `/api/private-videos/${id}/manifest`);
  assert.equal(h.hlsInstances[0].attaches, 1);
  assert.equal(h.supportChecks(), 1);
  assert.deepEqual(h.sourceAssignments, []);
  assert.equal(h.nativeVideo.src, "");
  h.cleanup();
});

test("modern Safari with ManagedMediaSource retains native HLS preference", async () => {
  const h = await playerHarness({ authorized: true, native: "probably", mediaSource: true, managedMediaSource: true });
  assert.equal(h.hlsInstances.length, 0);
  assert.equal(h.supportChecks(), 0);
  assert.deepEqual(h.sourceAssignments, [`/api/private-videos/${id}/manifest`]);
  h.cleanup();
});

test("older iOS without MediaSource retains native HLS preference", async () => {
  const h = await playerHarness({ authorized: true, native: "maybe", mediaSource: false, managedMediaSource: false });
  assert.equal(h.hlsInstances.length, 0);
  assert.equal(h.supportChecks(), 0);
  assert.equal(h.nativeVideo.src, `/api/private-videos/${id}/manifest`);
  h.cleanup();
});

test("native HLS remains a fallback when hls.js reports unsupported on an MSE browser", async () => {
  const h = await playerHarness({ authorized: true, native: "maybe", mediaSource: true, hlsSupported: false });
  assert.equal(h.supportChecks(), 1);
  assert.equal(h.hlsInstances.length, 0);
  assert.deepEqual(h.sourceAssignments, [`/api/private-videos/${id}/manifest`]);
  assert.doesNotMatch(h.text(), /暂不支持此视频格式/);
  h.cleanup();
});

test("no native HLS and no supported hls.js show an error without starting playback", async () => {
  const h = await playerHarness({ authorized: true, native: "", mediaSource: true, hlsSupported: false });
  await h.render();
  assert.equal(h.supportChecks(), 1);
  assert.equal(h.hlsInstances.length, 0);
  assert.deepEqual(h.sourceAssignments, []);
  assert.match(h.text(), /暂不支持此视频格式/);
  assert.ok(h.requests.every(request => request.url.startsWith("/api/private-videos/access?")));
  h.cleanup();
});

test("unchanged MSE player rerenders do not reload, and cleanup removes listeners and destroys once", async () => {
  const h = await playerHarness({ authorized: true, native: "maybe", mediaSource: true });
  for (let index = 0; index < 4; index++) await h.render();
  assert.equal(h.hlsInstances.length, 1);
  const instance = h.hlsInstances[0];
  assert.equal(instance.sourceLoads, 1); assert.equal(instance.attaches, 1);
  assert.deepEqual(h.sourceAssignments, []);
  h.cleanup(); h.cleanup();
  assert.equal(instance.destroys, 1);
  assert.equal(h.mediaEvents.size, 0);
  assert.equal(h.nativeVideo.loads, 1);
  assert.equal(h.nativeVideo.pauses, 1);
  assert.equal(h.nativeVideo.src, "");
});

test("cleanup before the asynchronous hls.js import callback prevents any late initialization", async () => {
  const h = await playerHarness({ admin: true, native: "maybe", mediaSource: true, cleanupBeforeInitialImport: true });
  assert.equal(h.supportChecks(), 0);
  assert.equal(h.hlsInstances.length, 0);
  assert.deepEqual(h.sourceAssignments, []);
  assert.equal(h.mediaEvents.size, 0);
  assert.equal(h.nativeVideo.loads, 1);
  h.cleanup();
});

test("OSS 403 with a valid viewer session retains access and retries a fresh stable manifest at the prior position", async () => {
  const h = await playerHarness({ authorized: true, native: false });
  h.nativeVideo.currentTime = 37;
  await h.failHls(403);
  assert.equal(h.find("form"), undefined);
  assert.match(h.text(), /资源暂时无法读取.*无需重新输入访问码/);
  await h.retry();
  assert.equal(h.hlsInstances.length, 2);
  assert.equal(h.hlsInstances[1].source, `/api/private-videos/${id}/manifest`);
  h.nativeVideo.currentTime = 0;
  h.mediaEvents.get("loadedmetadata")();
  assert.equal(h.nativeVideo.currentTime, 37);
  assert.ok(h.requests.every(request => request.method !== "POST"));
  h.cleanup();
});

test("player asks for a new code only after status confirms the session was revoked", async () => {
  const h = await playerHarness({ authorized: true, native: false });
  h.setAuthorized(false);
  await h.failHls(403);
  assert.ok(h.find("form"));
  assert.equal(h.find("video"), undefined);
  assert.match(h.text(), /观看权限已失效/);
  h.cleanup();
});

test("article auto-unlock event wins over a stale initial denial and does not restart an already playing video", async () => {
  let resolveFirst;
  const firstStatus = new Promise(resolve => { resolveFirst = resolve; });
  const h = await playerHarness({ native: false, firstStatus });
  assert.equal(h.find("video"), undefined);
  h.setAuthorized(true); await h.accessChanged();
  assert.ok(h.find("video")); assert.equal(h.hlsInstances.length, 1);
  resolveFirst({ ok: true, json: async () => ({ authorized: false }) }); await flush(); await h.render();
  assert.ok(h.find("video")); assert.equal(h.find("form"), undefined);
  h.nativeVideo.currentTime = 29;
  await h.accessChanged();
  assert.equal(h.hlsInstances.length, 1, "successful grant events leave an already working player intact");
  assert.equal(h.nativeVideo.currentTime, 29);
  h.cleanup();
});
